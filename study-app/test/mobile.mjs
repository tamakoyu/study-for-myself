/**
 * test/mobile.mjs —— 手机做题端（/m）的端到端测试
 *
 * 和 test/e2e.mjs 一样：真实浏览器（无头 Edge）+ CDP + 真服务 + 真写盘，
 * 只是**把窗口调成手机尺寸并开触摸模拟**，然后照着一个人拿手机做题的顺序点一遍。
 *
 * 必须先起一个指向「副本」的测试服务（run-e2e.sh 会做好）：
 *   NOTEBOOK_PORT=4199 node server.mjs --no-open &
 *   "/Applications/Microsoft Edge.app/..." --headless=new --remote-debugging-port=9333 \
 *     --window-size=1500,1150 "http://127.0.0.1:4199/"
 *   APP_URL=http://127.0.0.1:4199 CDP_PORT=9333 E2E_VAULT=<副本> node test/mobile.mjs
 *
 * 这个测试是**有状态**的：它会打卡、会记英语成绩。每跑一次都要把副本重新复制一份。
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const CDP = Number(process.env.CDP_PORT || 9333);
const APP = process.env.APP_URL || 'http://127.0.0.1:4199';
const VAULT = process.env.E2E_VAULT || '';
const OUT = process.env.SHOT_DIR || '/tmp';
const MOB = `${APP}/m`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* 等浏览器起来 */
    }
    await sleep(500);
  }
  throw new Error('连不上无头浏览器的调试端口');
}

class Session {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      const slot = this.pending.get(msg.id);
      if (slot) {
        this.pending.delete(msg.id);
        msg.error ? slot.reject(new Error(JSON.stringify(msg.error))) : slot.resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} 超时`));
        }
      }, 20000);
    });
  }
  async js(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async function(){ ${expr} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || '页面脚本报错');
    return r.result.value;
  }
  async waitFor(sel, timeout = 10000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await this.js(`return !!document.querySelector(${JSON.stringify(sel)});`)) return true;
      await sleep(150);
    }
    const diag = await this.js(
      `return JSON.stringify({
         url: location.href,
         head: (document.getElementById('mmain') || {}).innerHTML ? document.getElementById('mmain').innerHTML.slice(0, 400) : '(空)',
         toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent)
       });`
    );
    throw new Error(`等不到元素：${sel}\n  现场：${diag}`);
  }
  async waitText(sel, re, timeout = 12000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const t = await this.js(
        `var el=document.querySelector(${JSON.stringify(sel)}); return el ? el.innerText : '';`
      );
      if (re.test(t)) return t;
      await sleep(250);
    }
    const t = await this.js(
      `var el=document.querySelector(${JSON.stringify(sel)}); return el ? el.innerText : '(没有这个元素)';`
    );
    throw new Error(`等不到 ${sel} 匹配 ${re}，现在是：${t.slice(0, 200)}`);
  }
  async shot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${OUT}/mobile-${name}.png`, Buffer.from(data, 'base64'));
  }
  click(sel) {
    return this.js(
      `var el=document.querySelector(${JSON.stringify(sel)}); if(!el) return 'NOELEM'; el.click(); return 'ok';`
    );
  }
  /** 手机上真实的点法：派发触摸事件，走的是同一条 click 委托 */
  async tapText(sel, text) {
    return this.js(
      `var els=[...document.querySelectorAll(${JSON.stringify(sel)})];
       var el=els.find(function(x){ return x.innerText.includes(${JSON.stringify(text)}); });
       if(!el) return 'NOELEM';
       el.click(); return 'ok';`
    );
  }
  async navigate(url, ready = '.mtabs') {
    await this.send('Page.navigate', { url });
    // 等页面自己把首屏渲染出来（loading 消失）
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      const ok = await this.js(
        `return !!document.querySelector(${JSON.stringify(ready)}) && !document.querySelector('main .loading');`
      );
      if (ok) return;
    }
    throw new Error(`页面没渲染出来：${url}（等的是 ${ready}）`);
  }
  /**
   * 从一张白纸开始。
   *
   * 桌面端那套跑完（或者中途崩了）会把浏览器留在它自己的那一屏，甚至带着它的 hash ——
   * 直接 Page.navigate 到 /m 有时候会跟它没走完的导航撞上。所以先跳一次 about:blank
   * 把上一个文档彻底扔掉，再进 /m，并且**确认 hash 是空的**：手机端是靠 hash 恢复
   * 那一屏的，带着别人的 hash 进来就会莫名其妙地停在某一屏（这个坑真踩过）。
   */
  async freshMobile(url, ready = '.mtabs') {
    await this.send('Page.navigate', { url: 'about:blank' });
    await sleep(400);
    await this.navigate(url, ready);
    const hash = await this.js(`return location.hash;`);
    if (hash) {
      await this.js(`history.replaceState(null, '', location.pathname); location.reload(); 'ok'`);
      await sleep(600);
      await this.navigate(url, ready);
    }
    return this.js(`return location.hash;`);
  }
}

const api2 = (p, options) =>
  fetch(`${APP}${p}`, { headers: { 'Content-Type': 'application/json' }, ...options }).then((r) => r.json());

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok });
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? `　— ${detail}` : ''}`);
};

/**
 * 页面上不该漏出字面的 Markdown 记号。
 * 在 HTML 模板里直接写 `**加粗**` 会原样显示成星号（桌面端也踩过，e2e 里有同款断言）——
 * 手机端这边第一版就漏了一处，所以每个主要屏都扫一遍。
 */
const leakScreens = [];
async function scanLeak(name) {
  const bad = await s.js(
    `var t=(document.body.innerText)||'';
     return t.split('\\n').filter(function(l){ return l.indexOf('**')>=0 || l.indexOf('~~')>=0; }).slice(0,1).join('');`
  );
  if (bad) leakScreens.push(`${name}：${bad.trim().slice(0, 40)}`);
}

const readVault = (rel) => {
  const abs = path.join(VAULT, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
};

/* ============================================================
   开场：连浏览器 + 调成手机
   ============================================================ */
const page = await findPage();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res);
  ws.addEventListener('error', rej);
});
const s = new Session(ws);
await s.send('Runtime.enable');
await s.send('Page.enable');
// iPhone 14 那一档：390×844。**必须在导航前设好**，不然首屏按桌面宽度排版
await s.send('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 3,
  mobile: true,
});
await s.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

/* ---------- 1. /m 能打开，而且是手机版 ---------- */
const startHash = await s.freshMobile(MOB);
check('手机端 /m 能直接打开（不用打 .html）', (await s.js(`return location.pathname;`)) === '/m');
check(
  '手机端：从一张白纸进来（hash 是空的，不会带着上一轮那一屏）',
  startHash === '',
  startHash ? `起来时带着 ${startHash}` : '干净'
);
check(
  '两个页签在：今日 / 做题',
  (await s.js(`return [...document.querySelectorAll('.mtab')].map(x=>x.innerText.trim()).join('|');`)) === '📅\n今日|✍️\n做题' ||
    (await s.js(`return [...document.querySelectorAll('.mtab')].map(x=>x.innerText.trim()).join('|');`)).includes('今日')
);
check(
  '底部页签是固定定位，正文给它让出了地方',
  (await s.js(
    `var t=getComputedStyle(document.getElementById('mtabs')).position;
     var p=parseFloat(getComputedStyle(document.body).paddingBottom);
     return t==='fixed' && p>40;`
  )) === true,
  await s.js(`return 'tab=' + getComputedStyle(document.getElementById('mtabs')).position + ' bodyPad=' + getComputedStyle(document.body).paddingBottom;`)
);
check(
  '没有横向溢出（手机上最烦的就是能左右拖）',
  (await s.js(`return document.documentElement.scrollWidth <= window.innerWidth + 1;`)) === true,
  await s.js(`return 'scrollWidth=' + document.documentElement.scrollWidth + ' viewport=' + window.innerWidth;`)
);

/* ---------- 2. 今日页 ---------- */
await s.waitFor('.countdown-card');
check(
  '今日页：考研倒计时读出来了',
  (await s.js(`return document.querySelector('.cd-days').innerText;`)).includes('天'),
  await s.js(`return document.querySelector('.cd-days').innerText.replace(/\\s+/g,' ');`)
);
check(
  '今日页：四张统计卡都在（今日完成 / 待复习 / 本周 / 连续打卡）',
  (await s.js(`return document.querySelectorAll('.stat-card').length;`)) >= 4
);
const taskCount = await s.js(`return document.querySelectorAll('.task-list input[type=checkbox]').length;`);
check('今日页：今天的任务列出来了', taskCount > 0, `${taskCount} 条`);
await scanLeak('今日');
await s.shot('01-today');

/* ---------- 3. 勾选任务直接写回 Obsidian ---------- */
const weekRel = (await api2('/api/today')).week?.rel || '';
// 拿「本周完成数」比：勾到的可能是 🔁 每日任务（写的是当天的打卡子行，
// 文件里 `- [ ]` 的行数不会变），所以不能只看未完成行数
const beforeDone = (await api2('/api/today')).week?.done ?? 0;
const beforeLine = (readVault(weekRel).match(/^- \[ \]/gm) || []).length;
await s.js(`document.querySelector('.task-list input[type=checkbox]:not(:checked)').click();`);
await sleep(1800);
const afterDone = (await api2('/api/today')).week?.done ?? 0;
const afterLine = (readVault(weekRel).match(/^- \[ \]/gm) || []).length;
check(
  '今日页：勾一下任务，真的写回周计划文件了',
  !!weekRel && afterDone === beforeDone + 1,
  `${path.basename(weekRel)} 本周完成 ${beforeDone} → ${afterDone}（文件里未完成行 ${beforeLine} → ${afterLine}）`
);

/* ---------- 4. 做题页：三块都在 ---------- */
await s.js(`document.querySelector('[data-tab="drill"]').click();`);
await sleep(900);
// 先确认真的在做题页 —— 不是的话把当前那一屏打出来。
// （以前这里失败只报「0 道」，查半天查不出是停在哪一屏，教训）
const whereAmI = await s.js(`
  return JSON.stringify({
    hash: location.hash,
    top: (document.getElementById('mtop') || {}).innerText ? document.getElementById('mtop').innerText.replace(/\\s+/g,' ') : '',
    head: document.body.innerText.replace(/\\s+/g,' ').slice(0, 90)
  });
`);
check(
  '做题页：切到「做题」页签后确实在做题页（不是停在别的屏）',
  (await s.js(`return !!document.getElementById('qList');`)) === true,
  whereAmI
);
check(
  '做题页：三块内容都在（今日测试 / 错题刷题 / 英语阅读）',
  (await s.js(`return [...document.querySelectorAll('.msec h2')].map(x=>x.innerText.trim()).join('|');`)).includes('今日测试') &&
    (await s.js(`return document.body.innerText.includes('错题刷题');`)) &&
    (await s.js(`return document.body.innerText.includes('英语阅读');`)),
  await s.js(`return [...document.querySelectorAll('.msec h2')].map(x=>x.innerText.trim()).join(' / ');`)
);
const qRows = await s.js(`return document.querySelectorAll('#qList .mrow').length;`);
check('做题页：错题列表有题', qRows > 0, `${qRows} 道`);
await scanLeak('做题页');
await s.shot('02-drill');

/* ---------- 5. 搜索框：本地筛，且不整页重绘（焦点不丢） ---------- */
const searchInfo = await s.js(`
  var input=document.getElementById('qSearch');
  input.focus();
  input.value='极限';
  input.dispatchEvent(new Event('input',{bubbles:true}));
  await new Promise(r=>setTimeout(r,300));
  return JSON.stringify({
    rows: document.querySelectorAll('#qList .mrow').length,
    focused: document.activeElement && document.activeElement.id,
    value: document.getElementById('qSearch').value
  });
`);
const si = JSON.parse(searchInfo);
check(
  '搜索框：打字就筛题，而且焦点没被打掉（不是整页重绘）',
  si.rows > 0 && si.rows <= qRows && si.focused === 'qSearch' && si.value === '极限',
  `筛出 ${si.rows}/${qRows} 道，焦点在 ${si.focused}`
);
await s.js(`
  var input=document.getElementById('qSearch');
  input.value=''; input.dispatchEvent(new Event('input',{bubbles:true}));
  await new Promise(r=>setTimeout(r,200));
`);

/* ---------- 6. 打开今日测试卷：公式、计时器、拍照入口 ---------- */
/**
 * 先确保副本里有一份卷子。
 * **不能假定它一定在** —— 桌面端那套 e2e 最后会把试卷删光（它有个「删除」用例），
 * 全量跑的时候手机端就接在一份卷子都没有的仓库上。所以这里自己造一份，跟顺序无关。
 */
const FIXTURE = [
  '---',
  'date: 2026-09-14',
  'title: 手机端测试卷',
  'minutes: 20',
  'full: 30',
  '---',
  '',
  '# 手机端测试卷',
  '',
  '## 题目',
  '',
  '### 1. 填空题 ｜ 两个重要极限 ｜ 10 分',
  '',
  '求 $\\lim\\limits_{x\\to0}\\dfrac{\\sin x}{x}$，并写出 $1^{\\infty}$ 型极限的计算公式。',
  '',
  '### 2. 大题 ｜ 1的无穷大型 ｜ 20 分',
  '',
  '求 $\\lim\\limits_{x\\to0}\\left(\\dfrac{1+x}{1-x}\\right)^{\\frac{1}{x}}$。',
  '',
  '## 答案与解析',
  '',
  '### 1. 填空题 ｜ 两个重要极限 ｜ 10 分',
  '',
  '**标准答案**',
  '',
  '$\\lim\\limits_{x\\to0}\\dfrac{\\sin x}{x}=1$；$\\lim f(x)^{g(x)}=\\mathrm{e}^{\\lim g(x)[f(x)-1]}$。',
  '',
  '**解析**',
  '',
  '必须是 $1^{\\infty}$ 型未定式才能用这个公式。',
  '',
  '### 2. 大题 ｜ 1的无穷大型 ｜ 20 分',
  '',
  '**标准答案**',
  '',
  '解：底数趋于 $1$、指数趋于 $\\infty$，是 $1^{\\infty}$ 型。',
  '',
  '$$f(x)-1=\\frac{1+x}{1-x}-1=\\frac{2x}{1-x},\\qquad g(x)[f(x)-1]=\\frac{2}{1-x}\\to2$$',
  '',
  '所以原式 $=\\mathrm{e}^{2}$。',
  '',
  '**解析**',
  '',
  '先验证是 $1^{\\infty}$ 型，再通分算 $\\lim g(f-1)$。',
].join('\n');

let testRel = (await api2('/api/test')).tests?.[0]?.rel;
if (!testRel) {
  const made = await api2('/api/test', {
    method: 'POST',
    body: JSON.stringify({ rel: '今日测试/2026-09-14-手机端测试卷.md', content: FIXTURE }),
  });
  testRel = made.rel || '今日测试/2026-09-14-手机端测试卷.md';
  check('试卷：副本里没有试卷时，自己造一份（这条不依赖别的测试留没留数据）', !!testRel, testRel);
  await s.js(`document.querySelector('[data-act="refresh"]').click(); 'ok'`);
  await sleep(2000);
}
await s.js(`
  var el=document.querySelector('[data-act="open-paper"]');
  if(!el) throw new Error('做题页上找不到「开始做」那个按钮');
  el.click(); 'ok'
`);
await s.waitFor('.mq-body .katex', 12000);
check(
  '试卷：题干渲染成真公式了（KaTeX 在，不是一堆美元符号）',
  (await s.js(`return document.querySelectorAll('.katex').length;`)) > 5 &&
    !(await s.js(`var t=document.querySelector('.mq-body').innerText; return t.includes('$');`)),
  `${await s.js(`return document.querySelectorAll('.katex').length;`)} 个公式节点`
);
check(
  '试卷：每题都标了分值和参考用时',
  (await s.js(`return document.querySelector('.mq-tag').innerText;`)).includes('分') &&
    (await s.js(`return document.querySelector('.mq-tag').innerText;`)).includes('参考'),
  await s.js(`return document.querySelector('.mq-tag').innerText.trim();`)
);
check('试卷：答案默认藏着（点开才有）', (await s.js(`return document.querySelectorAll('details.fold[open]').length;`)) === 0);
check(
  '试卷：顶栏计时器在走',
  /\d+:\d\d/.test(await s.js(`return document.getElementById('mtimer').innerText;`)),
  await s.js(`return document.getElementById('mtimer').innerText.trim();`)
);
const t1 = await s.js(`return document.getElementById('mtimer').innerText;`);
await sleep(1600);
const t2 = await s.js(`return document.getElementById('mtimer').innerText;`);
check('试卷：计时器真的在走（不是画上去的样子货）', t1 !== t2, `${t1.trim()} → ${t2.trim()}`);

check(
  '拍照入口：相机那个带 capture=environment，相册那个能多选',
  (await s.js(`return document.getElementById('camShot').getAttribute('capture');`)) === 'environment' &&
    (await s.js(`return document.getElementById('albumPick').hasAttribute('multiple');`)) === true
);
check(
  '底部操作条：拍照 / 相册 / 判分三个按钮都在',
  (await s.js(`return document.body.innerText.includes('📷 拍照');`)) &&
    (await s.js(`return document.body.innerText.includes('🖼 相册');`)) &&
    (await s.js(`return !!document.querySelector('[data-act="grade"]');`))
);
check(
  '还没传图时「判分」是禁用的（不让人白点一下）',
  (await s.js(`return document.querySelector('[data-act="grade"]').disabled;`)) === true
);
await scanLeak('试卷');
await s.shot('03-paper');

/* ---------- 7. 拍照上传：走真实的 input change 事件 ---------- */
const up = await s.js(`
  var cv=document.createElement('canvas'); cv.width=900; cv.height=1200;
  var ctx=cv.getContext('2d');
  ctx.fillStyle='#fff'; ctx.fillRect(0,0,900,1200);
  ctx.fillStyle='#000'; ctx.font='44px serif'; ctx.fillText('解：手写答案 e2e', 60, 200);
  var blob=await new Promise(function(r){ cv.toBlob(r,'image/jpeg',0.9); });
  var f=new File([blob],'手机拍的.jpg',{type:'image/jpeg'});
  var dt=new DataTransfer(); dt.items.add(f);
  var input=document.getElementById('camShot');
  input.files=dt.files;
  input.dispatchEvent(new Event('change',{bubbles:true}));
  for (var i=0;i<40;i++){
    await new Promise(function(r){ setTimeout(r,250); });
    if (document.querySelectorAll('.mphoto img').length) break;
  }
  return JSON.stringify({ thumbs: document.querySelectorAll('.mphoto img').length, html: document.body.innerText.includes('手写答案') });
`);
const upInfo = JSON.parse(up);
check('拍照上传：传一张就在底部看到缩略图了', upInfo.thumbs === 1 && upInfo.html, JSON.stringify(upInfo));
const uploads = await api2('/api/uploads');
check(
  '拍照上传：图真的落到服务端的暂存目录了',
  (uploads.files || []).length === 1,
  `${(uploads.files || []).length} 张：${(uploads.files || []).map((f) => f.name).join(',')}`
);
check(
  '拍照上传：传完图「判分」按钮变可点（没配 AI 时仍拦住）',
  (await s.js(`return document.querySelector('[data-act="grade"]').disabled;`)) ===
    !(await api2('/api/ai')).ready,
  `AI ready=${(await api2('/api/ai')).ready}`
);
await s.shot('04-photo');
// 操作条这时候是最挤的（缩略图 + 拍照/相册 + 判分三行）——
// 正是它最容易顶出屏幕的时候，量一下它到底有没有整个待在视口里
const barFit = JSON.parse(
  await s.js(`
    var b=document.getElementById('mbar');
    var r=b.getBoundingClientRect();
    var last=b.querySelector('.mbar-row:last-child');
    var lr=last ? last.getBoundingClientRect() : null;
    return JSON.stringify({
      top:Math.round(r.top), h:Math.round(r.height), vh:window.innerHeight,
      lastBottom: lr ? Math.round(lr.bottom) : null,
      pad:Math.round(parseFloat(getComputedStyle(document.querySelector('main')).paddingBottom)),
      cvar:getComputedStyle(document.documentElement).getPropertyValue('--mbar-h').trim()
    });
  `)
);
check(
  '底部操作条：整个在屏幕里，没被顶出视口下面（最挤的时候也不藏按钮）',
  barFit.top >= 0 && barFit.lastBottom !== null && barFit.lastBottom <= barFit.vh,
  `条高 ${barFit.h}px，顶 ${barFit.top}，最后一行底 ${barFit.lastBottom}，视口高 ${barFit.vh}`
);
check(
  '底部操作条：正文给它留的底边距 ≥ 它的实际高度（最后一点内容不会被压住）',
  barFit.pad >= barFit.h && barFit.cvar === `${barFit.h}px`,
  `正文底边距 ${barFit.pad}px / 条高 ${barFit.h}px（--mbar-h=${barFit.cvar}）`
);

/* ---------- 8. 删掉这一张：服务端那份也要一起删 ---------- */
await s.js(`document.querySelector('.mphoto button').click();`);
await sleep(900);
check(
  '删图：点了 ✕ 之后暂存目录里也没了（不在 uploads 里堆垃圾）',
  (await s.js(`return document.querySelectorAll('.mphoto img').length;`)) === 0 &&
    ((await api2('/api/uploads')).files || []).length === 0
);

/* ---------- 9. 退出试卷：回做题页 ---------- */
await s.js(`document.querySelector('[data-act="back"]').click();`);
await sleep(800);
check(
  '退出：回到做题页，底部页签也回来了',
  (await s.js(`return !!document.getElementById('qList');`)) === true &&
    (await s.js(`return document.getElementById('mtabs').hidden;`)) === false
);

/* ---------- 10. 单题做题 + 手动打卡写盘 ---------- */
// 挑一道**题干里带公式**的题：KaTeX 渲染这条要真的验一下，不能挑到纯文字的题就跳过。
// （目录里两种题都有 —— 比如 408 那些「简述…」就是纯文字的。）
const problems = (await api2('/api/questions')).problems;
const target = problems.find((p) => p.kind === 'mistakes' && /\$/.test(p.stem)) || problems[0];
const targetBefore = target.stats.total;
await s.js(`
  var el=[...document.querySelectorAll('#qList [data-act="open-question"]')]
    .find(function(x){ return x.dataset.id === ${JSON.stringify(target.id)}; });
  if(!el) throw new Error('列表里找不到 ' + ${JSON.stringify(target.id)});
  el.click();
`);
await s.waitFor('.mq-body .md-p', 12000);
check(
  '单题：题干、考点、难度热度都在',
  (await s.js(`return document.querySelectorAll('.mq-body .katex').length;`)) > 0 &&
    (await s.js(`return document.querySelectorAll('.mbadge').length;`)) >= 3,
  `${target.num} · ${await s.js(`return document.querySelectorAll('.mq-body .katex').length;`)} 个公式节点`
);
check('单题：答案默认藏着', (await s.js(`return document.querySelectorAll('details.fold[open]').length;`)) === 0);
check(
  '单题：三个结果按钮在（完美 / 普通 / 失败）',
  (await s.js(`return document.querySelectorAll('[data-act="record"]').length;`)) === 3
);
await scanLeak('单题');
await s.shot('05-question');

await s.js(`document.querySelector('[data-act="record"][data-result="完美"]').click();`);
await sleep(400);
check(
  '单题：点了结果之后就问错因（8 个词 + 可以跳过）',
  (await s.js(`return document.querySelectorAll('[data-act="pick-reason"]').length;`)) === 8 &&
    (await s.js(`return !!document.querySelector('[data-act="commit-record"]');`))
);
await s.js(`document.querySelector('[data-act="pick-reason"][data-reason="计算失误"]').click();`);
await sleep(300);
await s.js(`document.querySelector('[data-act="commit-record"]').click();`);
await sleep(2200);

const after = (await api2('/api/questions')).problems.find((p) => p.id === target.id);
check(
  '单题：打卡真的写进笔记了（次数 +1，错因也记上了）',
  after.stats.total === targetBefore + 1 && (after.reasonCounts?.['计算失误'] || 0) > 0,
  `${targetBefore} → ${after.stats.total} 次，错因 ${Object.keys(after.reasonCounts || {}).join('/') || '（空）'}`
);
// relPath 是相对错题本目录的，vaultRel 才是相对仓库根 —— 读文件要用后者
const noteMd = readVault(target.vaultRel || target.relPath);
check(
  '单题：笔记末尾多了一行打卡记录，带日期和用时',
  /- \[x\] 第 \d+ 次 · 完美 · \d{4}-\d{2}-\d{2} · \d+s · 错因：计算失误/.test(noteMd),
  (noteMd.match(/^- \[x\] 第 \d+ 次.*$/m) || ['(没找到)'])[0].slice(0, 70)
);
check(
  '单题：记完之后计时器归零重来（方便再练一遍）',
  (await s.js(`return document.getElementById('mtimer') ? document.getElementById('mtimer').innerText : '';`)).trim().startsWith('0:')
);
await s.shot('06-checkin');

/* ---------- 11. 刷新后回到原来那一屏（手机上锁屏就会重载） ---------- */
await s.js(`location.reload(); 'ok'`);
await sleep(1200);
for (let i = 0; i < 60; i++) {
  await sleep(250);
  if (await s.js(`return !!document.getElementById('mtimer');`)) break;
}
check(
  '刷新（锁屏再回来）：hash 记着这道题，直接回到刚才那一屏',
  (await s.js(`return location.hash;`)).startsWith('#q=') &&
    (await s.js(`return document.body.innerText.includes(${JSON.stringify(target.num)});`)) === true,
  await s.js(`return location.hash;`)
);

/* ---------- 12. 英语阅读：本地判卷 + 落盘 ---------- */
await s.js(`location.hash='#drill'; 'ok'`);
await sleep(900);
/**
 * 挑一篇**合用的**，别拿第一篇就用：
 *   - `!last`：判过分的篇目一进去就显示成绩单，底部那条「对答案」是收起来的（判完就没必要再判）
 *   - `questions >= 4`：要够几道题才验得动「判的分 = 手算的分」
 *   - 目标词够多：才验得动正文标蓝
 *
 * 一篇都没有就**自己造一篇** —— 桌面端那套跑完可能把现成的那些都判过一遍了
 * （它自己就有一个「本地判卷写进成绩记录」的用例），别赌它还留着干净的。
 */
const S_FIXTURE_REL = '单词故事/2026-09-14-97-手机端测试篇.md';
const STORY_FIXTURE = [
  '---',
  'date: 2026-09-14',
  'type: 传统阅读 · 细节题',
  'title: A Short Walk in the Rain',
  'words:',
  '  - reluctant',
  '  - umbrella',
  '  - shelter',
  '  - drenched',
  '  - pavement',
  '  - cheerful',
  '  - hesitate',
  '  - glimpse',
  '---',
  '',
  '# A Short Walk in the Rain',
  '',
  'She was **reluctant** to leave, but the sky had turned grey and she had no **umbrella**.',
  'By the corner she found **shelter** under a shop awning, **drenched** from the knee down,',
  'and watched the **pavement** turn into a shallow river. A **cheerful** stranger **hesitated**',
  'beside her, then offered to share his coat. She caught a **glimpse** of her own reflection',
  'in the wet glass and laughed.',
  '',
  '## 题目',
  '',
  '1. Why did she leave the house?',
  'A. She wanted a walk in the rain',
  'B. The weather turned bad and she had no umbrella',
  'C. She was meeting the stranger',
  'D. She had to buy a coat',
  '',
  '2. Where did she stop?',
  'A. At a bus stop',
  'B. Under a shop awning',
  'C. Inside a cafe',
  'D. At her own door',
  '',
  '3. What did the stranger do?',
  'A. He ignored her',
  'B. He offered to share his coat',
  'C. He took her umbrella',
  'D. He walked away quickly',
  '',
  '4. What did she see in the glass?',
  'A. The stranger',
  'B. Her own reflection',
  'C. A river',
  'D. Nothing at all',
  '',
  '5. What is the tone of the passage?',
  'A. Cheerful and light',
  'B. Angry',
  'C. Formal and cold',
  'D. Sad and hopeless',
  '',
  '## 答案速查',
  '',
  '1. B　2. B　3. B　4. B　5. A',
  '',
  '## 答案解析',
  '',
  '| 题号 | 题型 | 答案 | 定位句 |',
  '| --- | --- | --- | --- |',
  '| 1 | 细节题 | B | the sky had turned grey and she had no umbrella |',
  '| 2 | 细节题 | B | she found shelter under a shop awning |',
  '| 3 | 细节题 | B | offered to share his coat |',
  '| 4 | 细节题 | B | a glimpse of her own reflection |',
  '| 5 | 主旨题 | A | cheerful stranger / laughed |',
].join('\n');

const allStories = (await api2('/api/words')).stories || [];
let story = allStories.find((x) => !x.last && x.questions >= 4 && (x.words || []).length >= 8);
if (!story) {
  await api2('/api/words/story', {
    method: 'POST',
    body: JSON.stringify({ rel: S_FIXTURE_REL, content: STORY_FIXTURE, words: ['reluctant', 'umbrella', 'shelter', 'drenched', 'pavement', 'cheerful', 'hesitate', 'glimpse'] }),
  });
  await s.js(`document.querySelector('[data-act="refresh"]').click(); 'ok'`);
  await sleep(2000);
  story = ((await api2('/api/words')).stories || []).find((x) => x.rel === S_FIXTURE_REL);
  check('英语：没有干净篇目时自己造一篇（这条不依赖别的测试留没留数据）', !!story && !story.last, story ? story.rel : '(没造出来)');
}
if (story) {
  await s.js(`
    var el=[...document.querySelectorAll('[data-act="open-reading"]')]
      .find(function(x){ return x.dataset.rel === ${JSON.stringify(story.rel)}; });
    if(!el) throw new Error('列表里找不到 ' + ${JSON.stringify(story.rel)});
    el.click();
  `);
  await s.waitFor('.mreading', 12000);
  const hi = await s.js(`return document.querySelectorAll('.story-word').length;`);
  check(
    '英语：原文出来了，目标词标蓝了',
    hi >= Math.min(6, (story.words || []).length),
    `${hi} 个标蓝的词（这一篇 ${(story.words || []).length} 个目标词）`
  );
  await s.js(`document.querySelector('[data-act="reading-tab"][data-tab="quiz"]').click();`);
  await sleep(700);
  check(
    '英语：题目页签里选项是可点的（A/B/C/D）',
    (await s.js(`return document.querySelectorAll('.mopt').length;`)) >= 4
  );
  // 每题都点第一个选项（A）。
  // **必须一题一题点、中间等一下** —— 每答一题页面会重绘，抓着的一串旧节点
  // 已经从文档里摘下来了，再点不会冒泡到 document 上（真实用户也不会这么点）。
  const storyFull = await api2(`/api/words/story?rel=${encodeURIComponent(story.rel)}`);
  const nQ = await s.js(`return document.querySelectorAll('.mopts').length;`);
  for (let i = 0; i < nQ; i++) {
    await s.js(`
      var g=document.querySelectorAll('.mopts')[${i}];
      var b=g && g.querySelector('.mopt');
      if (b) b.click();
      'ok'
    `);
    await sleep(220);
  }
  const chosen = await s.js(
    `return [...document.querySelectorAll('.mopt.is-on')].map(function(x){ return x.dataset.n + ':' + x.dataset.key; }).join(',');`
  );
  check('英语：选的选项自己会亮起来', chosen.split(',').filter(Boolean).length === nQ, chosen);

  const key = storyFull.key || {};
  const answers = {};
  for (let i = 0; i < nQ; i++) answers[i + 1] = 'A'; // 全选 A
  const gradeBtn = await s.js(
    `var b=document.querySelector('[data-act="local-grade"]'); return b ? String(b.disabled) : '(没有这个按钮)';`
  );
  check(
    '英语：选完就能点「对答案」（不用拍照、不用调模型）',
    gradeBtn === 'false',
    `按钮状态 ${gradeBtn}`
  );
  await s.js(`document.querySelector('[data-act="local-grade"]').click();`);
  await s.waitFor('.mcard', 12000);

  // 程序判的分必须**正好等于**按答案速查手算的分（分值按卷子自己的来，不是拍脑袋 ×2）
  const expected = Object.keys(key).reduce(
    (s, n) => s + (answers[n] === key[n] ? Number(storyFull.plan?.table?.byN?.[n]) || 0 : 0),
    0
  );
  const got = Number(
    (await s.js(`return document.querySelector('.mcard-total .big').innerText;`)).trim()
  );
  check(
    '英语：判的分 = 按答案速查算出来的分（不是「都算对」）',
    got === expected,
    `程序判 ${got} / 手算 ${expected}（全选 A，正确答案是 ${Object.values(key).join('')}）`
  );
  const greens = await s.js(`return document.querySelectorAll('.mopt.is-right').length;`);
  const reds = await s.js(`return document.querySelectorAll('.mopt.is-wrong').length;`);
  check(
    '英语：正确答案标绿、自己选错的标红',
    greens === Object.keys(key).length && reds === Object.values(key).filter((a) => a !== 'A').length,
    `绿 ${greens} / 红 ${reds}`
  );
  const storyMd = readVault(story.rel);
  check(
    '英语：成绩写进这一篇的成绩记录了（电脑上刷新就能看到）',
    /## 成绩记录/.test(storyMd) && /本地判卷/.test(storyMd),
    (storyMd.match(/### 第 \d+ 次.*$/m) || ['(没写)'])[0].slice(0, 60)
  );
  // 对完答案就是做完了：顶栏计时得自己停下（不停的话，挂在这一屏上数字会一直涨）
  const readStop1 = await s.js(`return document.getElementById('mtimer').innerText;`);
  await sleep(1600);
  const readStop2 = await s.js(`return document.getElementById('mtimer').innerText;`);
  check(
    '英语：点完「对答案」顶栏计时自动停下（数字不再变、计时器变灰）',
    readStop1 === readStop2 &&
      (await s.js(`return document.getElementById('mtimer').classList.contains('is-paused');`)) === true,
    `${readStop1.trim()} → ${readStop2.trim()}`
  );
  await scanLeak('英语阅读');
  await s.shot('07-reading');
} else {
  check('英语：副本里有一篇阅读题（这条测不下去，先补一篇）', false, '没有 stories');
}

/* ---------- 13. 拍照判分：起一台假模型服务，把整条链路真跑一遍 ---------- */
/**
 * 前面那些只能验到「入口在不在、图传没传上去」。判分本身是手机端最要紧的一步，
 * 不能只测一半 —— 所以这里起一台**假的 OpenAI 兼容服务**（不需要真 key），
 * 让手机端真的点一次「判这一题」和「判这份答案」，
 * 看它对不对得起「总分由程序自己加、不采信模型报的数」这条规矩。
 *
 * 配的是 `AI_CONFIG_FILE` 指向的临时配置，**不会碰你真在用的 .ai-config.json**。
 */

const lastSeen = { multimodal: false, count: 0 };
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const payload = JSON.parse(body || '{}');
    const rawContent = payload.messages?.at(-1)?.content;
    const parts = Array.isArray(rawContent) ? rawContent : [];
    const user = Array.isArray(rawContent)
      ? parts.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
      : String(rawContent || '');
    lastSeen.count += 1;
    if (parts.some((c) => c.type === 'image_url')) lastSeen.multimodal = true;

    const send = (text) => {
      if (payload.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const chunk of text.match(/[\s\S]{1,50}/g) || []) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
      }
    };

    // 单题判分：要的是一个对象（不是 items 数组）。
    // ⚠️ **必须排在整卷前面**：单题的提示词开头也是「你是**考研阅卷老师**，现在批我一道题…」，
    //    顺序反了的话两个分支都会命中整卷那个，单题就会拿到 items 结构 → 静默判 0 分。
    if (user.includes('批我**一道题**')) {
      send(
        // 判分结果里带 LaTeX：`你写的 / 丢分点 / 该怎么改` 在手机上必须渲染成公式，
        // 不能显示成一串 `$x\to 0$`（那看着就跟乱码一样）
        JSON.stringify({
          score: 72,
          result: '普通',
          reason: '计算失误',
          got: '我写的：$x\\to 0$ 时左右极限都是 1',
          lost: '右极限算错了，忘了取 $x\\to 0^+$，$1^{\\infty}$ 型也没认出来',
          fix: '分段点必须左右各算一次：$\\lim_{x\\to 0^+}f(x)$ 单独求',
          analysis:
            '这一步把右极限直接当成了 0（$\\frac{0}{0}$ 型要先化简）。\n下次看到分段函数，先写左右极限再谈极限存在。',
          weak: ['分段点'],
        })
      );
      return;
    }

    // 整卷判分：满分那题给满分（验「一键加入错题本」只收做错的）。
    // ⚠️ 这份 JSON **故意漏转义**（写 `\to` 而不是 `\\to`）—— 真模型就是这么翻车的，
    //    程序得在解析时修回来，不能把 `\frac` 吃成换页符、`\to` 吃成制表符。
    if (user.includes('考研阅卷老师')) {
      const qs = [...user.matchAll(/### 第 (\d+) 题[^\n]*满分 ([\d.]+) 分/g)].map((m) => ({
        n: Number(m[1]),
        full: Number(m[2]),
      }));
      const lastQ = qs.length - 1;
      const rows = qs
        .map((q, i) => {
          const full = i === lastQ;
          return `{"n":${q.n},"got":"${String.raw`考生写的第 `}${q.n}${String.raw` 题：$x\to 0$`}","score":${
            full ? q.full : Math.max(0, Math.round((q.full - 2) * 100) / 100)
          },"full":${q.full},"verdict":"${full ? '正确' : '部分正确'}","reason":"${
            full ? '' : '计算失误'
          }","lost":"${full ? '无' : String.raw`漏了 $x\to 0^+$ 那一支`}","fix":"${
            full ? '保持' : String.raw`先看 $1^{\infty}$ 型：$\lim_{x\to 0}\frac{\sin x}{x}=1$`
          }"}`;
        })
        .join(',');
      send(
        `{"items":[${rows}],"summary":"${String.raw`假模型的总评：$\frac{1}{2}$ 这种系数别再丢。`}",` +
          `"weak":[${String.raw`"$1^{\infty}$ 型"`}],"next":["重做第 1 题"],"total":999}`
      );
      return;
    }

    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: '假服务不认这个请求' } }));
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const mockPort = mock.address().port;
await api2('/api/ai/config', {
  method: 'POST',
  body: JSON.stringify({ baseUrl: `http://127.0.0.1:${mockPort}/v1`, model: 'fake-mobile', apiKey: 'fake-key' }),
});
check('判分：能配上一台（假的）模型服务', (await api2('/api/ai')).ready === true);

/** 在手机上从零走一遍「传图 → 判分」 */
async function shootAndGrade() {
  await s.js(`
    var cv=document.createElement('canvas'); cv.width=900; cv.height=1200;
    var ctx=cv.getContext('2d');
    ctx.fillStyle='#fff'; ctx.fillRect(0,0,900,1200);
    ctx.fillStyle='#000'; ctx.font='44px serif'; ctx.fillText('解：手写答案 e2e', 60, 200);
    var blob=await new Promise(function(r){ cv.toBlob(r,'image/jpeg',0.9); });
    var dt=new DataTransfer(); dt.items.add(new File([blob],'判分用.jpg',{type:'image/jpeg'}));
    var input=document.getElementById('camShot');
    input.files=dt.files;
    input.dispatchEvent(new Event('change',{bubbles:true}));
    for (var i=0;i<40;i++){
      await new Promise(function(r){ setTimeout(r,250); });
      if (document.querySelectorAll('.mphoto img').length) break;
    }
    return document.querySelectorAll('.mphoto img').length;
  `);
  await s.js(`document.querySelector('[data-act="grade"]').click(); 'ok'`);
}

// —— 单题判分 ——
await s.freshMobile(MOB); // 同样从白纸开始：判分这一段对「页面初始状态」很敏感
await s.js(`location.hash='#drill'; 'ok'`);
await sleep(900);
check(
  '手改 hash / 浏览器后退回到 #drill：页签跟着切、列表真画出来（不是点了没反应）',
  (await s.js(`return !!document.getElementById('qList');`)) === true &&
    (await s.js(`return document.querySelector('.mtab[data-tab="drill"]').classList.contains('is-active');`)) === true
);
const one = (await api2('/api/questions')).problems[0];
await s.js(`
  var el=[...document.querySelectorAll('#qList .mqrow')]
    .find(function(x){ return x.dataset.id === ${JSON.stringify(one.id)}; });
  el.click(); 'ok'
`);
await s.waitFor('#mtimer', 12000);
await shootAndGrade();
await s.waitFor('#qAnalysis', 30000);
check(
  '判分：手机上传的图真的以多模态发给了模型（不是只传了个文件名）',
  lastSeen.multimodal === true,
  `模型收到 ${lastSeen.count} 次请求`
);
const verdictScore = (await s.js(`return document.querySelector('.mcard-total .big').innerText.trim();`)).trim();
check(
  '判分：AI 的结论按得分 / 建议填进面板了',
  verdictScore === '72' && (await s.js(`return document.body.innerText.includes('AI 建议 普通');`)) === true,
  `得分 ${verdictScore}`
);
check(
  '判分：错因分析预填好了，而且是一个能改的文本框',
  (await s.js(`return document.getElementById('qAnalysis').value.includes('右极限直接当成了 0');`)) === true
);
// 判分结果里的公式（`$x\to 0$` 这种）：手机上也得当场渲染成公式，
// 以前这里是 esc()，屏幕上就是一串美元符号加反斜杠命令 —— 看着像乱码
const oneMath = JSON.parse(
  await s.js(`
    var card=[...document.querySelectorAll('.mcard')].find(function(c){ return c.innerText.includes('丢分点'); });
    if(!card) return JSON.stringify({none:true});
    var text=[...card.querySelectorAll('.mcard-sub, .mcard-body')].map(function(x){return x.innerText;}).join('\\n');
    return JSON.stringify({katex:card.querySelectorAll('.katex').length, fallback:card.querySelectorAll('.math-fallback').length, text:text});
  `)
);
check(
  '判分：单题面板里的公式渲染成 KaTeX（你写的 / 丢分点 / 该怎么改 / 分析预览都不漏裸的 $）',
  oneMath.katex > 0 && oneMath.fallback === 0 && !oneMath.text.includes('$'),
  `${oneMath.katex} 处 KaTeX · ${String(oneMath.text || '').replace(/\s+/g, ' ').slice(0, 46)}`
);

// 这是修过的一个真问题：点「结果」chip 会重绘，**不能把我刚敲的分析冲掉**
const typed = '我自己改的：先写左右极限，再谈存在性。';
await s.js(`
  var ta=document.getElementById('qAnalysis');
  ta.value=${JSON.stringify(typed)};
  document.querySelector('[data-act="set-result"][data-result="失败"]').click();
  'ok'
`);
await sleep(600);
check(
  '判分：改「结果」之后，我刚敲的错因分析还在（重绘不冲掉草稿）',
  (await s.js(`return document.getElementById('qAnalysis').value;`)) === typed &&
    (await s.js(`return document.querySelector('[data-act="set-result"][data-result="失败"]').classList.contains('is-on');`)) === true
);

await s.js(`document.querySelector('[data-act="commit-verdict"]').click(); 'ok'`);
await sleep(2500);
const afterVerdict = readVault(one.vaultRel || one.relPath);
check(
  '判分：点「记进笔记」之后，我定的结果 + 我改的分析真的进了笔记',
  /- \[x\] 第 \d+ 次 · 失败 · \d{4}-\d{2}-\d{2}/.test(afterVerdict) &&
    afterVerdict.includes('先写左右极限，再谈存在性'),
  (afterVerdict.match(/^- \[x\] 第 \d+ 次.*$/m) || ['(没找到打卡行)'])[0].slice(0, 60)
);
check(
  '判分：判完之后面板收起来，回到手动打卡那一屏',
  (await s.js(`return !!document.querySelector('[data-act="record"][data-result="完美"]');`)) === true
);

// —— 整卷判分 ——
await s.js(`location.hash='#drill'; 'ok'`);
await sleep(900);
await s.js(`
  var el=document.querySelector('[data-act="open-paper"]');
  if(!el) throw new Error('找不到试卷入口');
  el.click(); 'ok'
`);
await s.waitFor('.mq-body .katex', 12000);
const paper = await api2(`/api/test/paper?rel=${encodeURIComponent(testRel)}`);
const fulls = (paper.items || []).map((x) => Number(paper.plan?.table?.byN?.[x.n]) || 0);
const expectTotal = fulls.reduce((s, f, i) => s + (i === fulls.length - 1 ? f : Math.max(0, Math.round((f - 2) * 100) / 100)), 0);
const gradesBefore = (paper.grades || []).length;
await shootAndGrade();
// 这一屏**一打开就显示「最近一次成绩」**，所以不能只等 `.mcard-total` 出现 ——
// 那可能是上一次的成绩（真卷子判过分就有）。等「成绩记录真的多了一条」，
// 说明这次判分落盘了，页面上的分数才是这一次的。
for (let i = 0; i < 100; i += 1) {
  await sleep(300);
  const now = await api2(`/api/test/paper?rel=${encodeURIComponent(testRel)}`);
  if ((now.grades || []).length > gradesBefore) break;
}
await sleep(600);
const paperTotal = Number((await s.js(`return document.querySelector('.mcard-total .big').innerText.trim();`)).trim());
check(
  '整卷判分：总分由程序自己加，**模型乱报的 999 没被采信**',
  paperTotal === expectTotal && paperTotal !== 999,
  `程序算 ${paperTotal} / 手算 ${expectTotal}（模型报的是 999）`
);
// 交卷了，顶栏计时得自己停下：判分要等模型，那几分钟不该算我的做题用时
const paperStop1 = await s.js(`return document.getElementById('mtimer').innerText;`);
await sleep(1600);
const paperStop2 = await s.js(`return document.getElementById('mtimer').innerText;`);
check(
  '整卷判分：交卷后顶栏计时自动停下（数字不再涨、计时器变灰）',
  paperStop1 === paperStop2 &&
    (await s.js(`return document.getElementById('mtimer').classList.contains('is-paused');`)) === true,
  `${paperStop1.trim()} → ${paperStop2.trim()}`
);
const paperMath = JSON.parse(
  await s.js(`
    var card=document.querySelector('.mcard');
    if(!card) return JSON.stringify({none:true});
    var text=[...card.querySelectorAll('.mcard-body')].map(function(x){return x.innerText;}).join('\\n');
    return JSON.stringify({katex:card.querySelectorAll('.katex').length, fallback:card.querySelectorAll('.math-fallback').length, text:text, all:card.innerText});
  `)
);
// 总评 / 薄弱点 / 下一步是模型和 items 平级给出来的。以前程序只收 items 数组，
// 这三项当场被丢掉，成绩单上永远空着 —— 这里盯住它别再丢。
check(
  '整卷判分：总评 / 薄弱点 / 下一步都显示出来了（不再被程序丢掉）',
  paperMath.all.includes('假模型的总评') &&
    paperMath.all.includes('薄弱点') &&
    paperMath.all.includes('下一步'),
  String(paperMath.all || '').replace(/\s+/g, ' ').slice(0, 60)
);
check(
  '整卷判分：成绩单的丢分点 / 总评 / 薄弱点里的公式也渲染成 KaTeX（不漏裸的 $）',
  paperMath.katex > 0 && paperMath.fallback === 0 && !paperMath.text.includes('$'),
  `${paperMath.katex} 处 KaTeX · ${String(paperMath.text || '').replace(/\s+/g, ' ').slice(0, 46)}`
);
const bankBtn = await s.js(
  `var b=document.querySelector('[data-act="to-bank"]'); return b ? b.innerText.trim() : '(没有这个按钮)';`
);
check(
  '整卷判分：一键加入错题本只数**没拿满分**的题',
  bankBtn.includes(`把 ${fulls.length - 1} 道错题`),
  bankBtn
);

const beforeBank = (await api2('/api/questions')).problems.length;
await s.js(`document.querySelector('[data-act="to-bank"]').click(); 'ok'`);
await sleep(3000);
const afterBank = (await api2('/api/questions')).problems.length;
check(
  '整卷判分：点一下就真写进错题本了（题干 + 答案 + 判分给的错因和丢分点）',
  afterBank === beforeBank + fulls.length - 1,
  `题库 ${beforeBank} → ${afterBank} 题`
);
check(
  '整卷判分：按钮换成回执，点不了第二遍',
  (await s.js(`var b=document.querySelector('[data-act="to-bank"]'); return b ? b.disabled : true;`)) === true
);
await s.shot('08-paper-graded');

// 判分那一整套是这台的假服务在撑，用完就收
await new Promise((r) => mock.close(r));

check(
  '手机端各屏：没有漏出来的 ** 记号（在 HTML 里写 Markdown 会原样显示成星号）',
  leakScreens.length === 0,
  leakScreens.join(' ／ ') || '都干净'
);

/* ---------- 14. 退出之后：桌面的那套没被动过 ---------- */
await s.send('Emulation.clearDeviceMetricsOverride');
await s.navigate(`${APP}/`, '.topbar');
check(
  '桌面端照旧：八个页签还在，没被手机端改坏',
  (await s.js(`return document.querySelectorAll('.tab').length;`)) === 8,
  await s.js(`return [...document.querySelectorAll('.tab')].map(x=>x.innerText.trim()).join('/');`)
);
await s.shot('09-desktop-back');

/* ============================================================
   收场
   ============================================================ */
const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`手机端：${results.length - failed.length}/${results.length} 条通过`);
if (failed.length) {
  console.log('没过的：');
  for (const f of failed) console.log(`  ❌ ${f.label}`);
  process.exitCode = 1;
}
// 不关掉这条 WebSocket，Node 的事件循环就一直挂着，脚本跑完了也不退出
// （表现是「测试没有任何输出、卡死」，其实早就跑完了，截图都落盘了）
ws.close();
