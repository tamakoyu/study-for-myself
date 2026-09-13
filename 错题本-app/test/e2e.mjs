/**
 * test/e2e.mjs —— 用无头 Edge 真实点一遍界面（零第三方依赖）
 *
 * 必须先起一个指向「副本」的测试服务，绝不测真数据：
 *   cp -R 错题本 /tmp/notebook-test
 *   NOTEBOOK_DIR=/tmp/notebook-test NOTEBOOK_PORT=4199 node server.mjs --no-open &
 *   "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
 *     --headless=old --disable-gpu --no-sandbox --remote-allow-origins='*' \
 *     --remote-debugging-port=9333 --user-data-dir=/tmp/edge-e2e \
 *     --window-size=1500,1150 "http://127.0.0.1:4199/" &
 *   node test/e2e.mjs
 * 截图输出到 /tmp/e2e-*.png
 */

import fs from 'node:fs';

const CDP = Number(process.env.CDP_PORT || 9333);
const APP = process.env.APP_URL || 'http://127.0.0.1:4199';
const OUT = process.env.SHOT_DIR || '/tmp';
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
      }, 15000);
    });
  }
  async js(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(function(){ ${expr} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || '页面脚本报错');
    return r.result.value;
  }
  async waitFor(sel, timeout = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await this.js(`return !!document.querySelector(${JSON.stringify(sel)});`)) return true;
      await sleep(150);
    }
    throw new Error(`等不到元素：${sel}`);
  }
  async shot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${OUT}/e2e-${name}.png`, Buffer.from(data, 'base64'));
  }
  click(sel) {
    return this.js(
      `var el=document.querySelector(${JSON.stringify(sel)}); if(!el) return 'NOELEM'; el.click(); return 'ok';`
    );
  }
}

const api2 = (path, options) =>
  fetch(`${APP}${path}`, { headers: { 'Content-Type': 'application/json' }, ...options }).then((r) => r.json());

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok });
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? `　— ${detail}` : ''}`);
};

const page = await findPage();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res);
  ws.addEventListener('error', rej);
});
const s = new Session(ws);
await s.send('Runtime.enable');
await s.send('Page.enable');

console.log(`\n=== 错题本 · 浏览器端到端测试（${APP}）===\n`);

/* ---------- 1. 总览首页：数学 / 408 两张大页 ---------- */
await s.js(`location.hash=''; location.reload();`);
await sleep(1600);
await s.waitFor('.category-grid');
const cats = await s.js(
  `return [...document.querySelectorAll('.category-card')].map(c=>c.querySelector('.cc-name').textContent.trim());`
);
check('总览首页：两类大卡都在（含 0 题的 408）', cats.length === 2 && cats.includes('数学') && cats.includes('408'), cats.join(' / '));

const mathCard = await s.js(
  `var c=[...document.querySelectorAll('.category-card')].find(x=>x.querySelector('.cc-name').textContent.trim()==='数学');
   return c ? c.querySelector('.cc-count').textContent.trim()+' 题 | '+c.querySelector('.cc-chapters').textContent.trim().slice(0,40) : 'NO';`
);
check('总览首页：数学卡显示题数与科目', mathCard.startsWith('10'), mathCard);
await s.shot('01-home');

/* ---------- 2. 进入数学 → 科目页 ---------- */
await s.js(
  `[...document.querySelectorAll('.category-card')].find(x=>x.querySelector('.cc-name').textContent.trim()==='数学').click();`
);
await sleep(800);
await s.waitFor('.subject-card');
const subs = await s.js(`return [...document.querySelectorAll('.subject-card .sc-name')].map(x=>x.textContent.trim());`);
check(
  '数学总览：三个科目都在',
  subs.length === 3 && subs.includes('高数') && subs.includes('线代') && subs.includes('概率论'),
  subs.join(' / ')
);
check('数学总览：面包屑正确', (await s.js(`return document.querySelector('.crumb')?.textContent.trim()||'';`)).includes('数学'));
const btnText = await s.js(
  `return document.querySelector('#scopeText').textContent.trim()+' / '+document.querySelector('#scopeCnt').textContent.trim();`
);
check('范围选择器：按钮显示当前范围', btnText.includes('数学'), btnText);
await s.click('#scopeBtn');
await s.waitFor('.scope-menu:not([hidden])');
const menuRows = await s.js(
  `return [...document.querySelectorAll('.scope-menu .sm-row')].map(x=>x.querySelector('.sm-name').textContent.trim());`
);
check(
  '范围选择器：下拉里列出大类与科目',
  menuRows.includes('全部错题') && menuRows.includes('数学') && menuRows.includes('408') && menuRows.includes('高数'),
  menuRows.join(' / ')
);
await s.shot('02-math');
await s.click('#scopeBtn');

/* ---------- 3. 进入高数 → 完整总览 ---------- */
await s.js(
  `[...document.querySelectorAll('.subject-card')].find(x=>x.querySelector('.sc-name').textContent.trim()==='高数').click();`
);
await sleep(1000);
await s.waitFor('.stat-grid');
const statCount = await s.js(`return document.querySelectorAll('.stat-card').length;`);
check('高数总览：5 张统计卡', statCount === 5, `${statCount} 张`);
await s.click('#scopeBtn');
await s.waitFor('.scope-menu:not([hidden])');
const chRows = await s.js(
  `return [...document.querySelectorAll('.scope-menu .sm-ch')].map(x=>x.querySelector('.sm-name').textContent.trim());`
);
check('范围选择器：选中科目后展开章节', chRows.includes('极限') && chRows.includes('函数'), chRows.join(' / '));
await s.click('#scopeBtn');
await s.shot('03-gaoshu');

/* ---------- 4. 下钻到「极限」章节 ---------- */
await s.click('#scopeBtn');
await s.waitFor('.scope-menu:not([hidden])');
await s.js(
  `[...document.querySelectorAll('.scope-menu .sm-ch')].find(x=>x.querySelector('.sm-name').textContent.trim()==='极限').click();`
);
await sleep(1000);
const limTotal = await s.js(`return document.querySelector('.stat-card .stat-value')?.textContent.trim();`);
check('章节下钻：极限 8 题', limTotal === '8', `${limTotal} 题`);
const btnPath = await s.js(`return document.querySelector('#scopeText').textContent.trim();`);
check('范围选择器：按钮更新为三级路径', btnPath === '数学 › 高数 › 极限', btnPath);

/* ---------- 5. 题库跟随范围 ---------- */
await s.js(`document.querySelector('.tab[data-view="library"]').click();`);
await sleep(800);
await s.waitFor('.problem-grid');
const libCards = await s.js(`return document.querySelectorAll('.problem-card').length;`);
check('题库：跟随范围（极限 8 题）', libCards === 8, `${libCards} 张卡`);
const katexNodes = await s.js(`return document.querySelectorAll('.problem-grid .katex').length;`);
check('题库：公式已 KaTeX 渲染', katexNodes > 0, `${katexNodes} 个节点`);
const whereText = await s.js(`return document.querySelector('.pc-where')?.textContent.trim()||'';`);
check('题库：卡片显示「大类·科目·章节」', whereText.includes('数学') && whereText.includes('极限'), whereText);

await s.click('.problem-card');
await s.waitFor('#drawerPanel .do-panel');
const folds = await s.js(`return document.querySelectorAll('#drawerPanel details.fold').length;`);
const opened = await s.js(`return document.querySelectorAll('#drawerPanel details.fold[open]').length;`);
check('详情抽屉：折叠块默认收起', folds >= 4 && opened === 0, `${folds} 个折叠块，展开 ${opened}`);
check(
  '详情抽屉：有「开始做题」、已无打卡按钮',
  (await s.js(`return !!document.querySelector('#drawerPanel [data-solve-start]');`)) === true &&
    (await s.js(`return !!document.querySelector('#drawerPanel [data-checkin]');`)) === false
);
await s.shot('04-drawer');

/* ---------- 5.4 全屏做题模式 ---------- */
await s.click('[data-solve-start]');
await sleep(900);
await s.waitFor('.rv-reveal');
check('做题模式：进入全屏，解析与错因都藏着', (await s.js(`return !document.querySelector('.rv-revealed');`)) === true);
const solveWho = await s.js(`return document.querySelector('.rv-num')?.textContent.trim() || '';`);
check('做题模式：错因不可见', (await s.js(`return !document.querySelector('.fold-reason');`)) === true, solveWho);
await s.js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true}));`);
await sleep(500);
check('做题模式：空格显示答案', (await s.js(`return !!document.querySelector('.rv-revealed');`)) === true);
check('做题模式：展开后能看到「错因分析」', (await s.js(`return !!document.querySelector('.fold-reason');`)) === true);
await s.shot('12-solve');

await s.js(`document.querySelector('[data-solve="record"][data-result="失败"]').click();`);
await sleep(500);
check('做题模式：点「失败」弹出错因选择器', (await s.js(`return !!document.querySelector('.reason-picker');`)) === true);
await s.shot('13-reason');
await s.js(`document.querySelector('.rp-chips [data-reason="计算失误"]').click();`);
await sleep(1500);
const afterReason = await (await fetch(`${APP}/api/questions`)).json();
const solved = afterReason.problems.find((x) => x.num === solveWho);
check('做题模式：错因写进打卡记录', !!solved && solved.checkins.some((c) => c.reason === '计算失误'), solved ? solved.num : 'NO');
check('做题模式：用时也记下了', !!solved && solved.checkins.some((c) => c.seconds > 0));

await s.js(`location.hash='#library';`);
await sleep(900);
await s.click('.problem-card');
await s.waitFor('#drawerPanel [data-reason-select]');
await s.js(
  `var sel=document.querySelector('[data-reason-select]'); sel.value='概念不清';
   sel.dispatchEvent(new Event('change',{bubbles:true}));`
);
await sleep(1500);
const afterFirst = await (await fetch(`${APP}/api/questions`)).json();
check(
  '详情：首次错因可写入',
  afterFirst.problems.some((x) => x.firstReason === '概念不清'),
  afterFirst.problems.filter((x) => x.firstReason).map((x) => `${x.num}=${x.firstReason}`).join(' ')
);
await s.click('[data-close-drawer]');

/* ---------- 5.5 考点标签 ---------- */
await s.click('.problem-card');
await s.waitFor('#drawerPanel .points-panel');
const pts = await s.js(
  `return [...document.querySelectorAll('#drawerPanel .point-chip')].map(x=>x.firstChild.textContent.trim());`
);
check('详情：显示考点标签', pts.length > 0, pts.join(' / '));
await s.js(
  `var i=document.getElementById('pointInput'); i.value='E2E测试考点';
   i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));`
);
await sleep(1400);
const pts2 = await s.js(
  `return [...document.querySelectorAll('#drawerPanel .point-chip')].map(x=>x.firstChild.textContent.trim());`
);
check('详情：回车能新增考点标签', pts2.includes('E2E测试考点'), pts2.join(' / '));
await s.click('[data-close-drawer]');

/* ---------- 6. 复习：换范围 + 混刷 ---------- */
await s.js(`document.querySelector('.tab[data-view="review"]').click();`);
await s.waitFor('.rv-setup');
const quickChips = await s.js(
  `return [...document.querySelectorAll('[data-scope="reset"],[data-scope2="subject"]')].map(x=>x.textContent.trim());`
);
check(
  '复习：有「全部混刷」与按科目快捷筹码',
  quickChips.some((t) => t.includes('全部混刷')) && quickChips.some((t) => t.includes('高数')),
  `${quickChips.length} 个`
);
await s.shot('05-review-setup');

await s.js(`document.querySelector('[data-scope="reset"]').click();`);
await sleep(800);
const poolAll = await s.js(`return document.querySelector('.rv-pool')?.textContent.trim();`);
check('复习：全部混刷可选 10 题', poolAll === '10 题', poolAll || '(空)');

await s.js(`[...document.querySelectorAll('[data-scope="category"]')].find(x=>x.dataset.value==='408').click();`);
await sleep(800);
const disabled = await s.js(`return document.querySelector('[data-review="start"]').disabled;`);
check('复习：切到 408（0 题）开始按钮禁用', disabled === true);

await s.js(`[...document.querySelectorAll('[data-scope="category"]')].find(x=>x.dataset.value==='数学').click();`);
await sleep(700);
await s.js(`[...document.querySelectorAll('[data-scope2="subject"]')].find(x=>x.dataset.value2==='高数').click();`);
await sleep(800);
const chChips = await s.js(`return [...document.querySelectorAll('[data-rv-chapter]')].map(x=>x.textContent.trim());`);
check(
  '复习：章节多选清单跟随范围',
  chChips.some((t) => t.includes('极限')) && chChips.some((t) => t.includes('函数')),
  chChips.join(' / ')
);

await s.js(
  `[...document.querySelectorAll('[data-rv-chapter]')].find(x=>x.dataset.rvChapter.includes('极限')).click();`
);
await sleep(600);
const poolLim = await s.js(`return document.querySelector('.rv-pool')?.textContent.trim();`);
check('复习：只勾「极限」→ 8 题', poolLim === '8 题', poolLim || '(空)');
await s.shot('06-review-scoped');

await s.js(`document.querySelector('[data-rv-count="5"]').click();`);
await sleep(400);
await s.js(`document.querySelector('[data-review="start"]').click();`);
await s.waitFor('.rv-card');
const firstNum = await s.js(`return document.querySelector('.rv-num').textContent.trim();`);
check('复习：进入答题页，答案隐藏', (await s.js(`return !document.querySelector('.rv-revealed');`)) === true, firstNum);
await s.js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true}));`);
await sleep(400);
check('复习：空格显示答案', (await s.js(`return !!document.querySelector('.rv-revealed');`)) === true);
await s.shot('07-review-run');
await s.js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'1',bubbles:true}));`);
await sleep(700);
const secondNum = await s.js(`return document.querySelector('.rv-num').textContent.trim();`);
check('复习：按 1 记结果并翻页', secondNum !== firstNum, `${firstNum} → ${secondNum}`);

// 把本局剩下的题答完（本局 5 题，已答 1 题）
for (let i = 0; i < 8; i++) {
  if (await s.js(`return !!document.querySelector('.rv-setup');`)) break;
  await s.js(`document.querySelector('[data-review="reveal"]')?.click();`);
  await sleep(350);
  await s.js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'2',bubbles:true}));`);
  await sleep(500);
  await s.js(`document.querySelector('.rp-foot [data-reason]')?.click();`);
  await sleep(700);
}
await s.waitFor('.rv-setup');
const doneTitle = await s.js(`return document.querySelector('.rv-setup-head h2').textContent.trim();`);
check('复习：一局结束出成绩单', doneTitle.includes('本局结束'), doneTitle);
const rows = await s.js(`return document.querySelectorAll('table.data tbody tr').length;`);
check('复习：逐题结果 5 行', rows === 5, `${rows} 行`);
await s.shot('08-review-done');

const apiStats = await (await fetch(`${APP}/api/stats`)).json();
// 本局 5 次 + 预置的那 1 次（用来制造「遗忘曲线到期」）
check('复习：打卡确实写回文件', apiStats.totals.checkins === 7, `累计打卡 ${apiStats.totals.checkins} 次`);

/* ---------- 6.5 遗忘曲线 + 用时分析 ---------- */
const detail = await (await fetch(`${APP}/api/stats`)).json();
check(
  '遗忘曲线：刚做完完美的题进入「完成」并排了下一次',
  detail.totals.done >= 1,
  `完成 ${detail.totals.done} 题`
);

await s.js(`document.querySelector('.tab[data-view="dashboard"]').click();`);
await sleep(1200);
const duePanel = await s.js(
  `return [...document.querySelectorAll('.panel-head h3')].map(x=>x.textContent.trim()).join(' | ');`
);
check('总览：出现「遗忘曲线提醒」面板（测试数据里有到期的题）', duePanel.includes('遗忘曲线提醒'), duePanel.slice(0, 120));
check('总览：出现「考点薄弱排行」面板', duePanel.includes('考点薄弱排行'));
check('总览：出现「错因分布」面板', duePanel.includes('错因分布'), duePanel.slice(0, 170));
await s.shot('11-insights');

const q1 = await (await fetch(`${APP}/api/questions`)).json();
const timed = q1.problems.find((p) => p.checkins.some((c) => c.done && c.seconds > 0));
check('用时：打卡记录带上了秒数', !!timed, timed ? `${timed.num} → ${timed.checkins.find((c) => c.seconds > 0).seconds}s` : '没找到');

/* ---------- 7. 增题页 ---------- */
await s.js(`document.querySelector('.tab[data-view="add"]').click();`);
await s.waitFor('#addStem');
await s.js(
  `var t=document.getElementById('addStem');
   t.value='计算 $\\\\lim_{x\\\\to 0}\\\\dfrac{\\\\tan x - x}{x^{3}}$\\n---\\n简述进程调度算法中的时间片轮转法';
   t.dispatchEvent(new Event('input',{bubbles:true}));`
);
await s.js(`document.querySelector('[data-add="parse"]').click();`);
await sleep(1000);
const items = await s.js(
  `return [...document.querySelectorAll('.add-item')].map(n=>({
     cat:n.querySelector('[data-field="category"]').value,
     sub:n.querySelector('[data-field="subject"]').value,
     ch:n.querySelector('[data-field="chapter"]').value }));`
);
check('增题：识别出 2 道题', items.length === 2, `${items.length} 道`);
check(
  '增题：第一题归到 数学/高数/极限',
  items[0]?.cat === '数学' && items[0]?.sub === '高数' && items[0]?.ch === '极限',
  JSON.stringify(items[0])
);
check('增题：第二题归到 408/操作系统', items[1]?.cat === '408' && items[1]?.sub === '操作系统', JSON.stringify(items[1]));
await s.shot('09-add');

// 图片：造一张 PNG 传上去
await s.js(
  `var c=document.createElement('canvas'); c.width=80; c.height=40;
   var g=c.getContext('2d'); g.fillStyle='#fff'; g.fillRect(0,0,80,40);
   g.fillStyle='#000'; g.fillText('E2E',10,25);
   window.__png = c.toDataURL('image/png');`
);
const dataUrl = await s.js(`return window.__png;`);
const up = await api2('/api/upload', { method: 'POST', body: JSON.stringify({ name: 'e2e题目.png', dataUrl }) });
check('图片：上传成功', !!up.name, up.name);
await s.js(`location.hash='#add';`);
await sleep(1400);
const thumbs = await s.js(`return document.querySelectorAll('.upload-item img').length;`);
check('图片：缩略图显示在增题页', thumbs >= 1, `${thumbs} 张`);
check('图片：「生成提示词」按钮已可用', (await s.js(`return !document.querySelector('[data-add="prompt-images"]').disabled;`)) === true);
await s.shot('14-upload');
const promptOut = await api2('/api/prompt-images', {
  method: 'POST',
  body: JSON.stringify({ names: [up.name], reason: '计算失误' }),
});
check(
  '图片：提示词强调「不要原图、要重画」',
  promptOut.prompt.includes('不要把我上传的原图直接放进笔记') && promptOut.prompt.includes('重新画一张'),
  `${promptOut.prompt.length} 字`
);
await api2('/api/uploads', { method: 'DELETE', body: JSON.stringify({}) });

const before = (await (await fetch(`${APP}/api/questions`)).json()).problems.length;
await s.js(`document.querySelector('[data-add="create"]').click();`);
await sleep(1800);
const afterDoc = await (await fetch(`${APP}/api/questions`)).json();
check('增题：写盘成功（10 → 12 题）', before === 10 && afterDoc.problems.length === 12, `${before} → ${afterDoc.problems.length}`);
const os8 = afterDoc.tree.find((c) => c.name === '408');
check('增题：408 / 操作系统 目录已自动创建', !!os8 && os8.total === 1, os8 ? `408 共 ${os8.total} 题` : '没有 408');
const newFile = afterDoc.problems.find((p) => p.category === '408');
check('增题：新题可被解析并带完整骨架', !!newFile && newFile.warnings.length === 0, newFile ? newFile.relPath : 'NO');

/* ---------- 8. 主题 ---------- */
await s.js(`document.documentElement.dataset.theme='light'; location.hash='';`);
await sleep(800);
await s.shot('10-light');
check('浅色主题', (await s.js(`return document.documentElement.dataset.theme;`)) === 'light');

const failed = results.filter((r) => !r.ok);
console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log('  ❌', f.label);
  process.exitCode = 1;
}
ws.close();
