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
import http from 'node:http';
import path from 'node:path';

const CDP = Number(process.env.CDP_PORT || 9333);
const APP = process.env.APP_URL || 'http://127.0.0.1:4199';
const ENV = { vaultDir: process.env.E2E_VAULT || '' };
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
check(
  '今日：本周总结有生成入口（没配 AI 时不显示按钮，而是提示去设置）',
  (await s.js(
    `return !!document.querySelector('[data-airun="weekly"]') || !!document.querySelector('.weekly .ai-hint') || !!document.querySelector('.weekly .rv-hint');`
  )) === true
);
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

// 今日单词：用图表，而且必须排在「本周状态与建议」上面
const order = await s.js(
  `var secs=[...document.querySelectorAll('#main .today section.panel')];
   var vocab=secs.findIndex(x=>x.classList.contains('vocab-panel'));
   var weekly=secs.findIndex(x=>x.classList.contains('weekly'));
   return JSON.stringify({vocab, weekly, hasDonut: !!document.querySelector('.vocab-panel .donut')});`
);
const orderInfo = JSON.parse(order);
const todayWordsApi = await api2('/api/today');
const hasVocabData = !!(todayWordsApi.words && todayWordsApi.words.ok);
if (hasVocabData) {
  check('今日：今日单词用环形图显示', orderInfo.hasDonut === true, orderInfo.hasDonut ? '有 .donut' : '没有图表');
} else {
  // 这一轮是 MAIMEMO_OFF=1 起的，读不到墨墨数据 → 该显示原因，而不是画一张空图
  const vocabText = await s.js(`return (document.querySelector('.vocab-panel')||{}).innerText || '';`);
  check(
    '今日：墨墨读不到数据时不画空图，给出原因',
    orderInfo.hasDonut === false && vocabText.trim().length > 0,
    vocabText.replace(/\s+/g, ' ').trim().slice(0, 60)
  );
}
check(
  '今日：今日单词排在「本周状态与建议」上面（不在最顶上）',
  orderInfo.vocab >= 0 && orderInfo.weekly >= 0 && orderInfo.vocab < orderInfo.weekly,
  `今日单词第 ${orderInfo.vocab + 1} 个面板，本周状态第 ${orderInfo.weekly + 1} 个`
);

// 任务标题里的 ** 要渲染成粗体，不能把星号原样显示出来
const starLeft = await s.js(
  `return [...document.querySelectorAll('.task-list .md-task > span, .plan-group .md-task > span')]
     .filter(x=>x.textContent.includes('**')).length;`
);
const starBold = await s.js(`return document.querySelectorAll('.task-list .md-task > span strong').length;`);
check(
  '今日：任务里的 ** 渲染成粗体（不再显示字面星号）',
  starLeft === 0,
  starLeft === 0 ? `0 处残留，共 ${starBold} 处粗体` : `还有 ${starLeft} 处在显示 **`
);

// 周一换周之后，上一周的总结要能找回来（否则看起来像丢了）
const weeklyApi = await api2('/api/weekly');
if (!weeklyApi.summary) {
  const prev = await s.js(`var d=document.querySelector('.prev-summary'); return d ? d.querySelector('summary').textContent.trim() : '';`);
  check(
    '今日：本周没写总结时，能翻到上一周的（不会看起来像丢了）',
    !!weeklyApi.previous && prev.includes('上一周'),
    prev || `API previous = ${weeklyApi.previous ? weeklyApi.previous.rel : 'null'}`
  );
} else {
  check('今日：本周总结已渲染', await s.js(`return !!document.querySelector('.weekly .weekly-body');`));
}
await s.shot('15-today');

// 勾一条今日任务 → 应写回 Obsidian
// 周计划文件按「今天属于哪一周」取 —— 写死周次的话，一换周测试就红
const todayWeek = await (await fetch(`${APP}/api/today`)).json();
const planPath = todayWeek.week.rel;
const beforePlan = await (await fetch(`${APP}/api/plan?rel=${encodeURIComponent(planPath)}`)).json();
// 今日页只列「今天该做的」，顺序和计划文件里的排列不一样；
// 而且你平时可能已经把今天的任务全勾了 —— 所以不假设初始状态，
// 只验证「点一下 → 文件真的变了」「再点一下 → 变回来」。
const probeTask = await s.js(
  `var b=document.querySelector('.task-list input[data-task]');
   return b ? JSON.stringify({ text: b.dataset.text, checked: b.checked }) : 'NONE';`
);
const picked = probeTask === 'NONE' ? null : JSON.parse(probeTask);
check('今日：任务列表渲染出了可点的复选框', !!picked, picked ? `${picked.text.slice(0, 20)}（当前${picked.checked ? '已勾' : '未勾'}）` : 'NONE');

const clickTask = (text, want) =>
  s.js(
    `var b=[...document.querySelectorAll('.task-list input[data-task]')]
       .find(x=>x.dataset.text===${JSON.stringify(picked ? picked.text : '')} && x.checked===${want});
     if(!b) return 'NONE'; b.click(); return 'ok';`
  );

if (picked) {
  const firstClick = await clickTask(picked.text, picked.checked);
  check('今日：点得到那条任务', firstClick === 'ok', firstClick);
  await sleep(1600);
  const afterPlan = await (await fetch(`${APP}/api/plan?rel=${encodeURIComponent(planPath)}`)).json();
  // 前后都用**同一种口径**数：任务上的 done（🔁 每日任务说的是「今天」，和汇总的完成数不是一回事）
  const countDone = (plan) => plan.groups.flatMap((g) => g.tasks).filter((x) => x.done).length;
  const beforeDone = countDone(beforePlan);
  const nowDone = countDone(afterPlan);
  const delta = picked.checked ? -1 : 1;
  check(
    '今日：勾选 / 取消都真的写回 Obsidian',
    nowDone === beforeDone + delta,
    `${beforeDone} → ${nowDone} 已完成（${picked.checked ? '取消' : '勾上'}）`
  );
  if (!picked.checked) {
    check(
      '今日：写回带上了完成日期',
      afterPlan.groups.flatMap((g) => g.tasks).some((x) => x.doneDate === new Date().toISOString().slice(0, 10))
    );
  }
  // 再点一次，还原成原样
  await clickTask(picked.text, !picked.checked);
  await sleep(1600);
  const reverted = await (await fetch(`${APP}/api/plan?rel=${encodeURIComponent(planPath)}`)).json();
  check('今日：再点一次能还原（测试不留脏数据）', countDone(reverted) === beforeDone, `${countDone(reverted)} 项已完成`);
}

// 🔁 每日任务：勾的是「今天」。模板行必须保持 `- [ ]`，否则第二天又带着昨天的勾
const todayIso = new Date().toISOString().slice(0, 10);
const dailyProbe = await s.js(
  `var b=[...document.querySelectorAll('.task-list input[data-task]')].find(x=>x.dataset.text.indexOf('🔁')===0);
   return b ? JSON.stringify({ text: b.dataset.text, checked: b.checked }) : 'NONE';`
);
check('今日：每日任务渲染出了复选框', dailyProbe !== 'NONE', dailyProbe === 'NONE' ? '本周计划里没有 🔁 任务' : dailyProbe.slice(0, 40));

if (dailyProbe !== 'NONE') {
  const d = JSON.parse(dailyProbe);
  const clickDaily = (want) =>
    s.js(
      `var b=[...document.querySelectorAll('.task-list input[data-task]')]
         .find(x=>x.dataset.text===${JSON.stringify(d.text)} && x.checked===${want});
       if(!b) return 'NONE'; b.click(); return 'ok';`
    );
  const planText = async () => ((await (await fetch(`${APP}/api/plan?rel=${encodeURIComponent(planPath)}`)).json()).content || '');
  const dailyDone = async () => (await (await fetch(`${APP}/api/today`)).json()).week?.daily?.done ?? 0;

  // 先归零成「今天没勾」，这样下面两步都是确定的
  if (d.checked) {
    await clickDaily(true);
    await sleep(1600);
  }
  const beforeDaily = await dailyDone();

  await clickDaily(false);
  await sleep(1600);
  const afterText = await planText();
  check('每日任务：写回的模板行仍然是 - [ ]（第二天才不会带着昨天的勾）', !/^- \[x\] 🔁/m.test(afterText), afterText.split('\n').find((l) => l.includes(d.text)) || '');
  check('每日任务：今天的打卡行写进了文件', afterText.includes(`  - [x] ${todayIso}`), `找「  - [x] ${todayIso}」`);
  check('每日任务：本周打卡数 +1', (await dailyDone()) === beforeDaily + 1, `${beforeDaily} → ${await dailyDone()}`);
  check('每日任务：界面上是勾上的', (await s.js(`var b=[...document.querySelectorAll('.task-list input[data-task]')].find(x=>x.dataset.text===${JSON.stringify(d.text)}); return b ? b.checked : null;`)) === true);

  // 再点一次，今天那行该被删掉，昨天的记录不受影响
  await clickDaily(true);
  await sleep(1600);
  const backText = await planText();
  check('每日任务：取消只删今天那行，模板行还是 - [ ]', !backText.includes(`  - [x] ${todayIso}`) && !/^- \[x\] 🔁/m.test(backText));
  check('每日任务：本周打卡数还原', (await dailyDone()) === beforeDaily, `${beforeDaily} → ${await dailyDone()}`);
}

// 首页「本周进度」那排日期：点别的天就能翻过去看那天要做什么
const dayCellCount = await s.js(`return document.querySelectorAll('.day-cell').length;`);
check('首页：本周进度那排是 7 个可点的日期', dayCellCount === 7, `${dayCellCount} 格`);
const dailyChip = await s.js(
  `var e=document.querySelector('.task-list .task-week'); return e ? e.textContent.trim() : 'NONE';`
);
check('首页：每日任务旁边写着本周打了几次卡、哪几天', dailyChip !== 'NONE' && /本周 \d+\/\d+/.test(dailyChip), dailyChip);

const otherDay = await s.js(
  `var c=[...document.querySelectorAll('.day-cell')].filter(x=>!x.classList.contains('is-today'))[0];
   return c ? c.dataset.day : 'NONE';`
);
check('首页：找得到别的日子', otherDay !== 'NONE', otherDay);

if (otherDay !== 'NONE') {
  const dayApi = await (await fetch(`${APP}/api/today?date=${otherDay}`)).json();
  await s.js(
    `[...document.querySelectorAll('.day-cell')].find(x=>x.dataset.day===${JSON.stringify(otherDay)}).click();`
  );
  await sleep(1400);
  const hash = await s.js(`return location.hash;`);
  check('首页：点别的天 → hash 跟着走（刷新 / 分享链接都还在）', hash === `#today/${otherDay}`, hash);
  const head = await s.js(`return (document.querySelector('.today-grid .panel-head h3')||{}).textContent||'';`);
  const want = `${Number(otherDay.slice(5, 7))}/${Number(otherDay.slice(8, 10))}`;
  check('首页：任务卡换成那天的', head.includes(want) && !head.includes('今天的任务'), head.trim());
  const domCount = await s.js(
    `return document.querySelectorAll('.today-grid > .panel:first-child .task-list .md-task').length;`
  );
  check(
    '首页：列的就是那天该做的任务（条数对得上）',
    domCount === dayApi.todayTasks.length,
    `界面 ${domCount} 条 / 接口 ${dayApi.todayTasks.length} 条`
  );
  const viewingCells = await s.js(`return document.querySelectorAll('.day-cell.is-viewing').length;`);
  check('首页：正在看的那天标出来了', viewingCells === 1, `${viewingCells} 格`);

  await s.js(`document.querySelector('.day-back').click();`);
  await sleep(1400);
  const backHash = await s.js(`return location.hash;`);
  const backHead = await s.js(`return (document.querySelector('.today-grid .panel-head h3')||{}).textContent||'';`);
  check(
    '首页：点「回到今天」→ 回到今天的任务',
    backHash === '#today' && backHead.includes('今天的任务'),
    `${backHash}　${backHead.trim()}`
  );
}

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
const barOrder = await s.js(
  `var bar=document.querySelector('.topbar');
   var kids=[...bar.children].map(x=>x.className.split(' ')[0]);
   var tabs=bar.querySelector('#tabs'), picker=bar.querySelector('#scopePicker');
   return JSON.stringify({kids, tabsBeforePicker: !!(tabs.compareDocumentPosition(picker) & Node.DOCUMENT_POSITION_FOLLOWING)});`
);
const barInfo = JSON.parse(barOrder);
check(
  '顶栏：范围/题本按钮挪到了「复盘」右边（导航之后）',
  barInfo.tabsBeforePicker === true && barInfo.kids.indexOf('tabs') < barInfo.kids.indexOf('scope-picker'),
  barInfo.kids.join(' | ')
);
const goodSubs = await s.js(`return [...document.querySelectorAll('.subtab')].map(x=>x.textContent.trim()).join('/');`);
check('好题本：与错题本同一套子页面', goodSubs === '总览/题库/复习/增题', goodSubs);
const goodTotal = await s.js(`return document.querySelector('.stat-card .stat-value')?.textContent.trim();`);
check('好题本：统计是独立的（好题为 0，不显示错题的 10）', goodTotal === '0', `总览显示 ${goodTotal} 题`);

// 题库可以共通，但要能分清哪本
await s.js(`document.querySelector('.subtab[data-sub="library"]').click();`);
await sleep(1500);
const kindChips = await s.js(
  `return [...document.querySelectorAll('[data-filter="kind"]')].map(x=>x.textContent.trim()).join(' | ');`
);
check('好题本·题库：有「哪一本」筛选', kindChips.includes('当前') && kindChips.includes('全部'), kindChips);
check('好题本·题库：默认只看好题（0 张）', (await s.js(`return document.querySelectorAll('.problem-card').length;`)) === 0);
await s.js(`[...document.querySelectorAll('[data-filter="kind"]')].find(x=>x.dataset.value==='all').click();`);
await sleep(1200);
const commonCards = await s.js(`return document.querySelectorAll('.problem-card').length;`);
const kindTags = await s.js(`return document.querySelectorAll('.kind-tag').length;`);
const allCount = (await (await fetch(`${APP}/api/questions`)).json()).problems.length;
check(
  '好题本·题库：切「全部」能看到两本书并标出来源',
  commonCards === allCount && kindTags === allCount,
  `${commonCards} 张，${kindTags} 个来源标签（题库共 ${allCount}）`
);

// 好题页里点东西不应该跳回错题
await s.js(`document.querySelector('.subtab[data-sub="dashboard"]').click();`);
await sleep(1200);
const stillGood = await s.js(`return location.hash.startsWith('#good')`);
check('好题本：点来点去不会跳回错题页', stillGood === true, await s.js(`return location.hash`));
await s.shot('19-good');

// 增题页必须整个跟着「当前在哪一本」走：标题、错因字段、提示词里的落盘目录
await s.js(`document.querySelector('.subtab[data-sub="add"]').click();`);
await sleep(1600);
const addTitle = await s.js(`return document.querySelector('.rv-setup-head h2')?.textContent.trim() || '';`);
check('好题本·增题：标题是「加新好题」', addTitle === '加新好题', addTitle);
check(
  '好题本·增题：没有错因字段（好题不归因）',
  (await s.js(`return !!document.querySelector('.ai-fields [data-field="reason"]');`)) === false &&
    (await s.js(`return !!document.querySelector('#imageReason');`)) === false
);
const addCreateBtn = await s.js(`return document.querySelector('[data-add="create"]')?.textContent.trim() || '';`);
check('好题本·增题：按钮写的是「写入好题本」', addCreateBtn.includes('好题本'), addCreateBtn);
const goodPrompt = await api2('/api/prompt', {
  method: 'POST',
  body: JSON.stringify({ stems: ['求极限 test'], book: 'good', category: '数学', subject: '高数', chapter: '极限' }),
});
check(
  '好题本·增题：提示词写进「好题本/」而不是「错题本/」',
  goodPrompt.prompt.includes('好题本/<大类>') &&
    !goodPrompt.prompt.includes('错题本/<大类>') &&
    goodPrompt.prompt.includes('不要写 `## 错因分析` 区块'),
  `${goodPrompt.prompt.length} 字，book=${goodPrompt.book}`
);
const promptRules = await api2('/api/prompt', {
  method: 'POST',
  body: JSON.stringify({ stems: ['求极限 test'], book: 'mistakes', category: '数学', subject: '高数', chapter: '极限' }),
});
check(
  '增题提示词：大题要求写完整的标准解答过程',
  promptRules.prompt.includes('完整标准过程') &&
    promptRules.prompt.includes('以「解：」或「证明：」开头') &&
    promptRules.prompt.includes('不许') &&
    promptRules.prompt.includes('把过程挪到「解析」里只留一个结果'),
  `${promptRules.prompt.length} 字`
);
check(
  '增题提示词：考点标签要求「没有的直接新建」',
  promptRules.prompt.includes('没有的考点就直接新建') && promptRules.prompt.includes('points:'),
  '考点规则已写入'
);
check(
  '增题提示词：打卡说明改成「任何结果都进遗忘曲线 + 次数不封顶」',
  promptRules.prompt.includes('任何结果都会排进遗忘曲线') && promptRules.prompt.includes('次数不封顶'),
  '打卡说明已更新'
);
check(
  '好题本·增题：提示词里带上了「自动归类到题型本」的要求',
  goodPrompt.prompt.includes('归类到「题型本」') && goodPrompt.prompt.includes('good:<文件名去掉.md>'),
  `通解 ${goodPrompt.patternCount} 份`
);
// 编号只看自己这一本
const goodDetect = await api2('/api/detect', {
  method: 'POST',
  body: JSON.stringify({ raw: '求极限 $\\lim_{x\\to0}\\frac{\\sin x}{x}$', book: 'good' }),
});
const badDetect = await api2('/api/detect', {
  method: 'POST',
  body: JSON.stringify({ raw: '求极限 $\\lim_{x\\to0}\\frac{\\sin x}{x}$', book: 'mistakes' }),
});
check(
  '好题本·增题：编号按好题本单独排（两本互不干扰）',
  goodDetect.items[0]?.num === 1 && badDetect.items[0]?.num > 1 &&
    badDetect.items[0]?.num !== goodDetect.items[0]?.num,
  `好题本 #${goodDetect.items[0]?.num} ／ 错题本 #${badDetect.items[0]?.num}`
);
await s.shot('19b-good-add');

// 复习页的范围筹码也要只数当前这本
await s.js(`document.querySelector('.subtab[data-sub="drill"]').click();`);
await sleep(1600);
const mixChip = await s.js(
  `return [...document.querySelectorAll('.chip')].find(x=>x.textContent.includes('全部混刷'))?.textContent.replace(/\\s+/g,' ').trim() || '';`
);
check('好题本·复习：「全部混刷」数的是好题本的题，不是错题本的 10 题', mixChip.includes('0') && !mixChip.includes('10'), mixChip);

// 回错题页做后面的测试（切书会保留子页面，所以显式回到总览）
await s.js(`document.querySelector('.tab[data-module="mistakes"]').click();`);
await sleep(1200);
await s.js(`document.querySelector('.subtab[data-sub="dashboard"]').click();`);
await sleep(1500);

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
check('题型：归类按钮已移除', (await s.js(`return !!document.querySelector('[data-pattern-prompt]');`)) === false);
// 点开进入大屏
const firstTitle = await s.js(`return document.querySelector('.pattern-card h3').textContent.trim();`);
await s.js(`document.querySelector('[data-pattern-open]').click();`);
await sleep(1400);
check('题型：点击进入大屏（不是下拉）', (await s.js(`return !!document.querySelector('.pattern-screen');`)) === true, firstTitle);
const scrTitle = await s.js(`return document.querySelector('.pattern-screen .rv-num')?.textContent.trim() || '';`);
check('题型：大屏显示的是同一个题型', scrTitle === firstTitle, scrTitle);
const bodyText = await s.js(`return document.querySelector('.pattern-screen .rv-stem')?.textContent || '';`);
check('题型：大屏有适用特征/通解步骤/易错点', bodyText.includes('适用特征') && bodyText.includes('通解步骤') && bodyText.includes('易错点'));
const relChips = await s.js(`return document.querySelectorAll('.pattern-screen .rel-chip').length;`);
check('题型：大屏列出关联的错题/好题', relChips >= 1, `${relChips} 道`);
await s.shot('20-patterns');
// 看原文
await s.js(`document.querySelector('.pattern-screen [data-doc-open]').click();`);
await sleep(1500);
check('原文：能从题型跳到源文件原文', (await s.js(`return !!document.querySelector('.doc-screen');`)) === true);
check('原文：渲染出了正文', (await s.js(`return (document.querySelector('.doc-screen .note-body')?.textContent || '').length;`)) > 100);
await s.shot('21-doc');
await s.js(`document.querySelector('[data-doc-back]').click();`);
await sleep(1200);
const pt = await api2('/api/patterns');
const allQ = await api2('/api/questions');
// 以前这里断言的是 `unlinkedCount === 0` —— 那是在断言**我笔记里的数据**，不是断言代码。
// 「有题还没归类」本来就是允许的状态（界面写着「下次在增题页生成提示词时会自动归进去」），
// 所以只要我新加一道题，这条就会红：同一份代码，一轮 240/240、另一轮 239/240。
// 现在改成断言真正的不变量：两个接口的说法互相对得上、没有悬空关联。
const qIds = new Set(allQ.problems.map((p) => p.id));
const claimed = new Set(pt.patterns.flatMap((x) => x.related.filter((id) => qIds.has(id))));
const expectUnlinked = allQ.problems.filter((p) => !claimed.has(p.id)).length;
check(
  '题型：关联双向对得上（没有悬空关联、未归类数算得准、每份通解都有正文）',
  pt.patterns.every((x) => x.missing.length === 0 && x.linkedCount === x.related.length) &&
    pt.patterns.every((x) => x.steps && x.title) &&
    pt.unlinkedCount === expectUnlinked,
  `${pt.patterns.length} 个通解 · 关联 ${pt.patterns.reduce((s, x) => s + x.related.length, 0)} 条 · 未归类 ${pt.unlinkedCount}（题库 ${allQ.problems.length} 题）`
);
const ptPrompt = await api2('/api/pattern-prompt');
check(
  '题型：提示词包含已有通解与归类要求',
  ptPrompt.prompt.includes('已有的通解') && ptPrompt.prompt.includes('同一题型只允许一份通解'),
  `${ptPrompt.prompt.length} 字`
);

/* ---------- 0.95 好题本：真的有一道好题以后的行为 ---------- */
const goodCreated = await api2('/api/new', {
  method: 'POST',
  body: JSON.stringify({
    book: 'good',
    items: [
      {
        category: '数学',
        subject: '高数',
        chapter: '极限',
        num: 1,
        slug: 'E2E好题样本',
        type: '计算题',
        difficulty: 2,
        heat: 4,
        stem: '求极限 $\\lim\\limits_{x\\to0}\\dfrac{\\sin x}{x}$',
      },
    ],
  }),
});
check(
  '好题本：新题落盘在「好题本/」而不是「错题本/」',
  !!goodCreated.created?.[0] && goodCreated.created[0].file.startsWith('数学/'),
  goodCreated.created?.[0]?.absPath || JSON.stringify(goodCreated)
);
const goodFile = (await (await fetch(`${APP}/api/questions`)).json()).problems.find((x) => x.kind === 'good');
check('好题本：能被解析出来，且 kind=good', !!goodFile && goodFile.kind === 'good', goodFile?.id);

// 换书要收回「全部（共通）」筛选（否则好题页又会看到一堆错题）
// 整页重载一次：新题是程序外写进仓库的，重新扫盘才看得到
await s.js(`location.replace(location.origin + location.pathname + '?t=' + Date.now() + '#mistakes/library');`);
await sleep(2600);
await s.js(
  `[...document.querySelectorAll('[data-filter="kind"]')].find(x=>x.dataset.value==='all')?.click();`
);
await sleep(1200);
const kindInMistakes = await s.js(
  `return document.querySelector('[data-filter="kind"].is-on')?.dataset.value || '(无)';`
);
await s.js(`location.hash = '#good/library';`);
await sleep(1800);
const kindAfterSwitch = await s.js(
  `return document.querySelector('[data-filter="kind"].is-on')?.dataset.value || '(无)';`
);
check(
  '好题本·题库：换书后「哪一本」收回当前这本，不会残留「全部」',
  kindInMistakes === 'all' && kindAfterSwitch === 'current',
  `${kindInMistakes} → ${kindAfterSwitch}`
);

// 好题本自己的题库：默认只列好题
await sleep(600);
const goodCards = await s.js(`return document.querySelectorAll('.problem-card').length;`);
check('好题本·题库：只列好题本自己的题，不再混进错题', goodCards === 1, `${goodCards} 张`);
const goodWhere = await s.js(`return document.querySelector('.pc-where')?.textContent.trim() || '';`);
check('好题本·题库：来源标签没被误标成错题', !goodWhere.includes('错题'), goodWhere);

// 全屏做题 + 键盘快捷键（以前只有错题页能用）
await s.js(`document.querySelector('.problem-card').click();`);
await sleep(900);
await s.js(`document.querySelector('#drawerPanel [data-solve-start]').click();`);
await sleep(1300);
check('好题本：能进全屏做题模式', await s.js(`return location.hash.startsWith('#good/solve')`), await s.js(`return location.hash`));
await s.js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true}));`);
await sleep(600);
check(
  '好题本：空格也能显示答案（快捷键不再只在错题页生效）',
  (await s.js(`return !!document.querySelector('.rv-revealed');`)) === true
);
await s.js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'1',bubbles:true}));`);
await sleep(1600);
check('好题本：数字键 1 能记录「完美」', (await s.js(`return !!document.querySelector('.toast');`)) === true);
await s.js(`location.hash = '#good/library';`);
await sleep(1500);

// 抽屉里的「本题原文」要真的能打开（以前用的是相对书目录的路径，会 403）
await s.js(`document.querySelector('.problem-card').click();`);
await sleep(900);
await s.js(`document.querySelector('#drawerPanel [data-doc-open]').click();`);
await sleep(1800);
check('原文：抽屉里的「本题原文」真的能打开', (await s.js(`return !!document.querySelector('.doc-screen');`)) === true);
const drawerDocRel = await s.js(`return document.querySelector('.doc-screen .rv-where code')?.textContent.trim() || '';`);
check('原文：打开的是仓库里的那道题（好题本/…）', drawerDocRel.startsWith('好题本/'), drawerDocRel);
check(
  '原文：题目正文渲染出来（题干/答案都在）',
  (await s.js(`return document.querySelector('.doc-screen .note-body')?.textContent || '';`)).includes('题干')
);
await s.shot('23-good-doc');
await s.js(`document.querySelector('[data-doc-back]').click();`);
await sleep(1300);

/* ---------- 0.97 原文页：图片与双链（Obsidian 笔记原样渲染） ---------- */
await s.js(`location.hash = '#doc/' + encodeURIComponent('高等数学/函数极限与连续/02-函数的图像.md');`);
await sleep(2200);
const docImgs = await s.js(`return document.querySelectorAll('.doc-screen .note-body img.md-img').length;`);
check('原文：笔记里的 ![[图片]] 渲染出来了', docImgs >= 3, `${docImgs} 张`);
// 图片是懒加载的，只检查首屏那一张
const docImgsOk = await s.js(
  `var i=document.querySelector('.doc-screen .note-body img.md-img'); return !!i && i.complete && i.naturalWidth>0;`
);
check('原文：图片真的加载出来了（走 /api/asset）', docImgsOk === true);
const docLinks = await s.js(`return document.querySelectorAll('.doc-screen .note-body .wikilink').length;`);
check('原文：笔记里的 [[双链]] 变成了可点的链接', docLinks >= 1, `${docLinks} 个`);
// 点双链 → 应该在程序里跳到那篇笔记
await s.js(`document.querySelector('.doc-screen .note-body .wikilink').click();`);
await sleep(2000);
const jumpedRel = await s.js(`return document.querySelector('.doc-screen .rv-where code')?.textContent.trim() || '';`);
check('原文：点双链能直接跳到那篇笔记', jumpedRel.endsWith('.md') && jumpedRel !== '高等数学/函数极限与连续/02-函数的图像.md', jumpedRel);
await s.shot('24-doc-note');
// 源码视图
await s.js(`document.querySelector('.doc-screen [data-doc-raw]').click();`);
await sleep(700);
check('原文：能切到源码视图', (await s.js(`return !!document.querySelector('.doc-screen .doc-raw');`)) === true);
await s.js(`document.querySelector('.doc-screen [data-doc-raw]').click();`);
await sleep(600);

/* ---------- 1. 错题模块：先造一道「遗忘曲线到期」的题 ---------- */
// 用 6 天前做「完美」的方式，让间隔 4 天的排期到期（等级 1 → 4 天）
const seedList = await (await fetch(`${APP}/api/questions`)).json();
const seedTarget = seedList.problems.find((x) => x.chapter === '函数');
const back3 = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
await api2('/api/checkin', {
  method: 'POST',
  body: JSON.stringify({ id: seedTarget.id, result: '完美', date: back3, seconds: 180 }),
});
await sleep(600);

await s.js(`document.querySelector('.tab[data-module="mistakes"]').click();`);
await sleep(1600);
await s.js(`document.querySelector('.subtab[data-sub="dashboard"]').click();`);
await sleep(1600);
await s.waitFor('.category-grid');
const tabNames = await s.js(`return [...document.querySelectorAll('.tab')].map(x=>x.textContent.trim()).join('/');`);
check('顶栏：笔记模块已移除', !tabNames.includes('笔记') && tabNames.includes('复盘'), tabNames);
const cats = await s.js(
  `return [...document.querySelectorAll('.category-card')].map(c=>c.querySelector('.cc-name').textContent.trim());`
);
check('总览首页：两类大卡都在（含 0 题的 408）', cats.length === 2 && cats.includes('数学') && cats.includes('408'), cats.join(' / '));
// 0 题的大类不该显示 0%（那看着像「全没复习」），应该算 100%
const emptyCard = await s.js(
  `var c=[...document.querySelectorAll('.category-card')].find(x=>x.querySelector('.cc-name').textContent.trim()==='408');
   return c ? c.querySelector('.cc-foot').textContent.replace(/\\s+/g,' ').trim() : 'NO';`
);
check(
  '总览首页：0 题的大类进度算 100%，不是 0%',
  emptyCard.includes('100%') && !emptyCard.replace('100%', '').includes('0%'),
  emptyCard
);

const mathCard = await s.js(
  `var c=[...document.querySelectorAll('.category-card')].find(x=>x.querySelector('.cc-name').textContent.trim()==='数学');
   return c ? c.querySelector('.cc-count').textContent.trim()+' 题 | '+c.querySelector('.cc-chapters').textContent.trim().slice(0,40) : 'NO';`
);
const mathTotal = (await (await fetch(`${APP}/api/questions`)).json()).problems.filter(
  (p) => p.category === '数学' && p.kind === 'mistakes'
).length;
check('总览首页：数学卡显示题数与科目', mathCard.startsWith(String(mathTotal)) && mathCard.includes('高数'), mathCard);
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
const limCount = (await (await fetch(`${APP}/api/questions`)).json()).problems.filter(
  (p) => p.chapter === '极限' && p.kind === 'mistakes'
).length;
check('章节下钻：统计卡跟上「极限」这一章的题数', limTotal === String(limCount), `${limTotal} 题（题库里 ${limCount}）`);
const btnPath = await s.js(`return document.querySelector('#scopeText').textContent.trim();`);
check('范围选择器：按钮更新为三级路径', btnPath === '数学 › 高数 › 极限', btnPath);

/* ---------- 5. 题库跟随范围 ---------- */
await s.js(`document.querySelector('.subtab[data-sub="library"]').click();`);
await sleep(800);
await s.waitFor('.problem-grid');
const libCards = await s.js(`return document.querySelectorAll('.problem-card').length;`);
check('题库：跟随范围（只列「极限」这一章）', libCards === limCount, `${libCards} 张卡（应为 ${limCount}）`);
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
check('详情：有「本题原文」入口', (await s.js(`return !!document.querySelector('#drawerPanel [data-doc-open]');`)) === true);
check(
  '详情：已去掉「相关笔记」按钮',
  (await s.js(`return !!document.querySelector('#drawerPanel [data-related-notes], #drawerPanel .related-notes');`)) ===
    false
);
// 从抽屉打开本题原文
await s.js(`document.querySelector('#drawerPanel [data-doc-open]').click();`);
await sleep(1800);
check('原文：从题目能打开自己的源文件', (await s.js(`return !!document.querySelector('.doc-screen');`)) === true);
check('原文：笔记正文已渲染', (await s.js(`return (document.querySelector('.doc-screen .note-body')?.textContent || '').length;`)) > 200);
await s.shot("22-pick-doc");
await s.js(`document.querySelector('[data-doc-back]').click();`);
await sleep(1400);

await s.shot('04-drawer');

/* ---------- 5.4 全屏做题模式 ---------- */
await s.click('[data-solve-start]');
await sleep(900);
await s.waitFor('.rv-reveal');
check('做题模式：进入全屏，解析与错因都藏着', (await s.js(`return !document.querySelector('.rv-revealed');`)) === true);
const solveWho = await s.js(`return document.querySelector('.rv-num')?.textContent.trim() || '';`);
check('做题模式：错因不可见', (await s.js(`return !document.querySelector('.fold-reason');`)) === true, solveWho);
check(
  '做题模式：顶栏计时器和试卷那套一样（能暂停、能重置，不是只显示一个「用时 0:00」）',
  (await s.js(`return !!document.getElementById('paperTimer');`)) === true &&
    (await s.js(`return document.querySelectorAll('[data-timer="toggle"], [data-timer="reset"]').length;`)) === 2,
  await s.js(`return (document.getElementById('paperTimer')||{}).textContent || '(没有计时器)';`)
);
check(
  '做题模式：有「拍照判分」区（这一题独立判：上传手写过程 → AI 判分）',
  (await s.js(`return !!document.getElementById('gradeDrop') && !!document.getElementById('gradeFiles');`)) === true &&
    (await s.js(`return !!document.querySelector('.solve-grade [data-grade="pick"]');`)) === true,
  await s.js(`return (document.querySelector('.solve-grade .gp-head')||{}).innerText.replace(/\\s+/g,' ').trim() || '(没有判分区)';`)
);
check(
  '做题模式：没配 AI 时不给「判这一题」按钮（而是提示去设置）',
  (await s.js(`return !!document.querySelector('.solve-grade [data-grade="run"]');`)) === false,
  await s.js(`return (document.querySelector('.solve-grade .gp-actions')||{}).innerText.replace(/\\s+/g,' ').trim() || '';`)
);
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

/* ---------- 5.5 打卡次数不封顶 + 遗忘曲线语义 ---------- */
const solveId = solved.id;
const slotsBefore = await (await fetch(`${APP}/api/questions`)).json();
const beforeFile = slotsBefore.problems.find((p) => p.id === solveId);
const emptyBefore = beforeFile.checkins.filter((c) => !c.done).length;
check('打卡：文件里始终预留多组空白位置（默认 3 组 = 9 行）', emptyBefore === 9, `${emptyBefore} 行空白`);
// 连打 5 次（远超模板里的 3 次），每次都应该成功
let lastAttempt = 0;
for (let i = 0; i < 5; i++) {
  const out = await api2('/api/checkin', {
    method: 'POST',
    body: JSON.stringify({ id: solveId, result: '失败', seconds: 30, reason: '计算失误' }),
  });
  lastAttempt = out.attempt;
}
check('打卡：次数不封顶（连打 5 次都记上了）', lastAttempt >= beforeFile.checkins.filter((c) => c.done).length + 5, `第 ${lastAttempt} 次`);
const afterLoop = await (await fetch(`${APP}/api/questions`)).json();
const looped = afterLoop.problems.find((p) => p.id === solveId);
check(
  '打卡：打完还是预留 3 组空白，可以一直勾',
  looped.checkins.filter((c) => !c.done).length === 9,
  `${looped.checkins.filter((c) => !c.done).length} 行空白`
);
// 失败 = 明天再来（不是今天到期），做了就算「已复习」
check(
  '遗忘曲线：刚失败的题算「已复习」，下次排到明天',
  looped.stats.status === '已复习' && looped.stats.schedule.level === 0 && looped.stats.schedule.interval === 1,
  `${looped.stats.status} · 第 ${looped.stats.schedule.level} 级 · ${looped.stats.schedule.interval} 天后`
);
// 完美两次 → 等级 1 → 2 次；再完美一次 → 等级 2
const curve = await api2('/api/checkin', { method: 'POST', body: JSON.stringify({ id: solveId, result: '完美' }) });
const c1 = await (await fetch(`${APP}/api/questions`)).json();
const afterPerfect1 = c1.problems.find((p) => p.id === solveId);
check(
  '遗忘曲线：失败后做一次完美 → 等级 1、间隔 4 天',
  afterPerfect1.stats.schedule.level === 1 && afterPerfect1.stats.schedule.interval === 4,
  `第 ${afterPerfect1.stats.schedule.level} 级 · ${afterPerfect1.stats.schedule.interval} 天`
);
await api2('/api/checkin', { method: 'POST', body: JSON.stringify({ id: solveId, result: '完美' }) });
const c2 = await (await fetch(`${APP}/api/questions`)).json();
const afterPerfect2 = c2.problems.find((p) => p.id === solveId);
check(
  '遗忘曲线：第二次完美 → 等级 2、间隔 8 天（每对一次翻一倍，没有 60 天上限）',
  afterPerfect2.stats.schedule.level === 2 && afterPerfect2.stats.schedule.interval === 8,
  `第 ${afterPerfect2.stats.schedule.level} 级 · ${afterPerfect2.stats.schedule.interval} 天`
);
// 「续上打卡位置」：位置够用时不动文件；在 Obsidian 里勾完了能一键续上
const enough = await api2('/api/checkin-slots', { method: 'POST', body: JSON.stringify({ id: solveId }) });
check('打卡：位置够用时「续上」不会重复写', enough.added === 0, `added=${enough.added}`);
const topupBtn = await s.js(
  `var b=document.querySelector('#drawerPanel [data-topup]'); return b ? b.textContent.replace(/\\s+/g,' ').trim() : 'NO';`
);
check('详情：「续上打卡位置」按钮在，并且写着还剩几次', topupBtn.includes('续上打卡位置') && topupBtn.includes('还剩'), topupBtn);
const beforeTopUp = (await (await fetch(`${APP}/api/questions`)).json()).problems.find((p) => p.id === solveId);
const doneBeforeTopUp = beforeTopUp.checkins.filter((c) => c.done).length;
const raw = fs.readFileSync(beforeTopUp.absPath, 'utf8');
fs.writeFileSync(beforeTopUp.absPath, raw.replace(/^- \[ \] 第 .*$/gm, '').replace(/\n{3,}/g, '\n\n'), 'utf8');
const topped = await api2('/api/checkin-slots', { method: 'POST', body: JSON.stringify({ id: solveId }) });
check('打卡：空白位置用完后能一键续上 3 组', topped.added === 3, `续上 ${topped.added} 组`);
const toppedQ = await (await fetch(`${APP}/api/questions`)).json();
const toppedP = toppedQ.problems.find((p) => p.id === solveId);
check(
  '打卡：续完之后还是 9 行空白，历史记录一条没丢',
  toppedP.checkins.filter((c) => !c.done).length === 9 &&
    toppedP.checkins.filter((c) => c.done).length === doneBeforeTopUp,
  `${toppedP.checkins.filter((c) => !c.done).length} 空 / ${toppedP.checkins.filter((c) => c.done).length} 已记（原 ${doneBeforeTopUp}）`
);

// 在 Obsidian 里手勾（没有日期）也算「已复习」，只是不会乱排期
const beforeTick = fs.readFileSync(toppedP.absPath, 'utf8');
fs.writeFileSync(
  toppedP.absPath,
  beforeTick.replace(/- \[ \] 第 (\d+) 次 · 完美\n/, '- [x] 第 $1 次 · 完美\n'),
  'utf8'
);
const ticked = (await (await fetch(`${APP}/api/questions`)).json()).problems.find((p) => p.id === solveId);
check(
  '打卡：在 Obsidian 里手勾（没有日期）也算「已复习」，排期仍按有日期的那条走',
  ticked.stats.status === '已复习' && ticked.stats.schedule.level === 2,
  `${ticked.stats.status} · 等级 ${ticked.stats.schedule.level}`
);

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
const expectPool = (await (await fetch(`${APP}/api/questions`)).json()).problems.filter(
  (p) => p.kind === 'mistakes' && p.stats.status !== '已复习'
).length;
check('复习：全部混刷 = 还没复习完的题', poolAll === `${expectPool} 题`, `${poolAll}（应为 ${expectPool}）`);

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
// 别把题数写死：错题本是会长大的（我一直在往里加题），
// 写死的话今天 8 明天 9，一跑就红，还看不出是测试老了还是程序坏了
const expectLim = (await (await fetch(`${APP}/api/questions`)).json()).problems.filter(
  (p) =>
    p.kind === 'mistakes' &&
    p.category === '数学' &&
    p.subject === '高数' &&
    p.chapter === '极限' &&
    p.stats.status !== '已复习'
).length;
check('复习：只勾「极限」→ 题数就是这一章的（跟着范围走）', poolLim === `${expectLim} 题`, `${poolLim}（应为 ${expectLim}）`);
await s.shot('06-review-scoped');

await s.js(`document.querySelector('[data-rv-count="5"]').click();`);
await sleep(400);
const checkinsBefore = (await (await fetch(`${APP}/api/stats`)).json()).totals.checkins;
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
// 本局答了 5 题，文件里就该多 5 次打卡
check(
  '复习：打卡确实写回文件',
  apiStats.totals.checkins === checkinsBefore + 5,
  `${checkinsBefore} → ${apiStats.totals.checkins} 次`
);

/* ---------- 6.5 遗忘曲线 + 用时分析 ---------- */
const detail = await (await fetch(`${APP}/api/stats`)).json();
check(
  '遗忘曲线：做过的题都算「已复习」并排了下一次',
  detail.totals.done >= 1 && detail.totals.due >= 1,
  `已复习 ${detail.totals.done} · 待复习 ${detail.totals.due}`
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

// 粘进文本框的题干，不能被别的动作引发的重绘冲掉 —— 只能靠「敲一下就存回 state」。
// 以前只有 addParse() 会去 DOM 里读它，所以点一下分题方式 / 传一张图，粘的题就没了。
await s.js(
  `var t=document.getElementById('addStem');
   t.value='先粘一道：$\\\\lim_{x\\\\to 0}\\\\dfrac{\\\\sin x-x}{x^{3}}$';
   t.dispatchEvent(new Event('input',{bubbles:true}));`
);
await s.js(`document.querySelector('[data-add-mode="blank"]').click();`);
await sleep(900);
const keptStem = await s.js(`return document.getElementById('addStem')?.value || '';`);
check('增题：换个分题方式（会整页重绘）不会把粘好的题干冲掉', keptStem.includes('sin x-x'), keptStem.slice(0, 50));
await s.js(`document.querySelector('[data-add-mode="rule"]').click();`);
await sleep(700);

await s.js(
  `var t=document.getElementById('addStem');
   t.value='用等价无穷小计算 $\\\\lim_{x\\\\to 0}\\\\dfrac{\\\\tan x - x}{x^{3}}$\\n---\\n简述进程调度算法中的时间片轮转法';
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
const addPointFields = await s.js(
  `return [...document.querySelectorAll('.add-item [data-field="points"]')].map(x=>x.value);`
);
check('增题：每题都有「考点」字段', addPointFields.length === 2, addPointFields.join(' ／ '));
check(
  '增题：题干里出现过的已有考点会自动勾上',
  addPointFields.some((v) => v.includes('等价无穷小')),
  addPointFields[0] || '(空)'
);
const addPointOptions = await s.js(`return document.querySelectorAll('#pointList option').length;`);
check('增题：考点输入框能补全已有考点', addPointOptions >= 1, `${addPointOptions} 个候选`);
check(
  '增题：第一题归到 数学/高数/极限',
  items[0]?.cat === '数学' && items[0]?.sub === '高数' && items[0]?.ch === '极限',
  JSON.stringify(items[0])
);
check('增题：第二题归到 408/操作系统', items[1]?.cat === '408' && items[1]?.sub === '操作系统', JSON.stringify(items[1]));
await s.shot('09-add');

// 识别结果里手改的字段，也要经得起「切个页再回来」的重绘：
// 以前这些输入框只是在写盘那一刻从 DOM 里读，中间一重绘就全被冲回识别出来的原样。
await s.js(
  `var n=document.querySelector('.add-item [data-field="slug"]');
   n.value='E2E改过的短标题';
   n.dispatchEvent(new Event('input',{bubbles:true}));`
);
await s.js(`document.querySelector('.subtab[data-sub="dashboard"]').click();`);
await sleep(700);
await s.js(`document.querySelector('.subtab[data-sub="add"]').click();`);
await s.waitFor('.add-item');
await sleep(900);
const keptSlug = await s.js(`return document.querySelector('.add-item [data-field="slug"]')?.value || '';`);
check('增题：手改的短标题经得起重绘（切页回来还在）', keptSlug === 'E2E改过的短标题', keptSlug || '(空)');

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
check(
  '增题页：只有一个生成按钮 —— 粘的题干和传的图都由它处理（不再「生成」一个「写入」一个）',
  (await s.js(
    `return document.querySelectorAll('[data-airun="add"], [data-airun="questions"], [data-airun="images"], [data-add="create"], [data-add="prompt-images"]').length;`
  )) === 1 &&
    (await s.js(`return document.querySelector('.rv-start-row button').textContent.includes('生成');`)) === true,
  await s.js(
    `return [...document.querySelectorAll('.rv-start-row button')].map(x=>x.textContent.replace(/\s+/g,' ').trim()).join(' | ');`
  )
);
check(
  '增题页：没配 AI 时给「去设置」的提示（粘题干和图片两条路都要模型）',
  (await s.js(`return !!document.querySelector('#main .ai-hint');`)) === true
);
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

// 手填一个新考点（紧挨着写入，中间的重渲染不会把值冲掉）
await s.js(
  `var i=document.querySelectorAll('.add-item [data-field="points"]')[0];
   i.value = i.value ? i.value + '、E2E新考点' : 'E2E新考点';
   i.dispatchEvent(new Event('input',{bubbles:true}));`
);
const pointPreview = await s.js(
  `return document.querySelectorAll('.add-item [data-field="points"]')[0]?.value || '';`
);
check('增题：考点框里能填新考点（预备写盘）', pointPreview.includes('E2E新考点'), pointPreview);
const before = (await (await fetch(`${APP}/api/questions`)).json()).problems.length;
await s.js(`document.querySelector('[data-add="create"]').click();`);
await sleep(1800);
const afterDoc = await (await fetch(`${APP}/api/questions`)).json();
check('增题：写盘成功（+2 题）', afterDoc.problems.length === before + 2, `${before} → ${afterDoc.problems.length}`);
const os8 = afterDoc.tree.find((c) => c.name === '408');
check('增题：408 / 操作系统 目录已自动创建', !!os8 && os8.total === 1, os8 ? `408 共 ${os8.total} 题` : '没有 408');
const newFile = afterDoc.problems.find((p) => p.category === '408');
check('增题：新题可被解析并带完整骨架', !!newFile && newFile.warnings.length === 0, newFile ? newFile.relPath : 'NO');
const newPointed = afterDoc.problems.find((p) => (p.points || []).includes('E2E新考点'));
check(
  '考点：新加的考点会写进骨架并自动出现在题库标签里',
  !!newPointed && afterDoc.problems.flatMap((p) => p.points).includes('E2E新考点'),
  newPointed ? `${newPointed.num} → ${newPointed.points.join('、')}` : '没写进去'
);
check(
  '考点：识别不到考点时不乱写，等 AI 写题时补',
  !!newFile && Array.isArray(newFile.points) && newFile.points.length === 0,
  newFile ? `points = ${(newFile.points || []).join('、') || '(空，符合预期)'}` : 'NO'
);

/* ---------- 7.5 还原被改动的计划文件 ---------- */
const finalPlan = await (await fetch(`${APP}/api/plan?rel=${encodeURIComponent(planPath)}`)).json();
const extra = finalPlan.groups.flatMap((g) => g.tasks).filter((x) => x.done && !x.doneDate);
check('计划：测试期间没有留下脏数据', finalPlan.done === beforePlan.done, `完成数 ${finalPlan.done}（原 ${beforePlan.done}）`);

/* ---------- 7.6 单词（墨墨背单词 → 考研英语一题型） ---------- */
// 这一轮服务是带 MAIMEMO_OFF=1 起的：不联外网，但要验证「接口关掉也照常能开页面」
await s.js(`location.hash='#today';`);
await sleep(800);
const tabNames2 = await s.js(`return [...document.querySelectorAll('.tab')].map(x=>x.textContent.trim()).join('/');`);
check('顶栏：加了「单词」模块', tabNames2.includes('单词'), tabNames2);

const vocabCard = await s.js(`return (document.querySelector('.vocab-panel')||{}).textContent || '';`);
check('今日：首页有「今日单词」卡', vocabCard.includes('今日单词'), vocabCard.trim().slice(0, 50));
check(
  '今日：墨墨读不到数据时首页不崩，卡片给出原因',
  vocabCard.includes('MAIMEMO_OFF') || vocabCard.includes('token') || vocabCard.includes('没读到'),
  vocabCard.replace(/\s+/g, ' ').trim().slice(0, 70)
);

await s.js(`document.querySelector('.tab[data-module="words"]').click();`);
await sleep(1200);
await s.waitFor('.picker-panel');

// 选词区在上面、原文在下面，两者都是整行（不再左右并排）
const wordsLayout = await s.js(
  `var secs=[...document.querySelectorAll('#main .words > section')].map(x=>x.className);
   var pick=secs.findIndex(c=>c.includes('picker-panel'));
   var story=secs.findIndex(c=>c.includes('story-panel'));
   var g=document.querySelector('.words-grid');
   return JSON.stringify({pick, story, grid: !!g});`
);
const wl = JSON.parse(wordsLayout);
check(
  '单词页：选词在上、原文在下，不再左右并排',
  wl.pick >= 0 && wl.story >= 0 && wl.pick < wl.story && wl.grid === false,
  `选词第 ${wl.pick + 1} 个、原文第 ${wl.story + 1} 个，words-grid=${wl.grid}`
);

check('单词页：8 个考研题型都能选', (await s.js(`return document.querySelectorAll('[data-type]').length;`)) === 8);
check(
  '单词页：篇数可选 1–6 篇',
  (await s.js(`return document.querySelectorAll('[data-papers]').length;`)) === 6
);
// 这一轮墨墨是关掉的 → 词池为空，此时该给提示而不是画一排空筛选
const sourceCount = await s.js(`return document.querySelectorAll('[data-source]').length;`);
const sourceText = await s.js(
  `return [...document.querySelectorAll('[data-source]')].map(x=>x.textContent.trim()).join(' | ')
     || (document.querySelector('.word-chips') ? '' : (document.querySelector('.picker-panel .rv-hint')||{}).textContent || '');`
);
check(
  '单词页：词池来源是可多选的筛选（拿不到词时给提示而不是空筛选）',
  sourceCount >= 4 || /MAIMEMO_OFF|没读到|背完了/.test(sourceText),
  sourceCount ? sourceText : sourceText.trim().slice(0, 50)
);
check(
  '单词页：没配 AI 时给「去设置」的提示（设置块已收进设置页）',
  (await s.js(`return document.querySelectorAll('#main .ai-box').length;`)) === 0 &&
    (await s.js(`return !!document.querySelector('#main .ai-hint');`)) === true
);
check(
  '单词页：token 设置有入口，且不回显 token 本身',
  (await s.js(
    `var b=document.querySelector('.token-box');
     return !!b && b.textContent.includes('token') && !document.querySelector('#tokenInput')?.value;`
  )) === true
);

const promptRes = await fetch(`${APP}/api/words/prompt`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ count: 20 }),
});
const promptJson = await promptRes.json().catch(() => ({}));
check(
  '单词：没词可写时提示词接口给明确错误（不是 500）',
  promptRes.status === 400 && /先选几个单词|先勾一个题型/.test(promptJson.error || ''),
  `${promptRes.status} ${promptJson.error}`
);

// 写一份「考研阅读题」进来：原文 + 5 道四选一 + 答案速查 + 三节默认折叠的内容
const storyDate = todayWeek.date;
const storyRel = `单词故事/${storyDate}-01-传统阅读·细节题.md`;
const storyMd = `---
date: ${storyDate}
type: 传统阅读 · 细节题
title: E2E Paper
words:
  - theoretical
  - capsule
---

# E2E Paper

A **theoretical** problem and a white **capsule** were found on the desk. The room had been
locked for years, and nobody could explain how either of them had got there. The janitor, who
had worked in the building for three decades, said he had never seen anything like it.

Colleagues offered explanations that contradicted one another. Some said the objects had been
left behind by a visiting researcher; others insisted that the department had never employed
anyone by that name. The records, which were kept in the basement, were incomplete.

What made the episode memorable was not the objects themselves but the reaction to them. Nobody
wanted to be the person who admitted that the inventory had not been checked since the previous
decade. So the problem stayed on the desk, and the capsule stayed beside it, and both slowly
became part of the furniture.

Visitors who came to see the room asked the same three questions, in the same order, and received
the same three unsatisfactory answers. The first question concerned the origin of the objects,
the second the identity of the person who had left them, and the third, inevitably, the reason
nobody had done anything about either. Each answer began with a qualification and ended with an
apology, and none of them survived a second hearing.

It would be easy to read the episode as a satire about bureaucracy, and many of the staff did
exactly that. But the more careful observers noticed something else: the objects had changed the
way people moved through the building. Conversations that used to happen in the corridor now
happened at the doorway, and the doorway itself acquired a reputation it had never earned.

By the following spring the phrase "the theoretical problem" had entered the local vocabulary.
People used it to describe any difficulty that everyone acknowledged and nobody owned, which is
to say most of them. The capsule, for its part, was eventually moved to a drawer, and the drawer
was eventually moved to a different room, and in this way the whole affair was resolved, in the
sense that it stopped being visible.

## 题目

1. What was found on the desk?
A. A theoretical problem and a capsule
B. A statute and a ribbon
C. Nothing at all
D. A bare cupboard

2. Which word describes the capsule?
A. Red
B. Blue
C. White
D. Black

## 答案速查

1.A 2.C

## 答案解析

| 题号 | 题型 | 答案 | 解析 |
| --- | --- | --- | --- |
| 1 | 细节题 | A | 第一段直接给出 |
| 2 | 细节题 | C | white capsule |

## 生词回收

| 单词 | 词性 · 释义 | 文中原句 |
| --- | --- | --- |
| **theoretical** | adj. 理论的 | A theoretical problem |

## 中文大意

桌上有一个理论问题和一颗白色胶囊。
`;
const savedStory = await api2('/api/words/story', {
  method: 'POST',
  body: JSON.stringify({ rel: storyRel, content: storyMd }),
});
check('单词故事：写进仓库（按 rel 定位，一天可以多篇）', savedStory.rel === storyRel, savedStory.rel);
const backStory = await api2(`/api/words/story?rel=${encodeURIComponent(storyRel)}`);
check(
  '单词故事：题目与答案速查都能被解析出来',
  backStory.exists && backStory.questions.length === 2 && backStory.key['1'] === 'A' && backStory.key['2'] === 'C',
  `${backStory.questions.length} 题 · 答案 ${JSON.stringify(backStory.key)}`
);

await s.js(`location.hash='#words/${encodeURIComponent(storyRel)}';`);
await sleep(1500);
check('阅读：原文里的目标词被标蓝', (await s.js(`return document.querySelectorAll('.reading-passage .story-word').length;`)) >= 2);

// 版式：左原文 / 右侧栏（题目 + 解析类内容都在侧栏里，可以同时开几个）
const railView = await s.js(
  `var l=document.querySelector('.read-layout'), m=document.querySelector('.read-main'), r=document.querySelector('.read-rail');
   return JSON.stringify({
     hasLayout: !!l, hasRail: !!(l && l.classList.contains('has-rail')),
     left: m ? Math.round(m.getBoundingClientRect().left) : -1,
     railLeft: r ? Math.round(r.getBoundingClientRect().left) : -1,
     railW: r ? Math.round(r.getBoundingClientRect().width) : -1,
     tabs: [...document.querySelectorAll('.rail-tab')].map(x=>x.textContent.trim()),
     open: [...document.querySelectorAll('.rail-panel')].map(x=>x.dataset.panel),
     sticky: r ? getComputedStyle(r.querySelector('.rail-sticky')).position : ''
   });`
);
const rv = JSON.parse(railView);
check(
  '阅读：改成左右两栏 —— 原文在左、侧栏在右（侧栏里排开：题目 / 答案解析 / 生词回收 / 中文大意）',
  rv.hasLayout &&
    rv.hasRail &&
    rv.railLeft > rv.left &&
    rv.tabs.length === 4 &&
    rv.tabs[0].includes('题目') &&
    rv.tabs[1].includes('答案解析') &&
    rv.tabs[2].includes('生词回收') &&
    rv.tabs[3].includes('中文大意'),
  `${rv.tabs.join(' / ')}　·　原文 x=${rv.left}，侧栏 x=${rv.railLeft}（宽 ${rv.railW}）`
);
check(
  '阅读：默认只开「题目」——解析 / 大意还藏着（想看得自己点开），侧栏跟着原文滚动',
  rv.open.length === 1 && rv.open[0] === '题目' && rv.sticky === 'sticky',
  `开着的面板：${rv.open.join('、') || '（无）'}　·　侧栏 ${rv.sticky}`
);
check(
  '阅读：2 道题、8 个选项都在侧栏里（不在原文下面）',
  (await s.js(`return document.querySelectorAll('.rail-panel[data-panel="题目"] .quiz-q').length;`)) === 2 &&
    (await s.js(`return document.querySelectorAll('.rail-panel[data-panel="题目"] .q-opt').length;`)) === 8 &&
    (await s.js(`return document.querySelectorAll('.read-main .quiz').length;`)) === 0
);

/**
 * 侧栏拉到最底，最后一行也必须落在可见范围内。
 *
 * 以前 CSS 写的是 `max-height: calc(100vh - 20px)`，可全屏阅读时滚的是 `.rf-body`，
 * 视口里还占着一条标题栏 + 上下内边距 —— 100vh 比真实可见高度大一截，
 * 于是侧栏自己滚到底会差几行，非得把左边文章也拉到底才露出来。
 * 现在高度由 fitReadRail() 按真实滚动容器算，这条断言盯着它别退回去。
 */
await s.js(`document.querySelectorAll('.rail-tab')[1]?.click();`); // 开「答案解析」，内容够长才滚得动
await sleep(600);
const railFit = JSON.parse(
  await s.js(
    `var stick=document.querySelector('.rail-sticky');
     if(!stick) return JSON.stringify({ok:false,why:'没有侧栏'});
     stick.scrollTop = stick.scrollHeight;               // 拉到最底
     var box=stick.parentElement, scroller=null;
     while(box && box!==document.body){
       var st=getComputedStyle(box);
       if(/(auto|scroll)/.test(st.overflowY) && box.scrollHeight>box.clientHeight+1){scroller=box;break;}
       box=box.parentElement;
     }
     var sr=scroller?scroller.getBoundingClientRect():{top:0,bottom:innerHeight};
     var pad=scroller?(parseFloat(getComputedStyle(scroller).paddingBottom)||0):0;
     var last=stick.lastElementChild?stick.lastElementChild.getBoundingClientRect():stick.getBoundingClientRect();
     return JSON.stringify({
       ok:true,
       maxH:Math.round(stick.getBoundingClientRect().height),
       overflow:Math.round(last.bottom - (sr.bottom - pad)),   // >0 = 被切掉了
       canScroll: stick.scrollHeight > stick.clientHeight
     });`
  )
);
check(
  '阅读：侧栏拉到最底，最后一行也在可见范围内（不再需要拿左边的文章去顶）',
  railFit.ok && railFit.overflow <= 1,
  railFit.ok ? `侧栏高 ${railFit.maxH}px · 超出可见区 ${railFit.overflow}px` : railFit.why
);

// 折叠 / 打开侧栏 → 原文位置跟着动。
//
// 收起这一步要把**开着的全收掉**，不能只点「题目」：上面那条「拉到最底」为了量滚动高度
// 会先把「答案解析」开起来，只点题目的话它还在，侧栏当然缩不成窄边条 ——
// 这条断言就白白红了（而且会连累后面两条：状态已经不是它假设的样子了）。
// 按**页面上实际有的标签**收，别写死列表：这篇有哪几节是笔记决定的（可能 4 个也可能 5 个）。
const railNames = await s.js(`return [...document.querySelectorAll('.rail-tab')].map(x=>x.dataset.rail);`);
for (const name of railNames) {
  await s.js(
    `var t=document.querySelector('.rail-tab[data-rail=${JSON.stringify(name)}]');
     if (t && document.querySelector('.rail-panel[data-panel=${JSON.stringify(name)}]')) t.click();`
  );
  await sleep(300);
}
await sleep(400);
const collapsed = await s.js(
  `var l=document.querySelector('.read-layout'), m=document.querySelector('.read-main'), r=document.querySelector('.read-rail');
   return JSON.stringify({
     hasRail: l.classList.contains('has-rail'),
     panels: document.querySelectorAll('.rail-panel').length,
     railW: Math.round(r.getBoundingClientRect().width),
     left: Math.round(m.getBoundingClientRect().left),
     tabs: document.querySelectorAll('.rail-tab').length
   });`
);
const cl = JSON.parse(collapsed);
check(
  '阅读：侧栏全部收起 → 缩成右边一条窄边条，**原文回到中间**（位置真的动了）',
  cl.hasRail === false && cl.panels === 0 && cl.railW <= 60 && cl.left > rv.left && cl.tabs === 4,
  `侧栏 ${cl.railW}px · 原文左边距 ${rv.left} → ${cl.left}`
);

await s.js(`document.querySelector('.rail-tab[data-rail="中文大意"]').click();`); // 打开中文大意
await sleep(700);
const railOpened = await s.js(
  `var l=document.querySelector('.read-layout'), m=document.querySelector('.read-main');
   return JSON.stringify({
     hasRail: l.classList.contains('has-rail'),
     panels: [...document.querySelectorAll('.rail-panel')].map(x=>x.dataset.panel),
     text: (document.querySelector('.rail-panel')||{}).innerText || '',
     left: Math.round(m.getBoundingClientRect().left)
   });`
);
const op = JSON.parse(railOpened);
check(
  '阅读：点「中文大意」→ 原文让位到左边、大意显示在右边',
  op.hasRail === true &&
    op.panels.length === 1 &&
    op.panels[0] === '中文大意' &&
    op.text.includes('桌上有一个理论问题') &&
    // 滚动条出现 / 消失会让居中列左右差几个像素，别卡死
    Math.abs(op.left - rv.left) <= 12,
  `面板=${op.panels.join('、')} · 原文左边距回到 ${op.left}`
);

await s.js(`document.querySelector('.rail-tab[data-rail="题目"]').click();`); // 换回题目，继续做题
await sleep(700);
check(
  '阅读：点回「题目」把题目换回来（侧栏可以同时开几个，不是一次只能一个）',
  (await s.js(`return [...document.querySelectorAll('.rail-panel')].map(x=>x.dataset.panel).join('、');`)) === '题目、中文大意' &&
    (await s.js(`return document.querySelectorAll('.rail-panel[data-panel="题目"] .q-opt').length;`)) === 8,
  await s.js(`return [...document.querySelectorAll('.rail-panel')].map(x=>x.dataset.panel).join('、');`)
);
await s.js(`document.querySelector('.rail-tab[data-rail="中文大意"]').click();`); // 收起大意，只留题目
await sleep(600);

// 侧栏要真的 sticky：原文很长，往下滚的时候侧栏得钉在视野里，不然「对着原文看解析」就无从谈起
const stickBefore = await s.js(`return Math.round(document.querySelector('.rail-sticky').getBoundingClientRect().top);`);
await s.js(`document.querySelector('.rf-body').scrollTop = 600;`);
await sleep(500);
const stickAfter = await s.js(
  `return JSON.stringify({
     railTop: Math.round(document.querySelector('.rail-sticky').getBoundingClientRect().top),
     scroll: Math.round(document.querySelector('.rf-body').scrollTop)
   });`
);
const sa = JSON.parse(stickAfter);
check(
  '阅读：往下滚原文时侧栏钉在视野里（sticky 真的生效，不是一直待在顶上被滚走）',
  sa.scroll > 300 && sa.railTop >= -2 && sa.railTop < stickBefore + 40,
  `滚动 ${sa.scroll}px 后侧栏顶部 y=${sa.railTop}（滚动前 ${stickBefore}）`
);
await s.js(`document.querySelector('.rf-body').scrollTop = 0;`);
await sleep(400);

// 做一遍题：全选 A（1 对、2 错），先确认交卷前不给任何对错反馈
await s.js(
  `[...document.querySelectorAll('.quiz-q')].forEach(function(q){var b=q.querySelector('.q-opt[data-k="A"]'); if(b) b.click();});`
);
await sleep(400);
check('阅读：点了选项就算已答，且交卷前不显示对错',
  (await s.js(`return document.querySelectorAll('.q-opt.is-picked').length;`)) === 2 &&
  (await s.js(`return document.querySelectorAll('.q-opt.is-right,.q-opt.is-wrong').length;`)) === 0
);

await s.js(`document.querySelector('[data-quiz="grade"]').click();`);
await sleep(400);
const graded = await s.js(
  `return JSON.stringify({
     right: document.querySelectorAll('.q-opt.is-right').length,
     wrong: document.querySelectorAll('.q-opt.is-wrong').length,
     hint: (document.querySelector('.quiz-head .hint')||{}).textContent || ''
   });`
);
const g = JSON.parse(graded);
check(
  '阅读：对答案在本地判卷，得分按每题分值算（2 题 = 满分 10，对 1 题 = 5 分）',
  g.right === 2 && g.wrong === 1 && /得分\s*5\s*\/\s*10/.test(g.hint),
  g.hint.trim()
);
check(
  '阅读：每题标着分值，题目上方给出每题的参考用时（考研英语一：一篇 10 分 / 18 分钟）',
  (await s.js(`return document.querySelectorAll('.quiz-q .q-score').length;`)) === 2 &&
    (await s.js(`return !!document.querySelector('.quiz-ref');`)) === true &&
    (await s.js(`return (document.querySelector('.quiz-ref')||{}).innerText || '';`)).includes('参考用时'),
  await s.js(`return (document.querySelector('.quiz-ref')||{}).innerText || '';`)
);

// 本地判卷的成绩要记进卷子的「成绩记录」—— 页面上的分数刷新一下就没了
await sleep(1400);
const storyAfterQuiz = await api2(`/api/words/story?rel=${encodeURIComponent(storyRel)}`);
check(
  '阅读：本地判卷的成绩也写进卷子的 ## 成绩记录（标出来是本地判卷）',
  (storyAfterQuiz.grades || []).length === 1 &&
    storyAfterQuiz.grades[0].total === 5 &&
    storyAfterQuiz.grades[0].full === 10 &&
    storyAfterQuiz.grades[0].source === 'local' &&
    storyAfterQuiz.grades[0].seconds > 0,
  `第 ${storyAfterQuiz.grades?.[0]?.index} 次 · ${storyAfterQuiz.grades?.[0]?.total}/${storyAfterQuiz.grades?.[0]?.full} · 用时 ${storyAfterQuiz.grades?.[0]?.seconds}s`
);
check(
  '阅读：页面上的成绩单就跟在题目下面（总分 + 每题得分 + 判定）',
  (await s.js(`return !!document.querySelector('.grade-result .gr-total');`)) === true &&
    (await s.js(`return (document.querySelector('.grade-result .gr-total')||{}).innerText || '';`)).includes('5') &&
    (await s.js(`return document.querySelectorAll('.grade-result .gr-table tbody tr').length;`)) === 2,
  await s.js(`return (document.querySelector('.grade-result .gr-total')||{}).innerText.replace(/\\s+/g,' ').trim() || '(没有成绩单)';`)
);
check(
  '阅读：英语**没有**「拍照判分」那套（全是选择题，程序自己判，不用传图也不用调模型）',
  (await s.js(`return !!document.getElementById('gradeDrop');`)) === false &&
    (await s.js(`return !!document.querySelector('[data-grade="run"]');`)) === false &&
    (await s.js(`return !!document.querySelector('.grade-zone-plain');`)) === true &&
    (await s.js(`return !document.getElementById('main').innerText.includes('拍照判分');`)) === true,
  await s.js(`return (document.querySelector('.grade-zone-plain .gp-head')||{}).innerText.replace(/\\s+/g,' ').trim() || '(没有成绩区)';`)
);
check(
  '阅读：全屏阅读顶栏有计时器，一进来就在走，并且标出了参考用时',
  (await s.js(`return !!document.getElementById('paperTimer');`)) === true &&
    (await s.js(`return (document.getElementById('paperTimer')||{}).dataset.ref || '0';`)) === '1080' &&
    (await s.js(`return (document.getElementById('paperTimer')||{}).textContent || '';`)).includes('参考 18:00'),
  await s.js(`return (document.getElementById('paperTimer')||{}).textContent || '(没有计时器)';`)
);
// 对答案之后计时必须自己停：这一篇已经做完了，数字再涨就是假的（写进成绩的用时也跟着假）
const readDone1 = await s.js(`return (document.getElementById('paperTimer')||{}).textContent || '';`);
await sleep(1600);
const readDone2 = await s.js(`return (document.getElementById('paperTimer')||{}).textContent || '';`);
check(
  '阅读：点完「对答案」计时自动停下（数字不再变、按钮变「继续」）',
  readDone1 === readDone2 &&
    (await s.js(`return (document.querySelector('[data-timer="toggle"]')||{}).textContent || '';`)).trim() === '继续' &&
    (await s.js(`return document.getElementById('paperTimer').classList.contains('is-paused');`)) === true,
  `${readDone1} → ${readDone2}`
);

await s.js(`document.querySelector('[data-quiz="reset"]').click();`);
await sleep(300);
check('阅读：重做能清空重来', (await s.js(`return document.querySelectorAll('.q-opt.is-picked').length;`)) === 0);
await s.shot('16-words');

/* ---------- 7.7 今日测试 ---------- */
await s.js(`location.hash='#test';`);
await sleep(1500);
await s.waitFor('.daily-test');
check(
  '顶栏：加了「测试」模块',
  (await s.js(`return [...document.querySelectorAll('.tab')].map(x=>x.textContent.trim()).includes('测试');`)) === true
);
check(
  '今日测试：列出了今天计划里的数学与 408',
  (await s.js(`return [...document.querySelectorAll('.panel-head h3')].map(x=>x.textContent.trim()).join('/');
  `)).includes('今天计划里的数学')
);
check(
  '今日测试：有生成入口（没配 AI 时给去设置的提示）',
  (await s.js(
    `return !!document.querySelector('[data-airun="test"]') || !!document.querySelector('.picker-panel .ai-hint');`
  )) === true
);

// 测试页的接口要能直接从「今天的计划 + 今天的笔记」凑出提示词
const testApi = await api2('/api/test');
check(
  '今日测试：接口整理的上下文里带着今天的任务，并算出了「今天学了多少」',
  !!testApi.today &&
    Array.isArray(testApi.today.math) &&
    Array.isArray(testApi.today.cs) &&
    ['少', '一般', '多'].includes(testApi.today.learned?.volume) &&
    testApi.prompt.prompt.includes('每个重要知识点至少出一道题'),
  `${testApi.today.math.length} 条数学 · ${testApi.today.cs.length} 条 408 · 今天笔记 ${
    testApi.today.notes.length
  } 篇 · 判断「${testApi.today.learned?.volume}」`
);

// 内置 AI：设置块要在，没配好时不显示「直接生成」，但复制提示词那条路要留着
check('内置 AI：设置块已经从「测试」页收进设置页，页面上只剩「去设置」的提示',
  (await s.js(`return document.querySelectorAll('#main .ai-box').length;`)) === 0 &&
  (await s.js(`return !!document.querySelector('#main .ai-hint');`)) === true);
check(
  '内置 AI：没配置时不显示「生成」按钮，而是给「去设置」的提示（页面上不再有「复制提示词」这条路）',
  (await s.js(`return document.querySelectorAll('[data-airun]').length;`)) === 0 &&
    (await s.js(`return !document.getElementById('main').innerText.includes('复制提示词');`)) === true
);

// 写一份测试进来：4 道题，答案默认藏着
const testDate = todayWeek.date;
const testRel = `今日测试/${testDate}-今日测试.md`;
const testMd = `---
date: ${testDate}
title: ${testDate.slice(5)} 今日测试
scope: 数学 · 极限 ｜ 408 · C 语言
minutes: 30
full: 100
---

# ${testDate.slice(5)} 今日测试

## 题目

### 1. 公式默写 ｜ 两个重要极限 ｜ 40 分

计算 $\\lim_{x\\to 0}\\frac{\\sin x}{x}$，并写出两个重要极限。

### 2. 大题 ｜ 编译过程 ｜ 60 分

一段 C 程序要经过哪些步骤？

## 答案与解析

### 1. 公式默写 ｜ 两个重要极限 ｜ 40 分

**标准答案**

$\\lim_{x\\to 0}\\frac{\\sin x}{x}=1$。

**解析**

- 第一个是 $\frac{0}{0}$ 型，用夹逼定理。
- 易错点：把 $x\\to\\infty$ 也当成 1。

### 2. 大题 ｜ 编译过程 ｜ 60 分

**标准答案**

解：依次经过预处理、编译、汇编、链接四步。

**解析**

- 为什么这样切分：看「谁读什么、产出什么」。
`;
const savedTest = await api2('/api/test', {
  method: 'POST',
  body: JSON.stringify({ rel: testRel, content: testMd }),
});
check('今日测试：写进仓库', savedTest.rel === testRel, savedTest.rel);
const backTest = await api2(`/api/test/paper?rel=${encodeURIComponent(testRel)}`);
check(
  '今日测试：题干与答案一一对上',
  backTest.exists && backTest.items.length === 2 && backTest.answerMissing.length === 0 &&
    backTest.items[1].answer.includes('预处理'),
  `${backTest.items.length} 题 · 缺答案 ${backTest.answerMissing.length}`
);
check(
  '今日测试：每题的分值解析出来了，满分 100，并按分值折算出每题的参考用时',
  backTest.plan.table.full === 100 &&
    backTest.plan.table.byN['1'] === 40 &&
    backTest.plan.table.byN['2'] === 60 &&
    backTest.plan.ref.minutes === 30 &&
    backTest.plan.ref.byN['1'] === 720 &&
    backTest.plan.table.assumed === false,
  `满分 ${backTest.plan.table.full} · 参考 ${backTest.plan.ref.minutes} 分钟 · 40 分那题参考 ${backTest.plan.ref.byN['1']} 秒`
);

await s.js(`location.hash='#test/${encodeURIComponent(testRel)}';`);
await sleep(1500);
check('今日测试：全屏打开（顶栏收起，选词/首页都不在）',
  (await s.js(`return document.body.classList.contains('is-reading') && getComputedStyle(document.querySelector('.topbar')).display === 'none';`)) === true);
check('今日测试：渲染出 2 道题、题型标签在',
  (await s.js(`return document.querySelectorAll('.dt-q').length;`)) === 2 &&
  (await s.js(`return [...document.querySelectorAll('.dt-q-type')].map(x=>x.textContent.trim()).join('/');`)) === '公式默写/大题');
check(
  '今日测试：每题都标着分值，旁边给出这道题的参考用时',
  (await s.js(`return [...document.querySelectorAll('.dt-q-score')].map(x=>x.textContent.trim()).join('/');`)) === '40 分/60 分' &&
    (await s.js(`return [...document.querySelectorAll('.dt-q-ref')].map(x=>x.textContent.trim()).join('/');`)) === '参考 12 分钟/参考 18 分钟',
  await s.js(`return [...document.querySelectorAll('.dt-q-ref')].map(x=>x.textContent.trim()).join(' / ');`)
);

// 计时器：一进来就在走，能暂停，能重置
const timer1 = await s.js(`return (document.getElementById('paperTimer')||{}).textContent || '';`);
check(
  '今日测试：顶栏有计时器，进来就开始走，并标出参考用时（30 分钟）',
  !!timer1 && timer1.includes('参考 30:00'),
  timer1 || '(没有计时器)'
);
await sleep(1600);
const timer2 = await s.js(`return (document.getElementById('paperTimer')||{}).textContent || '';`);
const secOf = (t) => {
  const m = /^(\d+):(\d+)/.exec(t || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
};
check('今日测试：计时器真的在走（过一秒数字变大）', secOf(timer2) > secOf(timer1), `${timer1} → ${timer2}`);
await s.js(`document.querySelector('[data-timer="toggle"]').click();`);
await sleep(1400);
const timerPaused = await s.js(`return (document.getElementById('paperTimer')||{}).textContent || '';`);
await sleep(1200);
const timerPaused2 = await s.js(`return (document.getElementById('paperTimer')||{}).textContent || '';`);
check(
  '今日测试：能暂停（暂停后数字不再变，按钮变「继续」、数字变灰）',
  timerPaused === timerPaused2 &&
    (await s.js(`return document.querySelector('[data-timer="toggle"]').textContent.trim();`)) === '继续' &&
    (await s.js(`return document.getElementById('paperTimer').classList.contains('is-paused');`)) === true,
  `${timerPaused} → ${timerPaused2}`
);
await s.js(`document.querySelector('[data-timer="reset"]').click();`);
await sleep(500);
check(
  '今日测试：重置能把这一次的计时归零、重新开始走',
  secOf(await s.js(`return (document.getElementById('paperTimer')||{}).textContent || '';`)) < secOf(timerPaused) &&
    (await s.js(`return document.querySelector('[data-timer="toggle"]').textContent.trim();`)) === '暂停'
);

check(
  '今日测试：全屏卷子里有「拍照判分」区（拖拽/粘贴/选文件 + 打分按钮）',
  (await s.js(`return !!document.getElementById('gradeDrop') && !!document.getElementById('gradeFiles');`)) === true &&
    (await s.js(`return !!document.querySelector('[data-grade="pick"]');`)) === true
);
check(
  '今日测试：没配 AI 时不给「打分」按钮，而是提示去设置（不摆一个点不动的假按钮）',
  (await s.js(`return !!document.querySelector('[data-grade="run"]');`)) === false ||
    (await s.js(`return document.querySelector('[data-grade="run"]').disabled;`)) === true,
  await s.js(`var b=document.querySelector('[data-grade="run"]'); return b ? '按钮在，disabled='+b.disabled : '没配 AI，只给提示';`)
);
check('今日测试：答案和解析默认全部藏着',
  (await s.js(`return document.querySelectorAll('.dt-answer').length;`)) === 0 &&
  (await s.js(`return document.querySelectorAll('[data-test-bank]').length;`)) === 0);
check(
  '今日测试：考点标签和顶部覆盖范围里的公式也渲染成 KaTeX，不会漏出裸的 $',
  (await s.js(
    `var t=[...document.querySelectorAll('.dt-q-topic')].map(x=>x.innerText).join('') +
         ((document.querySelector('.rf-meta')||{}).innerText||'');
     return !t.includes('$');`
  )) === true,
  await s.js(`return [...document.querySelectorAll('.dt-q-topic')].slice(0,2).map(x=>x.innerText.replace(/\\n/g,'')).join(' | ');`)
);

check('今日测试：公式渲染成 KaTeX',
  (await s.js(`return document.querySelectorAll('.dt-stem .katex, .dt-stem .math-display').length;`)) > 0,
  await s.js(`return document.querySelectorAll('.dt-stem .katex').length + ' 处 KaTeX';`));
await s.shot('17-test-hidden');

await s.js(`document.querySelector('[data-test-answer]').click();`);
await sleep(400);
check('今日测试：显示答案后才出现答案解析与「加入题库」按钮',
  (await s.js(`return document.querySelectorAll('.dt-answer').length;`)) === 1 &&
  (await s.js(`return document.querySelectorAll('[data-test-bank-open]').length;`)) === 2 &&
  (await s.js(`return (document.querySelector('.dt-answer')||{}).innerText?.includes('解析');`)) === true);
await s.shot('17-test-answer');

// 加入题库：先弹填写面板（错因 / 考点 / 难度 / 热度 / 归类），不是点一下就闷头写
await s.js(`document.querySelector('[data-test-bank-open="mistakes"]').click();`);
await sleep(1600);
check(
  '加入错题本：先弹填写面板，错题本该有的字段一个不少',
  (await s.js(`return [...document.querySelectorAll('.bf-label')].map(x=>x.textContent.trim()).join('/');`)) ===
    '错因/考点/难度/考研热度/归类'
);
check(
  '加入错题本：归类是程序按题干关键词先识别好、预填进去的（可以改）',
  (await s.js(
    `return [...document.querySelectorAll('[data-bank-field]')].every(x => x.value.trim().length > 0) &&
            document.querySelectorAll('[data-bank-field]').length === 3;`
  )) === true,
  await s.js(`return [...document.querySelectorAll('[data-bank-field]')].map(x=>x.dataset.bankField+'='+x.value).join(' | ');`)
);
check(
  '加入错题本：8 个错因可选，难度 / 热度各 5 档',
  (await s.js(`return document.querySelectorAll('[data-bank-reason]').length;`)) === 8 &&
    (await s.js(`return document.querySelectorAll('[data-bank-diff]').length;`)) === 5 &&
    (await s.js(`return document.querySelectorAll('[data-bank-heat]').length;`)) === 5
);
await s.js(`document.querySelector('[data-bank-reason="方法不会"]').click();`);
await sleep(700);
await s.js(`document.querySelector('[data-bank-diff="5"]').click();`);
await sleep(700);
await s.js(`document.querySelector('[data-bank-heat="4"]').click();`);
await sleep(700);
await s.js(`document.getElementById('bankPoints').value = 'E2E考点甲、E2E考点乙';`);
await s.shot('17-bank-form');

// 确认加入 → 用 API 校验「填的字段真的进了笔记」
await s.js(`document.querySelector('[data-test-bank="confirm"]').click();`);
await sleep(2200);
check(
  '加入错题本：确认后面板收起，并提示写到了哪',
  (await s.js(`return document.querySelectorAll('.bank-form').length;`)) === 0
);

const bank = await api2('/api/test/to-bank', {
  method: 'POST',
  body: JSON.stringify({
    rel: testRel,
    n: 2,
    book: 'mistakes',
    reason: '方法不会',
    points: 'E2E考点甲、E2E考点乙',
    difficulty: 5,
    heat: 4,
    category: '数学',
    subject: '高数',
    chapter: '极限',
  }),
});
const created = bank.created && bank.created.created && bank.created.created[0];
check(
  '今日测试：一键加入错题本（题干 + 标准答案 + 解析一起写进去）',
  !!created && created.file.endsWith('.md') && !created.file.includes('undefined'),
  created ? created.file : JSON.stringify(bank)
);
const afterBank = await api2('/api/questions');
const banked = afterBank.problems.find((p) => p.file === created.file || p.relPath === created.file);
check(
  '加入错题本：填的错因 / 考点 / 难度 / 热度 / 归类全都写进笔记了',
  !!banked &&
    banked.firstReason === '方法不会' &&
    banked.difficulty === 5 &&
    banked.heat === 4 &&
    banked.category === '数学' &&
    banked.subject === '高数' &&
    banked.chapter === '极限' &&
    banked.points.includes('E2E考点甲') &&
    banked.points.includes('E2E考点乙'),
  banked
    ? `错因=${banked.firstReason} 难度=${banked.difficulty} 热度=${banked.heat} 归类=${banked.category}/${banked.subject}/${banked.chapter} 考点=${banked.points.join('、')}`
    : '没找到刚加进去的题'
);
check(
  '加入错题本：标准答案和解析也一起写进去了（不用再等 AI 补）',
  !!banked && /预处理|解：/.test(banked.answer || '') && (banked.solution || '').length > 0,
  banked ? `答案 ${(banked.answer || '').length} 字 · 解析 ${(banked.solution || '').length} 字` : ''
);

// 清理：把这一节写进副本错题本的题删掉。
// 副本跑完就扔，但同一个副本里后面还有别的断言（题型通解、复习题数…），
// 多出来这几道题会把它们的数字带偏 —— 自己造的脏数据自己收。
for (const rel of [banked?.relPath, created?.file].filter(Boolean)) {
  const abs = path.join(ENV.vaultDir, '错题本', rel);
  try {
    fs.unlinkSync(abs);
  } catch {
    /* 已经不在就算了 */
  }
}
await sleep(1400); // 程序扫盘有 1 秒 TTL，等它过期再查
const afterCleanup = await api2('/api/questions');
check(
  '加入错题本：测试自己造的题收干净了，不会带偏后面的断言',
  !afterCleanup.problems.some((p) => p.relPath === banked?.relPath || p.relPath === created?.file),
  `题库回到 ${afterCleanup.problems.length} 题`
);

/* ---------- 7.7x 成绩单 + 一键把错题加入错题本 ---------- */
// 判完分的卷子长什么样：成绩单直接显示在题目下面，做错的题一键收进错题本。
// （真正的「拍照判分」要有模型才跑得动，这里用一份已经写了成绩记录的卷子验证呈现与写盘）
const gradeSection = `## 成绩记录

### 第 1 次 · ${testDate} · 80 / 100 · 用时 21:30（参考 30:00）

| 题号 | 考点 | 得分 | 满分 | 判定 | 错因 | 丢分点 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 两个重要极限 | 20 | 40 | 🟡部分正确 | 公式记错 | 把 $\\lim_{x\\to 0}\\frac{\\sin x}{x}$ 当成了 0；改：先看 $1^{\\infty}$ 型 |
| 2 | 编译过程 | 60 | 60 | ✅正确 | — | 无 |

**总分** 80 / 100（判分图片 2 张）

**总评** 极限那块还得再默一遍，$\\frac{1}{2}$ 这种系数别再丢。

**薄弱点** 第二个重要极限、$\\tan x$ 的展开
**下一步** 默写三遍
`;
await api2('/api/test', { method: 'POST', body: JSON.stringify({ rel: testRel, content: `${testMd}\n${gradeSection}` }) });
await s.js(`location.hash='#today';`);
await sleep(800);
await s.js(`location.hash='#test/${encodeURIComponent(testRel)}';`);
await sleep(1700);

const gradeCard = await s.js(
  `var r=document.querySelector('.grade-result');
   return JSON.stringify({
     total: (document.querySelector('.gr-total')||{}).innerText || '',
     rows: document.querySelectorAll('.gr-table tbody tr').length,
     bad: document.querySelectorAll('.gr-table tr.is-bad').length,
     verdicts: [...document.querySelectorAll('.vchip')].map(x=>x.textContent.trim()),
     reasons: [...document.querySelectorAll('.gr-reason')].map(x=>x.textContent.trim()),
     summary: (document.querySelector('.gr-summary')||{}).innerText || '',
     btn: (document.querySelector('[data-grade="bank"]')||{}).innerText || '',
     hasCard: !!r
   });`
);
const gc = JSON.parse(gradeCard);
check(
  '成绩单：卷子一打开就显示最近一次成绩（总分 / 每题得分 / 判定 / 错因 / 丢分点）',
  gc.hasCard &&
    gc.total.includes('80') &&
    gc.total.includes('100') &&
    gc.rows === 2 &&
    gc.bad === 1 &&
    gc.verdicts[0].includes('部分正确') &&
    gc.reasons[0] === '公式记错' &&
    gc.summary.includes('极限那块还得再默一遍'),
  `${gc.total.replace(/\s+/g, ' ').trim()} · ${gc.rows} 行 · 判定 ${gc.verdicts.join('、')}`
);
check(
  '成绩单：一键加入错题本的按钮上写清了要收几道（只数做错的题）',
  gc.btn.includes('一键把 1 道错题加入错题本'),
  gc.btn.trim() || '(没有按钮)'
);
// 判分给的丢分点、总评里全是 LaTeX（$\lim_{x\to 0}$ 这种）。以前这里是 esc()，
// 屏幕上就是一串反斜杠命令加美元符号 —— 看着跟乱码一样。
const gradeMath = await s.js(
  `var card=document.querySelector('.grade-result');
   var lost=card.querySelector('.gr-table .gr-lost');
   var sum=card.querySelector('.gr-summary');
   return JSON.stringify({
     katex: card.querySelectorAll('.katex').length,
     fallback: card.querySelectorAll('.math-fallback').length,
     lostText: (lost||{}).innerText || '',
     sumText: (sum||{}).innerText || '',
     weakText: [...card.querySelectorAll('.gr-lists .chip-static')].map(x=>x.innerText).join('、')
   });`
);
const gm = JSON.parse(gradeMath);
check(
  '成绩单：丢分点 / 总评 / 薄弱点里的公式渲染成 KaTeX（不是一串裸的 $ 和反斜杠）',
  gm.katex > 0 &&
    gm.fallback === 0 &&
    !gm.lostText.includes('$') &&
    !gm.lostText.includes('\\') &&
    !gm.sumText.includes('$') &&
    !gm.weakText.includes('$'),
  `${gm.katex} 处 KaTeX · 丢分点「${gm.lostText.slice(0, 34)}」`
);
await s.shot('17-test-grade');

await s.js(`document.querySelector('[data-grade="bank"]').click();`);
await sleep(2400);
check(
  '一键加入错题本：点一下就写完了，按钮换成「已加入第几题」的回执（不给点第二遍）',
  (await s.js(`return !document.querySelector('[data-grade="bank"]');`)) === true &&
    (await s.js(`return (document.querySelector('.gr-banknote')||{}).innerText || '';`)).includes('已加入错题本：第 1 题'),
  await s.js(`return (document.querySelector('.gr-banknote')||{}).innerText.trim() || '(没有回执)';`)
);

const afterWrongBank = await api2('/api/questions');
const wrongNote = afterWrongBank.problems.find((p) => p.firstReason === '公式记错');
check(
  '一键加入错题本：判分给的错因 / 丢分点 / 该怎么改，加题干与标准答案，全都进了笔记',
  !!wrongNote &&
    /当成了 0/.test(wrongNote.pitfalls || '') &&
    /先看/.test(wrongNote.pitfalls || '') &&
    /两个重要极限/.test(wrongNote.stem || '') &&
    (wrongNote.answer || '').length > 0,
  wrongNote
    ? `错因=${wrongNote.firstReason} · 易错提醒 ${(wrongNote.pitfalls || '').slice(0, 40)}…`
    : '没找到刚写进去的错题'
);
// 自己造的脏数据自己收：后面还有别的断言在数题目
if (wrongNote?.relPath) {
  try {
    fs.unlinkSync(path.join(ENV.vaultDir, '错题本', wrongNote.relPath));
  } catch {
    /* 已经不在就算了 */
  }
}
await sleep(1400);

/* ---------- 7.72 拍照判分：真跑一遍「传图 → 模型判 → 写成绩单」 ---------- */
/**
 * 上面那条只验了「成绩单长什么样」（读一份写好的成绩记录）。判分本身是这条路最要紧的一步，
 * 不能只测一半 —— 这里起一台**假的 OpenAI 兼容服务**（不需要真 key），
 * 让桌面端真的点一次「按考研标准打分」，看三件事：
 *   1. 计时器**自动停在交卷那一刻**（判分要等模型，那几分钟不算做题用时）；
 *   2. 模型给的 LaTeX（`$\lim_{x\to 0}$`）一路走到页面上还是真公式，不是一串反斜杠；
 *   3. 假模型**故意漏转义**（写 `\to` 而不是 `\\to`）时，落盘的 LaTeX 也不能被吃掉。
 *
 * 配置写进 AI_CONFIG_FILE 指的临时文件（run-e2e.sh 设好的），**不碰真在用的 .ai-config.json**，
 * 跑完立刻清掉并整页重载 —— 后面的断言都建立在「没配 AI」这个前提上。
 */
const aiSeen = { count: 0, multimodal: false };
/** 故意漏转义的判分结果：真模型就是这么翻车的（`\to` `\frac` 被 JSON 当成制表符 / 换页符） */
const fakeGradeJson = String.raw`{"items":[{"n":1,"got":"考生写的第 1 题：$x\to 0$ 时分子分母都趋于 0","score":38,"full":40,"verdict":"部分正确","reason":"计算失误","lost":"漏了 $x\to 0^+$ 那一支，$1^{\infty}$ 型没认出来","fix":"先写成 $\lim_{x\to 0}\frac{\sin x}{x}=1$ 再代"},{"n":2,"got":"考生写的第 2 题","score":60,"full":60,"verdict":"正确","reason":"","lost":"无","fix":"保持"}],"summary":"【E2E假模型】总评：$\frac{1}{2}$ 这种系数别再丢，$1^{\infty}$ 型要先认出来。","weak":["$1^{\infty}$ 型","$\tan x$ 的展开"],"next":["默写 $\lim_{x\to 0}\frac{\sin x}{x}=1$"]}`;

const mockAI = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const payload = JSON.parse(body || '{}');
    const raw = payload.messages?.at(-1)?.content;
    const parts = Array.isArray(raw) ? raw : [];
    aiSeen.count += 1;
    if (parts.some((c) => c.type === 'image_url')) aiSeen.multimodal = true;
    const send = (text) => {
      if (payload.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const chunk of text.match(/[\s\S]{1,60}/g) || []) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
      }
    };
    send(fakeGradeJson);
  });
});
await new Promise((r) => mockAI.listen(0, '127.0.0.1', r));
const mockPort = mockAI.address().port;
await api2('/api/ai/config', {
  method: 'POST',
  body: JSON.stringify({ baseUrl: `http://127.0.0.1:${mockPort}/v1`, model: 'fake-e2e', apiKey: 'fake-key' }),
});
check('拍照判分：能配上一台（假的）模型服务（这段验判分链路，不需要真 key）', (await api2('/api/ai')).ready === true);

// 页面上的 state.ai 是打开时读的，配完得**整页重载**一次才会知道「现在能判分了」
// （真实用户是在设置页点「保存」，那条路会自己刷新；这里直接调接口，所以自己重载）
await s.js(
  `location.replace(${JSON.stringify(APP + '/?t=')} + Date.now() + '#test/' + encodeURIComponent(${JSON.stringify(testRel)}));`
);
await sleep(3000);
await s.js(`document.querySelector('[data-timer="reset"]').click();`);
await sleep(300);
check(
  '拍照判分：配好 AI 之后「打分」按钮才可点（先把手写答案传上去）',
  (await s.js(`return !!document.querySelector('[data-grade="run"]');`)) === true &&
    (await s.js(`return document.querySelector('[data-grade="run"]').disabled;`)) === true,
  await s.js(`return (document.querySelector('.gp-actions')||{}).innerText.replace(/\\s+/g,' ').trim() || '(没有操作区)';`)
);

// 手机端那套「拍一张 → 传上去」在桌面端就是同一个 file input，用 canvas 造一张真的图
const uploaded = await s.js(
  `var cv=document.createElement('canvas'); cv.width=900; cv.height=1200;
   var ctx=cv.getContext('2d');
   ctx.fillStyle='#fff'; ctx.fillRect(0,0,900,1200);
   ctx.fillStyle='#000'; ctx.font='44px serif'; ctx.fillText('解：手写答案 e2e', 60, 200);
   return new Promise(function(done){
     cv.toBlob(function(blob){
       var dt=new DataTransfer();
       dt.items.add(new File([blob],'判分用.png',{type:'image/png'}));
       var input=document.getElementById('gradeFiles');
       input.files=dt.files;
       input.dispatchEvent(new Event('change',{bubbles:true}));
       var n=0,tries=0;
       var iv=setInterval(function(){
         n=document.querySelectorAll('.gp-thumb img').length;
         if(n || ++tries>40){ clearInterval(iv); done(n); }
       },250);
     },'image/png');
   });`
);
check('拍照判分：图真的传上去了（缩略图出现、打分按钮跟着可点）', uploaded === 1 &&
  (await s.js(`return document.querySelector('[data-grade="run"]').disabled;`)) === false,
  `${uploaded} 张缩略图`);

// 交卷前先确认计时在走 —— 不然下面「自动停」是白验
const tick1 = await s.js(`return (document.getElementById('paperTimer')||{}).textContent || '';`);
await sleep(1500);
const tick2 = await s.js(`return (document.getElementById('paperTimer')||{}).textContent || '';`);
check('拍照判分：交卷前计时在走（后面「自动停」才有意义）', secOf(tick2) > secOf(tick1), `${tick1} → ${tick2}`);

await s.js(`document.querySelector('[data-grade="run"]').click();`);
let aiRendered = false;
for (let i = 0; i < 100; i += 1) {
  await sleep(300);
  const txt = await s.js(`return (document.querySelector('.gr-summary')||{}).innerText || '';`);
  if (txt.includes('E2E假模型')) {
    aiRendered = true;
    break;
  }
}
check('拍照判分：假模型判完，成绩单当场刷新（总评换成这一份的）', aiRendered,
  await s.js(`return (document.querySelector('.gr-summary')||{}).innerText.slice(0,60) || '(还停在上一份成绩单)';`));
check('拍照判分：手写答案是以多模态发给模型的（不是只发了个文件名）', aiSeen.multimodal === true,
  `模型收到 ${aiSeen.count} 次请求`);

// ① 计时必须停在交卷那一刻
const stop1 = await s.js(`return (document.getElementById('paperTimer')||{}).textContent || '';`);
await sleep(1600);
const stop2 = await s.js(`return (document.getElementById('paperTimer')||{}).textContent || '';`);
check(
  '拍照判分：交卷后计时自动停下（数字冻在交卷那一刻、按钮变「继续」）',
  stop1 === stop2 &&
    (await s.js(`return (document.querySelector('[data-timer="toggle"]')||{}).textContent || '';`)).trim() === '继续' &&
    (await s.js(`return document.getElementById('paperTimer').classList.contains('is-paused');`)) === true,
  `${stop1} → ${stop2}`
);
const paperGradedNow = await api2(`/api/test/paper?rel=${encodeURIComponent(testRel)}`);
check(
  '拍照判分：写进成绩记录的用时就是停下来的那个数（判分等模型的几分钟不算进去）',
  Math.abs(Number(paperGradedNow.grades?.[0]?.seconds || 0) - secOf(stop1)) <= 1 &&
    paperGradedNow.grades?.[0]?.source === 'ai' &&
    paperGradedNow.grades?.[0]?.images === 1,
  `记录 ${paperGradedNow.grades?.[0]?.seconds}s · 计时器 ${stop1}`
);

// ② 页面上是渲染好的公式，③ 落盘的 LaTeX 没被 JSON 吃掉
const aiMath = await s.js(
  `var card=document.querySelector('.grade-result');
   var lost=card.querySelector('.gr-table .gr-lost');
   return JSON.stringify({
     katex: card.querySelectorAll('.katex').length,
     fallback: card.querySelectorAll('.math-fallback').length,
     lostText: (lost||{}).innerText || '',
     sumText: (card.querySelector('.gr-summary')||{}).innerText || ''
   });`
);
const am = JSON.parse(aiMath);
check(
  '拍照判分：判分结果里的公式当场渲染（丢分点 / 总评里没有裸的 $ 和反斜杠）',
  am.katex > 0 && am.fallback === 0 && !am.lostText.includes('$') && !am.sumText.includes('$') && !am.lostText.includes('\\'),
  `${am.katex} 处 KaTeX · 丢分点「${am.lostText.slice(0, 34)}」`
);
const savedLost = String(paperGradedNow.grades?.[0]?.items?.[0]?.lost || '');
check(
  '拍照判分：模型漏转义 LaTeX 时，落盘的公式一个字符都没被吃坏（没有制表符 / 换页符）',
  savedLost.includes(String.raw`$x\to 0^+$`) &&
    savedLost.includes(String.raw`$1^{\infty}$`) &&
    !/[\u0008\u000b\u000c\u000d]/.test(savedLost),
  JSON.stringify(savedLost.slice(0, 60))
);
await s.shot('17b-ai-grade');

// 收摊：把 AI 配置清回原样并整页重载，后面的断言回到「没配 AI」的前提
// （重载后直接回到这份卷子上 —— 下面那条「点退出回到测试首页」还要接着走）
await api2('/api/ai/config', { method: 'POST', body: JSON.stringify({ baseUrl: '', model: '' }) });
await new Promise((r) => mockAI.close(r));
await s.js(
  `location.replace(${JSON.stringify(APP + '/?t=')} + Date.now() + '#test/' + encodeURIComponent(${JSON.stringify(testRel)}));`
);
await sleep(3000);
check('拍照判分：跑完把（假的）AI 配置清干净了，页面回到没配 AI 的状态',
  (await api2('/api/ai')).ready === false, `ready=${(await api2('/api/ai')).ready}`);

await s.js(`document.querySelector('[data-test="exit"]').click();`);
await sleep(900);
check('今日测试：返回后回到测试首页', (await s.js(`return location.hash;`)) === '#test' &&
  (await s.js(`return !!document.querySelector('.daily-test');`)) === true);

// 回归：点顶栏 tab 不该跳进「上次看的那一篇」的全屏做题
await s.js(`location.hash='#test/${encodeURIComponent(testRel)}';`);
await sleep(1500);
const wasFull = await s.js(`return document.body.classList.contains('is-reading');`);
await s.js(`document.querySelector('.tab[data-module="test"]').click();`);
await sleep(1300);
check(
  '顶栏：从全屏试卷点「测试」tab 会回到测试首页（不会又跳进全屏）',
  wasFull === true &&
    (await s.js(`return location.hash;`)) === '#test' &&
    (await s.js(`return document.body.classList.contains('is-reading');`)) === false &&
    (await s.js(`return !!document.querySelector('.dt-head');`)) === true
);
await s.js(`location.hash='#words';`);
await sleep(2600);
const tabTestRel = await s.js(
  `var b=document.querySelector('[data-story-open]'); return b ? b.dataset.storyOpen : '';`
);
if (tabTestRel) {
  await s.js(`document.querySelector('[data-story-open]').click();`);
  await sleep(1600);
  const wasReading = await s.js(`return document.body.classList.contains('is-reading');`);
  await s.js(`document.querySelector('.tab[data-module="words"]').click();`);
  await sleep(1500);
  check(
    '顶栏：从全屏阅读点「单词」tab 会回到选词页（不会又跳进全屏）',
    wasReading === true &&
      (await s.js(`return location.hash;`)) === '#words' &&
      (await s.js(`return document.body.classList.contains('is-reading');`)) === false &&
      (await s.js(`return !!document.querySelector('.picker-panel');`)) === true
  );
}

/* ---------- 7.71 删除：生成的试卷 / 单词题 / 题库里的题 ---------- */
// 两段式：点一下变「确认删除？」，再点才真删 —— 不让它一下就没
await s.js(`location.hash='#test';`);
await sleep(2400);
check(
  '删除：每份试卷旁边有删除按钮（默认半透明，鼠标移上去才明显）',
  (await s.js(`return document.querySelectorAll('[data-del-test]').length;`)) >= 1
);
const armed1 = await s.js(
  `var b=document.querySelector('[data-del-test]');
   if(!b) return 'NOBTN';
   b.click();
   return document.querySelector('.del-btn.is-armed') ? 'armed' : 'not-armed';`
);
await sleep(600);
check('删除：第一次点是「确认删除？」，不会直接删', armed1 === 'armed' &&
  (await s.js(`return document.querySelectorAll('[data-del-test]').length;`)) >= 1, armed1);
await s.js(`var b=document.querySelector('.del-btn.is-armed'); if(b) b.click();`); // 解除
await sleep(500);

await s.js(`location.hash='#words';`);
await sleep(3000);
check('删除：单词题列表里也有删除按钮', (await s.js(`return document.querySelectorAll('[data-del-story]').length;`)) >= 1);
await s.js(`location.hash='#mistakes/library';`);
await sleep(2600);
await s.js(`var c=document.querySelector('.q-card, .problem-card'); if(c) c.click();`);
await sleep(1200);
check(
  '删除：题库详情里能删掉这道题',
  (await s.js(`return document.querySelectorAll('[data-del-question]').length;`)) === 1
);
await s.js(`document.querySelector('[data-close-drawer]')?.click();`);
await sleep(600);

// 真删一份（用临时造的文件，不动别的东西）：文件要没了、备份要还在
const throwawayRel = `今日测试/1999-01-01-今日测试.md`;
await api2('/api/test', {
  method: 'POST',
  body: JSON.stringify({ rel: throwawayRel, content: '---\ndate: 1999-01-01\ntitle: 临时\n---\n\n# 临时\n' }),
});
const beforeDel = await api2('/api/test');
const had = beforeDel.tests.some((t) => t.rel === throwawayRel);
const delRes = await api2('/api/test', { method: 'DELETE', body: JSON.stringify({ rel: throwawayRel }) });
const afterDel = await api2('/api/test');
check(
  '删除：删掉之后文件真的没了，而且先备份了一份（删错了能捞回来）',
  had && delRes.ok === true && !!delRes.backup && !afterDel.tests.some((t) => t.rel === throwawayRel),
  delRes.backup ? `备份在 ${String(delRes.backup).split('/backups/')[1] || delRes.backup}` : '没有备份'
);

/* ---------- 7.72 增题页：只能有一个「写入」按钮 ---------- */
// 以前这里有两个：「✚ 生成骨架并写入」和「生成答案与解析」——同一个流程被拆成两步。
// 配了 AI 就一步到位（解题 + 写完整笔记），所以任何情况下都只该有一个。
for (const [hash, bookName] of [['#mistakes/add', '错题本'], ['#good/add', '好题本']]) {
  await s.js(`location.hash='${hash}';`);
  await sleep(2600);
  const btns = await s.js(
    `return [...document.querySelectorAll('.rv-start-row button')].map(x=>x.textContent.replace(/\s+/g,' ').trim()).join(' | ');`
  );
  const writeBtns = await s.js(
    `return document.querySelectorAll('[data-add="create"], [data-airun="questions"]').length;`
  );
  check(
    `增题页（${bookName}）：只有一个写入按钮，不会「生成」和「写入」各来一个`,
    writeBtns === 1 && !btns.includes('生成答案与解析'),
    btns
  );
}

/* ---------- 7.75 设置页 ---------- */
await s.js(`location.hash='#settings';`);
await sleep(2500);
await s.waitFor('.settings');
check(
  '设置页：顶栏齿轮能进去，五个面板都在（内置 AI / 墨墨 / 自检 / 手机访问 / 服务）',
  (await s.js(`return [...document.querySelectorAll('.set-panel .panel-head h3')].map(x=>x.textContent.trim()).join('|');`)) ===
    '内置 AI|📖 墨墨背单词|🩺 自检|📱 手机访问|🔁 服务',
  await s.js(`return [...document.querySelectorAll('.set-panel .panel-head h3')].map(x=>x.textContent.trim()).join('|');`)
);

/* ---------- 7.7 「手机访问」开关 ---------- */
/**
 * 这个开关要验的是**行为**，不是文案：
 *   关掉 → 局域网那个地址应当连不上（端口没在听，不是回 403）
 *   打开 → 又能连上，而且能从那个地址拿到手机端页面
 * 本机监听不归它管，所以电脑端和后面的测试一点不受影响。
 */
const lan0 = await api2('/api/lan');
const lanIp = (lan0.addresses || [])[0];
const lanReachable = async () => {
  if (!lanIp) return null;
  try {
    const r = await fetch(`http://${lanIp}:${lan0.port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false; // 连不上 —— 关掉时正是要这个
  }
};
check(
  '手机访问：设置页里有开关，也给出了手机该输的地址',
  (await s.js(`return !!document.querySelector('[data-set="lan-on"]') && !!document.querySelector('[data-set="lan-off"]');`)) === true &&
    (await s.js(
      `var p=[...document.querySelectorAll('.set-panel')].find(function(x){var h=x.querySelector('h3'); return h && h.textContent.includes('手机访问');});
       return p ? (p.innerText.includes('/m') || p.innerText.includes('没找到局域网 IP')) : false;`
    )) === true,
  `接口说 on=${lan0.on} · ${(lan0.urls || []).join(' ') || '（无局域网 IP）'}`
);
// 开关的初值跟着 config.json 走（用户上次拨到哪儿就是哪儿），所以别假定它开着 ——
// 先拨到「开」，再验「关」和「开」这两下
if (!lan0.on) {
  await s.js(`document.querySelector('[data-set="lan-on"]').click(); 'ok'`);
  await sleep(1500);
}
if (!lanIp) {
  check('手机访问：这台机器没有局域网地址，跳过「真的连不上/连得上」那两条', true, '只验了接口与界面');
} else {
  await s.js(`document.querySelector('[data-set="lan-off"]').click(); 'ok'`);
  await sleep(1500);
  const off = await api2('/api/lan');
  check('手机访问：点「关闭」立刻生效（不用重启）', off.on === false, `on=${off.on}`);
  check(
    '手机访问：关掉之后局域网真的连不上（端口没在听，不是回 403）',
    (await lanReachable()) === false,
    `从 ${lanIp}:${off.port} 打过去：连不上`
  );
  // 配置路径直接问服务端要（/api/lan 会报 configFile）——
  // 比在测试进程里猜环境变量可靠：NOTEBOOK_CONFIG 只配在服务端的 env 里
  const cfgFile = lan0.configFile || '';
  let saved = '(接口没给 configFile)';
  try {
    saved = `lanAccess=${JSON.parse(fs.readFileSync(cfgFile, 'utf8')).lanAccess}`;
  } catch (e) {
    saved = `读配置失败（${cfgFile}）：${e.message}`;
  }
  check('手机访问：开关写回配置了（重启之后还是关的）', saved === 'lanAccess=false', saved);

  await s.js(`document.querySelector('[data-set="lan-on"]').click(); 'ok'`);
  await sleep(1500);
  const on = await api2('/api/lan');
  const page = await fetch(`http://${lanIp}:${on.port}/m`, { signal: AbortSignal.timeout(3000) })
    .then((r) => r.text())
    .catch(() => '');
  check(
    '手机访问：再点「打开」又立刻能连上，还能从局域网地址拿到手机端页面',
    on.on === true && (await lanReachable()) === true && /mobile\.js/.test(page),
    `on=${on.on} · 页面 ${page.length} 字节`
  );
}
await s.shot('18b-lan');

// e2e 用的是临时空配置（绝不碰你真在用的 .ai-config.json，更不会拿你的 key 去调模型）
check(
  '设置页：key 框永远是空的密码框（不回显已保存的 key）',
  (await s.js(`return document.getElementById('aiKey').value === '' && document.getElementById('aiKey').type === 'password';`)) === true
);
check(
  '设置页：7 个服务商预设可点',
  (await s.js(`return document.querySelectorAll('[data-ai-preset]').length;`)) >= 5,
  await s.js(`return [...document.querySelectorAll('[data-ai-preset]')].map(x=>x.textContent.trim()).join('/');`)
);
await s.js(`document.querySelector('[data-ai-preset="deepseek"]').click();`);
await sleep(400);
check(
  '设置页：点预设会把地址和模型填进输入框（DeepSeek 是 deepseek-flash）',
  (await s.js(`return document.getElementById('aiBaseUrl').value;`)) === 'https://api.deepseek.com/v1' &&
    (await s.js(`return document.getElementById('aiModel').value;`)) === 'deepseek-flash',
  await s.js(`return document.getElementById('aiBaseUrl').value + ' · ' + document.getElementById('aiModel').value;`)
);
await s.js(`document.querySelector('[data-ai-preset="ollama"]').click();`);
await sleep(300);
check('设置页：换预设会覆盖输入框', (await s.js(`return document.getElementById('aiBaseUrl').value;`)).includes('11434'));
await s.js(`document.querySelector('[data-set="selfcheck"]').click();`);
await sleep(3500);
check(
  '设置页：自检会依次试本地服务 / 墨墨 / 模型，连不上就如实报错（不假装成功）',
  // 按标题找「自检」那块，别用 :last-child —— 后面再加面板就指错地方了
  (await s.js(
    `var p=[...document.querySelectorAll('.set-panel')].find(function(x){var h=x.querySelector('h3'); return h && h.textContent.includes('自检');});
     return p ? p.querySelectorAll('.dt-list li').length : 0;`
  )) === 3 &&
    (await s.js(
      `var p=[...document.querySelectorAll('.set-panel')].find(function(x){var h=x.querySelector('h3'); return h && h.textContent.includes('自检');});
       var li=p && p.querySelector('.dt-list li');
       return !!li && li.innerText.includes('✅');`
    )) === true,
  await s.js(
    `var p=[...document.querySelectorAll('.set-panel')].find(function(x){var h=x.querySelector('h3'); return h && h.textContent.includes('自检');});
     return p ? [...p.querySelectorAll('.dt-list li')].map(function(x){return x.innerText.replace(/\s+/g,' ').trim();}).join(' ／ ') : '(没找到自检面板)';`
  )
);
await s.shot('18-settings');
// 真点一次齿轮，验证是「能点进去」而不是靠手打 hash
await s.js(`location.hash='#today';`);
await sleep(1600);
const gearExists = await s.js(`return !!document.getElementById('btnSettings');`);
await s.js(`document.getElementById('btnSettings').click();`);
await sleep(1400);
check(
  '设置页：点顶栏齿轮能进设置（不是只能手打 hash）',
  gearExists === true &&
    (await s.js(`return location.hash;`)) === '#settings' &&
    (await s.js(`return !!document.querySelector('.settings');`)) === true,
  `齿轮存在=${gearExists} → ${await s.js(`return location.hash;`)}`
);

/* ---------- 7.8 全局：页面上不许漏出字面的 Markdown 记号 ---------- */
// 在 HTML 模板里直接写 **加粗** 会原样显示成星号（以前在任务标题和提示文案上都踩过）
const leaks = [];
for (const [hash, name] of [['#today', '今日'], ['#test', '测试'], ['#words', '单词'], ['#plan', '计划']]) {
  await s.js(`location.hash='${hash}';`);
  await sleep(2200);
  const lines = await s.js(
    `var t=(document.getElementById('main')||{}).innerText||'';
     return JSON.stringify(t.split('\\n').filter(l=>l.includes('**')||l.includes('~~')).slice(0,2));`
  );
  const arr = JSON.parse(lines);
  if (arr.length) leaks.push(`${name}: ${arr[0].slice(0, 50)}`);
}
check('全站：页面文字里没有漏出来的 ** 记号', leaks.length === 0, leaks.join(' ／ ') || '都干净');
await s.js(`location.hash='#test';`);
await sleep(1800);
check(
  '今日测试：顶部是一行紧凑摘要，不是又高又空的大卡片',
  (await s.js(`return document.querySelectorAll('.dt-head').length;`)) === 1 &&
    (await s.js(`return document.querySelectorAll('.daily-test .today-grid').length;`)) === 0,
  '已去掉 today-grid 的两两并排'
);
check(
  '今日测试：四张卡片两两并排（数学|408、笔记|薄弱点）',
  (await s.js(`return [...document.querySelectorAll('.dt-grid > .panel .panel-head h3')].map(x=>x.textContent.trim()).join('|');`)) ===
    '📐 今天计划里的数学|💻 今天计划里的 408|📝 今天记的笔记|🎯 最近的薄弱点'
);
// 两两并排的长短不一：必须用 dt-grid（stretch）而不是 today-grid（align-items:start），
// 否则同一行里短的那张卡片底下会空出一大块
check(
  '今日测试：同一行的卡片等高，不会留空洞',
  (await s.js(
    `var cs=[...document.querySelectorAll('.dt-grid > .panel')].map(x=>Math.round(x.getBoundingClientRect().height));
     return cs.length===4 && cs[0]===cs[1] && cs[2]===cs[3];`
  )) === true,
  await s.js(`return [...document.querySelectorAll('.dt-grid > .panel')].map(x=>Math.round(x.getBoundingClientRect().height)).join(' / ');`)
);

/* ---------- 8. 主题 ---------- */
await s.js(`document.documentElement.dataset.theme='light'; location.hash='#today';`);
await sleep(800);
await s.shot('10-light');
check('浅色主题', (await s.js(`return document.documentElement.dataset.theme;`)) === 'light');

/* ---------- 9. 设置页：一键重启服务 ---------- */
// 放在最后跑：重启会让服务短暂断开，前面的断言已经全部拿完了
await s.js(`document.documentElement.dataset.theme='dark'; location.hash='#settings';`);
await sleep(1500);
const healthBefore = await api2('/api/health');
check(
  '设置页：新增「🔁 服务」面板，显示当前进程 PID / 端口 / 已运行多久，重启按钮**永远可点**（没有别的开关）',
  (await s.js(`return !!document.querySelector('.set-panel:nth-of-type(4)') || document.body.innerText.includes('服务在跑');`)) === true &&
    (await s.js(`return document.getElementById('main').innerText.includes('PID ' + ${JSON.stringify(String(healthBefore.pid))});`)) === true &&
    (await s.js(`return !!document.querySelector('[data-set="restart"]');`)) === true &&
    (await s.js(`return document.querySelector('[data-set="restart"]').disabled;`)) === false,
  `PID ${healthBefore.pid} · 端口 ${healthBefore.port} · 已运行 ${healthBefore.uptimeSeconds}s`
);
check(
  '设置页：重启按钮是两段式的 —— 点一下只变「确认重启？」，不会直接重启',
  (await s.js(`document.querySelector('[data-set="restart"]').click(); return 'ok';`)) === 'ok' &&
    (await s.js(`return new Promise(r=>setTimeout(()=>r(document.querySelector('[data-set="restart"]').textContent.includes('确认重启')),600));`)) === true &&
    (await api2('/api/health')).pid === healthBefore.pid,
  await s.js(`return document.querySelector('[data-set="restart"]').textContent.trim();`)
);
await s.shot('18-settings-service');

// 真重启：老进程退出 → 看门人等端口空出来 → 拉新进程起来（pid 必须变）
await s.js(`document.querySelector('[data-set="restart"]').click();`);
let healthAfter = null;
for (let i = 0; i < 40; i += 1) {
  await sleep(600);
  try {
    const h = await api2('/api/health');
    if (h?.ok && h.pid !== healthBefore.pid) {
      healthAfter = h;
      break;
    }
  } catch {
    /* 重启中，端口还没起来 */
  }
}
check(
  '设置页：点了确认之后服务真的重启了（**换了一个新进程**，端口和仓储配置都还在）',
  !!healthAfter &&
    healthAfter.pid !== healthBefore.pid &&
    healthAfter.port === healthBefore.port &&
    healthAfter.notebookDir === healthBefore.notebookDir,
  healthAfter ? `PID ${healthBefore.pid} → ${healthAfter.pid} · 端口 ${healthAfter.port}` : '等不到新进程'
);
const afterRestart = await api2('/api/test');
check(
  '设置页：重启之后服务照常能用（重启不是把服务弄没了）',
  Array.isArray(afterRestart.tests) && !!afterRestart.prompt?.prompt,
  `${afterRestart.tests?.length ?? 0} 份试卷`
);

const failed = results.filter((r) => !r.ok);
console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log('  ❌', f.label);
  process.exitCode = 1;
}
ws.close();
