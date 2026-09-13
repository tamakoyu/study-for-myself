/**
 * test/e2e.mjs —— 用无头 Edge 真实点一遍界面（零第三方依赖）
 *
 * ⚠️ 这个测试是「有状态」的：它会打卡、建题、改计划。**每跑一次都要先把副本重新复制一份**，
 *    否则第二次跑必然失败（数据已经变了）。
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
    // 等不到就把现场打出来，方便定位
    const diag = await this.js(
      `return JSON.stringify({
         url: location.href,
         head: (document.getElementById('main') || {}).innerHTML ? document.getElementById('main').innerHTML.slice(0, 300) : '(空)',
         toasts: [...document.querySelectorAll('.toast')].map(t=>t.textContent)
       });`
    );
    throw new Error(`等不到元素：${sel}\n  现场：${diag}`);
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

/* ---------- 0. 今日首页 ---------- */
// 加时间戳强制整页重载，否则只换 hash 会带上一次运行残留的状态
await s.js(`location.replace(${JSON.stringify(APP + '/?t=')} + Date.now() + '#today');`);
await sleep(2000);
await s.waitFor('.countdown-card');
const cdDays = await s.js(`return document.querySelector('.cd-days')?.textContent.trim() || '';`);
const cdExpect = Math.round((new Date('2027-12-18T00:00:00') - new Date(new Date().toDateString())) / 86400000);
check('今日：考研倒计时', cdDays.startsWith(String(cdExpect)), `显示 ${cdDays}，应为 ${cdExpect} 天`);
const todayTaskCount = await s.js(`return document.querySelectorAll('.task-list input[data-task]').length;`);
check('今日：列出今日与本周待办', todayTaskCount >= 1, `${todayTaskCount} 条`);
const progRows = await s.js(
  `return [...document.querySelectorAll('.prog-row')].map(r=>r.textContent.replace(/\\s+/g,' ').trim());`
);
check(
  '今日：本月进度不为 0（按当月周计划汇总）',
  progRows.some((r) => r.includes('本月完成') && !/本月完成 0\/0/.test(r) && !r.includes('0/0')),
  progRows.join(' ｜ ')
);
const dayCells = await s.js(`return document.querySelectorAll('.day-cell').length;`);
check('今日：本周 7 天进度条', dayCells === 7, `${dayCells} 格`);
const weeklyBox = await s.js(
  `var p=document.querySelector('.weekly'); return p ? p.querySelector('.panel-head h3').textContent.trim() : '';`
);
check('今日：有「本周状态与建议」面板', weeklyBox.includes('本周状态与建议'), weeklyBox || '(没有)');
check('今日：有生成提示词按钮', (await s.js(`return !!document.querySelector('[data-weekly-prompt]');`)) === true);
const weekly = await api2('/api/weekly');
check(
  '本周总结：提示词带上了计划、复盘与错题数据',
  weekly.prompt.includes('本周事实') && weekly.prompt.includes('这一周的每日复盘') && weekly.prompt.includes('错题情况') &&
    weekly.prompt.includes('本周状态与建议'),
  `${weekly.prompt.length} 字，收集 ${weekly.reviewCount} 篇复盘`
);

const todayStats = await s.js(`return [...document.querySelectorAll('.stat-card .stat-label')].map(x=>x.textContent.trim()).join(' | ');`);
check(
  '今日：四张统计卡（今日完成 / 本周 / 错题 / 连续打卡）',
  todayStats.includes('今日完成') && todayStats.includes('本周完成率') && todayStats.includes('错题待复习') && todayStats.includes('连续打卡'),
  todayStats
);
await s.shot('15-today');

// 勾一条今日任务 → 应写回 Obsidian
const planPath = '考研/2026-09/2026-09-第2周-周计划.md';
const beforePlan = await (await fetch(`${APP}/api/plan?rel=${encodeURIComponent(planPath)}`)).json();
const undoneTask = beforePlan.groups.flatMap((g) => g.tasks).find((x) => !x.done);
await s.js(`document.querySelectorAll('.task-list input[data-task]')[0].click();`);
await sleep(1600);
const afterPlan = await (await fetch(`${APP}/api/plan?rel=${encodeURIComponent(planPath)}`)).json();
const nowDone = afterPlan.groups.flatMap((g) => g.tasks).filter((x) => x.done).length;
check('今日：勾选任务写回 Obsidian', nowDone === beforePlan.done + 1, `${beforePlan.done} → ${nowDone} 已完成`);
check('今日：写回带上了完成日期', afterPlan.groups.flatMap((g) => g.tasks).some((x) => x.doneDate === new Date().toISOString().slice(0, 10)));
// 再点一次取消
await s.js(`document.querySelectorAll('.task-list input[data-task]')[0].click();`);
await sleep(1600);
const reverted = await (await fetch(`${APP}/api/plan?rel=${encodeURIComponent(planPath)}`)).json();
check('今日：再点一次可取消勾选', reverted.done === beforePlan.done, `${reverted.done} 项已完成`);

/* ---------- 0.5 计划页 ---------- */
await s.js(`document.querySelector('.tab[data-module="plan"]').click();`);
await sleep(1800);
await s.waitFor('.plan-link');
const planLinks = await s.js(`return document.querySelectorAll('.plan-link').length;`);
check('计划：列出周/月计划', planLinks >= 10, `${planLinks} 项`);
const weekIdx = await s.js(
  `return [...document.querySelectorAll('.plan-link')].findIndex(x=>!x.textContent.includes('月计划'));`
);
await s.js(`document.querySelectorAll('.plan-link')[${weekIdx}].click();`);
await sleep(1500);
const planGroups = await s.js(`return document.querySelectorAll('.plan-group').length;`);
check('计划：详情按科目分组渲染', planGroups >= 3, `${planGroups} 组`);
const planBoxes = await s.js(`return document.querySelectorAll('.plan-body input[data-task]').length;`);
check('计划：渲染出可勾选的任务', planBoxes >= 5, `${planBoxes} 个复选框`);
const monthOrder = await s.js(
  `return [...document.querySelectorAll('.plan-month .pm-head span')].map(x=>x.textContent.trim());`
);
const curMonth = new Date().toISOString().slice(0, 7);
check('计划：当月排在最前面', monthOrder[0] === curMonth, monthOrder.slice(0, 4).join(' → '));
await s.shot('16-plan');

/* ---------- 0.7 复盘页 ---------- */
await s.js(`document.querySelector('.tab[data-module="journal"]').click();`);
await sleep(1800);
await s.waitFor('.journal-edit');
const jPath = await s.js(`return document.querySelector('.plan-meta code')?.textContent.trim() || '';`);
check('复盘：路径按日期自动归档', /^复盘\/26\.9\/第[一二三四五]周\/9\.\d+复盘\.md$/.test(jPath), jPath);
await s.js(
  `var ta=document.getElementById('journalText');
   ta.value='## E2E 测试' + String.fromCharCode(10) + String.fromCharCode(10) + '今天把 study 首页做完了。';
   ta.dispatchEvent(new Event('input',{bubbles:true}));`
);
await s.js(`document.querySelector('[data-journal-save]').click();`);
await sleep(1800);
const jRead = await (await fetch(`${APP}/api/review?date=${new Date().toISOString().slice(0,10)}`)).json();
check('复盘：保存后文件已生成', jRead.exists && jRead.content.includes('E2E 测试'), jRead.rel);
await s.shot('18-journal');

// 切到前一天
const beforeDate = await s.js(`return document.getElementById('journalDate').value;`);
await s.js(`document.querySelector('[data-journal-move="-1"]').click();`);
await sleep(1500);
const prevDate = await s.js(`return document.getElementById('journalDate').value;`);
check('复盘：能切到前一天', prevDate < beforeDate, `${beforeDate} → ${prevDate}`);
const prevPath = await s.js(`return document.querySelector('.plan-meta code')?.textContent.trim() || '';`);
check('复盘：路径跟着日期变', prevPath !== jPath && prevPath.endsWith('复盘.md'), prevPath);
await s.js(`document.querySelector('[data-journal-move="0"]').click();`);
await sleep(1400);
const backToday = await s.js(`return document.getElementById('journalDate').value;`);
check('复盘：能一键回今天', backToday === beforeDate, backToday);
const jItems = await s.js(`return document.querySelectorAll('.j-item[data-journal]').length;`);
check('复盘：左侧历史按月份平铺', jItems >= 5 && (await s.js(`return document.querySelectorAll('.j-month').length;`)) >= 1, `${jItems} 篇`);
const jMonths = await s.js(`return [...document.querySelectorAll('.j-month .pm-head span')].map(x=>x.textContent.trim()).join(' / ');`);
check('复盘：按月份分组', /\d{4}-\d{2}/.test(jMonths), jMonths);
// 直接点历史里的一天
const firstItem = await s.js(
  `var b=document.querySelector('.j-item[data-journal]'); return b ? b.dataset.journal : '';`
);
await s.js(`document.querySelector('.j-item[data-journal]').click();`);
await sleep(1600);
const afterClick = await s.js(`return document.getElementById('journalDate').value;`);
check('复盘：直接点历史条目就能切过去', afterClick === firstItem, `${afterClick}（点了 ${firstItem}）`);

/* ---------- 0.8 好题本 ---------- */
await s.js(`document.querySelector('.tab[data-module="good"]').click();`);
await sleep(1800);
const goodTabs = await s.js(`return [...document.querySelectorAll('.tab')].map(x=>x.textContent.trim()).join('/');`);
check('顶栏：好题与题型模块已加入', goodTabs.includes('好题') && goodTabs.includes('题型'), goodTabs);
const goodSubs = await s.js(`return [...document.querySelectorAll('.subtab')].map(x=>x.textContent.trim()).join('/');`);
check('好题本：与错题本同一套子页面', goodSubs === '总览/题库/复习/增题', goodSubs);
check('好题本：目前为空（还没有好题）', (await s.js(`return !!document.querySelector('.empty-row, .category-grid, .problem-card');`)) === true);
await s.shot('19-good');

/* ---------- 0.9 题型大全 ---------- */
await s.js(`document.querySelector('.tab[data-module="patterns"]').click();`);
await sleep(2000);
await s.waitFor('.pattern-card');
const ptCount = await s.js(`return document.querySelectorAll('.pattern-card').length;`);
check('题型：通解卡片已渲染', ptCount >= 5, `${ptCount} 个题型`);
const ptStats = await s.js(
  `return [...document.querySelectorAll('.pattern-head .stat-label')].map(x=>x.textContent.trim()).join('/');`
);
check('题型：四张统计卡（题型数/掌握度/已归类/未归类）', ptStats.includes('题型数') && ptStats.includes('平均掌握度'), ptStats);
// 展开一个通解看关联题目
await s.js(`document.querySelector('[data-pattern-toggle]').click();`);
await sleep(800);
const relChips = await s.js(`return document.querySelectorAll('.rel-chip').length;`);
check('题型：展开后能看到关联的错题/好题', relChips >= 1, `${relChips} 道关联题目`);
const hasSteps = await s.js(`return (document.querySelector('.pp-body')?.textContent || '').includes('通解步骤');`);
check('题型：通解正文（适用特征/步骤/易错点）已渲染', hasSteps === true);
check('题型：题目已全部归类，生成按钮转为禁用', (await s.js(`return document.querySelector('[data-pattern-prompt]').disabled;`)) === true);
await s.shot('20-patterns');
const pt = await api2('/api/patterns');
check(
  '题型：每道题都归到了某个通解',
  pt.unlinkedCount === 0 && pt.patterns.every((x) => x.related.length > 0),
  `${pt.patterns.length} 个通解，未归类 ${pt.unlinkedCount}`
);
const ptPrompt = await api2('/api/pattern-prompt');
check(
  '题型：提示词包含已有通解与归类要求',
  ptPrompt.prompt.includes('已有的通解') && ptPrompt.prompt.includes('同一题型只允许一份通解'),
  `${ptPrompt.prompt.length} 字`
);

/* ---------- 1. 错题模块：先造一道「遗忘曲线到期」的题 ---------- */
// 用 3 天前做「完美」的方式，让间隔 1 天的排期立刻到期（不依赖外部预置数据）
const seedList = await (await fetch(`${APP}/api/questions`)).json();
const seedTarget = seedList.problems.find((x) => x.chapter === '函数');
const back3 = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
await api2('/api/checkin', {
  method: 'POST',
  body: JSON.stringify({ id: seedTarget.id, result: '完美', date: back3, seconds: 180 }),
});
await sleep(600);

await s.js(`document.querySelector('.tab[data-module="mistakes"]').click();`);
await sleep(1600);
await s.waitFor('.category-grid');
const tabNames = await s.js(`return [...document.querySelectorAll('.tab')].map(x=>x.textContent.trim()).join('/');`);
check('顶栏：笔记模块已移除', !tabNames.includes('笔记') && tabNames.includes('复盘'), tabNames);
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
await s.js(`document.querySelector('.subtab[data-sub="library"]').click();`);
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

await s.js(`location.hash='#mistakes/library';`);
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
await s.js(`document.querySelector('.subtab[data-sub="drill"]').click();`);
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

// 回到全库范围的总览，才能看到「函数」那道到期题
await s.js(`location.hash='#mistakes/dashboard';`);
await sleep(1800);
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
await s.js(`document.querySelector('.subtab[data-sub="add"]').click();`);
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
await s.js(`document.querySelector('.subtab[data-sub="dashboard"]').click();`);
await sleep(600);
await s.js(`document.querySelector('.subtab[data-sub="add"]').click();`);
await sleep(1800);
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

/* ---------- 7.5 还原被改动的计划文件 ---------- */
const finalPlan = await (await fetch(`${APP}/api/plan?rel=${encodeURIComponent(planPath)}`)).json();
const extra = finalPlan.groups.flatMap((g) => g.tasks).filter((x) => x.done && !x.doneDate);
check('计划：测试期间没有留下脏数据', finalPlan.done === beforePlan.done, `完成数 ${finalPlan.done}（原 ${beforePlan.done}）`);

/* ---------- 8. 主题 ---------- */
await s.js(`document.documentElement.dataset.theme='light'; location.hash='#today';`);
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
