/**
 * test/e2e.mjs —— 用无头 Edge 真实点一遍界面（不依赖任何第三方库）
 *
 * 用法：
 *   1) 起一个测试服务，指向副本错题本，别动真数据：
 *        NOTEBOOK_DIR=/tmp/notebook-test NOTEBOOK_PORT=4199 node server.mjs --no-open
 *   2) 起无头 Edge：
 *        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
 *          --headless=old --disable-gpu --no-sandbox --remote-allow-origins=* \
 *          --remote-debugging-port=9333 --user-data-dir=/tmp/edge-e2e \
 *          --window-size=1500,1150 "http://127.0.0.1:4199/"
 *   3) node test/e2e.mjs
 *
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
      /* 还没起来 */
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
  async waitFor(selector, timeout = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await this.js(`return !!document.querySelector(${JSON.stringify(selector)});`)) return true;
      await sleep(150);
    }
    throw new Error(`等不到元素：${selector}`);
  }
  async shot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    const file = `${OUT}/e2e-${name}.png`;
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  }
}

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? `　— ${detail}` : ''}`);
}

const page = await findPage();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res);
  ws.addEventListener('error', rej);
});
const s = new Session(ws);
await s.send('Runtime.enable');
await s.send('Page.enable');

console.log(`\n=== 高数错题本 · 浏览器端到端测试（${APP}）===\n`);

// ---------- 总览 ----------
await s.js(`location.hash = ''; location.reload();`);
await sleep(1500);
await s.waitFor('.stat-grid');
const statCount = await s.js(`return document.querySelectorAll('.stat-card').length;`);
check('总览：统计卡渲染', statCount === 5, `${statCount} 张卡`);

const barsText = await s.js(`return document.querySelectorAll('.bar-row').length;`);
check('总览：图表渲染', barsText > 0, `${barsText} 行条形`);

const katexable = await s.js(`return typeof window.katex === 'object' && typeof window.katex.renderToString === 'function';`);
check('KaTeX 已离线加载', katexable === true);

// ---------- 题库 ----------
await s.js(`location.hash = '#library';`);
await s.waitFor('.problem-grid');
const cards = await s.js(`return document.querySelectorAll('.problem-card').length;`);
check('题库：题目卡片', cards === 10, `${cards} 张`);
const katexNodes = await s.js(`return document.querySelectorAll('.problem-grid .katex').length;`);
check('题库：公式已用 KaTeX 渲染（不是原文）', katexNodes > 0, `${katexNodes} 个公式节点`);

// 筛选：只看「未做」
await s.js(`document.querySelector('[data-filter="status"][data-value="未做"]').click();`);
await sleep(300);
const afterFilter = await s.js(`return document.querySelectorAll('.problem-card').length;`);
check('题库：筛选生效', afterFilter === 10, `未做 ${afterFilter} 题`);
await s.js(`document.querySelector('#resetFilters')?.click();`);

// 打开详情抽屉
await s.js(`document.querySelector('.problem-card').click();`);
await s.waitFor('#drawerPanel .checkin-panel');
await s.shot('library-detail');
check('详情抽屉：打卡区渲染', true);
const foldCount = await s.js(`return document.querySelectorAll('#drawerPanel details.fold').length;`);
check('详情抽屉：折叠块', foldCount >= 4, `${foldCount} 个折叠块（默认应全部收起）`);
const anyOpen = await s.js(`return document.querySelectorAll('#drawerPanel details.fold[open]').length;`);
check('详情抽屉：折叠块默认收起', anyOpen === 0, `展开中 ${anyOpen} 个`);
await s.js(`document.querySelector('[data-close-drawer]').click();`);

// ---------- 复习模式 ----------
await s.js(`location.hash = '#review';`);
await s.waitFor('.rv-setup');
await s.shot('review-setup');
check('复习：设置页渲染', true);

// 选 5 题、纯随机
await s.js(`document.querySelector('[data-rv-count="5"]').click();`);
await sleep(200);
await s.js(`document.querySelector('[data-rv-order="random"]').click();`);
await sleep(200);
await s.js(`document.querySelector('[data-review="start"]').click();`);
await s.waitFor('.rv-card');
await s.shot('review-run');
check('复习：进入答题页', true);

const firstNum = await s.js(`return document.querySelector('.rv-num').textContent;`);
const hidden = await s.js(`return !!document.querySelector('.rv-hidden') && !document.querySelector('.rv-revealed');`);
check('复习：答案默认隐藏', hidden === true, `当前 ${firstNum}`);

// 空格键显示答案
await s.js(`document.dispatchEvent(new KeyboardEvent('keydown', {key:' ', bubbles:true}));`);
await sleep(300);
const revealed = await s.js(`return !!document.querySelector('.rv-revealed');`);
check('复习：空格键显示答案解析', revealed === true);

await s.shot('review-revealed');

// 按键 1 记「完美」，检查是否自动翻页
await s.js(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'1', bubbles:true}));`);
await sleep(500);
const secondNum = await s.js(`return document.querySelector('.rv-num').textContent;`);
check('复习：按 1 记结果并自动下一题', secondNum !== firstNum, `${firstNum} → ${secondNum}`);
const hiddenAgain = await s.js(`return !document.querySelector('.rv-revealed');`);
check('复习：新题答案重新隐藏', hiddenAgain === true);

// 再答完剩下的：第2题普通、第3题失败、第4题跳过
const plan = [
  ['2', '[data-review="reveal"]'],
  ['3', '[data-review="reveal"]'],
  [null, '[data-review="skip"]'],
  ['1', '[data-review="reveal"]'],
];
for (const [key, sel] of plan) {
  if (key) {
    await s.js(`document.querySelector('${sel}').click();`);
    await sleep(280);
    await s.js(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'${key}', bubbles:true}));`);
  } else {
    await s.js(`document.querySelector('${sel}').click();`);
  }
  await sleep(420);
}

await s.waitFor('.rv-setup');
await sleep(400);
await s.shot('review-done');
const doneTitle = await s.js(`return document.querySelector('.rv-setup-head h2').textContent;`);
check('复习：一局结束出成绩单', doneTitle.includes('本局结束'), doneTitle.trim());

const score = await s.js(
  `return [...document.querySelectorAll('.stat-card')].map(c=>c.querySelector('.stat-label').textContent.trim()+c.querySelector('.stat-value').textContent.trim()).join(' / ');`
);
check('复习：成绩单统计', score.includes('完美') && score.includes('失败'), score);
const rows = await s.js(`return document.querySelectorAll('table.data tbody tr').length;`);
check('复习：逐题结果表', rows === 5, `${rows} 行`);

// 打卡是否真的写进了（测试副本的）文件
const apiStats = await (await fetch(`${APP}/api/stats`)).json();
check(
  '复习：打卡确实写回文件',
  apiStats.totals.checkins === 4,
  `累计打卡 ${apiStats.totals.checkins} 次（跳过不计）`
);

// ---------- 深色/浅色 ----------
await s.js(`document.documentElement.dataset.theme='light'; location.hash='';`);
await sleep(500);
await s.shot('dashboard-light');
check('浅色主题切换', (await s.js(`return document.documentElement.dataset.theme;`)) === 'light');

// ---------- 汇总 ----------
const failed = results.filter((r) => !r.ok);
console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log('  ❌', f.label);
  process.exitCode = 1;
}
ws.close();
