import { mdToHtml, plainText, initMath, inlineMd, richInline } from './markdown.js';

/* ============================================================
   状态
   ============================================================ */
const state = {
  module: 'today',
  viewDate: null, // 首页在看哪一天（null = 今天）；点「本周进度」那排可以翻
  book: 'mistakes',
  patterns: null,
  openPattern: null,
  doc: null,
  docRaw: false,
  sub: 'dashboard',
  view: 'dashboard',
  scope: { category: null, subject: null, chapter: null },
  data: null, // 全量：problems / tree / taxonomy / options
  dataLoading: false, // 缓存被清空后自动补拉中（见 render）
  stats: null, // 当前 scope 的统计
  q: '',
  filters: { status: null, difficulty: null, heat: null, point: null, kind: null },
  openId: null,
  pickerOpen: false,
  solve: { id: null, revealed: false, startedAt: 0, timerId: null, pendingResult: null },
  uploads: [],
  drawerOpenedAt: 0,
  drawerTimerId: null,
  review: {
    phase: 'setup', // setup | run | done
    options: { chapters: [], scope: 'pending', order: 'priority', count: 10 },
    queue: [],
    index: 0,
    revealed: false,
    results: [],
    startedAt: 0,
    questionAt: 0,
    timerId: null,
    pendingResult: null,
  },
  add: { raw: '', mode: 'rule', items: null, busy: false, uploads: [] },
  // study 各模块的数据
  today: null,
  weekly: null,
  plans: null,
  planDetail: null,
  notesTree: null,
  noteDetail: null,
  journals: null,
  journal: null,
  // 单词（墨墨 → 考研英语一题型）
  words: null,
  pick: {
    day: null,
    sources: ['today'], // 默认就是「今天的词池」；想从整个计划里挑再勾「整个计划」
    q: '', // 选词区里的搜索词
    range: 'due200', // 词表显示范围：'due200' = 最快到期的 200 个；'all' = 全部
    rustyMin: 3,
    count: 'auto', // 'auto' = 按题型推荐；数字 = 自定义
    removed: [],
    added: [],
    types: [],
    papers: 1,
    random: false,
    busy: false,
  },
  story: null,
  storyRel: null,
  storyWide: false,
  storyEdit: false,
  storyDraft: null, // 改稿改到一半的正文（重绘后要接着显示，不然几百字白写）
  railTabs: ['题目'], // 英语阅读右侧栏开着哪几个面板（空数组 = 全收起，原文回中间）
  quiz: { answers: {}, graded: false },
  solveVerdict: null, // 单题拍照判分的结论（面板上可以改，改完才记录）
  wordCard: null, // 英语正文里点中的那个词（浮层：本句注释 / 加进墨墨计划）
  // 设置
  selfCheck: null,
  health: null, // 服务状态（pid / 端口 / 已运行多久）—— 设置页的「重启服务」要看它
  restartArmed: false, // 「重启服务」是否处于「确认重启？」状态
  // 内置 AI
  ai: null,
  aiRun: null,
  // 今日测试
  tests: null,
  test: null,
  testRel: null,
  testWide: false,
  testShown: {},
  bankDraft: null, // 加入错题本 / 好题本 前的填写面板
  delArmed: null, // 哪个删除按钮处于「确认删除？」状态
  // 试卷计时器（今日测试 / 英语阅读共用一套）—— 见 enterPaperTimer
  paperTimer: { current: null, timers: {}, id: null },
  // 拍照判分（上传手写答案 → 内置 AI 判分）
  // kind: 'test' = 今日测试整卷；'story' = 英语（只显示本地判卷的成绩单，不拍照）；
  //       'question' = 错题本的单题做题
  grade: { rel: null, kind: 'test', uploads: [], busy: false, progress: null, result: null, error: null, grades: [], bankBusy: false, bankDone: null },
};

const MODULES = ['today', 'test', 'words', 'mistakes', 'good', 'patterns', 'plan', 'journal', 'doc', 'settings'];
const BOOK_OF = { mistakes: 'mistakes', good: 'good' };
const SUBVIEWS = ['dashboard', 'library', 'drill', 'add', 'solve'];
const MODULE_LABEL = { today: '今日', test: '测试', settings: '设置', words: '单词', mistakes: '错题', good: '好题', patterns: '题型', plan: '计划', journal: '复盘' };

/** 词池来源的优先级（合并去重时按这个顺序挑「第一次出现」的那条） */
const SOURCE_ORDER = ['today', 'new', 'rusty', 'sticking', 'added', 'plan'];

/** 错因词表（与后端 taxonomy.mjs 保持一致） */
const REASONS = ['概念不清', '方法不会', '思路方向错', '计算失误', '审题错误', '公式记错', '粗心大意', '时间不够'];

const PALETTE = ['#6d8cff', '#3fb950', '#e3b341', '#f85149', '#a371f7', '#39c5cf', '#ff8c42'];

// 三种状态：做了就「已复习」并按遗忘曲线排下一次；到日子自动变「待复习」
const STATUS_META = {
  待复习: { cls: 'badge-due', text: '⏰ 待复习', cls2: 's-due' },
  已复习: { cls: 'badge-done', text: '✅ 已复习', cls2: 's-done' },
  未做: { cls: 'badge-none', text: '⭕ 未做', cls2: 's-none' },
};
const statusMeta = (s) => STATUS_META[s] || STATUS_META['未做'];

/** 秒 → 「3:12」/「1分20秒」 */
const fmtSec = (n) => {
  if (n == null || !Number.isFinite(n)) return '—';
  const s = Math.round(n);
  if (s < 60) return `${s} 秒`;
  return `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒`;
};
const fmtClock = (n) => (n == null ? '—' : `${Math.floor(n / 60)}:${String(Math.round(n) % 60).padStart(2, '0')}`);

/** 秒 → 「54 秒」/「4 分钟」（每题旁边的参考用时） */
function fmtSpan(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 90) return `${s} 秒`;
  return `${Math.round(s / 60)} 分钟`;
}

/** 分值：12 → 「12」；0.5 → 「0.5」（别显示成 0.5000001） */
const fmtPts = (n) => {
  const v = Math.round(Number(n) * 100) / 100;
  return Number.isFinite(v) ? String(v) : '—';
};

/** 遗忘曲线排期 → 一句人话 */
function scheduleText(p) {
  const sc = p.stats.schedule;
  if (!sc) return '';
  if (sc.overdue >= 0) return `已到期 ${sc.overdue === 0 ? '（今天）' : `${sc.overdue} 天`}`;
  return `${-sc.overdue} 天后（${sc.due}）`;
}

const RESULTS = [
  { key: '完美', cls: 'r-perfect', icon: '✅', hint: '独立做对' },
  { key: '普通', cls: 'r-normal', icon: '🟡', hint: '做出来了但不顺' },
  { key: '失败', cls: 'r-fail', icon: '❌', hint: '没做出来' },
];

/* ============================================================
   小工具
   ============================================================ */
const $ = (sel, root = document) => root.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const stars = (n) => `<span class="stars">${'⭐'.repeat(n)}${'☆'.repeat(5 - n)}</span>`;
const fires = (n) => `<span class="fires">${'🔥'.repeat(n)}${'☆'.repeat(5 - n)}</span>`;
const mmss = (ms) => {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 320);
  }, 2600);
}

async function api(path, options) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ============================================================
   试卷计时器（今日测试 / 英语阅读共用一套）

   一进全屏卷子就开始计时，能暂停、能重置。**按卷子（rel）各记各的**，
   并且落进 localStorage —— 刷新页面、切出去看一眼错题本，回来时间还在，
   不会因为手滑点错就把这一份的用时清零。

   每秒只改 DOM 里那一个数字，**绝不整页重绘** —— 一秒重绘一次会把滚动位置顶回去。
   ============================================================ */

const TIMER_KEY = 'study-paper-timer';
const TIMER_KEEP = 24; // 只记最近这么多份，别把 localStorage 撑爆

const timerOf = (rel) => {
  const t = state.paperTimer;
  if (!t.timers[rel]) t.timers[rel] = { startedAt: 0, accumulated: 0, running: false };
  return t.timers[rel];
};

function loadTimers() {
  try {
    const raw = JSON.parse(localStorage.getItem(TIMER_KEY) || 'null');
    if (raw && raw.timers && typeof raw.timers === 'object') {
      state.paperTimer.timers = raw.timers;
      state.paperTimer.current = raw.current || null;
      // 存的时候在跑 → 说明是刷新/关页面那一刻中断的，接着算
      for (const t of Object.values(state.paperTimer.timers)) {
        if (t.running) {
          const gap = Date.now() - (t.startedAt || 0);
          // 超过 3 小时说明早就不在做了，别把这几个小时算进去
          if (gap > 3 * 3600 * 1000) {
            t.running = false;
            t.accumulated = (t.accumulated || 0) + Math.min(gap, 3 * 3600 * 1000);
          }
        }
      }
    }
  } catch {
    /* 存坏了就当没有 */
  }
}

function saveTimers() {
  try {
    const entries = Object.entries(state.paperTimer.timers).slice(-TIMER_KEEP);
    localStorage.setItem(TIMER_KEY, JSON.stringify({ current: state.paperTimer.current, timers: Object.fromEntries(entries) }));
  } catch {
    /* 私密模式之类，存不了就算了，页面上照样计时 */
  }
}

/** 这一份卷子已经做了多久（毫秒） */
function paperElapsed(rel = state.paperTimer.current) {
  if (!rel) return 0;
  const t = timerOf(rel);
  return (t.accumulated || 0) + (t.running && t.startedAt ? Date.now() - t.startedAt : 0);
}

/** 进一份卷子：同一份就接着上次的算，换了一份就先把它暂停、这份从头开始 */
function enterPaperTimer(rel) {
  if (!rel) return;
  const t = state.paperTimer;
  if (t.current && t.current !== rel) {
    const prev = timerOf(t.current);
    if (prev.running) {
      prev.accumulated = paperElapsed(t.current);
      prev.running = false;
      prev.startedAt = 0;
    }
  }
  t.current = rel;
  const mine = timerOf(rel);
  // 从没计时过 → 现在开始。已经交过卷的（finished）不自动接着走：
  // 那份的时间已经定死在那儿了，想再做一遍得自己点「重置」。
  if (!mine.startedAt && !mine.accumulated && !mine.finished) {
    mine.startedAt = Date.now();
    mine.running = true;
  }
  saveTimers();
  startTimerTick();
}

/** 离开卷子（切模块 / 返回列表）→ 暂停，时间留着，回来接着算 */
function leavePaperTimer() {
  const t = state.paperTimer;
  if (t.current) {
    const cur = timerOf(t.current);
    if (cur.running) {
      cur.accumulated = paperElapsed(t.current);
      cur.running = false;
      cur.startedAt = 0;
      saveTimers();
    }
  }
  if (t.id) {
    clearInterval(t.id);
    t.id = null;
  }
}

function startTimerTick() {
  const t = state.paperTimer;
  if (t.id) return;
  t.id = setInterval(paintPaperTimer, 500);
  paintPaperTimer();
}

/** 只改 DOM 里那几个节点，不重绘 */
function paintPaperTimer() {
  const el = document.getElementById('paperTimer');
  if (!el) {
    const t = state.paperTimer;
    if (t.id) {
      clearInterval(t.id);
      t.id = null;
    }
    return;
  }
  const ref = Number(el.dataset.ref) || 0;
  const used = Math.round(paperElapsed() / 1000);
  const t = timerOf(state.paperTimer.current);
  el.textContent = ref ? `${fmtClock(used)} / 参考 ${fmtClock(ref)}` : fmtClock(used);
  el.classList.toggle('is-over', ref > 0 && used > ref);
  el.classList.toggle('is-paused', !t.running);
  const btn = document.querySelector('[data-timer="toggle"]');
  if (btn) btn.textContent = t.running ? '暂停' : '继续';
  const live = document.getElementById('gradeElapsed');
  if (live) live.textContent = fmtClock(used);
}

function togglePaperTimer() {
  const rel = state.paperTimer.current;
  if (!rel) return;
  const t = timerOf(rel);
  if (t.running) {
    t.accumulated = paperElapsed(rel);
    t.running = false;
    t.startedAt = 0;
  } else {
    t.startedAt = Date.now();
    t.running = true;
    t.finished = false; // 我又接着做了，交卷状态取消
  }
  saveTimers();
  paintPaperTimer();
}

function resetPaperTimer() {
  resetTimerFor(state.paperTimer.current);
  paintPaperTimer();
  toast('计时已归零，重新开始');
}

/** 静默地把某一份的计时归零并重新开始（记完一次之后用，不弹提示） */
function resetTimerFor(key) {
  if (!key) return;
  const t = timerOf(key);
  t.startedAt = Date.now();
  t.accumulated = 0;
  t.running = true;
  t.finished = false;
  saveTimers();
}

/**
 * 做完了（交卷判分 / 对完答案）→ 把这一份的计时停下来。
 *
 * 为什么必须停：判分要等模型想半天，那几分钟**不是我的做题用时**；
 * 不停的话，之后回到这份卷子翻一眼，数字也一直在涨，成绩记录里的「用时」就成假的了。
 * 数字冻在交卷那一刻，想再做一遍点「重置」。
 */
function stopPaperTimer(rel = state.paperTimer.current) {
  if (!rel) return;
  const t = timerOf(rel);
  if (t.running) {
    t.accumulated = paperElapsed(rel);
    t.running = false;
    t.startedAt = 0;
  }
  t.finished = true; // 再进这份卷子也不自动接着走
  saveTimers();
  paintPaperTimer();
}

/** 卷子标题上那一块：⏱ 12:34 / 参考 40:00 ［暂停］［重置］ */
function renderPaperTimer(refSeconds) {
  const ref = Math.round(Number(refSeconds) || 0);
  const used = Math.round(paperElapsed() / 1000);
  const t = state.paperTimer.current ? timerOf(state.paperTimer.current) : { running: true };
  return `<span class="ptimer">
    <span class="pt-label" title="做这份卷子用了多久">⏱</span>
    <b class="pt-clock${ref > 0 && used > ref ? ' is-over' : ''}${t.running ? '' : ' is-paused'}" id="paperTimer" data-ref="${ref}">${
      ref ? `${fmtClock(used)} / 参考 ${fmtClock(ref)}` : fmtClock(used)
    }</b>
    <button class="mini" data-timer="toggle">${t.running ? '暂停' : '继续'}</button>
    <button class="mini" data-timer="reset">重置</button>
  </span>`;
}

/* ============================================================
   范围（大类 / 科目 / 章节）—— 一个概念贯穿三个页面
   ============================================================ */
function scopeQuery(scope = state.scope) {
  const p = new URLSearchParams();
  p.set('book', state.book || 'mistakes');
  if (scope.category) p.set('category', scope.category);
  if (scope.subject) p.set('subject', scope.subject);
  if (scope.chapter) p.set('chapter', scope.chapter);
  return p.toString();
}

function scopeOfProblem(p) {
  const s = state.scope;
  // 题库页可以「共通」看两本书；其他页面只看当前这本
  let wantKind = state.sub === 'library' ? state.filters.kind : state.book;
  if (wantKind === 'current' || !wantKind) wantKind = state.book;
  if (wantKind !== 'all' && (p.kind || 'mistakes') !== wantKind) return false;
  if (s.category && p.category !== s.category) return false;
  if (s.subject && p.subject !== s.subject) return false;
  if (s.chapter && p.chapter !== s.chapter) return false;
  return true;
}

/** 当前范围在树上的节点 */
/** 当前这本（错题 / 好题）的导航树 */
function currentTree() {
  const trees = state.data?.trees || {};
  return trees[state.book] || state.data?.tree || [];
}

function scopeNode() {
  const tree = currentTree();
  const cat = state.scope.category ? tree.find((c) => c.name === state.scope.category) : null;
  const sub = cat && state.scope.subject ? cat.children.find((s) => s.name === state.scope.subject) : null;
  const ch = sub && state.scope.chapter ? sub.children.find((c) => c.name === state.scope.chapter) : null;
  return { cat, sub, ch };
}

function scopeName(sep = ' · ') {
  return [state.scope.category, state.scope.subject, state.scope.chapter].filter(Boolean).join(sep) || '全部';
}

function chip(active, label, count, attrs) {
  return `<button class="chip ${active ? 'is-on' : ''}" ${attrs}>${label}${
    count != null ? `<span class="cnt">${count}</span>` : ''
  }</button>`;
}

const CAT_ICON = { 数学: '📐', 408: '💻' };
const catIcon = (name) => CAT_ICON[name] || '📚';

/** 顶栏那个「当前在看哪本错题本」的按钮 */
function renderScopeButton() {
  if (!state.data) return;
  const tree = currentTree();
  const { cat, sub, ch } = scopeNode();
  const total = tree.reduce((s, c) => s + c.total, 0);

  const path = [cat?.name, sub?.name, ch?.name].filter(Boolean);
  const all = `全部${bookNoun()}`;
  const label = path.length ? path.join(' › ') : all;
  const count = ch ? ch.total : sub ? sub.total : cat ? cat.total : total;

  $('#scopeIcon').textContent = cat ? catIcon(cat.name) : '🎲';
  $('#scopeText').textContent = label;
  $('#scopeCnt').textContent = `${count} 题`;
  $('#scopeBtn').classList.toggle('is-scoped', path.length > 0);
  $('#scopeBtn').title = path.length ? `当前范围：${label}　共 ${count} 题` : `${all}　共 ${total} 题`;
}

/** 下拉里的一行 */
function scopeRow({ active = false, indent = 0, icon = '', name, count = 0, attrs = '', kind = 'row', arrow = '' }) {
  return `<button class="sm-row sm-${kind} ${active ? 'is-on' : ''}" style="--indent:${indent}" ${attrs}>
    ${icon ? `<span class="sm-icon">${icon}</span>` : '<span class="sm-icon"></span>'}
    <span class="sm-name">${esc(name)}</span>
    ${arrow ? `<span class="sm-arrow">${arrow}</span>` : ''}
    <span class="sm-count">${count}</span>
  </button>`;
}

/**
 * 下拉面板：大类 → 科目 →（只展开当前科目的）章节。
 * 没选中的大类只列科目名，保持紧凑；选中的才展开章节。
 */
function renderScopeMenu() {
  const tree = currentTree();
  const { cat, sub } = scopeNode();
  const total = tree.reduce((s, c) => s + c.total, 0);

  const parts = [
    scopeRow({ active: !cat, icon: '🎲', name: `全部${bookNoun()}`, count: total, kind: 'all', attrs: 'data-pick="reset"' }),
    '<div class="sm-divider"></div>',
  ];

  for (const c of tree) {
    if (!tree.length) break;
    parts.push(
      scopeRow({
        active: !!cat && cat.name === c.name && !sub,
        icon: catIcon(c.name),
        name: c.name,
        count: c.total,
        kind: 'cat',
        attrs: `data-pick="category" data-value="${esc(c.name)}"`,
      })
    );

    const catOpen = !!cat && cat.name === c.name;
    for (const s0 of c.children) {
      const subOpen = catOpen && !!sub && sub.name === s0.name;
      parts.push(
        scopeRow({
          active: subOpen && !state.scope.chapter,
          indent: 1,
          name: s0.name,
          count: s0.total,
          kind: 'sub',
          arrow: catOpen && s0.children.length ? (subOpen ? '▾' : '▸') : '',
          attrs: `data-pick="subject" data-category="${esc(c.name)}" data-value="${esc(s0.name)}"`,
        })
      );
      if (!subOpen) continue;
      for (const chNode of s0.children) {
        parts.push(
          scopeRow({
            active: state.scope.chapter === chNode.name,
            indent: 2,
            name: chNode.name,
            count: chNode.total,
            kind: 'ch',
            attrs: `data-pick="chapter" data-value="${esc(chNode.name)}"`,
          })
        );
      }
    }
  }
  return parts.join('');
}

function openPicker() {
  if (!state.data) return;
  state.pickerOpen = true;
  const menu = $('#scopeMenu');
  menu.innerHTML = renderScopeMenu();
  menu.hidden = false;
  $('#scopeBtn').setAttribute('aria-expanded', 'true');
}

function closePicker() {
  state.pickerOpen = false;
  $('#scopeMenu').hidden = true;
  $('#scopeBtn').setAttribute('aria-expanded', 'false');
}

function togglePicker() {
  state.pickerOpen ? closePicker() : openPicker();
}

/* ============================================================
   图表（手写 SVG）
   ============================================================ */
function donutChart(rows, size = 140) {
  const total = rows.reduce((s, r) => s + r.total, 0);
  const r = size / 2 - 13;
  const C = 2 * Math.PI * r;
  let offset = 0;
  const segs = rows
    .filter((row) => row.total > 0)
    .map((row, i) => {
      const len = (row.total / (total || 1)) * C;
      const seg = `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none"
        stroke="${PALETTE[i % PALETTE.length]}" stroke-width="15"
        stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}"
        stroke-dashoffset="${(-offset).toFixed(2)}"
        transform="rotate(-90 ${size / 2} ${size / 2})"></circle>`;
      offset += len;
      return seg;
    })
    .join('');
  return `<svg class="donut" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--surface-3)" stroke-width="15"></circle>
    ${segs}
    <text x="${size / 2}" y="${size / 2 - 1}" text-anchor="middle" fill="var(--text)" font-size="26" font-weight="700">${total}</text>
    <text x="${size / 2}" y="${size / 2 + 17}" text-anchor="middle" fill="var(--text-3)" font-size="11">题</text>
  </svg>`;
}

function legend(rows) {
  const total = rows.reduce((s, r) => s + r.total, 0) || 1;
  return `<div class="donut-legend">${rows
    .filter((row) => row.total > 0)
    .map(
      (row, i) => `<div class="legend-row">
      <span class="legend-dot" style="background:${PALETTE[i % PALETTE.length]}"></span>
      <span>${esc(row.key ?? row.name)}</span>
      <span class="num">${row.total} 题 · ${Math.round((row.total / total) * 100)}%</span>
    </div>`
    )
    .join('')}</div>`;
}

function barRows(rows, labelFn, colorFn) {
  const max = Math.max(1, ...rows.map((r) => r.total));
  return `<div class="bar-rows">${rows
    .filter((r) => r.total > 0)
    .map(
      (r) => `<div class="bar-row">
      <span class="bar-label">${labelFn(r.key)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${(r.total / max) * 100}%;background:${colorFn(r)}"></span></span>
      <span class="bar-value">${r.total} 题</span>
    </div>`
    )
    .join('') || '<div class="rv-hint">这个范围里还没有题目</div>'}</div>`;
}

function sparkline(trend) {
  const W = 640;
  const H = 130;
  const pad = 10;
  const max = Math.max(1, ...trend.map((d) => d.total));
  const stepX = (W - pad * 2) / Math.max(1, trend.length - 1);
  const y = (v) => H - pad - (v / max) * (H - pad * 2 - 10);
  const pts = trend.map((d, i) => [pad + i * stepX, y(d.total)]);
  const line = pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${pad},${H - pad} ${line} ${W - pad},${H - pad}`;
  const marks = pts
    .map((p, i) => (trend[i].total ? `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.2" fill="var(--accent)"></circle>` : ''))
    .join('');
  const empty = trend.every((d) => !d.total);
  return `<svg class="sparkline" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <defs><linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.34"/>
      <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
    </linearGradient></defs>
    <polygon points="${area}" fill="url(#sparkFill)"></polygon>
    <polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"></polyline>
    ${marks}
    ${empty ? `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="var(--text-3)" font-size="12">最近 30 天还没有打卡记录</text>` : ''}
  </svg>
  <div class="spark-legend"><span>近 30 天</span><span>峰值 ${max} 次/天</span><span>累计 ${trend.reduce((s, d) => s + d.total, 0)} 次</span></div>`;
}

/* ============================================================
   总览：四层 —— 全部 / 大类 / 科目 / 章节
   ============================================================ */
/**
 * 复习进度：已复习 / 总题数。
 * 一道题都没有的科目 / 大类算 100%（没有欠着的题），不是 0%
 * —— 否则 408 明明 0 个待复习，进度条却是空的。
 */
const progressRate = (total, done) => (total ? Math.round((done / total) * 100) : 100);

function statCards(stats, extra = []) {
  const t = stats.totals || {};
  // 后端字段变了、页面还是老的缓存时，宁可显示 0 也不要满屏 undefined
  const num = (v) => (Number.isFinite(v) ? v : 0);
  return `<div class="stat-grid">
    <div class="stat-card">
      <div class="stat-label">题目总数</div>
      <div class="stat-value">${t.total}</div>
      <div class="stat-foot">${extra[0] || ''}</div>
    </div>
    <div class="stat-card is-done">
      <div class="stat-label">✅ 已复习</div>
      <div class="stat-value">${num(t.done)}</div>
      <div class="stat-foot">做过的题都排进了遗忘曲线 · <b>${num(t.completionRate)}%</b></div>
      <div class="progress"><i style="width:${num(t.completionRate)}%"></i></div>
    </div>
    <div class="stat-card is-pending">
      <div class="stat-label">⏳ 待复习</div>
      <div class="stat-value">${num(t.pending)}</div>
      <div class="stat-foot">刚加的 + 复习到期的，都算在这里</div>
    </div>
    <div class="stat-card is-streak">
      <div class="stat-label">累计打卡</div>
      <div class="stat-value">${num(t.checkins)}<span style="font-size:15px;font-weight:500;color:var(--text-3)"> 次</span></div>
      <div class="stat-foot">完美 <b>${num(t.byResult?.['完美'])}</b> · 普通 <b>${num(t.byResult?.['普通'])}</b> · 失败 <b>${num(t.byResult?.['失败'])}</b></div>
    </div>
    <div class="stat-card">
      <div class="stat-label">🔥 连续打卡</div>
      <div class="stat-value">${num(t.streak)}<span style="font-size:15px;font-weight:500;color:var(--text-3)"> 天</span></div>
      <div class="stat-foot">有打卡记录的天数 <b>${num(t.activeDays)}</b> 天</div>
    </div>
  </div>`;
}

function pendingTable(stats, { showWhere = true } = {}) {
  return `<section class="panel" style="margin-top:14px">
    <div class="panel-head">
      <h3>待复习 · 按优先级排序</h3>
      <span class="hint">热度权重最高，失败过的会加权往前排</span>
    </div>
    <div class="table-wrap"><table class="data">
      <thead><tr>
        <th>题目</th>${showWhere ? '<th>科目</th><th>章节</th>' : ''}<th>类型</th><th>难度</th><th>热度</th>
        <th>完美</th><th>普通</th><th>失败</th><th>状态</th><th>最近一次</th>
      </tr></thead>
      <tbody>${
        stats.pending.length
          ? stats.pending
              .map(
                (p) => `<tr data-open="${esc(p.id)}">
          <td><b>${esc(p.num)}</b></td>
          ${showWhere ? `<td style="color:var(--text-3)">${esc(p.subject)}</td><td>${esc(p.chapter)}</td>` : ''}
          <td><span class="badge badge-type">${esc(p.type)}</span></td>
          <td>${stars(p.difficulty)}</td><td>${fires(p.heat)}</td>
          <td class="num-cell">${p.stats.perfect}</td><td class="num-cell">${p.stats.normal}</td><td class="num-cell">${p.stats.fail}</td>
          <td><span class="badge ${STATUS_META[p.stats.status].cls}">${STATUS_META[p.stats.status].text}</span></td>
          <td style="color:var(--text-3)">${p.stats.last ? `${esc(p.stats.last.result)} ${esc(p.stats.last.date || '')}` : '—'}</td>
        </tr>`
              )
              .join('')
          : `<tr><td colspan="12" class="empty-row">这个范围里全部完成 🎉</td></tr>`
      }</tbody>
    </table></div>
  </section>`;
}

function troubledTable(stats) {
  if (!stats.troubled.length) return '';
  return `<section class="panel" style="margin-top:14px">
    <div class="panel-head"><h3>⚠️ 失败过的题</h3><span class="hint">这些最该重做</span></div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>题目</th><th>科目</th><th>章节</th><th>失败次数</th><th>难度</th><th>热度</th><th>状态</th></tr></thead>
      <tbody>${stats.troubled
        .map(
          (p) => `<tr data-open="${esc(p.id)}">
        <td><b>${esc(p.num)}</b></td>
        <td style="color:var(--text-3)">${esc(p.subject)}</td><td>${esc(p.chapter)}</td>
        <td class="num-cell" style="color:var(--fail);font-weight:650">${p.stats.fail}</td>
        <td>${stars(p.difficulty)}</td><td>${fires(p.heat)}</td>
        <td><span class="badge ${STATUS_META[p.stats.status].cls}">${STATUS_META[p.stats.status].text}</span></td>
      </tr>`
        )
        .join('')}</tbody>
    </table></div>
  </section>`;
}

/** 科目卡片（大类总览 / 全部总览用） */
function subjectCards(node) {
  if (!node.children.length) {
    return `<div class="panel"><div class="panel-body rv-hint">这个大类下还没有题。去「题库」或「增题」加第一道吧。</div></div>`;
  }
  const total = node.children.reduce((s, c) => s + c.total, 0);
  return `<div class="subject-grid">${node.children
    .map((sub) => {
      const rate = progressRate(sub.total, sub.done);
      return `<article class="subject-card" data-scope="subject" data-value="${esc(sub.name)}">
      <div class="sc-head"><span class="sc-name">${esc(sub.name)}</span>
        <span class="sc-count">${sub.total}<small>题</small></span></div>
      <div class="progress"><i style="width:${rate}%"></i></div>
      <div class="sc-foot">
        ${
          sub.total
            ? `<span>✅ 已复习 <b>${sub.done}</b></span>
               <span>⏳ 待复习 <b>${sub.total - sub.done}</b></span>
               <span>占比 <b>${total ? Math.round((sub.total / total) * 100) : 0}%</b></span>`
            : `<span>还没有题</span><span><b>100%</b>（没有欠着的）</span>`
        }
      </div>
      <div class="sc-chapters">${sub.children.length ? sub.children.map((c) => `${esc(c.name)} <em>${c.total}</em>`).join(' · ') : '<em>还没有章节</em>'}</div>
    </article>`;
    })
    .join('')}</div>`;
}

/** 遗忘曲线提醒 / 考点薄弱排行 / 慢题——三个「下一步该干什么」的面板 */
function insightPanels(stats) {
  const parts = [];

  if (stats.due && stats.due.length) {
    parts.push(`<section class="panel" style="margin-top:14px">
      <div class="panel-head"><h3>⏰ 遗忘曲线提醒</h3><span class="hint">做对一次隔 4 天、再对一次 8 天、翻倍往上（1 → 4 → 8 → 16 → 32 → 64 …），到点才回队列；这些已到点</span></div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>题目</th><th>科目</th><th>章节</th><th>掌握等级</th><th>当前间隔</th><th>已过期</th></tr></thead>
        <tbody>${stats.due
          .map(
            (p) => `<tr data-open="${esc(p.id)}">
          <td><b>${esc(p.num)}</b></td>
          <td style="color:var(--text-3)">${esc(p.subject)}</td>
          <td>${esc(p.chapter)}</td>
          <td class="num-cell">${p.stats.schedule.level} 次</td>
          <td class="num-cell">${p.stats.schedule.interval} 天</td>
          <td class="num-cell" style="color:var(--warn);font-weight:650">${
            p.stats.schedule.overdue === 0 ? '今天' : `${p.stats.schedule.overdue} 天`
          }</td>
        </tr>`
          )
          .join('')}</tbody>
      </table></div></section>`);
  }

  const pts = stats.byPoint?.rows || [];
  if (pts.length) {
    parts.push(`<section class="panel" style="margin-top:14px">
      <div class="panel-head"><h3>🏷️ 考点薄弱排行</h3><span class="hint">按累计失败次数排，越靠前越该专项突破${
        stats.byPoint.untagged ? `　·　还有 ${stats.byPoint.untagged} 题没打考点` : ''
      }</span></div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>考点</th><th>题数</th><th>已复习</th><th>累计失败</th><th>累计打卡</th></tr></thead>
        <tbody>${pts
          .slice(0, 14)
          .map(
            (r) => `<tr data-point="${esc(r.key)}">
          <td><span class="point-chip static">${esc(r.key)}</span></td>
          <td class="num-cell">${r.total}</td>
          <td class="num-cell">${r.done}</td>
          <td class="num-cell" style="color:${r.fail ? 'var(--fail)' : 'var(--text-3)'};font-weight:${r.fail ? 650 : 400}">${r.fail}</td>
          <td class="num-cell">${r.checkins}</td>
        </tr>`
          )
          .join('')}</tbody>
      </table></div></section>`);
  }

  const rs = stats.byReason;
  if (rs && rs.rows.length) {
    parts.push(`<section class="panel" style="margin-top:14px">
      <div class="panel-head"><h3>🧠 错因分布</h3><span class="hint">你到底是怎么错的 —— 计算失误要练手感，概念不清得回课本${
        rs.noFirstReason ? `　·　还有 ${rs.noFirstReason} 题没写首次错因` : ''
      }</span></div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>错因</th><th>合计</th><th>录入时</th><th>后续做错</th></tr></thead>
        <tbody>${rs.rows
          .slice(0, 12)
          .map(
            (r) => `<tr>
          <td><span class="reason-tag">${esc(r.key)}</span></td>
          <td class="num-cell">${r.total}</td>
          <td class="num-cell">${r.first}</td>
          <td class="num-cell">${r.later}</td>
        </tr>`
          )
          .join('')}</tbody>
      </table></div></section>`);
  }

  const t = stats.timing;
  if (t && t.slow && t.slow.length) {
    parts.push(`<section class="panel" style="margin-top:14px">
      <div class="panel-head"><h3>⏱️ 做得慢的题</h3><span class="hint">会做但耗时明显偏长（中位数 ${fmtSec(
        t.medianSec
      )}，超过 ${fmtSec(t.slowThreshold)} 算慢）——这类题最容易抢分</span></div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>题目</th><th>科目</th><th>章节</th><th>平均用时</th><th>最近一次</th><th>难度</th><th>状态</th></tr></thead>
        <tbody>${t.slow
          .map(
            (p) => `<tr data-open="${esc(p.id)}">
          <td><b>${esc(p.num)}</b></td>
          <td style="color:var(--text-3)">${esc(p.subject)}</td>
          <td>${esc(p.chapter)}</td>
          <td class="num-cell" style="color:var(--warn);font-weight:650">${fmtSec(p.avgSec)}</td>
          <td class="num-cell">${fmtSec(p.lastSec)}</td>
          <td>${stars(p.difficulty)}</td>
          <td><span class="badge ${statusMeta(p.stats.status).cls}">${statusMeta(p.stats.status).text}</span></td>
        </tr>`
          )
          .join('')}</tbody>
      </table></div></section>`);
  }

  return parts.join('');
}

function renderDashboard() {
  const tree = currentTree();
  const stats = state.stats;
  const { cat, sub, ch } = scopeNode();

  // ── 第 0 层：全部 —— 数学 / 408 两张大页 ──
  if (!cat) {
    const cats = tree.length ? tree : [];
    return `${statCards(stats, [`覆盖 <b>${cats.length}</b> 个大类 · <b>${cats.reduce((s, c) => s + c.children.length, 0)}</b> 个科目`])}
      <div class="category-grid" style="margin-top:14px">
        ${cats
          .map((c) => {
            const rate = progressRate(c.total, c.done);
            return `<article class="category-card" data-scope="category" data-value="${esc(c.name)}">
          <div class="cc-head">
            <span class="cc-mark">${c.name === '数学' ? '📐' : c.name === '408' ? '💻' : '📚'}</span>
            <div><div class="cc-name">${esc(c.name)}</div><div class="cc-sub">${c.children.length} 个科目</div></div>
            <span class="cc-count">${c.total}<small>题</small></span>
          </div>
          <div class="progress"><i style="width:${rate}%"></i></div>
          <div class="cc-foot">${
            c.total
              ? `<span>✅ 已复习 ${c.done}</span><span>⏳ 待复习 ${c.total - c.done}</span><span>${rate}%</span>`
              : `<span>还没有题</span><span>${rate}%（没有欠着的）</span>`
          }</div>
          <div class="cc-chapters">${c.children.map((s) => `${esc(s.name)} <em>${s.total}</em>`).join(' ／ ') || '<em>还没有科目</em>'}</div>
          <div class="cc-enter">进入 ${esc(c.name)} 总览 →</div>
        </article>`;
          })
          .join('')}
      </div>
      ${insightPanels(stats)}
      ${pendingTable(stats)}`;
  }

  // ── 第 1 层：某个大类 —— 各科目情况 ──
  if (!sub) {
    return `<div class="crumb">${esc(cat.name)} 总览</div>
      ${statCards(stats, [`${esc(cat.name)} 下 <b>${cat.children.length}</b> 个科目`])}
      <div class="chart-grid" style="margin-top:14px">
        <section class="panel">
          <div class="panel-head"><h3>科目分布</h3><span class="hint">点卡片可下钻</span></div>
          <div class="panel-body"><div class="donut-wrap">${donutChart(
            cat.children.map((s) => ({ key: s.name, total: s.total }))
          )}${legend(cat.children.map((s) => ({ key: s.name, total: s.total })))}</div></div>
        </section>
        <section class="panel">
          <div class="panel-head"><h3>各科目复习情况</h3><span class="hint">✅ 已复习 / 总题数</span></div>
          <div class="panel-body">${barRows(
            cat.children.map((s) => ({ key: s.name, total: s.done })),
            (k) => esc(k),
            () => 'linear-gradient(90deg,#3fb950,#39c5cf)'
          )}</div>
        </section>
      </div>
      <div class="section-title"><h2>${esc(cat.name)} 的科目</h2><span class="hint">点任意科目进入它的总览</span></div>
      ${subjectCards(cat)}
      ${insightPanels(stats)}
      ${pendingTable(stats)}`;
  }

  // ── 第 2/3 层：某个科目（可再限定章节）—— 完整总览 ──
  const where = ch ? `${cat.name} / ${sub.name} / ${ch.name}` : `${cat.name} / ${sub.name}`;
  const groups = ch
    ? [{ key: '题型', rows: stats.byType }]
    : [{ key: '章节', rows: stats.byChapter }];
  return `<div class="crumb">${esc(where)} 总览</div>
    ${statCards(stats, [`${esc(where)}`])}
    <div class="chart-grid" style="margin-top:14px">
      <section class="panel">
        <div class="panel-head"><h3>${groups[0].key}分布</h3><span class="hint">${esc(where)}</span></div>
        <div class="panel-body"><div class="donut-wrap">${donutChart(groups[0].rows)}${legend(groups[0].rows)}</div></div>
      </section>
      <section class="panel">
        <div class="panel-head"><h3>考研热度分布</h3><span class="hint">🔥 越多越该优先</span></div>
        <div class="panel-body">${barRows([...stats.byHeat].reverse(), fires, () => 'linear-gradient(90deg,#ff8c42,#f85149)')}</div>
      </section>
      <section class="panel">
        <div class="panel-head"><h3>难度分布</h3><span class="hint">⭐ 越多越难</span></div>
        <div class="panel-body">${barRows([...stats.byDifficulty].reverse(), stars, () => 'linear-gradient(90deg,#6d8cff,#a371f7)')}</div>
      </section>
      <section class="panel">
        <div class="panel-head"><h3>近 30 天打卡</h3><span class="hint">每天完成了多少次</span></div>
        <div class="panel-body">${sparkline(stats.trend)}</div>
      </section>
    </div>
    ${insightPanels(stats)}
    ${pendingTable(stats, { showWhere: false })}
    ${troubledTable(stats)}`;
}

/* ============================================================
   题库
   ============================================================ */
function filteredProblems() {
  const q = state.q.trim().toLowerCase();
  const f = state.filters;
  return state.data.problems.filter((p) => {
    if (!scopeOfProblem(p)) return false;
    if (f.status && p.stats.status !== f.status) return false;
    if (f.difficulty && p.difficulty !== f.difficulty) return false;
    if (f.heat && p.heat !== f.heat) return false;
    if (f.point && !(p.points || []).includes(f.point)) return false;
    if (q && !p.searchText.toLowerCase().includes(q)) return false;
    return true;
  });
}

function filterChips(label, options, key, activeValue = state.filters[key]) {
  return `<div class="filter-group">
    <h4>${label}</h4>
    <div class="filter-list">
      ${options
        .map(
          ({ value, text, count }) => `<button class="chip ${activeValue === value ? 'is-on' : ''}"
        data-filter="${key}" data-value="${value === null ? '' : esc(value)}">${text}${
            count != null ? `<span class="cnt">${count}</span>` : ''
          }</button>`
        )
        .join('')}
    </div>
  </div>`;
}

function renderLibrary() {
  const list = filteredProblems();
  const scopedAll = state.data.problems.filter(scopeOfProblem);
  const countIn = (pred) => scopedAll.filter(pred).length;

  const allProblems = state.data.problems;
  const countKind = (k) => allProblems.filter((p) => (p.kind || 'mistakes') === k).length;

  const sidebar = `<aside class="sidebar">
    ${filterChips(
      '哪一本',
      [
        { value: 'current', text: `当前（${state.book === 'good' ? '好题' : '错题'}）`, count: countKind(state.book) },
        { value: 'all', text: '全部（共通）', count: allProblems.length },
        { value: 'mistakes', text: '错题本', count: countKind('mistakes') },
        { value: 'good', text: '好题本', count: countKind('good') },
      ],
      'kind',
      // 没选过时就是「当前这本」，别让三个筹码都不亮
      state.filters.kind || 'current'
    )}
    ${filterChips('复习状态', [
      { value: null, text: '全部', count: scopedAll.length },
      { value: '已复习', text: '✅ 已复习', count: countIn((p) => p.stats.status === '已复习') },
      { value: '待复习', text: '⏳ 待复习', count: countIn((p) => p.stats.status === '待复习') },
      { value: '未做', text: '⭕ 未做', count: countIn((p) => p.stats.status === '未做') },
    ], 'status')}
    ${filterChips('难度', [
      { value: null, text: '全部' },
      ...[5, 4, 3, 2, 1].map((n) => ({ value: n, text: stars(n), count: countIn((p) => p.difficulty === n) })),
    ], 'difficulty')}
    ${filterChips('考研热度', [
      { value: null, text: '全部' },
      ...[5, 4, 3, 2, 1].map((n) => ({ value: n, text: fires(n), count: countIn((p) => p.heat === n) })),
    ], 'heat')}
    ${
      allPoints().length
        ? filterChips('考点标签', [
            { value: null, text: '全部' },
            ...allPoints().map((pt) => ({
              value: pt,
              text: esc(pt),
              count: countIn((p) => (p.points || []).includes(pt)),
            })),
          ], 'point')
        : ''
    }
    <div class="sidebar-foot">
      范围 <b>${esc(scopeName())}</b><br>
      共 <b>${scopedAll.length}</b> 题，筛出 <b>${list.length}</b> 题
      ${
        Object.values(state.filters).some((v) => v !== null) || state.q
          ? '<br><button class="link-btn" id="resetFilters">清除全部筛选</button>'
          : ''
      }
    </div>
  </aside>`;

  const cards = list.length
    ? list
        .map((p) => {
          const meta = STATUS_META[p.stats.status];
          return `<article class="problem-card ${meta.cls2}" data-open="${esc(p.id)}">
      <div class="pc-top">
        <span class="pc-num">${esc(p.num)}</span>
        <span class="badge badge-type">${esc(p.type)}</span>
        <span class="pc-chip-row">${stars(p.difficulty)}${fires(p.heat)}</span>
      </div>
      <div class="pc-where">${esc(p.category)} · ${esc(p.subject)} · ${esc(p.chapter)}${
        state.filters.kind === 'all' ? `　<span class="kind-tag k-${p.kind}">${p.kind === 'good' ? '好题' : '错题'}</span>` : ''
      }</div>
      <div class="pc-expr">${mdToHtml(p.title.replace(/^\S+[\s　]*/, ''))}</div>
      <div class="pc-foot">
        <span class="badge ${meta.cls}">${meta.text}</span>
        <span>打卡 ${p.stats.total} 次</span>
        ${p.stats.last ? `<span>· 最近 ${esc(p.stats.last.result)}</span>` : ''}
      </div>
    </article>`;
        })
        .join('')
    : `<div class="panel"><div class="panel-body empty-row">没有符合条件的题目</div></div>`;

  return `<div class="library">${sidebar}<div class="problem-grid">${cards}</div></div>`;
}

/* ============================================================
   抽屉（题目详情）
   ============================================================ */
function foldBlock(cls, icon, title, tag, html, open = false) {
  return `<details class="fold ${cls}" ${open ? 'open' : ''}>
    <summary>${icon}<span>${title}</span>${tag ? `<span class="tag">${tag}</span>` : ''}</summary>
    <div class="fold-body">${html}</div>
  </details>`;
}

function gaugeEditor(id, field, value) {
  const on = field === 'heat' ? '🔥' : '⭐';
  return `<span class="gauge-edit" data-gauge="${field}" data-id="${esc(id)}">${[1, 2, 3, 4, 5]
    .map((n) => `<button class="${n <= value ? 'on' : ''}" title="点为 ${n} 分">${n <= value ? on : '☆'}</button>`)
    .join('')}</span>`;
}

function renderDrawer(id) {
  const p = state.data.problems.find((x) => x.id === id);
  if (!p) return '';
  const meta = STATUS_META[p.stats.status];
  const done = p.checkins.filter((c) => c.done);

  const timeline = done.length
    ? `<div class="timeline tl-line">${done
        .map(
          (c) => `<div class="tl-item">
        <span class="tl-date">${esc(c.date || '—')}</span>
        <span class="tl-dot" style="background:${
          c.result === '完美' ? 'var(--done)' : c.result === '普通' ? 'var(--warn)' : 'var(--fail)'
        }"></span>
        <span class="tl-text">第 ${c.attempt} 次 · <b>${esc(c.result)}</b></span>
        <button class="tl-undo" data-undo="${c.attempt}" data-result="${esc(c.result)}" data-id="${esc(p.id)}">撤销</button>
      </div>`
        )
        .join('')}</div>`
    : `<div class="tl-empty">还没有打卡记录。做完一次，点上面任一结果即可记下。</div>`;

  const warn = p.warnings.length
    ? `<div class="callout callout-warning"><div class="callout-head">⚠️<span>格式提醒（只读不写）</span></div>
       <div class="callout-body"><ul class="md-list">${p.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div></div>`
    : '';

  return `
  <div class="drawer-head">
    <div class="drawer-title">
      <h2>${esc(p.num)}
        <span class="badge badge-type">${esc(p.type)}</span>
        <span class="badge ${meta.cls}">${meta.text}</span>
      </h2>
      <div class="drawer-where">${esc(p.category)} · ${esc(p.subject)} · ${esc(p.chapter)}</div>
      <div class="drawer-expr">${mdToHtml('$' + p.expr + '$')}</div>
    </div>
    <button class="drawer-close" data-close-drawer title="关闭">✕</button>
  </div>

  <div class="drawer-body">
    ${warn}
    <div class="meta-row">
      <span class="meta-item">难度 ${gaugeEditor(p.id, 'difficulty', p.difficulty)}</span>
      <span class="meta-item">考研热度 ${gaugeEditor(p.id, 'heat', p.heat)}</span>
      <span class="meta-item">累计打卡 <b>${p.stats.total}</b> 次</span>
      ${
        p.stats.schedule
          ? `<span class="meta-item">遗忘曲线 <b class="${p.stats.schedule.isDue ? 'is-due' : ''}" title="掌握等级 ${p.stats.schedule.level}/${p.stats.schedule.levelMax}：等级越高，下一次隔得越久">${esc(
              `第 ${p.stats.schedule.level} 级 · ${scheduleText(p)}`
            )}</b></span>`
          : ''
      }
      ${
        p.stats.avgSec != null
          ? `<span class="meta-item">平均用时 <b>${fmtSec(p.stats.avgSec)}</b>（${p.stats.timedCount} 次计时）</span>`
          : ''
      }
    </div>

    <section class="points-panel">
      <h4>🏷️ 考点标签　<span class="hint">用来统计你在哪类考点上反复错</span></h4>
      <div class="points-list" id="pointsList" data-id="${esc(p.id)}">
        ${(p.points || [])
          .map(
            (pt) =>
              `<span class="point-chip">${esc(pt)}<button data-rm-point="${esc(pt)}" title="移除">×</button></span>`
          )
          .join('')}
        <input class="point-input" id="pointInput" list="pointList" placeholder="${
          (p.points || []).length ? '再加一个…' : '输入考点后回车，例如「等价无穷小」'
        }" />
      </div>
      <datalist id="pointList">${allPoints()
        .map((pt) => `<option value="${esc(pt)}"></option>`)
        .join('')}</datalist>
    </section>

    <section class="do-panel">
      <div class="drawer-actions">
        <button class="btn-ghost small" data-doc-open="${esc(p.vaultRel || p.relPath)}">📄 本题原文</button>
        <button class="btn-ghost small" data-topup="${esc(p.id)}"
          title="笔记里还剩 ${Math.round((p.emptyCheckins || 0) / 3)} 次空白位置。在 Obsidian 里把它们勾完了、没得勾了，点这里再续 3 次">➕ 续上打卡位置（还剩 ${Math.round((p.emptyCheckins || 0) / 3)} 次）</button>
        ${delBtn({ 'data-del-question': p.id, 'data-del-key': `q:${p.id}` }, '删掉这道题')}
      </div>
      <button class="btn-primary big" data-solve-start="${esc(p.id)}">▶ 开始做题（全屏）</button>
      <div class="do-hint">进全屏做题模式：解析和错因都会藏起来，做完在那边打卡。</div>
      <div class="do-stats">
        <span>已练 <b>${p.stats.total}</b> 次</span>
        <span>完美 <b style="color:var(--done)">${p.stats.perfect}</b></span>
        <span>普通 <b style="color:var(--warn)">${p.stats.normal}</b></span>
        <span>失败 <b style="color:var(--fail)">${p.stats.fail}</b></span>
        ${p.stats.avgSec != null ? `<span>平均用时 <b>${fmtSec(p.stats.avgSec)}</b></span>` : ''}
      </div>
      ${timeline}
    </section>

    ${
      p.kind === 'good'
        ? ''
        : `<section class="points-panel">
      <h4>🧠 错因分析　<span class="hint">做错的原因，攒起来才看得出你的固定错法</span></h4>
      <div class="reason-edit">
        <span class="rp-label">首次错因</span>
        <select class="reason-select" data-reason-select="${esc(p.id)}">
          <option value=""${p.firstReason ? '' : ' selected'}>（未记录）</option>
          ${REASONS.map((r) => `<option${p.firstReason === r ? ' selected' : ''}>${esc(r)}</option>`).join('')}
          ${p.firstReason && !REASONS.includes(p.firstReason) ? `<option selected>${esc(p.firstReason)}</option>` : ''}
        </select>
      </div>
      ${reasonReportHtml(p)}
    </section>`
    }

    <div class="stem-box">${mdToHtml(p.stem)}</div>
    ${foldBlock('fold-keypoints', '🔎', '核心考点与主要难点', '折叠', mdToHtml(p.keypoints))}
    ${foldBlock('fold-answer', '✅', '答案', '点击展开', mdToHtml(p.answer))}
    ${foldBlock('fold-solution', '📝', '解析', '点击展开', mdToHtml(p.solution))}
    ${p.pitfalls ? foldBlock('fold-pitfalls', '⚠️', '易错提醒', '点击展开', mdToHtml(p.pitfalls)) : ''}

    <div style="color:var(--text-3);font-size:12px;border-top:1px solid var(--border-soft);padding-top:12px">
      源文件：${esc(p.vaultRel || p.relPath)}
    </div>
  </div>`;
}

/** 全库出现过的考点标签，给输入框做补全 */
function allPoints() {
  const set = new Set();
  for (const p of state.data?.problems || []) for (const pt of p.points || []) set.add(pt);
  return [...set].sort((a, b) => a.localeCompare(b, 'zh'));
}

function openDrawer(id) {
  const html = renderDrawer(id);
  if (!html) return;
  const drawer = $('#drawer');
  $('#drawerPanel').innerHTML = html;
  drawer.hidden = false;
  drawer.setAttribute('aria-hidden', 'false');
  state.openId = id;
  document.body.style.overflow = 'hidden';
}

/** 详情页一打开就开始计时，打卡时把这段时长记进笔记 */
function startDrawerTimer() {
  stopDrawerTimer();
  state.drawerTimerId = setInterval(() => {
    const el = document.getElementById('liveTimer');
    if (!el) return stopDrawerTimer();
    el.textContent = `本次用时 ${mmss(Date.now() - state.drawerOpenedAt)}`;
  }, 500);
}
function stopDrawerTimer() {
  if (state.drawerTimerId) {
    clearInterval(state.drawerTimerId);
    state.drawerTimerId = null;
  }
}

function closeDrawer() {
  const drawer = $('#drawer');
  drawer.hidden = true;
  drawer.setAttribute('aria-hidden', 'true');
  state.openId = null;
  document.body.style.overflow = '';
}

function refreshDrawer() {
  if (state.openId && !$('#drawer').hidden) {
    const top = $('#drawerPanel').scrollTop;
    $('#drawerPanel').innerHTML = renderDrawer(state.openId);
    $('#drawerPanel').scrollTop = top;
  }
}

/* ============================================================
   复习模式
   ============================================================ */
const REVIEW_SCOPES = [
  { key: 'pending', label: '只抽待复习', hint: '到日子该再做的 + 一次没做过的' },
  { key: 'troubled', label: '只抽失败过', hint: '错得最狠的那几道' },
  { key: 'all', label: '全部题目', hint: '完整过一遍' },
  { key: 'done', label: '只抽已复习', hint: '巩固保温' },
];
const REVIEW_ORDERS = [
  { key: 'priority', label: '按优先级', hint: '热度高、失败过的排前面' },
  { key: 'heat', label: '最热优先', hint: '按考研热度从高到低' },
  { key: 'random', label: '纯随机', hint: '打乱顺序，防惯性记忆' },
];
const REVIEW_COUNTS = [5, 10, 20, 'all'];

function scopeMatch(p, scope) {
  if (scope === 'pending') return p.stats.status !== '已复习';
  if (scope === 'troubled') return p.stats.fail > 0;
  if (scope === 'done') return p.stats.status === '已复习';
  return true;
}

function priorityOf(p) {
  return p.heat * 2 + p.difficulty - p.stats.total * 0.5 + (p.stats.fail > 0 ? 1.5 : 0);
}

/** 复习可用章节：受顶部 range 限制 */
function reviewChapters() {
  const inScope = state.data.problems.filter(scopeOfProblem);
  const map = new Map();
  for (const p of inScope) {
    const key = `${p.subject}▸${p.chapter}`;
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()].map(([key, n]) => {
    const [subject, chapter] = key.split('▸');
    return { subject, chapter, key, count: n };
  });
}

function reviewPool() {
  const o = state.review.options;
  let pool = state.data.problems.filter((p) => scopeOfProblem(p) && scopeMatch(p, o.scope));
  if (o.chapters.length) pool = pool.filter((p) => o.chapters.includes(`${p.subject}▸${p.chapter}`));
  return pool;
}

function buildQueue() {
  const o = state.review.options;
  let pool = reviewPool();
  if (o.order === 'heat') {
    pool = [...pool].sort((a, b) => b.heat - a.heat || b.difficulty - a.difficulty || a.num.localeCompare(b.num, 'zh'));
  } else if (o.order === 'priority') {
    pool = pool
      .map((p) => ({ p, key: priorityOf(p) * (0.8 + Math.random() * 0.4) }))
      .sort((a, b) => b.key - a.key)
      .map((x) => x.p);
  } else {
    pool = pool.map((p) => ({ p, key: Math.random() })).sort((a, b) => a.key - b.key).map((x) => x.p);
  }
  if (o.count !== 'all') pool = pool.slice(0, Number(o.count));
  return pool.map((p) => p.id);
}

function renderReviewSetup() {
  const r = state.review;
  const pool = reviewPool();
  const chapters = reviewChapters();

  return `<div class="rv-setup">
    <div class="rv-setup-head">
      <h2>开始一局复习</h2>
      <p>当前范围：<b>${esc(scopeName())}</b>，可选 ${pool.length} 题。
      键盘：<span class="kbd">空格</span> 看答案 · <span class="kbd">1</span><span class="kbd">2</span><span class="kbd">3</span> 记结果 · <span class="kbd">S</span> 跳过 · <span class="kbd">Esc</span> 退出</p>
    </div>

    <div class="rv-options">
      <div class="filter-group">
        <h4>想要刷什么？换范围就换题库</h4>
        <div class="filter-list">
          ${chip(!state.scope.category && !state.scope.subject, '🎲 全部混刷', state.data.problems.filter(scopeOfProblem).length, 'data-scope="reset"')}
          ${currentTree()
            .map((c) => chip(false, `整个 ${c.name}`, c.total, `data-scope="category" data-value="${esc(c.name)}"`))
            .join('')}
        </div>
        <div class="rv-hint">下面按科目 / 章节再细选；选完上面的筹码，章节清单会跟着变。</div>
        <div class="filter-list" style="margin-top:8px">
          ${currentTree()
            .flatMap((c) => c.children.map((s) => chip(false, `${c.name}/${s.name}`, s.total, `data-scope="category" data-value="${esc(c.name)}" data-scope2="subject" data-value2="${esc(s.name)}"`)))
            .join('')}
        </div>
      </div>

      <div class="filter-group">
        <h4>章节多选（不选＝该范围全部）</h4>
        <div class="filter-list">
          ${
            chapters.length
              ? chapters
                  .map((c) =>
                    chip(
                      r.options.chapters.includes(c.key),
                      `${c.subject === state.scope.subject || !state.scope.subject ? '' : c.subject + ' · '}${c.chapter}`,
                      c.count,
                      `data-rv-chapter="${esc(c.key)}"`
                    )
                  )
                  .join('')
              : '<div class="rv-hint">这个范围里还没有题目</div>'
          }
        </div>
        ${
          r.options.chapters.length
            ? `<div class="rv-hint"><button class="link-btn" data-rv-clear="1">清空章节选择</button>　已选 ${r.options.chapters.length} 类</div>`
            : ''
        }
      </div>

      <div class="filter-group">
        <h4>抽哪些题</h4>
        <div class="filter-list">
          ${REVIEW_SCOPES.map(
            (s) => `<button class="chip ${r.options.scope === s.key ? 'is-on' : ''}" data-rv-scope="${s.key}">
              ${s.label}<span class="cnt">${state.data.problems.filter((p) => scopeOfProblem(p) && scopeMatch(p, s.key)).length}</span></button>`
          ).join('')}
        </div>
      </div>

      <div class="filter-group">
        <h4>出题顺序</h4>
        <div class="filter-list">
          ${REVIEW_ORDERS.map(
            (o) => `<button class="chip ${r.options.order === o.key ? 'is-on' : ''}" data-rv-order="${o.key}">${o.label}</button>`
          ).join('')}
        </div>
        <div class="rv-hint">${esc(REVIEW_ORDERS.find((o) => o.key === r.options.order)?.hint || '')}</div>
      </div>

      <div class="filter-group">
        <h4>本局题数</h4>
        <div class="filter-list">
          ${REVIEW_COUNTS.map(
            (c) => `<button class="chip ${r.options.count === c ? 'is-on' : ''}" data-rv-count="${c}">${c === 'all' ? '全部' : `${c} 题`}</button>`
          ).join('')}
        </div>
      </div>
    </div>

    <div class="rv-start-row">
      <button class="btn-primary" data-review="start" ${pool.length ? '' : 'disabled'}>▶ 开始复习　<span class="rv-pool">${pool.length} 题</span></button>
      ${pool.length ? '' : '<span class="rv-hint" style="color:var(--warn)">当前条件下没有题目</span>'}
    </div>
  </div>`;
}

function currentReviewProblem() {
  return state.data.problems.find((p) => p.id === state.review.queue[state.review.index]) || null;
}

function renderReviewSession() {
  const r = state.review;
  const p = currentReviewProblem();
  if (!p) return renderReviewDone();
  const meta = STATUS_META[p.stats.status];

  const revealed = r.revealed
    ? `<div class="rv-revealed">
        ${foldBlock('fold-answer', '✅', '答案', '', mdToHtml(p.answer), true)}
        ${foldBlock('fold-solution', '📝', '解析', '', mdToHtml(p.solution))}
        ${foldBlock('fold-keypoints', '🔎', '核心考点与主要难点', '', mdToHtml(p.keypoints))}
        ${p.pitfalls ? foldBlock('fold-pitfalls', '⚠️', '易错提醒', '', mdToHtml(p.pitfalls)) : ''}
      </div>`
    : `<div class="rv-hidden">
        <button class="rv-reveal" data-review="reveal">👁 显示答案与解析　<span class="kbd">空格</span></button>
        <p class="rv-tip">先在草稿纸上自己做一遍，再对答案——直接看等于没做。</p>
      </div>`;

  const actions = r.pendingResult
    ? reasonPickerHtml(r.pendingResult)
    : r.revealed
      ? `<div class="rv-record">
        <span class="rv-record-label">这次做得怎么样？</span>
        ${RESULTS.map(
          (res, i) => `<button class="checkin-btn ${res.cls}" data-review="record" data-result="${res.key}">
              <span>${res.icon} ${res.key}　<span class="kbd">${i + 1}</span></span><small>${res.hint}</small></button>`
        ).join('')}
      </div>`
      : `<div class="rv-record">
        <button class="checkin-btn r-skip" data-review="skip"><span>跳过这题　<span class="kbd">S</span></span><small>不计入打卡</small></button>
      </div>`;

  return `<div class="review">
    <div class="rv-bar">
      <div class="rv-progress"><i style="width:${(r.index / r.queue.length) * 100}%"></i></div>
      <span class="rv-count">第 <b>${r.index + 1}</b> / ${r.queue.length} 题</span>
      <span class="rv-timer" id="reviewTimer">${mmss(Date.now() - r.startedAt)}</span>
      <button class="rv-exit" data-review="exit">退出复习</button>
    </div>
    <article class="rv-card">
      <div class="rv-head">
        <span class="rv-num">${esc(p.num)}</span>
        <span class="badge badge-type">${esc(p.type)}</span>
        ${stars(p.difficulty)}${fires(p.heat)}
        <span class="badge ${meta.cls}">${meta.text}</span>
        <span class="rv-where">${esc(p.category)} · ${esc(p.subject)} · ${esc(p.chapter)}</span>
      </div>
      <div class="rv-stem">${mdToHtml(p.stem)}</div>
      ${revealed}
    </article>
    ${actions}
  </div>`;
}

function renderReviewDone() {
  const r = state.review;
  const n = (k) => r.results.filter((x) => x.result === k).length;
  const used = Date.now() - r.startedAt;
  const card = (label, value, cls) =>
    `<div class="stat-card ${cls}"><div class="stat-label">${label}</div><div class="stat-value">${value}</div></div>`;

  return `<div class="rv-setup">
    <div class="rv-setup-head">
      <h2>本局结束 🎉</h2>
      <p>范围 ${esc(scopeName())}　用时 ${mmss(used)}，平均每题 ${r.results.length ? mmss(used / r.results.length) : '—'}</p>
    </div>
    <div class="stat-grid">
      ${card('✅ 完美', n('完美'), 'is-done')}
      ${card('🟡 普通', n('普通'), 'is-pending')}
      ${card('❌ 失败', n('失败'), 'is-streak')}
      ${card('⏭ 跳过', n('跳过'), '')}
    </div>
    <section class="panel" style="margin-top:14px">
      <div class="panel-head"><h3>逐题结果</h3><span class="hint">点击可回看这一题</span></div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>题目</th><th>科目</th><th>章节</th><th>难度</th><th>热度</th><th>结果</th><th>用时</th></tr></thead>
        <tbody>${r.results
          .map(
            (x) => `<tr data-open="${esc(x.id)}">
          <td><b>${esc(x.num)}</b></td>
          <td style="color:var(--text-3)">${esc(x.subject)}</td><td>${esc(x.chapter)}</td>
          <td>${stars(x.difficulty)}</td><td>${fires(x.heat)}</td>
          <td>${
            x.result === '完美'
              ? '<span class="badge badge-done">✅ 完美</span>'
              : x.result === '普通'
                ? '<span class="badge badge-start">🟡 普通</span>'
                : x.result === '失败'
                  ? '<span class="badge badge-fail">❌ 失败</span>'
                  : '<span class="badge badge-none">⏭ 跳过</span>'
          }</td>
          <td class="num-cell">${mmss(x.ms)}</td>
        </tr>`
          )
          .join('')}</tbody>
      </table></div>
    </section>
    <div class="rv-start-row">
      <button class="btn-primary" data-review="again">🔄 再来一局</button>
      <button class="btn-ghost" data-review="back">回到总览</button>
    </div>
  </div>`;
}

function renderReview() {
  if (state.review.phase === 'setup') return renderReviewSetup();
  if (state.review.phase === 'run') return renderReviewSession();
  return renderReviewDone();
}

function startReviewTimer() {
  stopReviewTimer();
  state.review.timerId = setInterval(() => {
    const el = document.getElementById('reviewTimer');
    if (el) el.textContent = mmss(Date.now() - state.review.startedAt);
    else stopReviewTimer();
  }, 500);
}
function stopReviewTimer() {
  if (state.review.timerId) {
    clearInterval(state.review.timerId);
    state.review.timerId = null;
  }
}

function startReview() {
  const r = state.review;
  r.queue = buildQueue();
  if (!r.queue.length) return toast('没有符合条件的题目', 'err');
  r.phase = 'run';
  r.index = 0;
  r.revealed = false;
  r.results = [];
  r.pendingResult = null;
  r.startedAt = Date.now();
  r.questionAt = Date.now();
  render();
  startReviewTimer();
  window.scrollTo({ top: 0 });
}

function revealReview() {
  if (state.review.phase !== 'run' || state.review.revealed) return;
  state.review.revealed = true;
  render();
}

/** 点结果：完美直接记；普通/失败先问错因 */
function requestReviewRecord(result) {
  const r = state.review;
  if (r.phase !== 'run' || !r.revealed) return;
  if (result === '完美') return commitReview(result, null);
  r.pendingResult = result;
  render();
}

async function commitReview(result, reason) {
  const r = state.review;
  const p = currentReviewProblem();
  if (!p) return;
  const ms = Date.now() - r.questionAt;
  r.pendingResult = null;
  r.results.push({
    id: p.id, num: p.num, subject: p.subject, chapter: p.chapter,
    difficulty: p.difficulty, heat: p.heat, result, reason, ms,
  });
  advanceReview();
  try {
    await api('/api/checkin', {
      method: 'POST',
      body: JSON.stringify({
        id: p.id, result, seconds: Math.max(1, Math.round(ms / 1000)), reason: reason || null,
      }),
    });
    toast(`${p.num} → ${result}${reason ? `（${reason}）` : ''}（${fmtSec(ms / 1000)}）`, result === '完美' ? 'ok' : '');
  } catch (err) {
    toast(`${p.num} 打卡写入失败：${err.message}`, 'err');
  }
}

function skipReview() {
  const r = state.review;
  if (r.phase !== 'run') return;
  const p = currentReviewProblem();
  if (p) {
    r.results.push({
      id: p.id, num: p.num, subject: p.subject, chapter: p.chapter,
      difficulty: p.difficulty, heat: p.heat, result: '跳过', ms: Date.now() - r.questionAt,
    });
  }
  advanceReview();
}

function advanceReview() {
  const r = state.review;
  r.index += 1;
  r.revealed = false;
  r.pendingResult = null;
  r.questionAt = Date.now();
  if (r.index >= r.queue.length) {
    stopReviewTimer();
    r.phase = 'done';
    render();
    reload({ silent: true });
  } else {
    render();
  }
  window.scrollTo({ top: 0 });
}

function exitReview() {
  stopReviewTimer();
  state.review.phase = 'setup';
  state.review.queue = [];
  state.review.index = 0;
  state.review.revealed = false;
  render();
  reload({ silent: true });
}

/* ============================================================
   做题模式（全窗口，单题）
   ============================================================ */

/** 做题模式的计时器 key：和试卷那套共用一套机制，按题各记各的 */
const solveTimerKey = (id) => `错题:${id}`;

/**
 * 这道题的参考用时：优先用**这道题自己的平均用时**（做过几次就有数了），
 * 没做过就退到全库中位数（所有有计时记录的题）。两个都没有就不显示参考。
 */
function solveRefSeconds(p) {
  const avg = p?.stats?.avgSec;
  if (Number.isFinite(avg) && avg > 0) return Math.round(avg);
  const median = state.stats?.timing?.medianSec;
  return Number.isFinite(median) && median > 0 ? Math.round(median) : 0;
}

function enterSolve(id) {
  state.solve = { id, revealed: false, pendingResult: null };
  state.solveVerdict = null; // 上一次单题判分的结果，别带到下一题
  state.grade = { ...state.grade, rel: null, kind: 'question', uploads: [], busy: false, progress: null, error: null };
  if (!state.data?.problems.some((x) => x.id === id)) toast('找不到这道题', 'err');
}

function closeSolve() {
  state.solve.id = null;
  state.solve.revealed = false;
  state.solve.pendingResult = null;
  state.grade.uploads = [];
}

/** 做错时问一句「哪儿出的问题」——攒起来才看得出你的错法 */
function reasonPickerHtml(result) {
  return `<div class="reason-picker">
    <div class="rp-title">这次是「${esc(result)}」——问题出在哪？<span class="hint">记下来才能看出你的错法</span></div>
    <div class="rp-chips">
      ${REASONS.map((r) => `<button class="chip" data-reason="${esc(r)}">${esc(r)}</button>`).join('')}
    </div>
    <div class="rp-foot">
      <button class="link-btn" data-reason="">不记错因，直接保存</button>
      <button class="link-btn" data-reason-cancel="1">取消</button>
    </div>
  </div>`;
}

/** 做题时错因和解析一起藏着 */
function reasonReportHtml(p) {
  const rows = p.reasons || [];
  if (!rows.length) return '<p class="md-p" style="color:var(--text-3)">还没有记录过错因。</p>';
  const counts = Object.entries(p.reasonCounts || {}).sort((a, b) => b[1] - a[1]);
  return `<p class="md-p"><b>首次错因</b>　${
    p.firstReason ? esc(p.firstReason) : '<span style="color:var(--text-3)">未记录</span>'
  }</p>
    <p class="md-p"><b>错因分布</b>　${counts.map(([k, v]) => `${esc(k)} ×${v}`).join('　·　')}</p>
    <ul class="md-list">${rows
      .map(
        (r) =>
          `<li>${r.first ? '录入这道题时' : `第 ${r.attempt} 次练习`}　<b>${esc(r.reason)}</b>${
            r.date ? `　<span style="color:var(--text-3)">${esc(r.date)}</span>` : ''
          }</li>`
      )
      .join('')}</ul>`;
}

function renderSolve() {
  const p = state.data.problems.find((x) => x.id === state.solve.id);
  if (!p) {
    return `<div class="panel"><div class="panel-body empty-row">找不到这道题　<button class="link-btn" data-solve="exit">回到题库</button></div></div>`;
  }
  const meta = statusMeta(p.stats.status);
  const s = state.solve;

  const revealed = s.revealed
    ? `<div class="rv-revealed">
        ${foldBlock('fold-answer', '✅', '答案', '', mdToHtml(p.answer), true)}
        ${foldBlock('fold-solution', '📝', '解析', '', mdToHtml(p.solution))}
        ${foldBlock('fold-keypoints', '🔎', '核心考点与主要难点', '', mdToHtml(p.keypoints))}
        ${p.pitfalls ? foldBlock('fold-pitfalls', '⚠️', '易错提醒', '', mdToHtml(p.pitfalls)) : ''}
        ${foldBlock('fold-reason', '🧠', '错因分析', '', reasonReportHtml(p))}
      </div>`
    : `<div class="rv-hidden">
        <button class="rv-reveal" data-solve="reveal">👁 显示答案与解析　<span class="kbd">空格</span></button>
        <p class="rv-tip">解析和错因都藏着 —— 先自己在纸上做一遍。</p>
      </div>`;

  const actions = s.pendingResult
    ? reasonPickerHtml(s.pendingResult)
    : s.revealed
      ? `<div class="rv-record">
          <span class="rv-record-label">这次做得怎么样？</span>
          ${RESULTS.map(
            (res, i) => `<button class="checkin-btn ${res.cls}" data-solve="record" data-result="${res.key}">
              <span>${res.icon} ${res.key}　<span class="kbd">${i + 1}</span></span><small>${res.hint}</small></button>`
          ).join('')}
        </div>`
      : '';

  return `<div class="review">
    <div class="rv-bar">
      <button class="rv-exit" data-solve="exit">← 退出做题</button>
      <span class="rv-where">${esc(p.category)} · ${esc(p.subject)} · ${esc(p.chapter)}</span>
      <span class="rv-timer">${renderPaperTimer(solveRefSeconds(p))}</span>
    </div>
    <article class="rv-card">
      <div class="rv-head">
        <span class="rv-num">${esc(p.num)}</span>
        <span class="badge badge-type">${esc(p.type)}</span>
        ${stars(p.difficulty)}${fires(p.heat)}
        <span class="badge ${meta.cls}">${meta.text}</span>
      </div>
      ${
        (p.points || []).length
          ? `<div class="rv-points">${(p.points || []).map((x) => `<span class="point-chip static">${esc(x)}</span>`).join('')}</div>`
          : ''
      }
      <div class="rv-stem">${mdToHtml(p.stem)}</div>
      ${revealed}
    </article>
    ${actions}
    ${renderSolveGrade(p)}
    <div class="solve-foot">
      <span>已练 ${p.stats.total} 次${p.stats.last ? ` · 上次 ${esc(p.stats.last.result)}` : ''}</span>
      ${p.stats.schedule ? `<span>遗忘曲线：${esc(scheduleText(p))}</span>` : ''}
      ${p.stats.avgSec != null ? `<span>平均用时 ${fmtSec(p.stats.avgSec)}</span>` : ''}
    </div>
  </div>`;
}

/* ============================================================
   单题拍照判分（错题本 / 好题本的做题模式）

   错题本是一题一屏，所以**每小题独立打分**：把这道题的手写过程拍下来，
   AI 按考研阅卷标准给一个 0–100 的得分 + 「完美 / 普通 / 失败」的建议 + 错因 + 错因分析。
   但**记录什么由我定** —— 面板上三样都能改，改完点「记进笔记」才落盘：
   结果进打卡记录、错因进首次错因（可选）、错因分析进 `## 错因分析`。
   ============================================================ */

/**
 * 可编辑文本（错因分析）底下的**渲染预览**。
 *
 * 分析里常有 `$x\to 0$` 这种公式。文本框里必须是原文（那是我要存进笔记的内容），
 * 所以另起一行把渲染后的样子也摆出来 —— 不然屏幕上就是一串反斜杠命令，看着像乱码。
 * 纯文字（既没 `$` 也没 `*`）就什么都不显示，免得白占一行。
 */
function mdPreview(text) {
  const t = String(text ?? '').trim();
  if (!t || !/[$*`]/.test(t)) return '';
  return `<p><b>渲染</b>${t.split(/\n+/).map((line) => richInline(line)).join('<br>')}</p>`;
}

/** 判分面板（上传 + 判分按钮 + 判完之后的可编辑结论） */
function renderSolveGrade(p) {
  const g = state.grade;
  const v = state.solveVerdict;
  const thumbs = (g.uploads || [])
    .map(
      (u, i) => `<span class="gp-thumb">
        <img src="/uploads/${encodeURIComponent(u.name)}" alt="第 ${i + 1} 张" />
        <button class="gp-x" data-grade="del" data-name="${esc(u.name)}" title="删掉这张">✕</button>
      </span>`
    )
    .join('');
  const n = (g.uploads || []).length;
  const ready = !!state.ai?.ready;

  const verdictPanel = v
    ? `<div class="sq-verdict">
        <div class="sq-row">
          <span class="sq-label">得分</span>
          <span class="sq-score">${v.score}<em>/100</em></span>
          <span class="sq-hint">${v.got ? `你写的是：${richInline(v.got)}` : ''}</span>
        </div>
        <div class="sq-row">
          <span class="sq-label">结果</span>
          <div class="chip-row">${RESULTS.map(
            (r) =>
              `<button class="chip${v.result === r.key ? ' is-on' : ''}" data-solve-verdict="${esc(r.key)}">${r.icon} ${esc(r.key)}</button>`
          ).join('')}<span class="sq-tip">AI 建议「${esc(v.suggest || v.result)}」，不对就自己点</span></div>
        </div>
        <div class="sq-row">
          <span class="sq-label">错因</span>
          <div class="chip-row">
            <button class="chip${v.reason ? '' : ' is-on'}" data-solve-reason="">不记</button>
            ${REASONS.map(
              (r) => `<button class="chip${v.reason === r ? ' is-on' : ''}" data-solve-reason="${esc(r)}">${esc(r)}</button>`
            ).join('')}
          </div>
        </div>
        <div class="sq-row sq-row-block">
          <span class="sq-label">错因分析</span>
          <textarea id="sqAnalysis" class="sq-textarea" rows="4" placeholder="AI 写的分析，可以改也可以删">${esc(v.analysis || '')}</textarea>
          <div class="sq-notes" id="sqAnalysisMd">${mdPreview(v.analysis)}</div>
        </div>
        ${v.lost || v.fix
          ? `<div class="sq-row sq-row-block">
               <span class="sq-label">判语</span>
               <div class="sq-notes">
                 ${v.lost ? `<p><b>丢分点</b>${richInline(v.lost)}</p>` : ''}
                 ${v.fix ? `<p><b>怎么改</b>${richInline(v.fix)}</p>` : ''}
               </div>
             </div>`
          : ''}
        <div class="sq-row sq-actions">
          <label class="sq-check">
            <input type="checkbox" id="sqFirstReason"${v.setFirstReason ? ' checked' : ''}${v.reason ? '' : ' disabled'} />
            同时写进「首次错因」${p.firstReason ? `（现在记的是「${esc(p.firstReason)}」，勾上就覆盖）` : ''}
          </label>
          <button class="btn-primary small" data-grade="record">✍️ 记进笔记</button>
          <button class="btn-ghost small" data-grade="discard">不要这次判分</button>
        </div>
      </div>`
    : '';

  return `<section class="grade-zone solve-grade" id="gradeZone">
    <div class="gp-head">
      <h3>📷 拍照判分</h3>
      <span class="hint">把这道题的手写过程拍下来，AI 按考研标准判这一题</span>
    </div>
    <div class="gp-body">
      ${
        v
          ? verdictPanel
          : `<div class="gp-drop" id="gradeDrop">
               <input type="file" id="gradeFiles" accept="image/*" multiple hidden />
               <div class="gp-drop-main">
                 <b>把手写过程拍下来</b>
                 <span>多张一次全传 —— 拖进来、⌘V 粘贴，或者</span>
                 <button class="btn-ghost small" data-grade="pick">选择图片</button>
               </div>
               <div class="gp-tips">过程写全（一步一依据）才拿得到过程分；判完的结果、错因、分析都能自己改。</div>
             </div>
             ${n ? `<div class="gp-thumbs">${thumbs}</div>` : ''}
             <div class="gp-actions">
               ${
                 ready
                   ? `<button class="btn-primary" data-grade="run"${!n || g.busy ? ' disabled' : ''}>
                        ${g.busy ? '判分中…' : `🤖 判这一题${n ? `（${n} 张）` : ''}`}
                      </button>`
                   : '<span class="rv-hint">先配一下内置 AI（右上角 ⚙ 设置）</span>'
               }
               ${n ? '<button class="btn-ghost small" data-grade="clear">清空图片</button>' : ''}
               <span class="gp-note">本次用时 <b id="gradeElapsed">${fmtClock(Math.round(paperElapsed() / 1000))}</b></span>
             </div>`
      }
      <div class="gp-progress" id="gradeProgress"></div>
    </div>
  </section>`;
}

/** 判这一题：NDJSON 流，判完**不写盘**，先把结论填进面板等我改 */
async function runQuestionGrade() {
  const p = state.data?.problems.find((x) => x.id === state.solve.id);
  const g = state.grade;
  if (!p) return;
  if (!g.uploads.length) return toast('先把这道题的手写过程传上来', 'err');
  if (!state.ai?.ready) return toast('先配置内置 AI（右上角 ⚙ 设置）', 'err');

  g.busy = true;
  g.error = null;
  g.progress = { chars: 0, think: 0 };
  state.solveVerdict = null;
  render();

  const key = solveTimerKey(p.id);
  // 这道题我写完了、也拍完传上来了：计时停在交卷这一刻（先取时间，再停，别把停的瞬间算进去）
  const seconds = Math.round(paperElapsed(key) / 1000);
  stopPaperTimer(key);
  try {
    const res = await fetch('/api/grade/question', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: p.id, names: g.uploads.map((u) => u.name), seconds }),
    });
    if (!res.ok || !res.body) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        let m;
        try {
          m = JSON.parse(t);
        } catch {
          continue;
        }
        if (m.t === 'delta') {
          state.grade.progress = { chars: m.chars, think: m.think };
          paintGradeProgress();
        } else if (m.t === 'done') {
          // suggest 留着显示「AI 建议…」，我点了别的 chip 也不丢
          state.solveVerdict = {
            ...m.verdict,
            suggest: m.verdict.result,
            setFirstReason: !p.firstReason && !!m.verdict.reason,
          };
          state.grade.uploads = []; // 服务端判完就把暂存图片清掉了
        } else if (m.t === 'error') {
          state.grade.error = m.message;
        }
      }
    }
  } catch (err) {
    state.grade.error = String(err.message || err);
  } finally {
    g.busy = false;
    g.progress = null;
    render();
    if (state.grade.error) toast(`判分失败：${state.grade.error}`, 'err');
    else if (state.solveVerdict) toast(`判完了：${state.solveVerdict.score}/100（建议 ${state.solveVerdict.result}）`, 'ok');
  }
}

/** 把这次判分按我现在定的内容记进笔记 */
async function recordSolveVerdict() {
  const v = state.solveVerdict;
  if (!v) return;
  const analysis = document.getElementById('sqAnalysis')?.value?.trim() || '';
  const setFirst = !!document.getElementById('sqFirstReason')?.checked;
  state.solveVerdict = null;
  await doSolveCheckin(v.result, v.reason || null, { analysis, setFirstReason: setFirst });
}

async function doSolveCheckin(result, reason, extra = {}) {
  const p = state.data.problems.find((x) => x.id === state.solve.id);
  if (!p) return;
  const key = solveTimerKey(p.id);
  const seconds = Math.round(paperElapsed(key) / 1000);
  state.solve.pendingResult = null;
  try {
    await api('/api/checkin', {
      method: 'POST',
      body: JSON.stringify({
        id: p.id,
        result,
        seconds: Math.max(1, seconds),
        reason: reason || null,
        // 单题拍照判分那一路带过来的：错因分析（+ 要不要覆盖首次错因）
        analysis: extra.analysis || undefined,
        setFirstReason: !!extra.setFirstReason,
      }),
    });
    resetTimerFor(key); // 记完了重新计时，方便再练一遍
    await reload({ silent: true });
    toast(
      `${p.num} → ${result}${reason ? `（${reason}）` : ''} · ${fmtSec(Math.max(1, seconds))}`,
      result === '完美' ? 'ok' : ''
    );
  } catch (err) {
    toast(`打卡失败：${err.message}`, 'err');
  }
}

/* ============================================================
   增题
   ============================================================ */
function renderAdd() {
  const a = state.add;
  const items = a.items;
  const isGood = state.book === 'good';
  const bookName = bookLabel();
  const noun = isGood ? '好题' : '错题';

  const preview = items && items.length
    ? `<div class="section-title"><h2>识别结果</h2><span class="hint">逐题核对，可直接改；编号已自动避开已有文件</span></div>
       <div class="add-items">${items
         .map(
           (it, i) => `<article class="add-item" data-index="${i}">
        <div class="ai-head">
          <span class="ai-no">第 ${i + 1} 题</span>
          <span class="badge badge-type">${it.confidence ? `识别置信度 ${it.confidence}` : '未识别'}</span>
          <span class="ai-file">→ ${esc(bookName)}/${esc(it.category)}/${esc(it.subject)}/${esc(it.chapter || it.subject)}/</span>
        </div>
        <div class="ai-fields">
          <label>大类 <input data-field="category" value="${esc(it.category)}" list="catList"></label>
          <label>科目 <input data-field="subject" value="${esc(it.subject)}" list="subList"></label>
          <label>章节 <input data-field="chapter" value="${esc(it.chapter)}" list="chList"></label>
          <label>编号 <input data-field="num" value="${it.num}" size="3"></label>
          <label class="grow">短标题 <input data-field="slug" value="${esc(it.slug)}"></label>
          <label class="grow">考点 <input data-field="points" value="${esc((it.points || []).join('、'))}" list="pointList" placeholder="用、隔开，没有的会自动新建"></label>
          <label>题型 <input data-field="type" value="${esc(it.type)}"></label>
          <label>难度 <select data-field="difficulty">${[1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${n === 3 ? 'selected' : ''}>${'⭐'.repeat(n)}</option>`).join('')}</select></label>
          <label>热度 <select data-field="heat">${[1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${n === 3 ? 'selected' : ''}>${'🔥'.repeat(n)}</option>`).join('')}</select></label>
          ${
            isGood
              ? ''
              : `<label>错因 <select data-field="reason">${['', ...REASONS].map((r) => `<option value="${esc(r)}">${r ? esc(r) : '（待补充）'}</option>`).join('')}</select></label>`
          }
        </div>
        <pre class="ai-stem">${esc(it.stem.slice(0, 400))}${it.stem.length > 400 ? '\n…' : ''}</pre>
      </article>`
         )
         .join('')}</div>`
    : '';

  const dl = `<datalist id="pointList">${allPoints()
    .map((pt) => `<option value="${esc(pt)}"></option>`)
    .join('')}</datalist>
    <datalist id="catList">${state.data.taxonomy ? Object.keys(state.data.taxonomy).map((c) => `<option value="${esc(c)}">`).join('') : ''}</datalist>
    <datalist id="subList">${state.data.options ? [...new Set(state.data.options.map((o) => o.subject))].map((s) => `<option value="${esc(s)}">`).join('') : ''}</datalist>
    <datalist id="chList">${state.data.options ? [...new Set(state.data.options.map((o) => o.chapter))].map((c) => `<option value="${esc(c)}">`).join('') : ''}</datalist>`;

  return `<div class="add-page">
    <div class="rv-setup-head">
      <h2>加新${noun}</h2>
      <p>${
        state.ai?.ready
          ? `粘题干 → <b>生成并写入</b>，一步到位：认章节、定题型、编号、解出<b>标准答案与解析</b>、
             打考点标签，然后写进 <b>${esc(bookName)}</b>。${
               isGood ? '好题不写错因分析；' : ''
             }归类也顺手做了（能并进已有通解的只改关联）。`
          : `程序负责机械活：认章节、定题型、编号、建骨架、写进 <b>${esc(bookName)}</b>。
             <b>答案与解析留空</b> —— 想让它自动解题并写好答案，去右上角 <b>⚙ 设置</b> 配一下内置 AI。`
      }</p>
    </div>

    ${aiHint()}

    <section class="panel">
      <div class="panel-head"><h3>① 粘贴题干</h3><span class="hint">多道题用一行 <code>---</code> 分隔</span></div>
      <div class="panel-body">
        <textarea id="addStem" rows="9" placeholder="把题目粘贴到这里……&#10;&#10;例如：&#10;计算 $\lim\limits_{x\to 0}\dfrac{\sin x - x}{x^{3}}$">${esc(a.raw)}</textarea>
        <div class="add-controls">
          <span class="ai-label">分题方式</span>
          ${chip(a.mode === 'rule', '按 <code>---</code> 分隔', null, 'data-add-mode="rule"')}
          ${chip(a.mode === 'blank', '按空行分隔', null, 'data-add-mode="blank"')}
          ${chip(a.mode === 'whole', '整段当一题', null, 'data-add-mode="whole"')}
          <button class="btn-ghost small" data-add="parse">识别并预览</button>
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h3>② 或者上传题目图片</h3>
        <span class="hint">图片只做暂存 —— 我会看懂内容后用文字重写题目、用代码重画图，不会把原图贴进笔记</span>
      </div>
      <div class="panel-body">
        <div class="drop-zone" id="dropZone">
          <input type="file" id="fileInput" accept="image/*" multiple hidden />
          <div class="dz-icon">🖼️</div>
          <div class="dz-text">把题目截图拖到这里、直接 <b>⌘V 粘贴</b>，或 <button class="link-btn" data-add="pick">选择文件</button></div>
          <div class="dz-hint">PNG / JPG / WebP，单张最大 15MB，可一次多张</div>
        </div>
        ${
          a.uploads && a.uploads.length
            ? `<div class="upload-list">${a.uploads
                .map(
                  (f) => `<figure class="upload-item">
              <img src="/uploads/${encodeURIComponent(f.name)}" alt="" loading="lazy" />
              <figcaption>${esc(f.name)}<br><span>${(f.bytes / 1024).toFixed(0)} KB</span></figcaption>
              <button class="up-del" data-add="del-upload" data-name="${esc(f.name)}" title="删掉">×</button>
            </figure>`
                )
                .join('')}</div>`
            : ''
        }
        <div class="add-controls">
          ${
            isGood
              ? ''
              : `<label class="inline-field">这批题的错因
            <select id="imageReason">${['', ...REASONS].map((r) => `<option value="${esc(r)}">${r ? esc(r) : '（待补充，你问我）'}</option>`).join('')}</select>
          </label>`
          }
          <button class="btn-ghost small" data-add="clear-uploads" ${
            a.uploads && a.uploads.length ? '' : 'disabled'
          }>清空图片暂存</button>
          <span class="rv-hint" style="margin:0">图片会和你粘的题干一起，由底部那一个按钮处理</span>
        </div>
        <div class="rv-hint">${
          state.ai?.ready
            ? `模型直接<b>看图</b>：把题干用文字 + LaTeX 重写出来，图里的图形用 <b>SVG</b> 重画一张，
               然后写进${esc(bookName)}。你的原图不会被放进笔记。`
            : `生成的提示词里会带上图片路径${isGood ? '' : '、错因'}和完整格式规范。
               想让它直接看图写题，去右上角 <b>⚙ 设置</b> 配一下内置 AI。`
        }</div>
      </div>
    </section>

    ${preview}

    ${renderAIRun()}

    <div class="rv-start-row">
      ${
        state.ai?.ready
          ? // 配了 AI：一个按钮把「粘的题干」和「传的图」一起处理，一步写完整笔记
            `<button class="btn-primary" data-airun="add" ${
              ((items && items.length) || (a.uploads && a.uploads.length)) && !state.aiRun?.running ? '' : 'disabled'
            }>生成并写入${esc(bookName)}${
              [
                items && items.length ? `${items.length} 道题干` : '',
                a.uploads && a.uploads.length ? `${a.uploads.length} 张图` : '',
              ]
                .filter(Boolean)
                .length
                ? `（${[
                    items && items.length ? `${items.length} 道题干` : '',
                    a.uploads && a.uploads.length ? `${a.uploads.length} 张图` : '',
                  ]
                    .filter(Boolean)
                    .join(' + ')}）`
                : ''
            }</button>`
          : `<button class="btn-primary" data-add="create" ${
              items && items.length ? '' : 'disabled'
            }>✚ 生成骨架并写入${esc(bookName)}</button>`
      }
      <button class="btn-ghost" data-add="clear">清空</button>
      ${state.aiRun?.running ? '<span class="rv-hint" style="margin:0">正在生成 —— 进度在上面的进度条里，随时可以中断</span>' : ''}
    </div>
    ${dl}
  </div>`;
}

/** 从预览 DOM 里读出用户最终确认的字段 */
function collectAddItems() {
  const nodes = [...document.querySelectorAll('.add-item')];
  return nodes.map((node) => {
    const get = (f) => node.querySelector(`[data-field="${f}"]`)?.value?.trim() ?? '';
    return {
      category: get('category'),
      subject: get('subject'),
      chapter: get('chapter'),
      num: Number(get('num')) || null,
      slug: get('slug'),
      type: get('type'),
      difficulty: Number(get('difficulty')) || 3,
      heat: Number(get('heat')) || 3,
      reason: get('reason'),
      // 考点：用、/，/空格分开；没有的标签直接新建
      points: [
        ...new Set(
          get('points')
            .split(/[、,，;；\s]+/)
            .map((x) => x.trim())
            .filter(Boolean)
        ),
      ],
      stem: state.add.items[Number(node.dataset.index)]?.stem || '',
    };
  });
}

/**
 * 识别结果里手改的一个字段 → 收回 state.add.items[i]。
 *
 * 这些输入框是在 renderAdd() 里按 state.add.items 生成的：不收回来的话，
 * 你改完章节又去传一张图（会整页重绘），改的东西就被冲回识别出来的原样了。
 */
function syncAddItemField(node, field, value) {
  const it = state.add.items?.[Number(node.dataset.index)];
  if (!it) return;
  if (field === 'num' || field === 'difficulty' || field === 'heat') {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) it[field] = n;
  } else if (field === 'points') {
    it.points = [
      ...new Set(
        String(value)
          .split(/[、,，;；\s]+/)
          .map((x) => x.trim())
          .filter(Boolean)
      ),
    ];
  } else {
    it[field] = String(value);
  }
}

async function addParse() {
  const raw = $('#addStem')?.value ?? state.add.raw;
  state.add.raw = raw;
  if (!raw.trim()) return toast('先粘贴题干', 'err');  try {
    const out = await api('/api/detect', {
      method: 'POST',
      body: JSON.stringify({ raw, mode: state.add.mode, book: state.book }),
    });
    state.add.items = out.items;
    render();
    toast(`识别出 ${out.count} 道题`);
  } catch (err) {
    toast(`识别失败：${err.message}`, 'err');
  }
}

async function addCreate() {
  const items = collectAddItems();
  if (!items.length) return;
  state.add.busy = true;
  try {
    const out = await api('/api/new', {
      method: 'POST',
      body: JSON.stringify({ items, book: state.book }),
    });
    state.add.items = null;
    state.add.raw = '';
    await reload({ silent: true });
    render();
    toast(`已新建 ${out.created.length} 篇，现在共 ${out.total} 题（错题 + 好题）`, 'ok');
  } catch (err) {
    toast(`写入失败：${err.message}`, 'err');
  } finally {
    state.add.busy = false;
  }
}

/** 复制到剪贴板，失败时回退到 execCommand */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

async function loadUploads() {
  try {
    const r = await api('/api/uploads');
    state.add.uploads = r.files || [];
  } catch {
    state.add.uploads = [];
  }
}

async function uploadFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return toast('只支持图片文件', 'err');
  let ok = 0;
  for (const f of files) {
    if (f.size > 15 * 1024 * 1024) {
      toast(`${f.name} 超过 15MB，已跳过`, 'err');
      continue;
    }
    const dataUrl = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(f);
    });
    try {
      await api('/api/upload', { method: 'POST', body: JSON.stringify({ name: f.name, dataUrl }) });
      ok += 1;
    } catch (e) {
      toast(`上传失败 ${f.name}：${e.message}`, 'err');
    }
  }
  await loadUploads();
  render();
  if (ok) toast(`已上传 ${ok} 张 —— 再点底部的「生成并写入」`);
}

async function deleteUpload(name) {
  try {
    await api('/api/uploads', { method: 'DELETE', body: JSON.stringify({ names: [name] }) });
    await loadUploads();
    render();
  } catch (e) {
    toast(`删除失败：${e.message}`, 'err');
  }
}

async function clearUploads() {
  try {
    const r = await api('/api/uploads', { method: 'DELETE', body: JSON.stringify({}) });
    await loadUploads();
    render();
    toast(`已清空 ${r.removed} 张暂存图片`);
  } catch (e) {
    toast(`清空失败：${e.message}`, 'err');
  }
}

async function promptImages() {
  if (!state.add.uploads.length) return toast('先上传图片', 'err');
  const reason = document.getElementById('imageReason')?.value || '';
  try {
    const out = await api('/api/prompt-images', {
      method: 'POST',
      body: JSON.stringify({ names: state.add.uploads.map((f) => f.name), reason, book: state.book }),
    });
    await copyText(out.prompt);
    toast(`提示词已复制（写进${bookLabel()}）—— 粘给我，我读完图就把题目写进去`, 'ok');
  } catch (e) {
    toast(`生成提示词失败：${e.message}`, 'err');
  }
}

async function addPrompt() {
  const items = collectAddItems();
  if (!items.length) return;
  try {
    const out = await api('/api/prompt', {
      method: 'POST',
      body: JSON.stringify({
        stems: items.map((i) => i.stem),
        category: items[0].category,
        subject: items[0].subject,
        chapter: items[0].chapter,
        book: state.book,
      }),
    });
    await copyText(out.prompt);
    toast(`提示词已复制（写进${bookLabel()}）—— 去对话里发给我即可`, 'ok');
  } catch (err) {
    toast(`生成提示词失败：${err.message}`, 'err');
  }
}

/** 当前在哪一本：错题本 / 好题本（说“目录”时用） */
function bookLabel(book = state.book) {
  return book === 'good' ? '好题本' : '错题本';
}

/** 当前在哪一本，只要名词：错题 / 好题 */
function bookNoun(book = state.book) {
  return book === 'good' ? '好题' : '错题';
}

/* ============================================================
   渲染 & 路由
   ============================================================ */


/* ============================================================
   题型大全：每个题型一份通解
   ============================================================ */
async function loadPatterns(force = false) {
  if (state.patterns && !force) return;
  try {
    state.patterns = await api('/api/patterns');
  } catch (err) {
    state.patterns = { patterns: [], tree: [], unlinkedCount: 0 };
    toast(`读取题型本失败：${err.message}`, 'err');
  }
}

/** 掌握度徽标 */
function masteryBadge(pt) {
  const m = pt.mastery;
  if (m == null) {
    return pt.linkedCount
      ? '<span class="mastery none">还没练过</span>'
      : '<span class="mastery none">未关联题目</span>';
  }
  const tone = m >= 70 ? 'good' : m >= 40 ? 'mid' : 'low';
  return `<span class="mastery ${tone}">掌握度 ${m}%</span>`;
}

function renderPatterns() {
  const d = state.patterns;
  if (!d) return '<div class="loading"><div class="spinner"></div><p>正在读取题型本…</p></div>';

  // 大屏：整页看一份通解
  if (state.openPattern) {
    const pt = (d.patterns || []).find((x) => x.id === state.openPattern);
    if (pt) return renderPatternDetail(pt);
  }

  const list = d.patterns || [];
  const withMastery = list.filter((x) => x.mastery != null);
  const avg = withMastery.length ? Math.round(withMastery.reduce((s, x) => s + x.mastery, 0) / withMastery.length) : 0;
  const linkedTotal = list.reduce((s, x) => s + x.linkedCount, 0);

  const head = `<section class="panel pattern-head">
    <div class="panel-head">
      <h3>📐 题型大全</h3>
      <span class="hint">每个题型一份通解，掌握度由关联的错题/好题算出来</span>
    </div>
    <div class="panel-body">
      <div class="stat-grid" style="margin-bottom:14px">
        <div class="stat-card"><div class="stat-label">题型数</div><div class="stat-value">${list.length}</div>
          <div class="stat-foot">覆盖 ${(d.tree || []).length} 个大类</div></div>
        <div class="stat-card is-done"><div class="stat-label">平均掌握度</div><div class="stat-value">${avg}<span class="unit">%</span></div>
          <div class="stat-foot">${withMastery.length} 个题型有数据</div>
          <div class="progress"><i style="width:${avg}%"></i></div></div>
        <div class="stat-card"><div class="stat-label">已归类题目</div><div class="stat-value">${linkedTotal}</div>
          <div class="stat-foot">共 ${linkedTotal + d.unlinkedCount} 道</div></div>
        <div class="stat-card is-pending"><div class="stat-label">还没归类</div><div class="stat-value">${d.unlinkedCount}</div>
          <div class="stat-foot">${d.unlinkedCount ? '下次在「增题」页生成提示词时会自动归进去' : '全都归好了 🎉'}</div></div>
      </div>
      <div class="rv-hint">
        新题在<b>增题页生成提示词时就会自动归类</b>：能并入已有通解的只改关联，新题型才新建 ——
        同一题型永远只有一份通解。
      </div>
    </div>
  </section>`;

  if (!list.length) {
    return `${head}<div class="panel" style="margin-top:14px"><div class="panel-body empty-row">
      题型本还是空的。去「增题」页加题时，生成的提示词会顺手写下第一份通解。
    </div></div>`;
  }

  const cards = list
    .map(
      (pt) => `<article class="pattern-card" data-pattern-open="${esc(pt.id)}">
      <div class="pp-head">
        <h3>${esc(pt.title)}</h3>
        ${pt.type ? `<span class="badge badge-type">${esc(pt.type)}</span>` : ''}
        ${stars(pt.difficulty)}${fires(pt.heat)}
      </div>
      <div class="pp-meta">
        <span>${esc(pt.category)} · ${esc(pt.subject)} · ${esc(pt.chapter)}</span>
        <span>关联 <b>${pt.linkedCount}</b> 题</span>
        ${pt.failCount ? `<span style="color:var(--fail)">累计失败 <b>${pt.failCount}</b> 次</span>` : ''}
        ${pt.missing.length ? `<span style="color:var(--warn)">${pt.missing.length} 个关联已失效</span>` : ''}
        ${masteryBadge(pt)}
      </div>
      <div class="progress" style="margin-top:8px"><i style="width:${pt.mastery ?? 0}%"></i></div>
      <div class="pp-fold"><span class="pp-more">点开看通解与关联题目 →</span></div>
    </article>`
    )
    .join('');

  return `${head}<div class="pattern-list">${cards}</div>`;
}

/** 题型大屏：整页看一份通解 */
function renderPatternDetail(pt) {
  const rel = (pt.related || []).map((id) => state.data.problems.find((p) => p.id === id)).filter(Boolean);
  return `<div class="review pattern-screen">
    <div class="rv-bar">
      <button class="rv-exit" data-pattern-back="1">← 回到题型列表</button>
      <span class="rv-where">${esc(pt.category)} · ${esc(pt.subject)} · ${esc(pt.chapter)}</span>
    </div>
    <article class="rv-card">
      <div class="rv-head">
        <span class="rv-num">${esc(pt.title)}</span>
        ${pt.type ? `<span class="badge badge-type">${esc(pt.type)}</span>` : ''}
        ${stars(pt.difficulty)}${fires(pt.heat)}
        ${masteryBadge(pt)}
      </div>
      <div class="rv-stem">
        ${pt.features ? `<h4 class="pp-h">适用特征</h4>${mdToHtml(pt.features)}` : ''}
        ${pt.steps ? `<h4 class="pp-h">通解步骤</h4>${mdToHtml(pt.steps)}` : ''}
        ${pt.pitfalls ? `<h4 class="pp-h">易错点</h4>${mdToHtml(pt.pitfalls)}` : ''}
      </div>
      <div class="rv-revealed" style="margin-top:16px">
        <h4 class="pp-h" style="margin:0 0 10px">关联题目（${rel.length}）</h4>
        ${
          rel.length
            ? `<div class="pp-rel">${rel
                .map(
                  (p) => `<button class="rel-chip k-${p.kind}" data-open="${esc(p.id)}">
                    <span class="rc-kind">${p.kind === 'good' ? '好' : '错'}</span>${esc(p.num)}
                    <span class="rc-status">${esc(statusMeta(p.stats.status).text)}</span></button>`
                )
                .join('')}</div>`
            : '<p class="rv-hint">还没关联任何题目。</p>'
        }
      </div>
      <div class="solve-foot">
        <span>源文件：${esc(pt.rel)}</span>
        <button class="link-btn" data-doc-open="${esc(pt.rel)}">📄 看原文</button>
      </div>
    </article>
  </div>`;
}

/* ---------------- 原文查看 ---------------- */
async function loadDoc(rel) {
  state.doc = { rel, loading: true };
  try {
    state.doc = await api(`/api/raw?rel=${encodeURIComponent(rel)}`);
  } catch (err) {
    state.doc = { rel, content: `读取失败：${err.message}`, error: true };
  }
}

/** 原文页：把笔记正文（去掉 frontmatter）渲染出来，图片与双链都能用 */
function renderDoc() {
  const d = state.doc;
  if (!d || d.loading) return '<div class="loading"><div class="spinner"></div><p>正在读取原文…</p></div>';
  const body = (d.content || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const fm = (d.content || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const title = (body.match(/^#\s+(.+?)\s*$/m) || [])[1] || d.name || d.rel;
  const size = d.size ? `${(d.size / 1024).toFixed(1)} KB` : '';
  return `<div class="doc-screen">
    <div class="rv-bar">
      <button class="rv-exit" data-doc-back="1">← 返回</button>
      <span class="rv-where"><code>${esc(d.rel)}</code>${size ? `　${size}` : ''}</span>
      <button class="rv-exit doc-raw-toggle" data-doc-raw="1">${state.docRaw ? '看渲染' : '看源码'}</button>
    </div>
    <article class="note-detail">
      ${
        state.docRaw
          ? `<pre class="code-block doc-raw"><code>${esc(d.content || '')}</code></pre>`
          : `<div class="note-body">${mdToHtml(body)}</div>`
      }
      ${fm ? `<details class="doc-fm"><summary>frontmatter</summary><pre class="code-block"><code>${esc(fm[1])}</code></pre></details>` : ''}
      <div class="note-detail-foot">原文：<code>${esc(d.rel)}</code>${title ? '' : ''}</div>
    </article>
  </div>`;
}

/** 打开一篇笔记原文（双链跳转也走这里） */
async function openDoc(rel) {
  closeDrawer();
  go({ module: 'doc', rel });
}

/** 双链 [[名字]] / [[名字|别名]] 在程序里直接跳到那篇笔记 */
async function openWikiLink(target) {
  if (!target) return;
  try {
    const n = await api(`/api/note?name=${encodeURIComponent(target)}`);
    return openDoc(n.rel);
  } catch (err) {
    toast(`打不开「${target}」：${err.message}`, 'err');
  }
}

/* 归类提示词不再从「题型」页生成：新题在「增题」页生成提示词时就会自动归类到题型本 */

/* ============================================================
   study：今日 / 计划 / 笔记 / 复盘
   ============================================================ */

/** 一条可勾选的任务（计划页与今日页共用） */
function taskLi(task, { rel = '', occ = 0, lock = false } = {}) {
  const label = task.daily ? task.text.replace(/^🔁\s*/, '') : task.text;
  // 🔁 每日任务：本周打了几次卡，以及都是哪几天（>3 天就只给头和尾，免得把行撑爆）
  const days = task.daily ? (task.checkins || []).map((d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`) : [];
  const shown = !days.length ? '' : days.length <= 3 ? days.join('、') : `${days[0]}…${days[days.length - 1]}`;
  return `<li class="md-task${task.done ? ' is-done' : ''}">
    <input type="checkbox" data-task="1" data-rel="${esc(rel)}" data-text="${esc(task.text)}" data-occ="${occ}"${
      task.done ? ' checked' : ''
    }${lock ? ' disabled title="还没到那天"' : ''} />
    ${task.daily ? '<span class="daily-tag">每日</span>' : ''}
    <span>${inlineMd(label)}</span>
    ${task.daily ? `<em class="task-week">本周 ${(task.checkins || []).length}/${task.slots || 7}${shown ? ` · ${shown}` : ''}</em>` : ''}
    ${task.done && task.doneDate ? `<em class="task-date">✅ ${esc(task.doneDate)}</em>` : ''}
  </li>`;
}

/** 同一份计划里可能有重名任务，按出现顺序编号 */
function withOcc(list) {
  const seen = new Map();
  return list.map((t) => {
    const n = seen.get(t.text) || 0;
    seen.set(t.text, n + 1);
    return { ...t, occ: n };
  });
}

async function loadWeekly() {
  try {
    state.weekly = await api('/api/weekly');
  } catch {
    state.weekly = null;
  }
}

async function loadToday() {
  try {
    state.today = await api(`/api/today${state.viewDate ? `?date=${encodeURIComponent(state.viewDate)}` : ''}`);
    await loadWeekly();
  } catch (err) {
    state.today = null;
    toast(`读取今日数据失败：${err.message}`, 'err');
  }
}

/** 首页翻到本周的某一天（传 null / 空 = 回到今天）；写进 hash，刷新和分享链接都还在 */
async function goViewDate(date) {
  state.viewDate = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? String(date) : null;
  const hash = buildHash({ module: 'today' });
  if (location.hash !== hash) location.hash = hash; // 交给 applyHash 去拉数据
  else await loadToday().then(() => render());
}

/** 倒计时右边的「每日一句」：一天一句，跨天自动换（460 句里轮） */
function quoteBlock(q) {
  if (!q || !q.text) return '';
  return `<div class="cd-quote">
    <p class="cdq-text">${esc(q.text)}</p>
    <p class="cdq-from">—— ${esc(q.from || '')}</p>
  </div>`;
}

function renderToday() {
  const t = state.today;
  if (!t) return '<div class="loading"><div class="spinner"></div><p>正在读取今日数据…</p></div>';
  const cd = t.countdown;
  const w = t.week;
  const m = t.mistakes || {};

  const todayTasks = withOcc(t.todayTasks);
  const undated = withOcc(t.undated);
  const rest = withOcc(t.restUndone);

  // 在看哪一天：缺省今天；点「本周进度」那排的任意一天就能翻过去
  const viewing = t.viewing || { date: t.date, realToday: t.date, isToday: true, isFuture: false };
  const vLabel = `${Number(viewing.date.slice(5, 7))}/${Number(viewing.date.slice(8, 10))}（${t.weekday}）`;

  const dayStrip = w?.days?.length
    ? `<div class="day-strip">${w.days
        .map(
          (d) => `<button class="day-cell${d.isToday ? ' is-today' : ''}${d.isPast ? ' is-past' : ''}${
            d.isViewing ? ' is-viewing' : ''
          }" data-day="${esc(d.date)}" title="${esc(d.date)} ${esc(d.weekday)}　点开看这天要做什么">
        <span class="dc-week">${esc(d.weekday)}</span>
        <span class="dc-date">${esc(d.label)}</span>
        <span class="dc-count">${d.total ? `${d.done}/${d.total}` : '—'}</span>
        <span class="dc-bar"><i style="width:${d.total ? Math.round((d.done / d.total) * 100) : 0}%"></i></span>
      </button>`
        )
        .join('')}</div>`
    : '';

  return `<div class="today">
    <section class="countdown-card">
      <div class="cd-main">
        <div class="cd-label">距离考研还有</div>
        <div class="cd-days">${cd.days}<span>天</span></div>
        <div class="cd-sub">${esc(cd.examDate)}　·　约 ${cd.weeks} 周　·　约 ${cd.months} 个月</div>
      </div>
      ${quoteBlock(t.quote)}
      <div class="cd-actions">
        <button class="btn-primary" data-go="journal">✍️ 写今日复盘${t.review.exists ? '（已有）' : ''}</button>
        <button class="btn-ghost" data-go="mistakes">📕 去刷错题${m.due ? `（${m.due} 题到期）` : ''}</button>
      </div>
    </section>

    <div class="today-grid">
      <section class="panel">
        <div class="panel-head">
          <h3>${viewing.isToday ? '今天的任务' : `${esc(vLabel)}的任务`}</h3>
          ${
            viewing.isToday
              ? `<span class="hint">${esc(t.date)} ${esc(t.weekday)}　勾选直接写回 Obsidian</span>`
              : `<span class="hint">${esc(t.date)} ${esc(t.weekday)}${
                  viewing.isFuture ? '　还没到那天，先看个预览' : ''
                }　<button class="day-back" data-day="">← 回到今天</button></span>`
          }
        </div>
        <div class="panel-body">
          ${
            todayTasks.length
              ? `<ul class="task-list">${todayTasks
                  .map((x) => taskLi(x, { rel: w?.rel, lock: viewing.isFuture }))
                  .join('')}</ul>`
              : `<div class="rv-hint">${
                  viewing.isToday ? '这周的周计划里没有标今天日期的任务。' : '这天没有标日期的任务。'
                }</div>`
          }
          ${
            viewing.isToday && undated.length
              ? `<div class="task-sub">本周其他待办（没标日期）</div>
                 <ul class="task-list">${undated.map((x) => taskLi(x, { rel: w?.rel })).join('')}</ul>`
              : ''
          }
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <h3>本周进度</h3>
          <span class="hint">${w ? esc(w.title || '') : '没有找到本周计划'}</span>
        </div>
        <div class="panel-body">
          ${dayStrip}
          ${
            w
              ? `<div class="prog-row"><span>本周完成</span>
                   <div class="progress"><i style="width:${w.rate}%"></i></div>
                   <b>${w.done}/${w.total}　${w.rate}%</b></div>`
              : ''
          }
          ${
            t.monthPlan
              ? `<div class="prog-row"><span>本月完成</span>
                   <div class="progress"><i style="width:${t.monthPlan.rate}%"></i></div>
                   <b>${t.monthPlan.done}/${t.monthPlan.total}　${t.monthPlan.rate}%</b></div>`
              : ''
          }
          ${
            m.total != null
              ? `<div class="prog-row"><span>错题已复习</span>
                   <div class="progress"><i style="width:${m.rate}%"></i></div>
                   <b>${m.done}/${m.total}　${m.rate}%</b></div>`
              : ''
          }
        </div>
      </section>
    </div>

    <div class="stat-grid">
      <div class="stat-card">
        <div class="stat-label">${viewing.isToday ? '📅 今日完成' : `📅 ${esc(vLabel)}完成`}</div>
        <div class="stat-value">${t.todayTasks.filter((x) => x.done).length}<span class="unit">/${t.todayTasks.length}</span></div>
        <div class="stat-foot">${viewing.isToday ? '今天' : '那天'}标了日期的任务</div>
      </div>
      <div class="stat-card is-done">
        <div class="stat-label">✅ 本周完成率</div>
        <div class="stat-value">${w ? w.rate : 0}<span class="unit">%</span></div>
        <div class="stat-foot">${w ? `${w.done} / ${w.total} 项` : '—'}</div>
      </div>
      <div class="stat-card is-pending">
        <div class="stat-label">📕 错题待复习</div>
        <div class="stat-value">${m.pending ?? 0}</div>
        <div class="stat-foot">刚加的 + 复习到期的，都算在这里</div>
      </div>
      <div class="stat-card is-streak">
        <div class="stat-label">🔥 连续打卡</div>
        <div class="stat-value">${m.streak ?? 0}<span class="unit">天</span></div>
        <div class="stat-foot">错题累计打卡 <b>${m.checkins ?? 0}</b> 次</div>
      </div>
    </div>

    ${vocabPanel(state.today?.words, { fromToday: true })}

    ${weeklyPanel()}

    <section class="panel" style="margin-top:14px">
      <div class="panel-head"><h3>本周剩余</h3><span class="hint">还没勾掉的</span></div>
      <div class="panel-body">
        ${
          rest.length
            ? `<ul class="task-list">${rest.map((x) => taskLi(x, { rel: w?.rel })).join('')}</ul>`
            : '<div class="rv-hint">本周后面的任务都清掉了 🎉</div>'
        }
      </div>
    </section>
  </div>`;
}

/** 本周状态总结：程序不下结论，生成提示词交给 AI，写完再显示在这里 */
function weeklyPanel() {
  const w = state.weekly;
  if (!w) return '';
  const meta = w.week
    ? `${esc(w.week.range.start)} ~ ${esc(w.week.range.end)}　·　完成 ${w.week.done}/${w.week.total}（${w.week.rate}%）　·　复盘 ${w.reviewCount} 篇`
    : '';

  // 上一周的总结：周一一切周就从当前周的文件里「消失」了，不主动找出来会以为丢了
  const prev = w.summary || !w.previous
    ? ''
    : `<details class="prev-summary">
        <summary>📌 本周还没写 —— 看上一周（${esc(w.previous.range.start)} ~ ${esc(w.previous.range.end)}）的总结</summary>
        <div class="md-doc weekly-body">${mdToHtml(w.previous.body)}</div>
        <div class="rv-hint">写在 <code>${esc(w.previous.rel)}</code></div>
      </details>`;

  return `<section class="panel weekly" style="margin-top:14px">
    <div class="panel-head">
      <h3>🧭 本周状态与建议</h3>
      <span class="hint">${meta}</span>
    </div>
    <div class="panel-body">
      ${renderAIRun()}
      ${
        w.summary
          ? `<div class="md-doc weekly-body">${mdToHtml(w.summary.body)}</div>
             <div class="rv-start-row">
               <span class="rv-hint">${w.summary.body.length} 字　·　写在 <code>${esc(w.week ? w.week.rel : '')}</code></span>
               ${
                 state.ai?.ready
                   ? `<button class="btn-primary small" data-airun="weekly"${
                       state.aiRun?.running ? ' disabled' : ''
                     }>🔄 重新生成本周总结</button>`
                   : ''
               }

             </div>`
          : `<div class="rv-hint" style="margin-bottom:12px">
               程序自己不下结论。我可以读这一周的计划完成情况、每日复盘和错题数据，
               写一段<b>不超过 250 字</b>的总结与下周建议，写回你的周计划文件。
             </div>
             <div class="air-actions">
               ${
                 state.ai?.ready
                   ? `<button class="btn-primary" data-airun="weekly"${
                       state.aiRun?.running ? ' disabled' : ''
                     }>生成本周总结</button>`
                   : ''
               }

             </div>
             ${prev}`
      }
    </div>
  </section>`;
}

/* ---------------- 单词（墨墨背单词 → 考研英语一题型） ---------------- */

/** 词池里所有词（各来源去重） */
function poolAllWords() {
  const groups = state.words?.pool?.groups || {};
  const seen = new Map();
  for (const key of SOURCE_ORDER) {
    for (const w of groups[key]?.words || []) if (!seen.has(w.voc_id)) seen.set(w.voc_id, w);
  }
  return [...seen.values()];
}

/** 单个来源里的词（「背了多次」还要按次数阈值过一道） */
function sourceWords(key) {
  const g = state.words?.pool?.groups?.[key];
  if (!g) return [];
  const words = g.words || [];
  if (!g.byCount) return words;
  const min = Number(state.pick.rustyMin) || 3;
  return words.filter((w) => (w.study_count || 0) >= min);
}

/**
 * 候选池 → 搜索词 → 显示范围。
 *
 * 「整个计划」一勾就是上千个词条，默认只铺**最快到期的 200 个**（按到期日升序，
 * 没有排期的排最后）—— 想全看就把范围切到「全部」。
 */
function pickVisibleWords() {
  const q = String(state.pick.q || '').trim().toLowerCase();
  const list = candidateWords();
  const hit = q ? list.filter((w) => String(w.spelling || '').toLowerCase().includes(q)) : list;
  if (state.pick.range !== 'due200' || hit.length <= PICK_RANGE) return hit;
  // 稳一点：按到期日升序，没排期的（due=0/undefined）排到最后
  return [...hit]
    .sort((a, b) => (a.due || Number.POSITIVE_INFINITY) - (b.due || Number.POSITIVE_INFINITY))
    .slice(0, PICK_RANGE);
}

/** 默认铺多少个词条 */
const PICK_RANGE = 200;

/** 词条那一片 HTML：它得能单独重画（搜索时只换它，不整页重绘） */
function pickChipsHtml(words) {
  const pickedIds = new Set(buildSelection().picked.map((x) => x.voc_id));
  const sel = buildSelection();
  return words
    .map((x) => wordChip(sel.outsideIds.has(x.voc_id) ? { ...x, outside: true } : x, pickedIds.has(x.voc_id)))
    .join('');
}

/** 当前勾选的来源合起来能选哪些词 */
function candidateWords() {
  const seen = new Map();
  for (const key of SOURCE_ORDER) {
    if (!state.pick.sources.includes(key)) continue;
    for (const w of sourceWords(key)) if (!seen.has(w.voc_id)) seen.set(w.voc_id, w);
  }
  return [...seen.values()];
}

/** 这次会出几篇、推荐配多少词 */
function plannedPapers() {
  const types = state.words?.paperTypes || [];
  const byId = new Map(types.map((t) => [t.id, t]));
  const n = Math.max(1, Math.min(6, Number(state.pick.papers) || 1));
  if (state.pick.random) return { count: n, types: [], avg: 15 };
  const picked = state.pick.types.map((id) => byId.get(id)).filter(Boolean).slice(0, n);
  return {
    count: picked.length,
    types: picked,
    avg: picked.length ? Math.round(picked.reduce((s, t) => s + t.words, 0) / picked.length) : 15,
  };
}

/** 推荐词数（自选 = 各题型之和；随机 = 篇数 × 15） */
function recommendedCount() {
  const plan = plannedPapers();
  if (state.pick.random) return plan.count * 15;
  return plan.types.reduce((s, t) => s + t.words, 0) || 15;
}

/**
 * 真正会拿去出题的词。
 * 先按勾选的来源取，数量不够就**自动从外面的词池补足**（这就是「不够自动选外面的」），
 * 再叠上你手动点掉 / 手动加进来的。
 */
function buildSelection() {
  const want = state.pick.count === 'auto' ? recommendedCount() : Math.max(1, Number(state.pick.count) || 1);
  const removed = new Set(state.pick.removed);
  const cand = candidateWords().filter((w) => !removed.has(w.voc_id));
  const picked = cand.slice(0, want);
  const gotIds = new Set(picked.map((w) => w.voc_id));

  // 不够 → 从整个词池里按顺序补，补进来的标一下来源，界面上会说明
  let outside = 0;
  if (picked.length < want) {
    for (const w of poolAllWords()) {
      if (gotIds.has(w.voc_id) || removed.has(w.voc_id)) continue;
      picked.push({ ...w, outside: true });
      gotIds.add(w.voc_id);
      outside += 1;
      if (picked.length >= want) break;
    }
  }

  // 手动加进来的（可以超出 want）
  const addedById = new Map(poolAllWords().map((w) => [w.voc_id, w]));
  for (const id of state.pick.added) {
    if (gotIds.has(id) || removed.has(id)) continue;
    const w = addedById.get(id);
    if (w) {
      picked.push(w);
      gotIds.add(id);
    }
  }

  return {
    picked,
    want,
    outside,
    outsideIds: new Set(picked.filter((w) => w.outside).map((w) => w.voc_id)),
    available: cand.length + state.pick.added.length,
  };
}

function wordChip(w, on) {
  const extra =
    w.outside === true
      ? '<span class="cw-tag is-out">池外</span>'
      : w.is_new
        ? '<span class="cw-tag is-new">新</span>'
        : w.study_count
          ? `<span class="cw-tag">${w.study_count}×</span>`
          : '';
  return `<button class="chip-word${on ? ' is-on' : ''}" data-word="${esc(w.voc_id)}" title="${esc(w.why || '')}">
    <span class="cw-text">${esc(w.spelling)}</span>${extra}
  </button>`;
}

/** 把故事 body 按 `## ` 切成小节，正文在 __head */
function splitStorySections(body) {
  const text = String(body || '');
  const idx = [...text.matchAll(/^##\s+(.+?)\s*$/gm)];
  const out = { __head: (idx.length ? text.slice(0, idx[0].index) : text).trim(), order: [] };
  idx.forEach((m, i) => {
    const end = i + 1 < idx.length ? idx[i + 1].index : text.length;
    const name = m[1].trim();
    out[name] = text.slice(m.index + m[0].length, end).trim();
    out.order.push(name);
  });
  return out;
}

/**
 * 把目标词在正文里标蓝。只动标签之间的文本，不碰 HTML；
 * 词形变化（limp → limping）也算命中。
 */
function highlightStoryWords(html, words) {
  const list = (words || []).map((x) => String(x).toLowerCase()).filter((x) => x.length >= 3);
  // 每个英文词都包一层：点一下就能看「在本句里的意思」，或者加进墨墨计划。
  // 目标词（这一篇要背的那几个）另外加个 story-word 类，仍然标蓝。
  return html.replace(/>([^<]+)</g, (whole, text) => {
    const marked = text.replace(/[A-Za-z][A-Za-z'-]*/g, (word) => {
      const low = word.toLowerCase();
      const isTarget = list.some((t) => low.startsWith(t));
      const clean = word.replace(/['-]+$/, '');
      return `<span class="rd-word${isTarget ? ' story-word' : ''}" data-rdword="${esc(clean)}">${word}</span>`;
    });
    return `>${marked}<`;
  });
}

/* ------------------------------------------------------------
   点词：查一下这个词在本句里是什么意思，或者加进墨墨计划

   墨墨的开放接口**不给词典释义**（`GET /interpretations` 只能读你自己加的释义），
   所以「本句里是什么意思」这一条走内置 AI；「加进计划」走官方
   `POST /study/add_words`（voc_id 先由 `POST /vocabulary/query` 换出来）。
   ------------------------------------------------------------ */

/** 从这一篇的「生词回收」表里取词 → 词性·释义（目标词的释义不用问模型，笔记里本来就有） */
function vocabMapOf(story) {
  const sec = splitStorySections(story.body || '')['生词回收'] || '';
  const map = new Map();
  for (const line of sec.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((x) => x.trim());
    if (cells.length < 4 || /^-+$/.test(cells[2]) || cells[1] === '单词') continue;
    const word = (cells[1].match(/[A-Za-z][A-Za-z'-]*/g) || [])[0];
    if (word) map.set(word.toLowerCase(), { gloss: cells[2] || '', sentence: cells[3] || '' });
  }
  return map;
}

/** 点中的那个词所在的整句（给模型当上下文用） */
function sentenceAround(el) {
  const block = el.closest('.reading-passage') || el.parentElement;
  const text = (block?.textContent || '').replace(/\s+/g, ' ').trim();
  const word = el.dataset.rdword || '';
  const at = text.toLowerCase().indexOf(word.toLowerCase());
  if (at === -1) return text.slice(0, 200);
  const before = text.slice(0, at);
  const start = Math.max(before.lastIndexOf('. '), before.lastIndexOf('? '), before.lastIndexOf('! '), before.lastIndexOf('; ')) + 1;
  const rest = text.slice(at);
  const m = rest.match(/[.?!;]/);
  const end = m ? at + m.index + 1 : Math.min(text.length, at + 220);
  return text.slice(start, end).trim();
}

/** 打开点词面板（贴着点中的那个词） */
function openWordCard(el) {
  const word = el.dataset.rdword || '';
  if (!word) return;
  const box = el.getBoundingClientRect();
  const known = vocabMapOf(state.story || {}).get(word.toLowerCase()) || null;
  state.wordCard = {
    word,
    sentence: sentenceAround(el),
    gloss: known?.gloss || '',
    glossSentence: known?.sentence || '',
    ai: null,
    busy: false,
    added: null,
    advance: false,
    x: Math.min(Math.max(12, box.left + box.width / 2 - 155), innerWidth - 322),
    y: Math.min(box.bottom + 8, innerHeight - 260),
  };
  render();
}

/**
 * 侧栏高度按「它所在的那个滚动容器」算，而不是写死的 100vh。
 *
 * 原来 CSS 是 `max-height: calc(100vh - 20px)`。可全屏阅读时滚的是 `.rf-body`
 * （视口里还占着一条标题栏 + 上下内边距），100vh 比真正的可见高度大一截 ——
 * 于是侧栏自己滚到最底下会差几行，非得把左边的文章也拉到最底才露出来。
 * 这里量一下真实可见高度，顺手把 sticky 的落点让开顶栏（不然贴上去会被顶栏盖住）。
 */
function fitReadRail() {
  const rail = document.querySelector('.rail-sticky');
  if (!rail) return;
  const reading = document.body.classList.contains('is-reading');
  const barH = reading ? 0 : document.querySelector('.topbar')?.getBoundingClientRect().height || 0;
  const stickTop = Math.round(barH + 8);
  rail.style.top = `${stickTop}px`;

  // 往上找真正在滚的那个容器（全屏阅读是 .rf-body，普通阅读页是窗口）
  let box = rail.parentElement;
  let scroller = null;
  while (box && box !== document.body) {
    const st = getComputedStyle(box);
    if (/(auto|scroll)/.test(st.overflowY) && box.scrollHeight > box.clientHeight + 1) {
      scroller = box;
      break;
    }
    box = box.parentElement;
  }
  const rect = rail.getBoundingClientRect();
  const top = rect.top <= stickTop + 1 ? stickTop : rect.top; // 已经贴住了就用落点，别来回抖
  let avail;
  if (scroller) {
    const sr = scroller.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(scroller).paddingBottom) || 0;
    avail = sr.bottom - pad - top - 10;
  } else {
    avail = innerHeight - top - 16;
  }
  rail.style.maxHeight = `${Math.max(220, Math.floor(avail))}px`;
}

/** 滚动 / 改窗口大小都要重算（rAF 合并，别每个 scroll 事件都算一次） */
let railFitPending = false;
function queueFitReadRail() {
  if (railFitPending) return;
  railFitPending = true;
  requestAnimationFrame(() => {
    railFitPending = false;
    fitReadRail();
  });
}

/** 浮层挂在 body 上（fixed 定位，贴着我点的那个词），整页重绘时重新挂一次 */
function mountWordCard() {
  document.querySelectorAll('.word-card').forEach((el) => el.remove());
  if (!state.wordCard) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = renderWordCard();
  document.body.appendChild(tmp.firstElementChild);
}

/** 只改浮层自己那块 DOM，不整页重绘（长文的滚动位置不能动） */
function paintWordCard() {
  const host = document.querySelector('.word-card');
  const tmp = document.createElement('div');
  tmp.innerHTML = renderWordCard();
  if (host) host.replaceWith(tmp.firstElementChild);
  else mountWordCard();
}

/** 点「本句里是什么意思」：带上下文问模型（结果服务端会按「词 + 句子」缓存） */
async function annotateWord() {
  const w = state.wordCard;
  if (!w || w.busy) return;
  w.busy = true;
  paintWordCard();
  try {
    const out = await api('/api/words/annotate', {
      method: 'POST',
      body: JSON.stringify({ word: w.word, sentence: w.sentence }),
    });
    if (state.wordCard) state.wordCard.ai = out;
  } catch (err) {
    if (state.wordCard) state.wordCard.ai = { pos: '', meaning: `查不了：${err.message}`, note: '' };
  } finally {
    if (state.wordCard) {
      state.wordCard.busy = false;
      paintWordCard();
    }
  }
}

/** 点「加入墨墨计划」：先换 voc_id 再 add_words（官方接口） */
async function addWordToPlan() {
  const w = state.wordCard;
  if (!w || w.busy) return;
  w.busy = true;
  paintWordCard();
  try {
    const out = await api('/api/words/add-to-plan', {
      method: 'POST',
      body: JSON.stringify({ spellings: [w.word], advance: !!w.advance }),
    });
    const msg =
      out.added > 0
        ? `已加入墨墨计划（${out.added} 个${out.advance ? '，已提前到立即复习' : ''}）`
        : out.missing?.length
          ? `${w.word} 不在墨墨的词库里，加不了`
          : '这个词已经在你的计划里了';
    if (state.wordCard) state.wordCard.added = msg;
    toast(msg, out.added > 0 ? 'ok' : '');
    if (out.added > 0) loadWords({ force: true }).catch(() => {});
  } catch (err) {
    if (state.wordCard) state.wordCard.added = `加不了：${err.message}`;
  } finally {
    if (state.wordCard) {
      state.wordCard.busy = false;
      paintWordCard();
    }
  }
}

function renderWordCard() {
  const w = state.wordCard;
  if (!w) return '';
  const ai = w.ai;
  return `<div class="word-card" style="left:${Math.round(w.x)}px;top:${Math.round(w.y)}px">
    <div class="wc-head">
      <b>${esc(w.word)}</b>
      <button class="mini wc-x" data-word-card="close" title="关掉">✕</button>
    </div>
    ${
      w.gloss
        ? `<div class="wc-row"><span class="wc-tag">本篇生词</span>${esc(w.gloss)}${
            w.glossSentence ? `<i class="wc-src">${esc(w.glossSentence)}</i>` : ''
          }</div>`
        : ''
    }
    ${
      ai
        ? `<div class="wc-row"><span class="wc-tag ai">AI 注释</span>${ai.pos ? `<b>${esc(ai.pos)}</b> ` : ''}${esc(
            ai.meaning
          )}${ai.note ? `<i class="wc-src">${esc(ai.note)}</i>` : ''}</div>`
        : w.busy
          ? '<div class="wc-row wc-busy">正在问模型「本句里是什么意思」…</div>'
          : `<button class="mini wc-btn" data-word-card="annotate">🔍 本句里是什么意思</button>`
    }
    <div class="wc-foot">
      ${
        w.added === null
          ? `<button class="mini wc-btn primary" data-word-card="add">＋ 加入墨墨计划${
              w.advance ? '（并提前复习）' : ''
            }</button>
             <label class="wc-advance"><input type="checkbox" data-word-card="advance"${
               w.advance ? ' checked' : ''
             } />顺便提前复习</label>`
          : `<span class="wc-ok">${esc(w.added)}</span>`
      }
    </div>
  </div>`;
}

/**
 * 题目：选项可点，交卷前不给任何反馈；判卷完全在本地做。
 * 得分**按每题分值算**（考研英语一：一篇阅读 5 题 × 2 分 = 10 分），不是按题数。
 */
function renderQuiz(story) {
  const qs = story.questions || [];
  if (!qs.length) return '';
  const key = story.key || {};
  const graded = state.quiz.graded;
  const answers = state.quiz.answers || {};
  const hasKey = Object.keys(key).length > 0;
  const pts = story.plan?.table?.byN || {};
  const scoreOf = (n) => Number(pts[n] ?? 0);
  const full = story.plan?.table?.full || qs.length;

  const items = qs
    .map((q) => {
      const mine = answers[q.n];
      const right = key[String(q.n)];
      const opts = q.options
        .map((o) => {
          const isMine = mine === o.key;
          const isRight = graded && hasKey && right === o.key;
          const isWrongPick = graded && hasKey && isMine && right && right !== o.key;
          const cls = [
            'q-opt',
            isMine ? 'is-picked' : '',
            isRight ? 'is-right' : '',
            isWrongPick ? 'is-wrong' : '',
          ]
            .filter(Boolean)
            .join(' ');
          return `<button class="${cls}" data-quiz-pick="1" data-q="${q.n}" data-k="${o.key}"${
            graded && hasKey ? ' disabled' : ''
          }><b>${esc(o.key)}.</b> ${esc(o.text)}</button>`;
        })
        .join('');
      const mark = graded && hasKey && mine ? (mine === right ? '✅' : '❌') : '';
      return `<li class="quiz-q" data-q="${q.n}">
        <p class="q-stem"><b>${q.n}.</b> ${esc(q.stem)} <span class="q-mark">${mark}</span>
          ${scoreOf(q.n) ? `<span class="q-score">${fmtPts(scoreOf(q.n))} 分</span>` : ''}</p>
        <div class="q-opts">${opts}</div>
      </li>`;
    })
    .join('');

  const answered = qs.filter((q) => answers[q.n]).length;
  const score = graded && hasKey ? quizScore(qs, answers, key, scoreOf) : 0;
  const refByN = story.plan?.ref?.byN || {};

  return `<section class="quiz">
    <div class="quiz-head">
      <h3>题目</h3>
      <span class="hint">共 ${qs.length} 题　·　${fmtPts(full)} 分　·　已答 ${answered}${
        graded && hasKey ? `　·　得分 ${fmtPts(score)} / ${fmtPts(full)}` : ''
      }</span>
    </div>
    ${
      Object.keys(refByN).length
        ? `<div class="quiz-ref">每题参考用时：${qs
            .map((q) => `${q.n} 题 ${fmtSpan(refByN[q.n] || 0)}`)
            .join('　·　')}</div>`
        : ''
    }
    <ol class="quiz-list">${items}</ol>
    <div class="quiz-actions">
      ${
        hasKey
          ? `<button class="btn-primary small" data-quiz="grade"${answered === 0 ? ' disabled' : ''}>对答案</button>
             <button class="btn-ghost small" data-quiz="reset">重做</button>`
          : '<span class="rv-hint">这份没有「答案速查」，答案在下面的「答案解析」里。</span>'
      }
    </div>
  </section>`;
}

/** 本地判卷的得分：只有选对的题才算分，每题按分值给（不是每道 1 分） */
function quizScore(qs, answers, key, scoreOf) {
  return qs.reduce((s, q) => (answers[q.n] && answers[q.n] === key[String(q.n)] ? s + scoreOf(q.n) : s), 0);
}

/**
 * 「加入错题本 / 好题本」前的填写面板。
 * 错题本该有的东西一个都不能少：错因、考点、难度、热度，以及程序的分类识别结果（可改）。
 */
function renderBankForm(q) {
  const draft = state.bankDraft;
  if (!draft || draft.n !== q.n) return '';
  const isGood = draft.book === 'good';
  const label = isGood ? '好题本' : '错题本';
  return `<div class="bank-form">
    <div class="bf-head">
      <b>加入${label} · 第 ${q.n} 题</b>
      <span class="hint">这些字段会一起写进笔记</span>
    </div>

    ${
      isGood
        ? '<div class="rv-hint">好题本不收错因分析 —— 好题不是因为做错才收的。</div>'
        : `<div class="bf-row">
             <span class="bf-label">错因</span>
             <div class="chip-row">${REASONS.map(
               (r) =>
                 `<button class="chip${draft.reason === r ? ' is-on' : ''}" data-bank-reason="${esc(r)}">${esc(r)}</button>`
             ).join('')}</div>
           </div>`
    }

    <div class="bf-row">
      <span class="bf-label">考点</span>
      <input id="bankPoints" class="set-input" list="pointList" value="${esc(draft.points)}"
        placeholder="用、隔开，没有的会自动新建" />
    </div>

    <div class="bf-row">
      <span class="bf-label">难度</span>
      <div class="chip-row">${[1, 2, 3, 4, 5]
        .map(
          (n) =>
            `<button class="mini${Number(draft.difficulty) === n ? ' is-on' : ''}" data-bank-diff="${n}">${'⭐'.repeat(n)}</button>`
        )
        .join('')}</div>
    </div>

    <div class="bf-row">
      <span class="bf-label">考研热度</span>
      <div class="chip-row">${[1, 2, 3, 4, 5]
        .map(
          (n) =>
            `<button class="mini${Number(draft.heat) === n ? ' is-on' : ''}" data-bank-heat="${n}">${'🔥'.repeat(n)}</button>`
        )
        .join('')}</div>
    </div>

    <div class="bf-row">
      <span class="bf-label">归类</span>
      <div class="chip-row">
        <input class="mini-input bf-cat" data-bank-field="category" value="${esc(draft.category || '')}" placeholder="大类" />
        <input class="mini-input bf-cat" data-bank-field="subject" value="${esc(draft.subject || '')}" placeholder="科目" />
        <input class="mini-input bf-cat" data-bank-field="chapter" value="${esc(draft.chapter || '')}" placeholder="章节" />
        <span class="rv-hint" style="margin:0">程序按题干关键词识别的，不对就直接改</span>
      </div>
    </div>

    <div class="bf-actions">
      <button class="btn-primary small" data-test-bank="confirm" data-test-n="${q.n}">确认加入${label}</button>
      <button class="btn-ghost small" data-test-bank="cancel">取消</button>
    </div>
  </div>`;
}

/** 侧栏面板的图标（认不出来的节用 📎） */
const RAIL_ICON = { 题目: '📝', 答案解析: '✅', 生词回收: '🔤', 中文大意: '🀄', 长难句拆解: '🧩', 逐句分析: '🔍' };

/**
 * 整篇渲染：**左右两栏**。
 *
 *   左（主栏）：英文原文 —— 读英文是主线，它永远在，而且目标词标蓝。
 *   右（侧栏）：题目、答案解析、生词回收、中文大意、长难句拆解……**可以同时开几个**
 *               （对完答案就是「题目 + 答案解析」一起看：上面是对错，下面是定位句）。
 *
 * 侧栏**全收起时它会缩成右边一条窄边条，原文自动回到中间**；
 * 开任何一个面板，原文就让位到左边、内容在右边 —— 折叠 / 打开的时候原文位置跟着动，
 * 不用自己去滚去对。侧栏是 sticky 的，原文再长它也跟着。
 *
 * 「成绩记录」留在主栏下面（它是整篇的成绩单，不是「读的内容」）。
 */
function renderReading(story) {
  const sec = splitStorySections(story.body || story.content || '');
  const passage = highlightStoryWords(mdToHtml(sec.__head), story.words);
  const plan = story.plan || {};

  // 侧栏面板 = 题目 + 正文里其余每一节。三个要排掉：
  //   「题目」—— 它已经由解析出来的题目面板代表了，再收一次会渲染两份；
  //   「答案速查」—— 就一行的答案字母，题目面板里对完答案已经标出来了，不值一个面板；
  //   「成绩记录」—— 属于整篇的成绩单，留在主栏原文下面。
  const SKIP = ['题目', '答案速查', '成绩记录'];
  const order = ['题目', ...sec.order.filter((n) => !SKIP.includes(n))];
  const open = order.filter((n) => (state.railTabs || []).includes(n));

  const tabBar = order
    .map(
      (n) => `<button class="rail-tab${open.includes(n) ? ' is-on' : ''}" data-rail="${esc(n)}" title="${esc(n)}">
        <i>${RAIL_ICON[n] || '📎'}</i><span>${esc(n)}</span></button>`
    )
    .join('');

  const panel = open
    .map(
      (n) => `<section class="rail-panel" data-panel="${esc(n)}">
        ${
          n === '题目'
            ? renderQuiz(story)
            : `<div class="md-doc story-body rail-doc">${mdToHtml(sec[n] || '')}</div>`
        }
      </section>`
    )
    .join('');

  return `<div class="read-layout${open.length ? ' has-rail' : ''}" id="readLayout">
    <article class="reading read-main">
      <div class="md-doc story-body reading-passage">${passage}</div>
      ${renderReadingGrade()}
      <div class="story-foot">
        正文 ${story.length || '—'} 词　·　目标词 ${story.words.length} 个　·　题 ${(story.questions || []).length} 道　·　满分 ${
          fmtPts(plan.table?.full || 10)
        } 分　·　<code>${esc(story.rel)}</code>
      </div>
    </article>
    <aside class="read-rail" id="readRail">
      <div class="rail-sticky">
        <div class="rail-tabs">${tabBar}</div>
        ${panel}
      </div>
    </aside>
  </div>`;
}

async function loadWords({ force = false } = {}) {
  try {
    state.words = await api(`/api/words${force ? '?fresh=1' : ''}`);
    // 换了一天就把手动改动清掉；没勾过题型就给个默认
    const day = state.words.overview?.date || '';
    if (state.pick.day !== day) {
      state.pick.day = day;
      state.pick.removed = [];
      state.pick.added = [];
      state.pick.count = 'auto';
    }
    if (!state.pick.types.length && state.words.paperTypes?.length) {
      state.pick.types = [state.words.paperTypes[1]?.id || state.words.paperTypes[0].id];
    }
    if (!state.storyRel && state.words.stories?.length) {
      await loadStory(state.words.stories[0].rel);
    }
  } catch (err) {
    state.words = null;
    toast(`读取墨墨数据失败：${err.message}`, 'err');
  }
}

async function loadStory(rel) {
  if (!rel) {
    state.story = null;
    state.storyDraft = null;
    return;
  }
  try {
    state.story = await api(`/api/words/story?rel=${encodeURIComponent(rel)}`);
    state.storyRel = rel;
    state.storyDraft = null; // 换了一篇，上一篇没保存的草稿不能跟过来
    state.quiz = { answers: {}, graded: false };
    state.railTabs = ['题目']; // 换一篇就把侧栏收回「题目」—— 默认就是「原文在中间、题目在侧边」
    enterGradeZone(rel, 'story', state.story.grades || []);
  } catch {
    state.story = null;
  }
}

/**
 * 今日单词的环形图：已完成 / 待背。
 * 不用通用 donutChart 是因为那个中心写死了「题」，这里是「词」。
 */
function wordDonut(done, total, size = 132) {
  const r = size / 2 - 12;
  const C = 2 * Math.PI * r;
  const pct = total ? Math.min(1, done / total) : 0;
  const len = pct * C;
  const pctText = Math.round(pct * 100);
  return `<svg class="donut" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="今日已完成 ${pctText}%">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--surface-3)" stroke-width="14"></circle>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--done)" stroke-width="14"
      stroke-linecap="round" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}"
      transform="rotate(-90 ${size / 2} ${size / 2})"></circle>
    <text x="${size / 2}" y="${size / 2 - 1}" text-anchor="middle" fill="var(--text)" font-size="26" font-weight="700">${pctText}%</text>
    <text x="${size / 2}" y="${size / 2 + 18}" text-anchor="middle" fill="var(--text-3)" font-size="11">${done} / ${total} 词</text>
  </svg>`;
}

/**
 * 「今日单词」图表卡 —— 首页和单词页共用。
 * v 就是墨墨的概览对象（首页来自 /api/today 的 words，单词页来自 overview）。
 * 读不到数据也照常渲染，只是换一句原因：首页不能因为墨墨挂了就打不开。
 */
function vocabPanel(v, { fromToday = false } = {}) {
  const toWords = '<button class="btn-ghost small" data-go="words">📖 去单词页</button>';
  const wrap = (body, hint = '墨墨背单词') =>
    `<section class="panel vocab-panel" style="margin-top:14px">
      <div class="panel-head"><h3>📖 今日单词</h3><span class="hint">${esc(hint)}</span></div>
      <div class="panel-body">${body}</div>
    </section>`;

  // 首页：服务端进程比页面旧（改了代码没重启）时，说清楚，别让人以为墨墨坏了
  if (v === undefined) {
    return wrap(
      fromToday
        ? `<div class="rv-hint">服务端还是改动前的旧进程，没返回背词数据 —— 重启一下 study 服务就好。</div>${toWords}`
        : '<div class="rv-hint">正在读取…</div>'
    );
  }
  if (!v || !v.ok) {
    const msg = v.hasToken ? v.error : '还没配置墨墨 token';
    return wrap(
      `<div class="rv-hint">${esc(msg)}${v.stale ? `（显示的是 ${esc(v.stale)} 的缓存）` : ''}</div>${toWords}`,
      v.stale ? `缓存于 ${v.stale}` : '墨墨背单词'
    );
  }

  const p = v.progress;
  const plan = v.plan;
  // 整个计划的几个统计（已学 / 此刻过期 / 未来 7 天）。
  // **这个函数是今日页和单词页共用的**，必须在这里自己取一份 ——
  // 之前只在单词页那个函数里定义，这里直接引用，两个页签一起白屏。
  const psRaw = state.words?.pool?.planStats || {};
  const ps = {
    studied: Number(psRaw.studied) || 0,
    listed: Number(psRaw.listed) || 0,
    neverStudied: Number(psRaw.neverStudied) || 0,
    overdueNow: Number(psRaw.overdueNow) || 0,
    dueWeek: Number(psRaw.dueWeek) || 0,
  };
  const ratio = (n) => (plan.totalWords ? Math.round((n / plan.totalWords) * 100) : 0);
  // 分母可传：只有「已完成 / 该完成」这种才配进度条。
  // 之前分母写死成计划总量（1133），于是「今日到期 91」「易忘词 90」都成了永远填不满的细线，
  // 而且根本说不清在表达什么 —— 计数类指标现在一律只显示数字。
  const bar = (label, n, color, total = plan.totalWords) =>
    `<div class="vb-row">
      <span class="vb-label">${label}</span>
      <div class="bar-track"><i style="width:${
        total ? Math.min(100, Math.round((n / total) * 100)) : 0
      }%;background:${color}"></i></div>
      <b>${n} <em>/ ${total}</em></b>
    </div>`;

  return wrap(
    `<div class="vocab-charts">
      <div class="vocab-donut">
        ${wordDonut(p.finished, p.total)}
        <div class="donut-legend">
          <div class="legend-row"><span class="legend-dot" style="background:var(--done)"></span>
            <span>今日已完成</span><span class="num">${p.finished} 词</span></div>
          <div class="legend-row"><span class="legend-dot" style="background:var(--surface-3)"></span>
            <span>今日还剩</span><span class="num">${p.remaining} 词</span></div>
        </div>
      </div>
      <div class="vocab-bars">
        ${bar('今日进度', p.finished, 'var(--done)', p.total)}
        <div class="vb-row vb-plain">
          <span class="vb-label">今日已学</span>
          <b>${p.studyMinutes} 分钟</b>
        </div>
        <div class="vb-row vb-plain">
          <span class="vb-label">今日到期</span>
          <b>${plan.dueToday} 词<em>其中 ${ps.overdueNow} 个此刻已过期</em></b>
        </div>
        <div class="vb-row vb-plain">
          <span class="vb-label">易忘词（全计划）</span>
          <b>${plan.sticking} 词</b>
        </div>
        <div class="vb-row vb-plain">
          <span class="vb-label">未来 7 天复习</span>
          <b>${ps.dueWeek} 词</b>
        </div>
        <div class="vb-row vb-plain">
          <span class="vb-label">计划总量</span>
          <b>${plan.totalWords} 词</b>
        </div>
      </div>
      ${fromToday ? `<div class="vocab-side">${toWords}</div>` : ''}
    </div>`,
    v.stale ? `缓存于 ${esc(v.stale)}` : '墨墨背单词'
  );
}

/**
 * 判卷后的界面更新 —— **只动 DOM，不整页重绘**。
 * 整页重绘会把长文的滚动位置顶回顶部，做一道题跳一次，很难受。
 */
function paintQuiz() {
  const story = state.story;
  const qs = story?.questions || [];
  if (!qs.length) return;
  const key = story.key || {};
  const hasKey = Object.keys(key).length > 0;
  const graded = state.quiz.graded;
  const answers = state.quiz.answers || {};
  const pts = story.plan?.table?.byN || {};
  const scoreOf = (n) => Number(pts[n] ?? 0);
  const full = story.plan?.table?.full || qs.length;

  for (const li of document.querySelectorAll('.quiz-q')) {
    const n = li.dataset.q;
    const mine = answers[n];
    const right = key[n];
    const mark = li.querySelector('.q-mark');
    if (mark) mark.textContent = graded && hasKey && mine ? (mine === right ? '✅' : '❌') : '';
    for (const btn of li.querySelectorAll('.q-opt')) {
      const k = btn.dataset.k;
      btn.classList.toggle('is-picked', !graded && mine === k);
      btn.classList.toggle('is-right', graded && hasKey && k === right);
      btn.classList.toggle('is-wrong', graded && hasKey && !!mine && mine === k && right !== k);
      btn.disabled = graded && hasKey;
    }
  }

  const answered = qs.filter((q) => answers[q.n]).length;
  const score = quizScore(qs, answers, key, scoreOf);
  const hint = document.querySelector('.quiz-head .hint');
  if (hint) {
    hint.textContent = `共 ${qs.length} 题\u3000\u00b7\u3000${fmtPts(full)} 分\u3000\u00b7\u3000已答 ${answered}${
      graded && hasKey ? `\u3000\u00b7\u3000得分 ${fmtPts(score)} / ${fmtPts(full)}` : ''
    }`;
  }
  const gradeBtn = document.querySelector('[data-quiz="grade"]');
  if (gradeBtn) gradeBtn.disabled = answered === 0;
}

/** 兼容旧名字：故事区还在用 state.story 里的 title/type */
/* ---------------- 选词页（整行，分块排布） ---------------- */

/** 一个带标题的控区块：标题在左、说明在右，控件在下面一行 */
function pkBlock(title, note, body, extra = '') {
  return `<div class="pk-block">
    <div class="pk-head"><span class="pk-title">${title}</span><span class="pk-note">${note}</span></div>
    <div class="pk-body">${body}</div>
    ${extra}
  </div>`;
}

function renderPicker(w, ov) {
  const poolData = w.pool || {};
  const groups = poolData.groups || {};
  const sel = buildSelection();
  const plan = plannedPapers();
  const rec = recommendedCount();
  const allWords = poolAllWords();
  const pickedIds = new Set(sel.picked.map((x) => x.voc_id));

  /* ① 词从哪来 */
  const sourceChips = SOURCE_ORDER.map((key) => {
    const g = groups[key];
    if (!g) return '';
    return `<button class="chip${state.pick.sources.includes(key) ? ' is-on' : ''}" data-source="${key}">
      ${esc(g.label)}<span class="cnt">${sourceWords(key).length}</span></button>`;
  }).join('');

  const rustyRow = state.pick.sources.includes('rusty')
    ? `<span class="pk-inline">背了
         ${[2, 3, 5].map((n) => `<button class="mini${Number(state.pick.rustyMin) === n ? ' is-on' : ''}" data-rusty="${n}">${n}</button>`).join('')}
       次以上还不熟</span>`
    : '';

  const blockSource = pkBlock(
    '① 词从哪来',
    '可以多选，选中的来源合起来就是候选词　·　默认是今天的词池，「整个计划」是给想从全部单词里挑的时候用的',
    `<div class="chip-row">${sourceChips}</div>${rustyRow ? `<div class="pk-sub">${rustyRow}</div>` : ''}`
  );

  /* ② 要多少个词 */
  const countRow =
    state.pick.count === 'auto'
      ? `<button class="mini is-on" data-count-mode="auto">按题型推荐 ${rec}</button>
         <button class="mini" data-count-mode="custom">自定义</button>`
      : `<button class="mini" data-count-mode="auto">按题型推荐 ${rec}</button>
         <button class="mini is-on" data-count-mode="custom">自定义</button>
         <input type="number" class="mini-input" id="wordCount" min="1" max="200" value="${state.pick.count}" />`;

  const planTotal = Number(state.words?.overview?.plan?.totalWords) || 0;
  // 词表**默认折叠**：勾上「整个计划」就是上千个词条，铺开既重又难挑
  const visibleWords = pickVisibleWords();
  const chips = allWords.length
    ? `<details class="word-pick-fold">
         <summary>词表（显示 ${visibleWords.length} / 共 ${allWords.length} 个${
           state.pick.q ? ` · 搜索命中 ${visibleWords.length}` : ''
         }）</summary>
         <div class="chip-row word-range">
           <button class="mini${state.pick.range === 'due200' ? ' is-on' : ''}" data-range="due200">最快到期 200 个</button>
           <button class="mini${state.pick.range === 'all' ? ' is-on' : ''}" data-range="all">全部（${allWords.length}）</button>
           ${
             state.pick.range === 'due200' && allWords.length > 200
               ? `<span class="pk-note">按到期日排，先铺最近要复习的 200 个</span>`
               : ''
           }
         </div>
         <input class="mini-input word-filter" id="wordFilter" placeholder="搜一个词 / 一段拼写…" value="${esc(
           state.pick.q
         )}" />
         <div class="word-chips">${pickChipsHtml(visibleWords)}</div>
       </details>`
    : `<div class="rv-hint">${
        poolData.ok ? '这个来源下没有候选词 🎉' : esc(poolData.error || '没读到词表')
      }</div>`;

  const blockCount = pkBlock(
    '② 要多少个词',
    `已选 <b>${sel.picked.length}</b>${sel.outside ? `（其中 <b>${sel.outside}</b> 个是池子不够、从外面补的）` : ''}
     ／候选池 ${sel.available}${
       poolData.recordsTruncated ? `，记录只取了前 ${poolData.recordsSeen} 条` : ''
     }${
       // 候选池只装「今天要背的 + 最近没背下来的」，不是整个计划 —— 这个差额要说清楚
       planTotal > poolData.recordsSeen
         ? `（计划共 ${planTotal} 词，其中 ${poolData.recordsSeen} 个能列出来）`
         : ''
     }`,
    `<div class="chip-row">${countRow}</div>`,
    chips
      ? `<div class="pk-tools">
           <span class="pk-note">点词可以取消 / 加回来</span>
           <button class="mini" data-words="reset-pick">按来源重选</button>
           <button class="mini" data-words="clear-pick">全不选</button>
         </div>${chips}`
      : ''
  );

  /* ③ 题型 */
  const typeChips = (w.paperTypes || [])
    .map(
      (t) => `<button class="chip type-chip${state.pick.types.includes(t.id) ? ' is-on' : ''}" data-type="${t.id}">
        ${esc(t.full)}<span class="cnt">${t.words}词</span></button>`
    )
    .join('');
  const blockTypes = pkBlock(
    '③ 题型',
    '全部按考研英语一的标准出题，可以多选',
    `<div class="chip-row">${typeChips}</div>`
  );

  /* ④ 出几篇 */
  const poolSize = state.pick.types.length || (state.pick.random ? (w.paperTypes || []).length : 0);
  const effective = Math.min(Number(state.pick.papers) || 1, poolSize) || 0;
  const paperRow = `<div class="chip-row">${[1, 2, 3, 4, 5, 6]
    .map((n) => `<button class="mini${Number(state.pick.papers) === n ? ' is-on' : ''}" data-papers="${n}">${n} 篇</button>`)
    .join('')}
    <label class="mini-toggle">
      <input type="checkbox" id="randomType"${state.pick.random ? ' checked' : ''} /> 每篇随机题型（多篇不重复）
    </label></div>
    ${
      poolSize && effective < Number(state.pick.papers)
        ? `<div class="pk-warn">勾了 <b>${state.pick.types.length}</b> 个题型${
            state.pick.random ? '（随机池）' : ''
          }，最多出 <b>${effective}</b> 篇 —— 想出 ${state.pick.papers} 篇就再勾几个题型</div>`
        : ''
    }`;
  const blockPapers = pkBlock(
    '④ 出几篇',
    state.pick.random ? '每篇的题型从勾选里随机抽，互不重复' : '按勾选的题型依次出',
    paperRow
  );


  return `<section class="panel picker-panel">
    <div class="panel-head">
      <h3>✍️ 选词 · 选题型</h3>
      <span class="hint">词来自墨墨，题型全部按考研英语一</span>
    </div>
    <div class="panel-body">
      ${blockSource}
      ${blockCount}
      ${blockTypes}
      ${blockPapers}
      ${renderAIRun()}
      ${aiHint()}
      <div class="pk-actions">
        ${
          state.ai?.ready
            ? `<button class="btn-primary" data-airun="words"${
                sel.picked.length &&
                (state.pick.random || state.pick.types.length) &&
                !state.pick.busy &&
                !state.aiRun?.running
                  ? ''
                  : ' disabled'
              }>${state.aiRun?.running ? '生成中…' : `生成 ${effective || 0} 道题`}</button>`
            : ''
        }
        <span class="rv-hint">每道题是一整篇考研阅读（5 道小题，四选一），共 <b>${
          sel.picked.length
        }</b> 个目标词${plan.types.length ? `　·　${plan.types.map((t) => esc(t.full)).join('、')}` : ''}${
          state.pick.random ? '　·　题型随机不重复' : ''
        }</span>
      </div>
    </div>
  </section>`;
}

/** 已有篇目：横向一条，点了进全屏做题 */
function renderStoryStrip(w) {
  const stories = w.stories || [];
  if (!stories.length) {
    return `<section class="panel story-panel">
      <div class="panel-head"><h3>📖 题目</h3><span class="hint">写进 <code>${esc(w.storyDir)}/</code></span></div>
      <div class="panel-body">
        <div class="rv-hint">还没有题目。上面选好词和题型，点上面的按钮生成。</div>
      </div>
    </section>`;
  }
  // 按日期分组，每组一行
  const byDay = new Map();
  for (const s of stories) {
    if (!byDay.has(s.date)) byDay.set(s.date, []);
    byDay.get(s.date).push(s);
  }
  const rows = [...byDay.entries()]
    .map(
      ([date, list]) => `<div class="strip-day">
        <span class="sd-date">${esc(date)}</span>
        <div class="sd-items">${list
          .map(
            (s) => `<span class="chip-with-del">
              <button class="story-chip" data-story-open="${esc(s.rel)}">
                <span class="sc-title">${esc(s.title)}</span>
                <span class="sc-meta">${s.type ? `${esc(s.type)} · ` : ''}${
                  s.questions ? `${s.questions} 题 · ` : ''
                }${s.length} 词${s.full ? ` · 满分 ${fmtPts(s.full)}` : ''}${
                  s.refMinutes ? ` · 参考 ${s.refMinutes} 分钟` : ''
                }${s.last ? ` · <b class="sc-score">${fmtPts(s.last.total)}/${fmtPts(s.last.full)}</b>` : ''}</span>
              </button>
              ${delBtn({ 'data-del-story': s.rel, 'data-del-key': `story:${s.rel}` })}
            </span>`
          )
          .join('')}</div>
      </div>`
    )
    .join('');

  return `<section class="panel story-panel">
    <div class="panel-head">
      <h3>📖 题目</h3>
      <span class="hint">点一篇 → 全屏做题（答案默认藏着）</span>
    </div>
    <div class="panel-body">${rows}</div>
  </section>`;
}

/**
 * 全屏做题。整个页面只剩这一篇：原文 + 题目。
 * 生词回收 / 中文大意 / 答案解析默认收起来，先自己做。
 */
function renderReadingFull() {
  const s = state.story;
  if (!s || !s.exists) {
    return `<div class="reading-full">
      <header class="rf-bar">
        <button class="btn-ghost small" data-words="exit-reading">← 返回</button>
        <b>找不到这一篇</b>
      </header>
      <div class="rf-body"><div class="rv-hint">文件可能被删了，返回重新选一篇。</div></div>
    </div>`;
  }
  return `<div class="reading-full">
    <header class="rf-bar">
      <button class="btn-ghost small" data-words="exit-reading">← 返回选词</button>
      <b class="rf-title">${esc(s.title || '')}</b>
      ${s.type ? `<span class="badge-type">${esc(s.type)}</span>` : ''}
      <span class="rf-meta">${s.length || '—'} 词　·　${(s.questions || []).length} 题　·　满分 ${
        fmtPts(s.plan?.table?.full || 10)
      } 分${s.plan?.ref?.minutes ? `　·　参考 ${s.plan.ref.minutes} 分钟` : ''}</span>
      ${renderPaperTimer(s.plan?.ref?.seconds || 0)}
      <button class="btn-ghost small" data-words="${state.storyEdit ? 'cancel-story' : 'edit-story'}">
        ${state.storyEdit ? '取消编辑' : '✎ 编辑'}</button>
    </header>
    <div class="rf-body">
      ${
        state.storyEdit
          ? `<textarea class="story-edit" id="storyEdit" rows="24">${esc(state.storyDraft ?? s.content ?? '')}</textarea>
             <div class="pick-actions">
               <button class="btn-primary small" data-words="save-story">保存</button>
               <button class="btn-ghost small" data-words="cancel-story">取消</button>
             </div>`
          : renderReading(s)
      }
    </div>
  </div>`;
}

function renderWords() {
  const w = state.words;
  if (!w) return '<div class="loading"><div class="spinner"></div><p>正在读取墨墨数据…</p></div>';

  // 有具体篇目 → 全屏做题，别的都不显示
  if (state.storyWide && state.story) return renderReadingFull();

  const ov = w.overview || {};
  const psRaw = w.pool?.planStats || {};
  const ps = {
    listed: Number(psRaw.listed) || 0,
    studied: Number(psRaw.studied) || 0,
    neverStudied: Number(psRaw.neverStudied) || 0,
    overdueNow: Number(psRaw.overdueNow) || 0,
    dueWeek: Number(psRaw.dueWeek) || 0,
  };


  const tokenWarn =
    !w.hasToken || !ov.ok
      ? `<div class="callout-lite ${w.hasToken ? 'is-warn' : 'is-err'}">
           <span>${w.hasToken ? '⚠️' : '🔑'} ${esc(ov.ok ? '还没配置墨墨 token' : ov.error || '没读到墨墨数据')}</span>
           ${w.hasToken && ov.stale ? `<em>显示的是 ${esc(ov.stale)} 的缓存</em>` : ''}
         </div>`
      : '';

  const hero = ov.ok
    ? `<div class="stat-grid">
        <div class="stat-card">
          <div class="stat-label">📖 今日进度</div>
          <div class="stat-value">${ov.progress.finished}<span class="unit">/${ov.progress.total}</span></div>
          <div class="progress"><i style="width:${ov.progress.rate}%"></i></div>
          <div class="stat-foot">还剩 <b>${ov.progress.remaining}</b> 个　·　已学 <b>${ov.progress.studyMinutes}</b> 分钟</div>
        </div>
        <div class="stat-card is-done">
          <div class="stat-label">📚 计划总量</div>
          <div class="stat-value">${ov.plan.totalWords}<span class="unit">词</span></div>
          <div class="stat-foot">在墨墨里排进计划的全部单词</div>
        </div>
        <div class="stat-card is-pending">
          <div class="stat-label">⏳ 今日到期</div>
          <div class="stat-value">${ov.plan.dueToday}<span class="unit">词</span></div>
          <div class="stat-foot">遗忘曲线排到今天该复习的（其中 ${ps.overdueNow} 个此刻已过期）　·　未来 7 天还有 ${ps.dueWeek} 词</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">📚 整个计划 · 已学</div>
          <div class="stat-value">${ps.studied}<span class="unit">/ ${ps.listed} 词</span></div>
          <div class="stat-foot">${ps.studied + ps.neverStudied === ps.listed ? '' : '约 '}背过至少一次 ${
            ps.listed ? `${Math.round((ps.studied / ps.listed) * 100)}%` : '—'
          }　·　一次都没背过 ${ps.neverStudied} 词</div>
        </div>
        <div class="stat-card is-streak">
          <div class="stat-label">🔥 易忘词（整个计划）</div>
          <div class="stat-value">${ov.plan.sticking}<span class="unit">词</span></div>
          <div class="stat-foot">整个计划里墨墨标了「一直记不住」的词</div>
        </div>
      </div>`
    : '';

  const tokenBox = `<details class="token-box"${w.hasToken ? '' : ' open'}>
    <summary>🔑 墨墨 token${w.hasToken ? '（已配置，点开可更换）' : '（还没配置）'}</summary>
    <div class="tb-body">
      <div class="rv-hint">
        在墨墨 App 里：<b>我的 → 更多设置 → 实验功能 → 开放 API</b>，
        或打开 <code>open.maimemo.com/open/api/v1/tokens/openapi</code> 登录后复制。
        网页取的那份 <b>有效期只有 7 天</b>，过期了换一个粘进来即可。
      </div>
      <div class="tb-row">
        <input type="password" id="tokenInput" placeholder="粘贴 access token" autocomplete="off" />
        <button class="btn-ghost small" data-words="save-token">保存</button>
      </div>
      <div class="rv-hint">只存在本机 <code>${esc(w.tokenFile || '')}</code>，已在 .gitignore 里，不会进 git、也不会显示在页面上。</div>
    </div>
  </details>`;

  return `<div class="words">
    <section class="countdown-card words-head">
      <div class="cd-main">
        <div class="cd-label">墨墨背单词　·　${esc(ov.date || '')}</div>
        <div class="cd-days">${ov.ok ? ov.progress.finished : '—'}<span>${ov.ok ? ` / ${ov.progress.total}` : ''}</span></div>
        <div class="cd-sub">${
          ov.ok ? `还剩 ${ov.progress.remaining} 个　·　今日已学 ${ov.progress.studyMinutes} 分钟` : '没读到墨墨数据'
        }</div>
      </div>
      <div class="cd-actions">
        <button class="btn-ghost" data-words="refresh">⟳ 刷新墨墨数据</button>
      </div>
    </section>

    ${tokenWarn}
    ${tokenBox}
    ${hero}
    ${vocabPanel(ov)}
    ${renderPicker(w, ov)}
    ${renderStoryStrip(w)}
  </div>`;
}



async function saveStoryDraft() {
  const content = document.getElementById('storyEdit')?.value ?? '';
  if (!content.trim()) return toast('内容还是空的', 'err');
  try {
    const out = await api('/api/words/story', {
      method: 'POST',
      body: JSON.stringify({
        rel: state.storyRel,
        content,
        words: state.story?.words || [],
      }),
    });
    if (state.words) state.words.stories = out.stories || state.words.stories;
    state.storyDraft = null; // 存进去了，草稿完成使命
    await loadStory(state.storyRel);
    state.storyEdit = false;
    render();
    toast(`已存到 ${out.rel}`, 'ok');
  } catch (err) {
    toast(`保存失败：${err.message}`, 'err');
  }
}

async function saveMaimemoToken() {
  const input = document.getElementById('tokenInput');
  const token = input?.value?.trim();
  if (!token) return toast('先粘贴 token', 'err');
  try {
    await api('/api/words/token', { method: 'POST', body: JSON.stringify({ token }) });
    if (input) input.value = '';
    await loadWords({ force: true });
    render();
    toast('token 已保存到本机，开始读墨墨数据', 'ok');
  } catch (err) {
    toast(`保存失败：${err.message}`, 'err');
  }
}

/* ---------------- 设置页 ---------------- */

/**
 * 专门的设置界面（顶栏右上角齿轮，或 #settings）。
 * 把原先散落在「单词」「测试」页里的两个配置块收拢到这里。
 */
/**
 * 手机访问那一块：一个开关 + 手机该输的地址。
 *
 * 开关**拨一下就生效，不用重启** —— 背后是两个监听：本机那个（127.0.0.1）永远在，
 * 电脑端和跑测试都不受这个开关影响；局域网那个按开关起停。
 * 关掉是**真的不听这个端口**了，不是回一句 403。
 */
function renderLanPanel() {
  const l = state.lan;
  if (!l) {
    return `<div class="rv-hint">
      读不到开关状态 —— 现在跑的这个进程还是旧代码（没有 <code>/api/lan</code>）。
      在下面「🔁 服务」里重启一次就有了。
    </div>`;
  }
  const on = !!l.on;
  const busy = !!state.lanBusy;
  const urls = l.urls || [];
  return `
    <div class="set-status ${on ? 'is-ok' : ''}">
      ${
        on
          ? `🟢 <b>已打开</b> —— 同一个 Wi-Fi 下的设备，浏览器输
             <code>${esc(urls[0] || '（没找到局域网 IP，先确认电脑连着 Wi-Fi）')}</code> 就能做题`
          : '⚪️ <b>已关闭</b> —— 只有这台电脑能打开，局域网里谁都连不上（端口也没在听）'
      }
    </div>
    ${
      l.error
        ? `<div class="callout callout-error"><div class="callout-head">⛔<span>没打开</span></div>
             <div class="callout-body">${esc(l.error)}</div></div>`
        : ''
    }
    <div class="set-actions">
      <button class="${on ? 'btn-ghost' : 'btn-primary'}" data-set="lan-on"${on || busy ? ' disabled' : ''}>
        📱 打开手机访问
      </button>
      <button class="${on ? 'btn-danger' : 'btn-ghost'}" data-set="lan-off"${!on || busy ? ' disabled' : ''}>
        🔒 关闭手机访问
      </button>
    </div>
    ${
      urls.length > 1
        ? `<div class="rv-hint" style="margin-top:10px">这台电脑有多个地址，
             手机连哪个要看它在哪个网：${urls.map((u) => `<code>${esc(u)}</code>`).join('　')}</div>`
        : ''
    }
    <div class="rv-hint" style="margin-top:10px">
      手机上输上面的地址时，<b>结尾的 <code>/m</code> 别丢</b>。打开后手机就能看题、
      拍手写答案传上来让 AI 判分、把结果直接记进这套 Markdown。<br>
      <b>关掉/打开都是立刻生效、不用重启</b>：刚关掉的那一刻，已经连着的手机也会断开；
      电脑这边不受影响（本机那个监听不归这个开关管）。
      ${on ? '<br>⚠️ 开着的时候，局域网里任何人都能打开、也能改你的笔记 —— 公共 Wi-Fi 下记得关掉。' : ''}
    </div>`;
}

/** 服务那一块：当前进程信息 + 一键重启（改完 server.mjs / lib 不用再回终端按 Ctrl+C） */
function renderServicePanel() {
  const h = state.health;
  // 老进程（还没重启过的那一个）不会返回 pid —— 那不是错误，就是「重启一下就有了」
  const info = !h
    ? '<div class="rv-hint">正在读取服务状态…</div>'
    : h.pid
      ? `<div class="set-status is-ok">
           🟢 服务在跑：<b>PID ${h.pid}</b>　·　端口 ${h.port}　·　已运行 ${fmtSpan(h.uptimeSeconds || 0)}
         </div>`
      : '<div class="set-status is-ok">🟢 服务在跑（这个是重启前的旧进程，重启一下就会带上 PID 和运行时长）</div>';
  const armed = state.restartArmed;
  return `${info}
    <div class="rv-hint" style="margin-top:10px">
      改完 <code>server.mjs</code> 或 <code>lib/</code> 里的东西要<b>重启</b>才生效；
      前端（<code>public/</code>）改完刷新一下就行。<br>
      重启期间这一页会短暂连不上 —— 起来了会自动刷新，不用管。
    </div>
    <div class="set-actions">
      <button class="${armed ? 'btn-danger' : 'btn-ghost'}" data-set="restart">
        ${armed ? '确认重启？再点一次就重启' : '🔄 重启后端'}
      </button>
      <button class="btn-ghost" data-set="reload-health">⟳ 刷新状态</button>
    </div>`;
}

/**
 * 一键重启：请求打完老进程就退了，所以**打完开始轮询**，
 * 等新进程起来（pid 变了）再自动刷新页面 —— 不用自己盯着按 F5。
 */
async function restartServer(btn) {
  if (btn) btn.disabled = true;
  const oldPid = state.health?.pid;
  try {
    await api('/api/restart', { method: 'POST', body: JSON.stringify({}) });
  } catch (err) {
    const msg = String(err.message || err);
    // 还没重启过的那一个老进程根本没有这个接口 —— 说清楚该怎么办，别让人以为按钮坏了
    toast(
      /No such API route|404/.test(msg)
        ? '现在跑的这个服务进程还是旧代码（还没带重启接口）—— 先在终端里手动重启它一次，以后这个按钮就能用了'
        : `重启失败：${msg}`,
      'err'
    );
    if (btn) btn.disabled = false;
    return;
  }
  state.restartArmed = false;
  render();
  toast('服务正在重启…起来了会自动刷新这一页');
  for (let i = 0; i < 60; i += 1) {
    await sleep(400);
    try {
      const r = await fetch('/api/health', { headers: { 'Content-Type': 'application/json' }, cache: 'no-store' });
      if (r.ok) {
        const h = await r.json();
        // 同一次重启里 pid 一定会变；拿它确认「新的真的起来了」
        if (h.ok && h.pid !== oldPid) {
          location.reload();
          return;
        }
      }
    } catch {
      /* 还没起来，接着等 */
    }
  }
  toast('等太久没等到新进程 —— 手动刷新一下页面；还不通就看 study-app/.server.log', 'err');
  if (btn) btn.disabled = false;
}

function renderSettings() {
  const a = state.ai;
  const tk = state.words;

  const aiPanel = !a
    ? '<div class="rv-hint">正在读取 AI 配置…</div>'
    : `
    <div class="set-status ${a.ready ? 'is-ok' : 'is-warn'}">
      ${
        a.ready
          ? `✅ 已配置：<b>${esc(a.model)}</b>　·　${esc(a.baseUrl)}　·　key ${
              a.hasKey ? '已保存' : '不需要（本地服务）'
            }`
          : `⚠️ 还没配好${a.needsKey ? '（缺 API key）' : '（缺接口地址或模型）'} —— 配好后各页会出现「生成」按钮`
      }
    </div>
    <div class="set-field">
      <label>服务商</label>
      <div class="chip-row">${(a.presets || [])
        .map(
          (p) =>
            `<button class="chip${a.baseUrl === p.baseUrl ? ' is-on' : ''}" data-ai-preset="${esc(p.id)}" title="${esc(
              p.note || ''
            )}">${esc(p.label)}</button>`
        )
        .join('')}</div>
      <div class="rv-hint">点一个就把下面的地址和模型填好，再把 key 粘进去。</div>
    </div>
    <div class="set-field">
      <label>接口地址</label>
      <input id="aiBaseUrl" class="set-input" placeholder="https://api.deepseek.com/v1" value="${esc(a.baseUrl || '')}" />
      <div class="rv-hint">要 OpenAI 兼容的地址（程序会打 <code>{地址}/chat/completions</code>）。带不带 <code>/v1</code> 都行，404 会自动换一种试。</div>
    </div>
    <div class="set-field">
      <label>模型</label>
      <input id="aiModel" class="set-input" placeholder="deepseek-flash" value="${esc(a.model || '')}" />
    </div>
    <div class="set-field">
      <label>思考模式</label>
      <div class="chip-row">${[
        ['auto', '自动（推荐）'],
        ['none', '关'],
        ['low', '低'],
        ['medium', '中'],
        ['high', '高'],
      ]
        .map(
          ([v, t]) =>
            `<button class="chip${(a.reasoning || 'auto') === v ? ' is-on' : ''}" data-ai-reasoning="${v}">${t}</button>`
        )
        .join('')}</div>
      <div class="rv-hint">
        DeepSeek 这类模型会先「思考」再回答，思考很吃 <code>max_tokens</code> ——
        额度被思考吃光时正文就是空的（看起来像「连不通」）。<br>
        <b>自动</b>＝英语出题关掉思考（快），数学 / 408 出题和解题开「中」（更准）。
        连接测试永远走「关」。
      </div>
    </div>
    <div class="set-field">
      <label>API Key</label>
      <input type="password" id="aiKey" class="set-input" placeholder="${
        a.hasKey ? '已保存（留空 = 不改动）' : '粘贴你的 key'
      }" autocomplete="off" />
    </div>
    ${
      a.envLocked
        ? `<div class="pk-warn">有环境变量在生效（${[
            a.fromEnv?.baseUrl ? 'AI_BASE_URL' : '',
            a.fromEnv?.model ? 'AI_MODEL' : '',
            a.fromEnv?.apiKey ? 'AI_API_KEY' : '',
          ]
            .filter(Boolean)
            .join('、')}），<b>它们优先于这里填的</b> —— 在这里改不生效。</div>`
        : ''
    }
    <div class="set-actions">
      <button class="btn-primary" data-ai="save">保存</button>
      <button class="btn-ghost" data-ai="test">测试连接</button>
      ${a.testResult ? `<span class="set-result">上次自检：${esc(a.testResult)}</span>` : ''}
    </div>
    <div class="rv-hint">
      key 只写进本机 <code>${esc(a.file || '')}</code>（600 权限、已 .gitignore），
      <b>不进 git，接口永远不回显，页面上也永远是空的密码框</b>。
    </div>`;

  const maimemoPanel = `
    <div class="set-status ${tk?.hasToken ? 'is-ok' : 'is-warn'}">
      ${
        tk?.hasToken
          ? '✅ 已配置墨墨 token'
          : '⚠️ 还没配置墨墨 token —— 「单词」页会读不到背词数据'
      }
    </div>
    <div class="set-field">
      <label>墨墨 access token</label>
      <input type="password" id="tokenInput" class="set-input" placeholder="${
        tk?.hasToken ? '已保存（留空 = 不改动）' : '粘贴你的 token'
      }" autocomplete="off" />
      <div class="rv-hint">
        墨墨 App → 我的 → 更多设置 → 实验功能 → 开放 API，
        或打开 <code>open.maimemo.com/open/api/v1/tokens/openapi</code> 登录后复制。
        网页取的那份 <b>有效期只有 7 天</b>。
      </div>
    </div>
    <div class="set-actions">
      <button class="btn-primary" data-words="save-token">保存</button>
      <button class="btn-ghost" data-words="refresh">⟳ 重新拉一次墨墨数据</button>
    </div>
    <div class="rv-hint">只存在本机 <code>${esc(tk?.tokenFile || 'study-app/.maimemo-token')}</code>，同样不进 git、不回显。</div>`;

  return `<div class="settings">
    <section class="countdown-card words-head">
      <div class="cd-main">
        <div class="cd-label">设置</div>
        <div class="cd-days" style="font-size:26px">配置与自检</div>
        <div class="cd-sub">两个外部服务：模型（出题）与墨墨（背词数据）</div>
      </div>
      <div class="cd-actions">
        <button class="btn-ghost" data-set="selfcheck">🩺 自检</button>
      </div>
    </section>

    <section class="panel set-panel">
      <div class="panel-head">
        <h3>内置 AI</h3>
        <span class="hint">出题用它 —— 配好后「单词」「测试」页直接生成</span>
      </div>
      <div class="panel-body">${aiPanel}</div>
    </section>

    <section class="panel set-panel">
      <div class="panel-head">
        <h3>📖 墨墨背单词</h3>
        <span class="hint">读背词进度与待背词</span>
      </div>
      <div class="panel-body">${maimemoPanel}</div>
    </section>

    <section class="panel set-panel">
      <div class="panel-head"><h3>🩺 自检</h3><span class="hint">点上面「自检」跑一遍</span></div>
      <div class="panel-body">${renderSelfCheck()}</div>
    </section>

    <section class="panel set-panel">
      <div class="panel-head">
        <h3>📱 手机访问</h3>
        <span class="hint">让手机连上这个服务（关掉就谁都连不上）</span>
      </div>
      <div class="panel-body">${renderLanPanel()}</div>
    </section>

    <section class="panel set-panel">
      <div class="panel-head">
        <h3>🔁 服务</h3>
        <span class="hint">改完后端代码要重启才生效</span>
      </div>
      <div class="panel-body">${renderServicePanel()}</div>
    </section>
  </div>`;
}

function renderSelfCheck() {
  const r = state.selfCheck;
  if (!r) return '<div class="rv-hint">还没跑过。自检会依次试：本地服务、墨墨接口、模型接口。</div>';
  return `<ul class="dt-list">${r
    .map(
      (x) =>
        `<li><span class="dt-group">${x.ok ? '✅' : '❌'}</span><span><b>${esc(x.name)}</b> —— ${esc(
          x.detail
        )}${x.ms != null ? `（${x.ms}ms）` : ''}</span></li>`
    )
    .join('')}</ul>`;
}

async function runSelfCheck() {
  state.selfCheck = [{ name: '本地服务', ok: true, detail: '正常' }];
  render();
  try {
    const mm = await api('/api/words?fresh=1');
    state.selfCheck.push({
      name: '墨墨接口',
      ok: !!mm.overview?.ok,
      detail: mm.overview?.ok
        ? `今日 ${mm.overview.progress.finished}/${mm.overview.progress.total}，计划共 ${mm.overview.plan.totalWords} 词`
        : mm.overview?.error || '读不到',
    });
  } catch (err) {
    state.selfCheck.push({ name: '墨墨接口', ok: false, detail: err.message });
  }
  render();
  if (state.ai?.ready) {
    const out = await api('/api/ai/test', { method: 'POST', body: JSON.stringify({}) }).catch((e) => ({
      ok: false,
      error: e.message,
    }));
    state.selfCheck.push({
      name: '模型接口',
      ok: !!out.ok,
      detail: out.ok ? `通了，模型回了「${out.reply}」` : out.error,
      ms: out.ms,
    });
  } else {
    state.selfCheck.push({ name: '模型接口', ok: false, detail: '还没配置（在上面填地址、模型和 key）' });
  }
  render();
}

/* ---------------- 内置 AI：配置 + 一键生成 + 进度 ---------------- */

async function loadAI() {
  try {
    state.ai = await api('/api/ai');
  } catch {
    state.ai = null;
  }
}

/**
 * AI 设置块（单词页和测试页共用）。
 * key 只写本机 `.ai-config.json`，接口不回显，页面上永远是空的密码框。
 */
function renderAIBox() {
  const a = state.ai;
  if (!a) return '';
  const presetChips = (a.presets || [])
    .map(
      (p) =>
        `<button class="mini" data-ai-preset="${esc(p.id)}" title="${esc(p.note || '')}">${esc(p.label)}</button>`
    )
    .join('');

  return `<details class="token-box ai-box"${a.ready ? '' : ' open'}>
    <summary>内置 AI${
      a.ready ? `（已配置：${esc(a.model)}）` : '（还没配置 —— 配好就能点一下直接生成）'
    }</summary>
    <div class="tb-body">
      <div class="rv-hint">
        只认 <b>OpenAI 兼容</b>的接口（<code>POST {地址}/chat/completions</code>），
        所以 DeepSeek / Kimi / 智谱 / 通义 / 硅基流动 / OpenAI 都能用，本机 Ollama 也可以。
        先点一个预设，再把 key 粘进去。
      </div>
      <div class="chip-row" style="margin:10px 0">${presetChips}</div>
      <div class="tb-row">
        <input id="aiBaseUrl" placeholder="接口地址，如 https://api.deepseek.com/v1" value="${esc(
          a.baseUrl || ''
        )}" autocomplete="off" />
        <input id="aiModel" placeholder="模型，如 deepseek-chat" value="${esc(a.model || '')}" autocomplete="off" />
      </div>
      <div class="tb-row">
        <input type="password" id="aiKey" placeholder="${
          a.hasKey ? '已保存（留空 = 不改动）' : 'API Key'
        }" autocomplete="off" />
        <button class="btn-ghost small" data-ai="save">保存</button>
        <button class="btn-ghost small" data-ai="test">测试连接</button>
      </div>
      ${
        a.envLocked
          ? `<div class="pk-warn">有环境变量在生效（${[
              a.fromEnv?.baseUrl ? 'AI_BASE_URL' : '',
              a.fromEnv?.model ? 'AI_MODEL' : '',
              a.fromEnv?.apiKey ? 'AI_API_KEY' : '',
            ]
              .filter(Boolean)
              .join('、')}），<b>它们优先于这里填的</b> —— 在这里改不生效，要改就去改环境变量。</div>`
          : ''
      }
      <div class="rv-hint">
        只存在本机 <code>${esc(a.file || '')}</code>（已 .gitignore，不进 git、页面不回显）。
        本地 Ollama 这种不需要 key。
        ${a.testResult ? `<br><b>上次自检：${esc(a.testResult)}</b>` : ''}
      </div>
    </div>
  </details>`;
}

/**
 * 两段式确认删除：第一次点变成「确认删除？」，再点才真删。
 * 删除是不可逆操作（虽然程序会先备份），不让它一下就没。
 */
function delBtn(attrs, label = '删除') {
  const key = attrs['data-del-key'] || '';
  const armed = state.delArmed === key;
  const a = Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join('');
  return `<button class="del-btn${armed ? ' is-armed' : ''}"${a} title="${
    armed ? '再点一次就真删了' : label
  }">${armed ? '确认删除？' : '🗑'}</button>`;
}

/**
 * 两段式确认删除：第一次点变成「确认删除？」，再点才真删。
 * 删除不可逆（程序会先备份到 backups/），不让它一下就没。
 */
async function confirmDelete(kind, target, key) {
  if (state.delArmed !== key) {
    state.delArmed = key;
    render();
    // 5 秒没再点就自动解除，免得一直挂着「确认删除？」
    clearTimeout(confirmDelete._t);
    confirmDelete._t = setTimeout(() => {
      if (state.delArmed === key) {
        state.delArmed = null;
        render();
      }
    }, 5000);
    return;
  }
  state.delArmed = null;
  try {
    if (kind === 'test') {
      const out = await api('/api/test', { method: 'DELETE', body: JSON.stringify({ rel: target }) });
      if (state.words) state.words.stories = out.stories || state.words.stories;
      if (state.tests) state.tests.tests = out.tests || state.tests.tests;
      if (state.testRel === target) {
        state.testRel = null;
        state.test = null;
        state.testWide = false;
        if (state.tests?.tests?.length) await loadTest(state.tests.tests[0].rel);
      }
      toast('已删除这份试卷（备份在 backups/）', 'ok');
    } else if (kind === 'story') {
      const out = await api('/api/words/story', { method: 'DELETE', body: JSON.stringify({ rel: target }) });
      if (state.words) state.words.stories = out.stories || state.words.stories;
      if (state.storyRel === target) {
        state.storyRel = null;
        state.story = null;
        state.storyWide = false;
      }
      toast('已删除这道题（备份在 backups/）', 'ok');
    } else {
      await api('/api/question', { method: 'DELETE', body: JSON.stringify({ id: target }) });
      closeDrawer();
      await reload({ silent: true });
      toast('已删除这道题（备份在 backups/）', 'ok');
    }
  } catch (err) {
    toast(`删除失败：${err.message}`, 'err');
  }
  render();
}

/** 没配 AI 时给一条「去哪儿配」的提示 */
function aiHint() {
  if (state.ai?.ready) return '';
  return `<div class="ai-hint">还没配置内置 AI —— 去
    <button class="linklike" data-go="settings">⚙ 设置</button>
    填一下接口地址、模型和 key（DeepSeek 的地址已经预填好了），这里就会出现「生成」按钮，点一下直接出结果。</div>`;
}

/* ------------------------------------------------------------
   生成进度：一条能看得见的进度条

   以前只有「单词」和「今日测试」两页挂了进度面板，**增题页没有** ——
   粘完题干点「生成并写入」，请求发出去、界面却一个字都不变，
   模型要跑两三分钟，看着就跟点坏了没区别；生成失败也只在最后弹一句
   「看看下面的进度」，而下面根本没有进度可看。

   所以进度面板现在挂到每一个能触发生成的页面上，并且拆成三件事说清楚：
     1. 走到哪儿了 —— 进度条（每道 job 均分，正在跑的那道按字数往里填）
     2. 还在动吗   —— 用时 / 已生成字数 / 思考字数，卡住了要看得出来
     3. 成没成     —— 每道 job 一行，失败的原样把服务端给的原因显示出来
   ------------------------------------------------------------ */

/** 正在跑的那道 job 最多把进度条填到这儿 —— 没拿到 saved 之前不许显示 100% */
const AIR_FILL_CAP = 0.92;
/** 一道题「答案 + 解析」大概多少字，**只用来估进度条**，估得不准不影响任何正确性 */
const AIR_EST_CHARS = 1800;
/** 多久没吐出新内容就提醒一句（连接还在，只是模型不说话） */
const AIR_SILENT_MS = 45000;

/** 进度条百分比：0～1。失败的那道也算「这一道结束了」，不然进度条会永远停在那儿 */
function airPercent(r) {
  const jobs = r.jobs || [];
  const total = Math.max(1, r.total || jobs.length || 1);
  let filled = 0;
  jobs.forEach((j, i) => {
    if (j.phase === 'done' || j.phase === 'error') {
      filled += 1;
      return;
    }
    if (r.running && i === r.current) {
      // 思考也算动：思考模型前 30 秒可能一个字正文都不吐，那段不显示出来就跟卡死一样
      const seen = (j.chars || 0) + (j.think || 0) * 0.4;
      filled += Math.min(AIR_FILL_CAP, seen / AIR_EST_CHARS);
    }
  });
  return Math.max(0, Math.min(1, filled / total));
}

/** 现在在哪一页 —— 用来判断「这次生成是在哪一页发起的」 */
function airPageKey() {
  return `${state.module || ''}/${state.sub || ''}`;
}

/** 生成中的进度面板 —— 只更新 DOM，不整页重绘 */
function renderAIRun() {
  const r = state.aiRun;
  if (!r) return '';
  // 跑完的面板**只在发起它的那一页**上显示。
  // 不然刚在错题页增完题，切到今日 / 单词 / 今日测试，那一条「错题生成成功」还挂在人家页面上，
  // 看着像是这次生成出来的东西 —— 明明跟这一页没关系。
  // 还在跑的时候跟着走：那是真在干活，换了页也该看得见进度、也才中断得到。
  if (!r.running && r.page && r.page !== airPageKey()) return '';
  const jobs = r.jobs || [];
  const doneCount = jobs.filter((j) => j.phase === 'done').length;
  const errCount = jobs.filter((j) => j.phase === 'error').length;
  const busy = jobs.reduce((n, j) => n + (j.chars || 0), 0);
  const pct = Math.round(airPercent(r) * 100);
  // 注意：别把这个局部变量叫 state —— 会遮蔽全局的 state，整个函数体都进暂时性死区
  const mood = r.error || errCount ? 'failed' : r.running ? 'running' : 'done';

  const rows = jobs
    .map((j, i) => {
      const doing = i === r.current && r.running;
      const cls = j.phase === 'done' ? 'is-done' : j.phase === 'error' ? 'is-err' : doing ? 'is-doing' : '';
      const icon = j.phase === 'done' ? '✅' : j.phase === 'error' ? '❌' : doing ? '⏳' : '•';
      let right;
      if (j.phase === 'done') {
        right = j.created?.length ? `已写入 ${j.created.length} 篇` : j.chars ? `已写入 ${j.chars} 字` : '已写入';
      } else if (j.phase === 'error') {
        right = `失败：${j.error || '未知原因'}`;
      } else if (doing) {
        right = j.chars
          ? `生成中 · ${j.chars} 字`
          : j.think
            ? `思考中 · ${j.think} 字`
            : '已连上模型，等它开口…';
      } else {
        right = '排队中';
      }
      const sub = j.warns?.length
        ? `<i class="air-warn">格式提醒：${esc(j.warns[0])}</i>`
        : j.rejected?.length
          ? `<i class="air-warn">没收下：${esc(j.rejected[0])}</i>`
          : j.stage
            ? `<i class="air-stage">${esc(j.stage)}</i>`
            : '';
      return `<li class="${cls}">
        <span class="air-icon">${icon}</span>
        <span class="air-label">${esc(j.label || j.rel)}${sub}</span>
        <span class="air-right">${esc(right)}</span>
      </li>`;
    })
    .join('');

  const head = r.aborting
    ? '正在中断…'
    : r.running
      ? `正在生成 ${Math.min(r.current + 1, jobs.length || 1)} / ${jobs.length || 1}`
      : r.error
        ? '生成中断'
        : errCount
          ? `生成结束：成功 ${doneCount} · 失败 ${errCount}`
          : `生成完成：${doneCount} / ${jobs.length} 篇已写入`;

  // 用时与「模型还在不在说话」—— 静默久了要给一句人话，不能让人干等
  const used = r.t0 ? Math.round((Date.now() - r.t0) / 1000) : 0;
  const silent = r.t0 ? Math.round((Date.now() - (r.lastDelta || r.t0)) / 1000) : 0;
  const facts = [
    r.running ? `已用 ${fmtSec(used)}` : '',
    busy ? `已收到 ${busy} 字` : '',
    doneCount ? `成功 ${doneCount}` : '',
    errCount ? `失败 ${errCount}` : '',
  ].filter(Boolean);
  const quiet =
    r.running && silent >= Math.round(AIR_SILENT_MS / 1000)
      ? `<div class="air-quiet">模型已经 ${fmtSec(silent)} 没有新内容了 —— 连接还在（服务端在发心跳），
           多半是在长思考或者服务商排队。可以继续等，也可以中断。</div>`
      : '';

  return `<div class="ai-run" data-air-state="${mood}">
    <div class="air-head">
      <b>${esc(head)}</b>
      ${r.running ? '<span class="air-spin"></span>' : ''}
      <span class="air-pct">${pct}%</span>
      <span class="air-spacer"></span>
      ${facts.map((f) => `<span class="air-fact">${esc(f)}</span>`).join('')}
      ${
        r.running && r.ac
          ? '<button class="mini air-btn" data-air="abort">中断</button>'
          : '<button class="mini air-btn" data-air="close">收起</button>'
      }
    </div>
    <div class="air-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
      <i style="width:${pct}%"></i>
    </div>
    ${r.error ? `<div class="air-fail">生成中断：${esc(r.error)}</div>` : ''}
    ${quiet}
    <ul class="air-list">${rows}</ul>
  </div>`;
}

/** 进度只改动 DOM —— 整页重绘会把滚动位置顶回去 */
function paintAIRun() {
  const host = document.querySelector('.ai-run');
  if (!host) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = renderAIRun();
  const next = tmp.firstElementChild;
  if (next) host.replaceWith(next);
}

/** 生成期间每秒重画一次进度面板：就算模型一个字都不吐，用时也在往上走 —— 「没反应」和「在跑」要分得清 */
let airTicker = null;
function startAirTicker() {
  if (airTicker) return;
  airTicker = setInterval(() => {
    if (!state.aiRun?.running) return stopAirTicker();
    paintAIRun();
  }, 1000);
}
function stopAirTicker() {
  if (airTicker) clearInterval(airTicker);
  airTicker = null;
}

/** 面板一出现就让它落在视野里 —— 按钮在页面最底下，面板也在那儿，别让人自己找 */
function revealAIRun() {
  const el = document.querySelector('.ai-run');
  if (!el) return;
  const box = el.getBoundingClientRect();
  if (box.top < 0 || box.bottom > innerHeight) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/** 一键生成：POST 拿 NDJSON 流，边收边更新进度 */
async function runAI(kind, payload) {
  if (!state.ai?.ready) {
    toast('先配置内置 AI（右上角 ⚙ 设置）', 'err');
    return;
  }
  // 上一次还在跑就别再发一次：同一批题跑两遍会写出两份笔记
  if (state.aiRun?.running) {
    toast('上一次还在生成中，等它跑完或者点「中断」', 'err');
    revealAIRun();
    return;
  }
  const ac = new AbortController();
  const t0 = Date.now();
  state.aiRun = {
    running: true,
    total: 0,
    current: 0,
    jobs: [],
    error: null,
    t0,
    lastDelta: t0,
    ac,
    page: airPageKey(), // 记下这次是在哪一页发起的，跑完就只在这一页上留结果
  };
  render();
  revealAIRun();
  startAirTicker();
  let failed = false;
  let aborted = false;
  try {
    const res = await fetch('/api/ai/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, ...payload }),
      signal: ac.signal,
    });
    if (!res.ok || !res.body) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        let m;
        try {
          m = JSON.parse(t);
        } catch {
          continue;
        }
        const r = state.aiRun;
        if (m.t === 'start') {
          r.total = m.total;
          r.jobs = (m.jobs || []).map((j) => ({ ...j, phase: 'wait', chars: 0, think: 0 }));
        } else if (m.t === 'job') {
          r.current = m.i;
          if (r.jobs[m.i]) r.jobs[m.i].phase = 'doing';
        } else if (m.t === 'ping') {
          // 服务端心跳：连接还活着。**不动 lastDelta** —— 心跳不代表模型在说话
          r.alive = Date.now();
        } else if (m.t === 'stage') {
          // 同一道 job 里的第二个阶段（增题写完 → 归入题型本），进度条上要说出来
          if (r.jobs[m.i]) r.jobs[m.i].stage = m.text;
          r.lastDelta = Date.now();
        } else if (m.t === 'delta') {
          if (r.jobs[m.i]) {
            r.jobs[m.i].chars = m.chars || 0;
            r.jobs[m.i].think = m.think || 0;
          }
          r.lastDelta = Date.now();
        } else if (m.t === 'saved') {
          if (r.jobs[m.i]) {
            r.jobs[m.i].phase = 'done';
            r.jobs[m.i].chars = m.chars || 0;
            r.jobs[m.i].created = m.created || [];
            r.jobs[m.i].warns = m.warns || [];
            r.jobs[m.i].rejected = m.rejected || [];
          }
          r.lastDelta = Date.now();
        } else if (m.t === 'error') {
          failed = true;
          if (r.jobs[m.i]) {
            r.jobs[m.i].phase = 'error';
            r.jobs[m.i].error = m.message;
          }
          r.lastDelta = Date.now();
        } else if (m.t === 'done') {
          r.lastDelta = Date.now();
        }
        paintAIRun();
      }
    }
  } catch (err) {
    if (ac.signal.aborted) {
      aborted = true;
      state.aiRun.error = '已中断（已经写进去的题不会回滚）';
    } else {
      state.aiRun.error = String(err.message || err);
      failed = true;
    }
  } finally {
    stopAirTicker();
    if (state.aiRun) state.aiRun.running = false;
    await refreshAfterAI(kind);
    render();
    revealAIRun();
    const doneN = (state.aiRun?.jobs || []).filter((j) => j.phase === 'done').length;
    const errN = (state.aiRun?.jobs || []).filter((j) => j.phase === 'error').length;
    if (aborted) {
      toast(`已中断：成功 ${doneN} 道${errN ? ` · 失败 ${errN} 道` : ''}`, 'err');
    } else if (failed && !doneN) {
      // 一道都没成：把服务端给的原因直接说出来，别让人自己去猜
      const why =
        (state.aiRun?.jobs || []).find((j) => j.phase === 'error')?.error || state.aiRun?.error || '未知原因';
      toast(`生成失败：${why}`, 'err');
    } else if (failed) {
      toast(`生成结束：成功 ${doneN} · 失败 ${errN}（原因在下面的进度里）`, 'err');
    } else if (doneN) {
      const created = (state.aiRun?.jobs || []).flatMap((j) => j.created || []);
      toast(
        kind === 'images' || kind === 'questions' || kind === 'add'
          ? `生成完成：写入了 ${created.length || doneN} 个文件`
          : `生成完成：${doneN} 篇已写入`,
        'ok'
      );
      // 模型漏了什么 / 路径不对，如实报出来
      const warns = (state.aiRun?.jobs || []).flatMap((j) => j.warns || []);
      const rejected = (state.aiRun?.jobs || []).flatMap((j) => j.rejected || []);
      if (warns.length) toast(`有格式提醒：${warns[0]}`, 'err');
      if (rejected.length) toast(`有文件没收下：${rejected[0]}`, 'err');
    }
  }
}

/** 中断这次生成：关掉流，服务端会把上游的模型请求一起掐了 */
function abortAIRun() {
  const r = state.aiRun;
  if (!r?.running) return;
  // 立刻把面板切到「正在中断…」—— 流真正断掉还要一个来回，中间这段时间不能让界面看着像卡住
  r.aborting = true;
  r.error = '已中断（已经写进去的题不会回滚）';
  try {
    r.ac?.abort();
  } catch {
    /* 已经断了 */
  }
  paintAIRun();
}

/** 生成完把列表刷新出来，并把新生成的那篇打开 */
async function refreshAfterAI(kind) {
  const savedRels = (state.aiRun?.jobs || []).filter((j) => j.phase === 'done').map((j) => j.rel);
  try {
    if (kind === 'words') {
      await loadWords({ force: true });
      if (savedRels[0]) await loadStory(savedRels[0]);
    } else if (kind === 'test') {
      await loadTests();
      if (savedRels[0]) await loadTest(savedRels[0]);
    } else if (kind === 'weekly') {
      state.weekly = null;
      await loadWeekly();
    } else if (kind === 'questions' || kind === 'images' || kind === 'add') {
      // 题库变了：错题 / 好题 / 题型页下次进来重新拉
      state.data = null;
      state.stats = null;
      state.patterns = null;
      state.add.items = null;
      await loadUploads();
    }
  } catch {
    /* 刷新失败不影响已经落盘的东西 */
  }
}

/** 服务状态（/api/health）：设置页显示 PID / 端口，重启后靠 pid 变化确认新进程起来了 */
async function loadHealth() {
  try {
    state.health = await api('/api/health');
  } catch {
    state.health = null;
  }
}

/** 手机访问开关的状态（/api/lan） */
async function loadLan() {
  try {
    state.lan = await api('/api/lan');
  } catch {
    state.lan = null; // 老进程还没带这个接口 —— 面板上会说明重启一次就有了
  }
}

/** 拨「手机访问」开关：**立刻生效、不用重启**，状态写回 config.json */
async function toggleLan(on) {
  if (state.lanBusy) return;
  state.lanBusy = true;
  render();
  try {
    const out = await api('/api/lan', { method: 'POST', body: JSON.stringify({ on }) });
    state.lan = out;
    toast(
      out.on
        ? `手机访问已打开${out.urls?.[0] ? ` —— ${out.urls[0]}` : ''}`
        : '手机访问已关闭，局域网连不上了',
      out.on ? 'ok' : ''
    );
  } catch (err) {
    toast(`开关没拨动：${err.message}`, 'err');
    await loadLan();
  } finally {
    state.lanBusy = false;
    render();
  }
}

async function saveAIConfig() {
  const baseUrl = document.getElementById('aiBaseUrl')?.value?.trim() || '';
  const model = document.getElementById('aiModel')?.value?.trim() || '';
  const apiKey = document.getElementById('aiKey')?.value?.trim() || '';
  try {
    state.ai = await api('/api/ai/config', { method: 'POST', body: JSON.stringify({ baseUrl, model, apiKey }) });
    const keyInput = document.getElementById('aiKey');
    if (keyInput) keyInput.value = '';
    render();
    toast(state.ai.ready ? 'AI 配置已保存' : '已保存，但还差点东西（看提示）', state.ai.ready ? 'ok' : 'err');
  } catch (err) {
    toast(`保存失败：${err.message}`, 'err');
  }
}

async function testAIConnection() {
  toast('正在测试连接…');
  try {
    const out = await api('/api/ai/test', { method: 'POST', body: JSON.stringify({}) });
    state.ai = { ...(state.ai || {}), testResult: out.ok ? `通（${out.ms}ms，模型回了「${out.reply}」）` : `不通：${out.error}` };
    render();
    toast(out.ok ? `连接正常（${out.ms}ms）` : `连接失败：${out.error}`, out.ok ? 'ok' : 'err');
  } catch (err) {
    toast(`测试失败：${err.message}`, 'err');
  }
}

/** 预设：点一下把地址和模型填进输入框，key 还是自己粘 */
function applyAIPreset(id) {
  const p = (state.ai?.presets || []).find((x) => x.id === id);
  if (!p) return;
  const b = document.getElementById('aiBaseUrl');
  const m = document.getElementById('aiModel');
  if (b) b.value = p.baseUrl;
  if (m) m.value = p.model;
  toast(`已填入 ${p.label} 的地址和模型，再把 key 粘上点「保存」`);
}

/* ---------------- 今日测试（按今天学的数学 / 408 / 笔记出题） ---------------- */

/** 按「今天学了多少」给一个预计时长 */
function estMinutes(volume) {
  return volume === '多' ? '45–60' : volume === '少' ? '20–30' : '30–45';
}

/**
 * 今日测试首页。
 *
 * 排版要点：四张面板两两并排，**要用 dt-grid 而不是 today-grid**。
 * today-grid 是 `align-items: start`，同一行里短的那张卡片底下会空出一大块；
 * dt-grid 用默认的 stretch，同一行的两张卡片等高（内容顶对齐），就不会有洞。
 */
function renderTestHome() {
  const t = state.tests;
  if (!t) return '<div class="loading"><div class="spinner"></div><p>正在整理今天的学习内容…</p></div>';

  const c = t.today || {};
  // 计划里的分组名很长（「📐 数学（周一–周五 1 讲/天，周末练习与复盘）」），列表里只留前面的
  const shortGroup = (g) => String(g || '').replace(/（.*$/, '').trim();

  const taskList = (arr) =>
    arr.length
      ? `<ul class="dt-list">${arr
          .map(
            (x) => `<li><span class="dt-group">${esc(shortGroup(x.group))}</span><span>${inlineMd(
              x.text
            )}${x.done ? '<i class="dt-done">已完成</i>' : ''}</span></li>`
          )
          .join('')}</ul>`
      : '<div class="rv-hint">今天计划里没有这一类任务。</div>';

  const noteCell = (c.notes || []).length
    ? `<ul class="dt-list">${c.notes.map((n) => `<li><code>${esc(n.rel)}</code></li>`).join('')}</ul>`
    : `<div class="rv-hint">今天还没记笔记，先拿最近几天记的当参考：</div>
       <ul class="dt-list dt-recent">${(c.recentNotes || [])
         .slice(0, 6)
         .map((n) => `<li><code>${esc(n.rel)}</code><span class="dt-tag">最近</span></li>`)
         .join('')}</ul>`;

  const weakCell = (c.weakPoints || []).length
    ? `<ul class="dt-list">${c.weakPoints.slice(0, 8).map((x) => `<li><span>${esc(x)}</span></li>`).join('')}</ul>`
    : '<div class="rv-hint">错题本里还没打考点标签，没得参考。</div>';

  const tests = t.tests || [];
  const history = tests.length
    ? `<div class="dt-history">${tests
        .map(
          (x) => `<span class="chip-with-del">
            <button class="story-chip" data-test-open="${esc(x.rel)}">
              <span class="sc-title">${esc(x.title)}</span>
              <span class="sc-meta">${x.count} 题 · 满分 ${fmtPts(x.full || 100)} · 参考 ${x.refMinutes || x.minutes} 分钟${
                x.last ? ` · <b class="sc-score">${fmtPts(x.last.total)}/${fmtPts(x.last.full)}</b>` : ''
              }${
                // 有几题模型没判到：按 0 分算了，得说出来（不然总分看着像自己考砸了）
                x.last?.missing ? `<span class="sc-missing">${x.last.missing} 题模型没判到（按 0 分算）</span>` : ''
              }</span>
            </button>
            ${delBtn({ 'data-del-test': x.rel, 'data-del-key': `test:${x.rel}` })}
          </span>`
        )
        .join('')}</div>`
    : '<div class="rv-hint">还没出过测试，先生成一次提示词。</div>';

  const aiReady = !!state.ai?.ready;
  const promptBox = `<div class="rv-hint" style="margin-bottom:12px">
         程序不出题。点下面的按钮生成 —— 我会<b>只按今天学的内容</b>出题：<br>
         先盘点今天真正学到的重要知识点（计划任务 + <b>今天记的笔记</b> + <b>今天的复盘</b> + 错题薄弱点），
         再<b>按今天学了多少决定题量</b>（学得多就多出几道，学得少就少出，不硬凑），
         尽量把重要知识点都覆盖到。<br>
         题型跟着内容走：<b>概念填空</b>（讲了新概念）、<b>公式默写</b>（出现或复习了公式）、
         <b>选择题</b>（考辨析和边界条件）、<b>填空题 / 大题</b>（有明确结果或需要完整过程的）。
         基础阶段多出概念填空和公式默写，不会硬给你上大题。
       </div>
       <div class="air-actions">
         ${
           aiReady
             ? `<button class="btn-primary" data-airun="test"${
                 state.aiRun?.running ? ' disabled' : ''
               }>${tests.length ? '重新生成今日测试' : '生成今日测试'}</button>`
             : ''
         }
       </div>`;

  const mathCount = (c.math || []).length;
  const csCount = (c.cs || []).length;
  const noteCount = (c.notes || []).length;

  return `<div class="daily-test">
    <section class="panel dt-head">
      <div class="dt-head-main">
        <h3>🧪 今日测试</h3>
        <span class="dt-head-date">${esc(c.date || '')} ${esc(c.weekday || '')}</span>
        <span class="dt-head-week">${esc(c.week ? c.week.title : '没找到本周计划')}</span>
      </div>
      <div class="dt-head-stats">
        <span>数学 <b>${mathCount}</b></span>
        <span>408 <b>${csCount}</b></span>
        <span>今天笔记 <b>${noteCount}</b></span>
        ${
          c.learned
            ? `<span class="dt-vol is-${c.learned.volume === '多' ? 'high' : c.learned.volume === '少' ? 'low' : 'mid'}">
                 今天学得 <b>${esc(c.learned.volume)}</b> → 约 ${estMinutes(c.learned.volume)} 分钟
               </span>`
            : ''
        }
      </div>
      <button class="btn-ghost small" data-test="refresh">⟳ 重新整理</button>
    </section>

    <section class="panel picker-panel">
      <div class="panel-head">
        <h3>📋 出题</h3>
        <span class="hint">写进 <code>${esc(t.testDir || '今日测试')}/</code></span>
      </div>
      <div class="panel-body">
        ${renderAIRun()}
        ${aiHint()}
        ${promptBox}
        <div class="dt-history-row">
          <span class="pk-title">已有试卷</span>
          <span class="pk-note">点一份 → 全屏开做</span>
        </div>
        ${history}
      </div>
    </section>

    <div class="dt-grid">
      <section class="panel">
        <div class="panel-head"><h3>📐 今天计划里的数学</h3><span class="hint">出题的正面清单</span></div>
        <div class="panel-body">${taskList(c.math || [])}</div>
      </section>
      <section class="panel">
        <div class="panel-head"><h3>💻 今天计划里的 408</h3><span class="hint">出题的正面清单</span></div>
        <div class="panel-body">${taskList(c.cs || [])}</div>
      </section>
      <section class="panel">
        <div class="panel-head"><h3>📝 今天记的笔记</h3><span class="hint">最要紧的出题依据</span></div>
        <div class="panel-body">${noteCell}</div>
      </section>
      <section class="panel">
        <div class="panel-head"><h3>🎯 最近的薄弱点</h3><span class="hint">挑「易错点」时参考</span></div>
        <div class="panel-body">
          ${weakCell}
          ${
            (c.troubled || []).length
              ? `<div class="rv-hint">反复做错：${(c.troubled || []).map((x) => esc(x)).join('、')}</div>`
              : ''
          }
        </div>
      </section>
    </div>
  </div>`;
}

/** 全屏试卷：题目 → 每题一个「显示答案」；答案默认全部藏着 */
function renderTestPaper() {
  const p = state.test;
  if (!p || !p.exists) {
    return `<div class="reading-full">
      <header class="rf-bar">
        <button class="btn-ghost small" data-test="exit">← 返回</button>
        <b>找不到这份测试</b>
      </header>
      <div class="rf-body"><div class="rv-hint">文件可能被删了，返回重新生成。</div></div>
    </div>`;
  }

  const shown = state.testShown || {};
  const allShown = (p.items || []).length > 0 && (p.items || []).every((q) => shown[q.n]);
  const plan = p.plan || {};
  const pts = plan.table?.byN || {};
  const refByN = plan.ref?.byN || {};

  const items = (p.items || [])
    .map((q) => {
      const open = !!shown[q.n];
      const hasAnswer = !!q.answer;
      const score = pts[q.n];
      return `<section class="dt-q">
        <div class="dt-q-head">
          <span class="dt-q-n">${q.n}</span>
          ${q.type ? `<span class="dt-q-type">${esc(q.type)}</span>` : ''}
          ${q.topic ? `<span class="dt-q-topic">${richInline(q.topic)}</span>` : ''}
          ${score != null ? `<span class="dt-q-score">${fmtPts(score)} 分</span>` : ''}
          ${refByN[q.n] ? `<span class="dt-q-ref" title="这道题该花多久">参考 ${fmtSpan(refByN[q.n])}</span>` : ''}
          <span class="dt-q-tools">
            ${
              hasAnswer
                ? `<button class="mini${open ? ' is-on' : ''}" data-test-answer="${q.n}">
                     ${open ? '收起答案' : '显示答案'}</button>`
                : '<span class="rv-hint">这道题没写答案</span>'
            }
          </span>
        </div>
        <div class="md-doc dt-stem">${mdToHtml(q.body)}</div>
        ${
          open && hasAnswer
            ? `<div class="dt-answer md-doc">${mdToHtml(q.answer)}</div>
               ${renderBankForm(q)}
               <div class="dt-bank">
                 <span class="pk-note">收进题库时会一起带上题干、标准答案和解析：</span>
                 <button class="btn-ghost small" data-test-bank-open="mistakes" data-test-n="${q.n}">➕ 加入错题本</button>
                 <button class="btn-ghost small" data-test-bank-open="good" data-test-n="${q.n}">➕ 加入好题本</button>
               </div>`
            : ''
        }
      </section>`;
    })
    .join('');

  const noAnswer = (p.answerMissing || []).length
    ? `<div class="pk-warn">第 ${p.answerMissing.join('、')} 题在「答案与解析」里没找到对应答案。</div>`
    : '';
  const assumed = plan.table?.assumed
    ? `<div class="pk-warn">这份卷子没标每题分值 —— 按满分 ${fmtPts(plan.table.full)} 分平均算的。下次生成时会带上分值。</div>`
    : '';

  return `<div class="reading-full">
    <header class="rf-bar">
      <button class="btn-ghost small" data-test="exit">← 返回</button>
      <b class="rf-title">${esc(p.title || '今日测试')}</b>
      <span class="rf-meta">${(p.items || []).length} 题　·　满分 ${fmtPts(plan.table?.full || 100)}${
        plan.ref?.minutes ? `　·　参考 ${plan.ref.minutes} 分钟` : `　·　约 ${p.minutes} 分钟`
      }${p.scope ? `　·　${richInline(p.scope)}` : ''}</span>
      ${renderPaperTimer(plan.ref?.seconds || p.minutes * 60)}
      <button class="btn-ghost small" data-test="toggle-all" data-test-all="${allShown ? 'hide' : 'show'}">
        ${allShown ? '全部收起答案' : '全部显示答案'}</button>
    </header>
    <div class="rf-body">
      <article class="reading dt-paper">
        ${noAnswer}
        ${assumed}
        ${items || '<div class="rv-hint">这份测试里没解析出题目。</div>'}
        ${renderGradeZone(plan.ref?.seconds || p.minutes * 60)}
        <div class="story-foot">${esc(p.rel)}</div>
      </article>
    </div>
  </div>`;
}

function renderDailyTest() {
  if (state.testWide && state.test) return renderTestPaper();
  return renderTestHome();
}

/* ============================================================
   拍照判分：上传手写答案 → 内置 AI 按考研标准打分

   为什么是「拍照」而不是「在页面上填答案」：数学 / 408 的大题要在纸上写完整过程，
   考场上也是这么写的。所以判分要能看懂手写 —— 把整份卷子拍下来（可以多张），
   题号自己写好，模型照着题干和标准答案逐题按步给分。
   ============================================================ */

/** 载入一份卷子时同步判分区：最近一次成绩直接显示出来，图片列表清空 */
function enterGradeZone(rel, kind, grades) {
  state.grade = {
    rel,
    kind,
    uploads: [],
    busy: false,
    progress: null,
    result: (grades || [])[0] || null,
    error: null,
    grades: grades || [],
    bankBusy: false,
    bankDone: null,
  };
}

const VERDICT_CLS = { 正确: 'ok', 部分正确: 'part', 错误: 'bad', 未作答: 'none', 看不清: 'dim', 题号对不上: 'dim' };
const VERDICT_MARK = { 正确: '✅', 部分正确: '🟡', 错误: '❌', 未作答: '⬜', 看不清: '🔍', 题号对不上: '❓' };

function verdictChip(v) {
  const s = String(v || '').trim() || '—';
  return `<span class="vchip v-${VERDICT_CLS[s] || 'dim'}">${VERDICT_MARK[s] || '•'} ${esc(s)}</span>`;
}

/** 一次成绩的表格 + 总评（刚判完、以及从文件里读回来的历次成绩，都用这套渲染） */
function renderGradeResult() {
  const g = state.grade;
  const r = g.result;
  if (!r) return '';
  const items = r.items || [];
  if (!items.length) return '';

  const wrong = items.filter((x) => Number(x.score) < Number(x.full));
  const pct = r.full ? Math.round((r.total / r.full) * 100) : 0;
  const isTest = g.kind === 'test';

  const rows = items
    .map((x) => {
      const ok = Number(x.score) >= Number(x.full);
      return `<tr class="${ok ? 'is-ok' : 'is-bad'}">
        <td class="gr-n">${x.n}</td>
        <td class="gr-topic">${esc(x.topic || '—')}</td>
        <td class="gr-score"><b>${fmtPts(x.score)}</b><em>/${fmtPts(x.full)}</em></td>
        <td>${verdictChip(x.verdict)}</td>
        ${isTest ? `<td class="gr-reason">${esc(x.reason || '—')}</td>` : ''}
        <td class="gr-lost">${richInline(x.lost || '—')}${x.fix ? `<i>改：${richInline(x.fix)}</i>` : ''}</td>
      </tr>`;
    })
    .join('');

  const bankDone = g.bankDone || [];
  const bankBtn = isTest
    ? bankDone.length
      ? '' // 收完了就不留按钮，只留回执 —— 免得手滑点第二遍
      : wrong.length
        ? `<button class="btn-primary small" data-grade="bank"${g.bankBusy ? ' disabled' : ''}>
             ${g.bankBusy ? '正在写入…' : `➕ 一键把 ${wrong.length} 道错题加入错题本`}
           </button>`
        : '<span class="pk-note">全对，没有要收的错题 🎉</span>'
    : '';
  const bankNote = bankDone.length
    ? `<span class="pk-note ok">✅ 已加入错题本：第 ${bankDone.join('、')} 题（判分给的错因和丢分点都写进去了）</span>`
    : '';

  const head = [
    r.index ? `第 ${r.index} 次` : '',
    r.date || '',
    r.seconds ? `用时 ${fmtClock(r.seconds)}` : '',
    r.refSeconds ? `参考 ${fmtClock(r.refSeconds)}` : '',
    r.source === 'local' ? '本地判卷' : r.images ? `判分图片 ${r.images} 张` : '',
  ].filter(Boolean);

  return `<section class="grade-result">
    <div class="gr-head">
      <div class="gr-total${pct >= 85 ? ' is-good' : pct >= 60 ? ' is-mid' : ' is-low'}">
        <b>${fmtPts(r.total)}</b><em>/ ${fmtPts(r.full)}</em>${r.full !== 100 ? `<i>${pct}%</i>` : ''}
      </div>
      <div class="gr-headinfo">
        <span class="gr-title">📊 成绩单</span>
        <span class="gr-meta">${head.map((x) => esc(x)).join('　·　')}</span>
      </div>
      <div class="gr-bank">${bankBtn}</div>
    </div>
    ${bankNote ? `<div class="gr-banknote">${bankNote}</div>` : ''}
    <div class="table-wrap">
      <table class="gr-table">
        <thead><tr><th>题号</th><th>考点</th><th>得分</th><th>判定</th>${
          isTest ? '<th>错因</th>' : ''
        }<th>丢分点 / 怎么改</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${r.summary ? `<p class="gr-summary"><b>总评</b>${richInline(r.summary)}</p>` : ''}
    ${
      (r.weak || []).length || (r.next || []).length
        ? `<div class="gr-lists">
             ${(r.weak || []).length ? `<div><span class="gr-lb">薄弱点</span>${r.weak.map((x) => `<span class="chip-static">${richInline(x)}</span>`).join('')}</div>` : ''}
             ${(r.next || []).length ? `<div><span class="gr-lb">下一步</span>${r.next.map((x) => `<span class="chip-static">${richInline(x)}</span>`).join('')}</div>` : ''}
           </div>`
        : ''
    }
  </section>`;
}

/** 判分区的进度条（只改 DEV，不整页重绘） */
function paintGradeProgress() {
  const host = document.getElementById('gradeProgress');
  if (!host) return;
  const g = state.grade;
  if (g.busy) {
    const p = g.progress || {};
    host.innerHTML = `<span class="air-spin"></span>
      <b>正在按考研标准逐题判分…</b>
      <span class="gp-note">${p.think ? `思考 ${p.think} 字　·　` : ''}${p.chars || 0} 字</span>`;
  } else if (g.error) {
    host.innerHTML = `<b class="is-err">判分没成：${esc(g.error)}</b>`;
  } else {
    host.innerHTML = '';
  }
}

/** 历次成绩：折起来的一行行（今日测试 / 英语共用） */
function renderGradeHistory() {
  const g = state.grade;
  if ((g.grades || []).length < 2) return '';
  return `<details class="gp-history">
    <summary>历次成绩（${g.grades.length} 次）</summary>
    <ul>${g.grades
      .map(
        (x) =>
          `<li><span>第 ${x.index} 次 · ${esc(x.date)}</span><b>${fmtPts(x.total)} / ${fmtPts(x.full)}</b><em>${
            x.seconds ? `用时 ${fmtClock(x.seconds)}` : ''
          }${x.source === 'local' ? '本地判卷' : ''}</em><span class="gp-h-weak">${richInline((x.weak || []).join('、'))}</span></li>`
      )
      .join('')}</ul>
  </details>`;
}

/**
 * 英语那份的成绩区 —— **没有拍照这一套**。
 * 全篇都是四选一，程序对着「答案速查」按每题分值算就完了，又快又准；
 * 让模型去认手写字母反而可能看错。所以这里只显示成绩单和历次成绩。
 */
function renderReadingGrade() {
  const g = state.grade;
  if (!g.rel || g.kind !== 'story') return '';
  return `<section class="grade-zone grade-zone-plain">
    <div class="gp-head">
      <h3>📊 成绩</h3>
      <span class="hint">选择题程序自己判，不用拍照</span>
    </div>
    <div class="gp-body">
      ${
        g.result
          ? renderGradeResult()
          : `<p class="gp-plain-hint">做完点题目上面的「<b>对答案</b>」，程序按每题分值当场给分，
              成绩会记进这一篇的历次成绩里（页面关掉也还在）。</p>`
      }
      ${renderGradeHistory()}
    </div>
  </section>`;
}

/** 今日测试的判分区：成绩单 + 上传手写答案 + 历次成绩 */
function renderGradeZone(refSeconds) {
  const g = state.grade;
  if (!g.rel || g.kind !== 'test') return '';
  const thumbs = g.uploads
    .map(
      (u, i) => `<span class="gp-thumb">
        <img src="/uploads/${encodeURIComponent(u.name)}" alt="第 ${i + 1} 张" />
        <button class="gp-x" data-grade="del" data-name="${esc(u.name)}" title="删掉这张">✕</button>
      </span>`
    )
    .join('');

  const ready = !!state.ai?.ready;
  const n = g.uploads.length;
  const live = `${fmtClock(Math.round(paperElapsed() / 1000))}`;

  return `<section class="grade-zone" id="gradeZone">
    ${renderGradeResult()}
    <div class="gp-head">
      <h3>📷 拍照判分</h3>
      <span class="hint">数学 / 408 的大题按步给分，考研标准</span>
    </div>
    <div class="gp-body">
      <div class="gp-drop" id="gradeDrop">
        <input type="file" id="gradeFiles" accept="image/*" multiple hidden />
        <div class="gp-drop-main">
          <b>把手写答案拍下来传上来</b>
          <span>整份卷子（所有题）可以拍好几张，<b>一次全传</b> —— 可以拖进来、⌘V 粘贴，或者</span>
          <button class="btn-ghost small" data-grade="pick">选择图片</button>
        </div>
        <div class="gp-tips">
          题号写清楚（<code>1.</code> <code>2.</code> …）、小题只写答案、大题写完整过程 ——
          判分是按标准答案的采分点一步步对的，过程写了才拿得到过程分。
        </div>
      </div>
      ${n ? `<div class="gp-thumbs">${thumbs}</div>` : ''}
      <div class="gp-actions">
        ${
          ready
            ? `<button class="btn-primary" data-grade="run"${!n || g.busy ? ' disabled' : ''}>
                 ${g.busy ? '判分中…' : `🤖 按考研标准打分${n ? `（${n} 张）` : ''}`}
               </button>`
            : '<span class="rv-hint">先配一下内置 AI（右上角 ⚙ 设置）</span>'
        }
        ${n ? '<button class="btn-ghost small" data-grade="clear">清空图片</button>' : ''}
        <span class="gp-note">本次用时 <b id="gradeElapsed">${live}</b>${refSeconds ? `　·　参考 ${fmtClock(refSeconds)}` : ''}</span>
      </div>
      <div class="gp-progress" id="gradeProgress"></div>
      ${renderGradeHistory()}
    </div>
  </section>`;
}

/** 判分：NDJSON 流，边收边显示进度 */
async function runGrade() {
  const g = state.grade;
  if (!g.rel) return;
  if (!g.uploads.length) return toast('先把答案的图片传上来（可以多张）', 'err');
  if (!state.ai?.ready) return toast('先配置内置 AI（右上角 ⚙ 设置）', 'err');

  g.busy = true;
  g.error = null;
  g.progress = { chars: 0, think: 0 };
  g.bankDone = null;
  render();
  document.getElementById('gradeZone')?.scrollIntoView({ block: 'start', behavior: 'smooth' });

  const seconds = Math.round(paperElapsed() / 1000);
  // 交卷了：计时**停在这一刻**（判分要等模型，那几分钟不算我的做题用时）
  stopPaperTimer(g.rel);
  try {
    const res = await fetch('/api/grade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rel: g.rel, names: g.uploads.map((u) => u.name), seconds }),
    });
    if (!res.ok || !res.body) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        let m;
        try {
          m = JSON.parse(t);
        } catch {
          continue;
        }
        if (m.t === 'delta') {
          state.grade.progress = { chars: m.chars, think: m.think };
          paintGradeProgress();
        } else if (m.t === 'done') {
          state.grade.result = m.result?.attempt || m.result || null;
          state.grade.grades = m.grades || [];
          state.grade.uploads = []; // 服务端判完就把暂存图片清掉了
        } else if (m.t === 'error') {
          state.grade.error = m.message;
        }
      }
    }
  } catch (err) {
    state.grade.error = String(err.message || err);
  } finally {
    state.grade.busy = false;
    state.grade.progress = null;
    render();
    const r = state.grade.result;
    if (state.grade.error) toast(`判分失败：${state.grade.error}`, 'err');
    else if (r) {
      toast(`判完了：${fmtPts(r.total)} / ${fmtPts(r.full)}`, r.total >= r.full * 0.85 ? 'ok' : '');
      document.getElementById('gradeZone')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }
}

/** 一键把这次做错的题收进错题本 —— 错因、丢分点、该怎么改都一起带过去 */
async function addWrongToBank() {
  const g = state.grade;
  const items = (g.result?.items || []).filter((x) => Number(x.score) < Number(x.full));
  if (!items.length) return toast('这次没有做错的题 🎉');
  g.bankBusy = true;
  render();
  try {
    const out = await api('/api/test/to-bank', {
      method: 'POST',
      body: JSON.stringify({
        rel: g.rel,
        book: 'mistakes',
        items: items.map((x) => ({ n: x.n, reason: x.reason || '', lost: x.lost || '', fix: x.fix || '' })),
      }),
    });
    const created = out.created?.created || out.created || [];
    g.bankDone = items.map((x) => x.n);
    state.data = null;
    state.stats = null;
    state.patterns = null;
    toast(`已加入错题本：${created.length || items.length} 道（题干 + 标准答案 + 解析 + 错因都在里面）`, 'ok');
  } catch (err) {
    toast(`加入错题本失败：${err.message}`, 'err');
  } finally {
    g.bankBusy = false;
    render();
  }
}

/** 判分用的图片：拖着 / 粘着 / 选着，都走这里 */
async function uploadGradeFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return toast('只支持图片文件', 'err');
  let ok = 0;
  for (const f of files) {
    if (f.size > 15 * 1024 * 1024) {
      toast(`${f.name} 超过 15MB，已跳过`, 'err');
      continue;
    }
    const dataUrl = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(f);
    });
    try {
      const out = await api('/api/upload', { method: 'POST', body: JSON.stringify({ name: f.name, dataUrl }) });
      state.grade.uploads.push({ name: out.name, bytes: out.bytes });
      ok += 1;
    } catch (e) {
      toast(`上传失败 ${f.name}：${e.message}`, 'err');
    }
  }
  render();
  if (ok) toast(`已上传 ${ok} 张 —— 再点「按考研标准打分」`);
}

async function removeGradeImage(name) {
  try {
    await api('/api/uploads', { method: 'DELETE', body: JSON.stringify({ names: [name] }) });
  } catch {
    /* 删不掉就从列表里拿掉，反正判分时会被拒绝 */
  }
  state.grade.uploads = state.grade.uploads.filter((u) => u.name !== name);
  render();
}

async function clearGradeImages() {
  const names = state.grade.uploads.map((u) => u.name);
  try {
    if (names.length) await api('/api/uploads', { method: 'DELETE', body: JSON.stringify({ names }) });
  } catch {
    /* 同上 */
  }
  state.grade.uploads = [];
  render();
}

/**
 * 英语选择题「对答案」是本地判的，但**成绩要记进卷子** ——
 * 页面上的分数刷新一下就没了，写进 `## 成绩记录` 才留得住，也才能和拍照判分放一起看。
 * 分数由服务端按卷子自己的分值重算（不信页面报上来的）。
 */
async function recordLocalQuiz() {
  const rel = state.storyRel;
  if (!rel) return;
  try {
    const out = await api('/api/grade/local', {
      method: 'POST',
      body: JSON.stringify({
        rel,
        answers: state.quiz.answers || {},
        seconds: Math.round(paperElapsed(rel) / 1000),
      }),
    });
    state.grade.result = out.attempt || null;
    state.grade.grades = out.grades || [];
    render();
  } catch (err) {
    toast(`这次成绩没记进卷子：${err.message}`, 'err');
  }
}

async function loadTests() {
  try {
    state.tests = await api('/api/test');
    if (!state.testRel && state.tests.tests?.length) {
      state.testRel = state.tests.tests[0].rel;
    }
  } catch (err) {
    state.tests = null;
    toast(`整理今天的内容失败：${err.message}`, 'err');
  }
}

async function loadTest(rel) {
  if (!rel) {
    state.test = null;
    return;
  }
  try {
    state.test = await api(`/api/test/paper?rel=${encodeURIComponent(rel)}`);
    state.testRel = rel;
    state.testShown = {};
    // 判分区跟着换：最近一次成绩直接显示出来（重新打开也在）
    enterGradeZone(rel, 'test', state.test.grades || []);
  } catch {
    state.test = null;
  }
}


async function openBankForm(n, book) {
  const q = (state.test?.items || []).find((x) => x.n === n);
  if (!q) return;
  // 分类先用程序自己的关键词识别算一遍，用户可以在面板里改
  let guess = {};
  try {
    const out = await api('/api/test/to-bank/preview', {
      method: 'POST',
      body: JSON.stringify({ rel: state.testRel, n, book }),
    });
    guess = out.item || {};
  } catch {
    /* 识别失败就让用户自己填 */
  }
  state.bankDraft = {
    n,
    book,
    reason: '',
    // 测试里那道题的「考点」直接当默认标签
    points: q.topic || '',
    difficulty: 3,
    heat: 3,
    category: guess.category || '',
    subject: guess.subject || '',
    chapter: guess.chapter || '',
    slug: guess.slug || q.topic || '',
    type: guess.type || q.type || '',
  };
  render();
  document.querySelector('.bank-form')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function closeBankForm() {
  state.bankDraft = null;
  render();
}

async function addTestToBank(n, book, btn) {
  if (btn) btn.disabled = true;
  try {
    const d = state.bankDraft && state.bankDraft.n === n ? state.bankDraft : {};
    const pointsInput = document.getElementById('bankPoints');
    const out = await api('/api/test/to-bank', {
      method: 'POST',
      body: JSON.stringify({
        rel: state.testRel,
        n,
        book,
        reason: d.reason || '',
        points: (pointsInput ? pointsInput.value : d.points) || '',
        difficulty: d.difficulty,
        heat: d.heat,
        category: d.category,
        subject: d.subject,
        chapter: d.chapter,
        slug: d.slug,
        type: d.type,
      }),
    });
    state.bankDraft = null;
    render(); // 面板要收起来
    // 接口回的是 { ok, book, created: { ok, created: [{file,…}], total } } —— 两层都要认，
    // 不然拿到的是 undefined，连「写进哪个文件」都提示不出来
    const one = out.created?.created?.[0] || out.created?.[0] || null;
    toast(
      one
        ? `已加入${book === 'good' ? '好题本' : '错题本'}：${one.file}`
        : `已加入${book === 'good' ? '好题本' : '错题本'}`,
      'ok'
    );
    if (one) {
      // 题库变了，让错题 / 好题页下次进来重新拉（render 里会自动补拉）
      state.data = null;
      state.stats = null;
      state.patterns = null;
    }
  } catch (err) {
    toast(`加入失败：${err.message}`, 'err');
    render();
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ---------------- 计划 ---------------- */
async function loadPlans() {
  if (state.plans) return;
  try {
    state.plans = await api('/api/plans');
  } catch {
    state.plans = { plans: [] };
  }
}

async function loadPlanDetail(rel) {
  try {
    state.planDetail = await api(`/api/plan?rel=${encodeURIComponent(rel)}`);
  } catch (err) {
    state.planDetail = null;
    toast(`读取计划失败：${err.message}`, 'err');
  }
}

/** 当月排最前，其后的月份顺序往后，已经过去的月份倒序放最后 */
function sortMonths(months) {
  const cur = new Date().toISOString().slice(0, 7);
  const rank = (m) => (m === cur ? 0 : m > cur ? 1 : 2);
  return [...months].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return ra === 2 ? b.localeCompare(a) : a.localeCompare(b);
  });
}

function renderPlan() {
  const list = state.plans?.plans || [];
  const months = [...new Set(list.filter((p) => p.kind === 'month').map((p) => p.month))].sort();
  const sel = state.planDetail;

  const side = !list.length
    ? '<div class="rv-hint">还没扫到计划。确认 config.json 里的 planDir 指向 考研/。</div>'
    : `<div class="plan-months">${sortMonths([...new Set(list.filter((p) => p.kind === 'week').map((p) => p.month))])
        .map((mo) => {
          const weeks = list.filter((p) => p.kind === 'week' && p.month === mo);
          const mp = list.find((p) => p.kind === 'month' && p.month === mo);
          const done = weeks.reduce((s, x) => s + x.done, 0);
          const total = weeks.reduce((s, x) => s + x.total, 0);
          return `<div class="plan-month">
          <div class="pm-head"><span>${esc(mo)}</span><b>${total ? Math.round((done / total) * 100) : 0}%</b></div>
          ${mp ? `<button class="plan-link${state.planRel === mp.rel ? ' is-on' : ''}" data-plan="${esc(mp.rel)}">📅 月计划</button>` : ''}
          ${weeks
            .map(
              (x) =>
                `<button class="plan-link${state.planRel === x.rel ? ' is-on' : ''}" data-plan="${esc(x.rel)}">
                  <span class="pl-name">第 ${x.week ?? '?'} 周</span>
                  <span class="pl-rate">${x.done}/${x.total}</span>
                  <span class="pl-bar"><i style="width:${x.rate}%"></i></span>
                </button>`
            )
            .join('')}
        </div>`;
        })
        .join('')}</div>`;

  const detail = sel
    ? `<div class="plan-detail">
        <div class="plan-head">
          <h2>${esc(sel.title || sel.fileName)}</h2>
          <div class="plan-meta">
            ${sel.range ? `${esc(sel.range.start)} ~ ${esc(sel.range.end)}　·　` : ''}
            ${sel.done}/${sel.total} 完成（${sel.rate}%）
          </div>
          <div class="progress" style="margin-top:10px"><i style="width:${sel.rate}%"></i></div>
        </div>
        <div class="plan-body" data-rel="${esc(sel.rel)}">
          ${
            sel.kind === 'month'
              ? `<div class="rv-hint" style="margin-bottom:14px">月计划是索引页，任务在对应的周计划里勾选。</div>
                 <div class="md-doc">${mdToHtml(sel.content || '')}</div>`
              : planGroupsHtml(sel)
          }
        </div>
      </div>`
    : `<div class="panel"><div class="panel-body empty-row">左边选一份计划</div></div>`;

  return `<div class="library">
    <aside class="sidebar plan-side">${side}</aside>
    <div>${detail}</div>
  </div>`;
}

/** 一条任务在完成率里占几个位子：🔁 每日任务一周按天占位，其余算 1 */
function taskSlots(t) {
  return t.daily ? t.slots || 7 : 1;
}
/** 这条任务已经完成了几个位子：每日任务数打过的卡 */
function taskDoneSlots(t) {
  return t.daily ? (t.checkins || []).length : t.done ? 1 : 0;
}

function planGroupsHtml(plan) {
  return plan.groups
    .filter((g) => g.tasks.length)
    .map((g) => {
      const done = g.tasks.reduce((s, x) => s + taskDoneSlots(x), 0);
      const total = g.tasks.reduce((s, x) => s + taskSlots(x), 0);
      const items = withOcc(g.tasks);
      return `<section class="plan-group">
        <div class="pg-head">
          <span>${esc(g.name)}</span>
          <span class="pg-count">${done}/${total}</span>
        </div>
        <ul class="task-list">${items.map((x) => taskLi(x, { rel: plan.rel })).join('')}</ul>
      </section>`;
    })
    .join('');
}

/* ---------------- 笔记 ---------------- */
/* ---------------- 复盘 ---------------- */
async function loadJournal(date) {
  try {
    state.journals = await api('/api/reviews');
  } catch {
    state.journals = { reviews: [] };
  }
  const d = date || state.journals.today || new Date().toISOString().slice(0, 10);
  try {
    state.journal = await api(`/api/review?date=${d}`);
  } catch (err) {
    state.journal = null;
    toast(`读取复盘失败：${err.message}`, 'err');
  }
}

function renderJournal() {
  const j = state.journal;
  const list = state.journals?.reviews || [];
  if (!j) return '<div class="loading"><div class="spinner"></div><p>正在读取复盘…</p></div>';

  // 平铺 + 按月份分组
  const byMonth = new Map();
  for (const r of list) {
    const key = r.month || '其他';
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(r);
  }
  const months = [...byMonth.keys()].sort((a, b) => (a < b ? 1 : -1));
  const history = list.length
    ? `<div class="j-months">${months
        .map(
          (mo) => `<div class="j-month">
        <div class="pm-head"><span>${esc(mo)}</span><b>${byMonth.get(mo).length} 篇</b></div>
        ${byMonth
          .get(mo)
          .map((r) => {
            if (!r.date) {
              return `<button class="j-item" data-journal-open="${esc(r.rel)}">
                <span class="ji-day">${esc(r.name.replace(/复盘\.md$/, ''))}</span>
                <span class="ji-week">${esc(r.week || '')}</span>
              </button>`;
            }
            return `<button class="j-item${r.date === j.date ? ' is-on' : ''}" data-journal="${esc(r.date)}">
              <span class="ji-day">${esc(r.date.slice(5).replace('-', '.'))}</span>
              <span class="ji-week">${esc(r.week || '')}</span>
              <span class="ji-flag">${r.empty ? '' : '●'}</span>
            </button>`;
          })
          .join('')}
      </div>`
        )
        .join('')}</div>`
    : '<div class="rv-hint">还没有复盘记录。</div>';

  return `<div class="library">
    <aside class="sidebar plan-side">
      <div class="filter-group"><h4>历史复盘</h4>${history}</div>
    </aside>
    <div class="journal">
      <div class="journal-nav">
        <button class="btn-ghost small" data-journal-move="-1">‹ 前一天</button>
        <input type="date" id="journalDate" class="date-input" value="${esc(j.date)}" />
        <button class="btn-ghost small" data-journal-move="1">后一天 ›</button>
        <button class="btn-ghost small" data-journal-move="0">回到今天</button>
        <span class="rv-hint">${j.exists ? '已有这篇' : '这篇还没写过'}</span>
      </div>
      <div class="plan-head">
        <h2>${esc(j.date)} 复盘</h2>
        <div class="plan-meta">
          ${j.exists ? '这篇已存在，保存会覆盖（自动备份）' : '新建'}　·　
          <code>${esc(j.rel)}</code>
        </div>
      </div>
      <textarea id="journalText" class="journal-edit" rows="18" placeholder="今天做了什么、卡在哪、明天怎么调整…">${esc(j.draft ?? j.content)}</textarea>
      <div class="rv-start-row">
        <button class="btn-primary" data-journal-save="1">💾 保存到 Obsidian</button>
        <button class="btn-ghost" data-journal-today="1">回到今天</button>
        <span class="rv-hint">保存路径：${esc(j.rel)}</span>
      </div>
    </div>
  </div>`;
}

/** 非标准命名的复盘（比如 9月第一周复盘.md）：只能直接打开看 */
async function openJournalFile(rel) {
  try {
    const out = await api(`/api/note?rel=${encodeURIComponent(rel)}`);
    state.journal = { date: rel, rel, exists: true, content: out.content, week: null, raw: true };
    render();
  } catch {
    toast('这篇不在程序能读的范围里，去 Obsidian 看吧', 'err');
  }
}

/** 日期加减天数；n=0 表示回到今天 */
function shiftDate(date, n) {
  const base = n === 0 || !date ? new Date() : new Date(`${date}T00:00:00`);
  if (n !== 0) base.setDate(base.getDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${base.getFullYear()}-${p(base.getMonth() + 1)}-${p(base.getDate())}`;
}


async function saveJournal() {
  const j = state.journal;
  if (!j) return;
  const content = document.getElementById('journalText')?.value ?? '';
  try {
    const out = await api('/api/review', { method: 'POST', body: JSON.stringify({ date: j.date, content }) });
    await loadJournal(j.date);
    render();
    toast(`已保存到 ${out.rel}`, 'ok');
  } catch (err) {
    toast(`保存失败：${err.message}`, 'err');
  }
}

/** 勾选任务 → 写回 Obsidian */
async function togglePlanTask(input) {
  const rel = input.dataset.rel;
  const text = input.dataset.text;
  const occ = Number(input.dataset.occ) || 0;
  const done = input.checked;
  if (!rel) {
    toast('这条任务没有来源文件，无法写回', 'err');
    input.checked = !done;
    return;
  }
  input.disabled = true;
  try {
    // 在看某一天的时候勾选，就记在那一天上（🔁 任务补打昨天的卡 / 普通任务补完成日期）
    await api('/api/task', {
      method: 'POST',
      body: JSON.stringify({ rel, expect: text, occurrence: occ, done, date: state.viewDate || undefined }),
    });
    state.planDetail = null;
    state.plans = null;
    await loadToday();
    await loadPlans();
    if (state.planRel) await loadPlanDetail(state.planRel);
    render();
    toast(
      done
        ? `已勾选：${text.slice(0, 18)}…${state.viewDate ? `（记在 ${state.viewDate}）` : ''}`
        : '已取消勾选',
      'ok'
    );
  } catch (err) {
    input.checked = !done;
    toast(`写回失败：${err.message}`, 'err');
  } finally {
    input.disabled = false;
  }
}

function render() {
  const main = $('#main');

  // 整页重绘会把内部滚动条顶回顶部。全屏那几屏（试卷 / 阅读 / 做题）正文很长，
  // 顶回去一次就得重新滚 —— 所以同一个视图重绘时把滚动位置接回来。
  const viewKey = `${state.module}|${state.testRel || ''}|${state.storyRel || ''}|${state.solve.id || ''}`;
  const prev = document.querySelector('.rf-body');
  const keepScroll = prev && state.renderedView === viewKey ? prev.scrollTop : 0;

  let body = '';
  if (state.module === 'today') body = renderToday();
  else if (state.module === 'words') body = renderWords();
  else if (state.module === 'test') body = renderDailyTest();
  else if (state.module === 'settings') body = renderSettings();
  else if (state.module === 'plan') body = renderPlan();
  else if (state.module === 'journal') body = renderJournal();
  else if (state.module === 'patterns') {
    body = renderPatterns();
  } else if (state.module === 'doc') {
    body = renderDoc();
  } else {
    if (!state.data || !state.stats) {
      main.innerHTML = '<div class="loading"><div class="spinner"></div><p>正在读取错题本…</p></div>';
      // 题库刚被改过（加了题 / 删了题）会把这两份缓存清掉。这里**自动补拉一次** ——
      // 不补的话页面就一直卡在「正在读取错题本…」上，得手动按刷新才出得来。
      if (!state.dataLoading) {
        state.dataLoading = true;
        fetchAll()
          .then(() => render())
          .catch(() => {
            /* 拉不到就停在加载态，比白屏好 */
          })
          .finally(() => {
            state.dataLoading = false;
          });
      }
      return;
    }
    if (state.sub === 'dashboard') body = renderDashboard();
    else if (state.sub === 'library') body = renderLibrary();
    else if (state.sub === 'drill') body = renderReview();
    else if (state.sub === 'solve') body = renderSolve();
    else body = renderAdd();
  }

  main.innerHTML = body;
  state.renderedView = viewKey;
  if (keepScroll) {
    const now = document.querySelector('.rf-body');
    if (now) now.scrollTop = keepScroll;
  }

  const inMistakes = state.module === 'mistakes' || state.module === 'good';
  if (inMistakes && state.data) renderScopeButton();
  $('#scopePicker').hidden = !inMistakes || state.sub === 'add' || state.sub === 'solve';
  document.body.classList.toggle('is-solving', inMistakes && state.sub === 'solve');
  document.body.classList.toggle(
    'is-reading',
    (state.module === 'words' && state.storyWide && !!state.story) ||
      (state.module === 'test' && state.testWide && !!state.test)
  );
  $('#mistakeSubnav').hidden = !inMistakes;
  if (state.pickerOpen && inMistakes) $('#scopeMenu').innerHTML = renderScopeMenu();

  for (const btn of document.querySelectorAll('.tab')) {
    btn.classList.toggle('is-active', btn.dataset.module === state.module);
  }
  for (const btn of document.querySelectorAll('.subtab')) {
    btn.classList.toggle('is-active', btn.dataset.sub === state.sub);
  }

  // 全屏模式都要计时：试卷（今日测试 / 英语阅读）和错题本的单题做题
  // 一进去就开始走，出去了就暂停、时间留着；按「哪一份 / 哪一题」各记各的
  const wideKey = document.body.classList.contains('is-reading')
    ? state.module === 'test'
      ? state.testRel
      : state.storyRel
    : document.body.classList.contains('is-solving') && state.solve.id
      ? solveTimerKey(state.solve.id)
      : null;
  if (wideKey) enterPaperTimer(wideKey);
  else leavePaperTimer();
  mountWordCard(); // 点词浮层是 body 上的 fixed 元素，整页重绘后要重新挂
  fitReadRail(); // 阅读页的侧栏高度要按真实可见高度算（详见 fitReadRail）
}

/** 错题模块的二级导航 */
function renderMistakeSubnav() {
  const items = [
    ['dashboard', '总览'],
    ['library', '题库'],
    ['drill', '复习'],
    ['add', '增题'],
  ];
  return `<nav class="subnav" id="mistakeSubnav" hidden>${items
    .map(([k, label]) => `<button class="subtab" data-sub="${k}">${label}</button>`)
    .join('')}</nav>`;
}

/* ============================================================
   路由：#模块/子视图/范围…
   ============================================================ */
function buildHash({ module, sub, scope, solveId, rel }) {
  const seg = [module];
  if (module === 'mistakes' || module === 'good') {
    seg.push(sub);
    if (sub === 'solve') {
      if (solveId) seg.push(solveId);
    } else {
      if (scope?.category) seg.push(scope.category);
      if (scope?.subject) seg.push(scope.subject);
      if (scope?.chapter) seg.push(scope.chapter);
    }
  } else if ((module === 'patterns' || module === 'doc') && rel) {
    seg.push(rel); // 整段编码，路径里的 / 不会把 hash 拆散
  } else if (module === 'plan' && rel) {
    seg.push(...String(rel).split('/'));
  } else if (module === 'journal' && rel) {
    seg.push(rel);
  } else if (module === 'words' && rel) {
    seg.push(rel);
  } else if (module === 'test' && rel) {
    seg.push(rel);
  } else if (module === 'today' && state.viewDate) {
    seg.push(state.viewDate); // #today/2026-09-14 → 看那一天，刷新 / 分享链接都还在
  }
  return '#' + seg.filter(Boolean).map(encodeURIComponent).join('/');
}

function applyHash() {
  const parts = location.hash
    .replace(/^#/, '')
    .split('/')
    .filter(Boolean)
    .map(decodeURIComponent);
  const module = MODULES.includes(parts[0]) ? parts[0] : 'today';
  state.module = module;
  if (BOOK_OF[module]) {
    const nextBook = BOOK_OF[module];
    // 换书时把「哪一本」筛选收回当前这本：否则在错题本里点过「全部（共通）」，
    // 切到好题页会又看到一堆错题，看起来像没分开
    if (state.book !== nextBook) state.filters.kind = null;
    state.book = nextBook;
  }

  if (module === 'mistakes' || module === 'good') {
    const sub = SUBVIEWS.includes(parts[1]) ? parts[1] : 'dashboard';
    state.sub = sub;
    state.view = sub;

    if (sub === 'solve') {
      const id = parts[2] || null;
      if (id && state.solve.id !== id) enterSolve(id);
      if (!id) closeSolve();
      render(); // 计时器由 render 统一管（进了做题模式就开始走）
      return;
    }
    closeSolve();
    state.scope = { category: parts[2] || null, subject: parts[3] || null, chapter: parts[4] || null };
    render();
    refreshStats();
    if (sub === 'drill' && state.review.phase === 'run') startReviewTimer();
    else stopReviewTimer();
    if (sub === 'add') loadUploads().then(() => render());
    return;
  }

  closeSolve();
  stopReviewTimer();

  // 题型 / 原文的路径里本来就带 /，程序自己会整段编码；
  // 但手打或分享出来的 URL 往往是没编码的，这里 join 回去，两种都认
  if (module === 'patterns') {
    state.openPattern = parts.length > 1 ? parts.slice(1).join('/') : null;
    loadPatterns().then(() => render());
    render();
    return;
  }
  if (module === 'doc') {
    const rel = parts.length > 1 ? parts.slice(1).join('/') : null;
    if (rel) loadDoc(rel).then(() => render());
    render();
    return;
  }
  if (module === 'plan') {
    const rel = parts.slice(1).join('/') || null;
    state.planRel = rel;
    loadPlans().then(() => (rel ? loadPlanDetail(rel) : null)).then(() => render());
    render();
    return;
  }
  if (module === 'journal') {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(parts[1] || '') ? parts[1] : null;
    state.journalDate = date;
    loadJournal(date).then(() => render());
    render();
    return;
  }
  if (module === 'words') {
    const rel = parts.length > 1 ? parts.slice(1).join('/') : null;
    // 有 rel = 全屏做题；没有 = 选词页
    state.storyWide = !!rel;
    // 有 rel 就重新读盘 —— 不能因为「和当前这篇同名」就跳过：文件可能刚被重写过
    if (rel) loadStory(rel).then(() => render());
    if (!state.ai) loadAI().then(() => render());
    loadWords().then(() => render());
    render();
    return;
  }

  if (module === 'settings') {
    if (!state.ai) loadAI().then(() => render());
    if (!state.words) loadWords().then(() => render());
    if (!state.health) loadHealth().then(() => render());
    if (!state.lan) loadLan().then(() => render());
    render();
    return;
  }

  if (module === 'test') {
    const rel = parts.length > 1 ? parts.slice(1).join('/') : null;
    state.testWide = !!rel;
    if (rel) loadTest(rel).then(() => render());
    if (!state.ai) loadAI().then(() => render());
    loadTests().then(() => render());
    render();
    return;
  }

  // 今日（#today/2026-09-14 = 看本周里的那一天）
  state.viewDate = /^\d{4}-\d{2}-\d{2}$/.test(parts[1] || '') ? parts[1] : null;
  loadToday().then(() => render());
  render();
}

function go(patch = {}) {
  const module = patch.module ?? state.module;
  const sub = patch.sub ?? state.sub;

  if (module === 'mistakes' || module === 'good') {
    const scope = {
      category: patch.category !== undefined ? patch.category : state.scope.category,
      subject: patch.subject !== undefined ? patch.subject : state.scope.subject,
      chapter: patch.chapter !== undefined ? patch.chapter : state.scope.chapter,
    };
    if (patch.category !== undefined && patch.category !== state.scope.category) {
      scope.subject = null;
      scope.chapter = null;
    }
    if (patch.subject !== undefined && patch.subject !== state.scope.subject) scope.chapter = null;
    state.scope = scope;
    const hash = buildHash({ module, sub, scope, solveId: state.solve.id });
    if (location.hash !== hash) location.hash = hash;
    else applyHash();
    return;
  }

  let rel = patch.rel;
  if (module === 'patterns') rel = patch.rel !== undefined ? patch.rel : state.openPattern;
  else if (module === 'journal') rel = patch.date !== undefined ? patch.date : state.journalDate;
  // 单词 / 测试：只有明确传了 rel 才进「全屏那一篇」。
  // 不然点顶栏 tab 会拿到上次看的那一篇，直接跳进全屏做题。
  else if (module === 'words') rel = patch.rel !== undefined ? patch.rel : null;
  else if (module === 'test') rel = patch.rel !== undefined ? patch.rel : null;
  else if (module === 'plan') rel = patch.rel !== undefined ? patch.rel : state.planRel;
  const hash = buildHash({ module, rel });
  if (location.hash !== hash) location.hash = hash;
  else applyHash();
}

/** 一次把「全量题库」和「当前范围统计」都取回来，保证 render 时两者都非空 */
async function fetchAll() {
  const data = await api('/api/questions');
  const q = scopeQuery();
  const stats = await api(`/api/stats${q ? `?${q}` : ''}`);
  state.data = data;
  state.stats = stats;
}

async function reload({ silent = false } = {}) {
  try {
    await fetchAll();
    render();
    refreshDrawer();
  } catch (err) {
    if (!silent) {
      $('#main').innerHTML = `<div class="callout callout-error" style="margin:40px auto;max-width:640px">
        <div class="callout-head">⛔<span>读取失败</span></div>
        <div class="callout-body"><p class="md-p">${esc(err.message)}</p>
        <p class="md-p">请确认错题本目录存在，或检查 config.json 里的 notebookDir。</p></div></div>`;
    }
    throw err;
  }
}

async function refreshStats() {
  try {
    const q = scopeQuery();
    state.stats = await api(`/api/stats${q ? `?${q}` : ''}`);
    render();
  } catch {
    /* 统计失败不影响主流程 */
  }
}

/* ============================================================
   交互
   ============================================================ */
function bindEvents() {
  $('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (btn) go({ module: btn.dataset.module });
  });

  $('#mistakeSubnav').addEventListener('click', (e) => {
    const btn = e.target.closest('.subtab');
    if (btn) go({ module: state.book, sub: btn.dataset.sub });
  });

  window.addEventListener('hashchange', applyHash);

  // ⌘V / Ctrl+V 直接贴截图（macOS 的 Cmd+Ctrl+Shift+4 截完就能贴，不用先存文件）
  // 两处收图：增题页的虚线框，和全屏卷子 / 单题做题里的「拍照判分」区
  window.addEventListener('paste', (e) => {
    const inAdd = (state.module === 'mistakes' || state.module === 'good') && state.sub === 'add';
    // 判分区在屏幕上就收（今日测试 / 英语阅读 / 错题本单题做题都是同一个 #gradeDrop）
    const inGrade = !!document.getElementById('gradeDrop');
    if (!inAdd && !inGrade) return;
    const items = [...(e.clipboardData?.items || [])];
    const files = items
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter(Boolean);
    if (!files.length) return; // 贴的是文字就照常贴进输入框
    e.preventDefault();
    // 截图的文件名都一样，给它起个能认的
    const stamped = files.map((f, i) => {
      const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      const name = f.name && f.name !== 'image.png' ? f.name : `粘贴-${Date.now()}-${i + 1}.${ext}`;
      try {
        return new File([f], name, { type: f.type });
      } catch {
        return f;
      }
    });
    toast(`贴进来 ${stamped.length} 张图，正在上传…`);
    if (inAdd) uploadFiles(stamped);
    else uploadGradeFiles(stamped);
  });

  // 顶栏范围选择器
  $('#scopeBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    togglePicker();
  });
  $('#scopeMenu').addEventListener('click', (e) => {
    const row = e.target.closest('[data-pick]');
    if (!row) return;
    e.stopPropagation();
    const kind = row.dataset.pick;
    closePicker();
    if (kind === 'reset') return go({ category: null, subject: null, chapter: null });
    if (kind === 'category') return go({ category: row.dataset.value, subject: null, chapter: null });
    if (kind === 'subject')
      return go({ category: row.dataset.category, subject: row.dataset.value, chapter: null });
    if (kind === 'chapter') return go({ chapter: row.dataset.value });
  });
  document.addEventListener('click', (e) => {
    if (state.pickerOpen && !e.target.closest('#scopePicker')) closePicker();
  });

  // 任务勾选 → 写回 Obsidian
  $('#main').addEventListener('change', (e) => {
    if (e.target.matches('input[data-task]')) togglePlanTask(e.target);
    // 单词页：随机题型开关 / 自定义词数（失焦或回车才重绘，免得打字时丢焦点）
    if (e.target.id === 'randomType') {
      state.pick.random = e.target.checked;
      render();
    }
    if (e.target.id === 'wordCount') {
      state.pick.count = Math.max(1, Number(e.target.value) || 1);
      render();
    }
    // 加入题库面板里的归类输入框
    if (e.target.matches('[data-bank-field]') && state.bankDraft) {
      state.bankDraft[e.target.dataset.bankField] = e.target.value.trim();
    }
    // 判分面板：勾了「同时写进首次错因」也先记下来（重绘后不丢）
    if (e.target.id === 'sqFirstReason' && state.solveVerdict) {
      state.solveVerdict.setFirstReason = e.target.checked;
    }
  });
  $('#main').addEventListener('input', (e) => {
    if (e.target.id === 'wordCount') state.pick.count = Math.max(1, Number(e.target.value) || 1);
    // 判分面板里的错因分析：随手改的都存回 state，不然点一下 chip 重绘就白改了；
    // 底下那行渲染预览也跟着变（公式在预览里是真公式，文本框里保持原文）
    if (e.target.id === 'sqAnalysis') {
      if (state.solveVerdict) state.solveVerdict.analysis = e.target.value;
      const host = document.getElementById('sqAnalysisMd');
      if (host) host.innerHTML = mdPreview(e.target.value);
    }
    // 增题页粘的题干：**每敲一下都得存回 state**。
    // 不然传一张图、或者点一下「按空行分隔」，整页重绘就会拿 state 里的旧值把文本框重建，
    // 你刚粘的一大段题直接没了（文本框只在这儿和 addParse() 里被读过，重绘不管它）。
    if (e.target.id === 'addStem') state.add.raw = e.target.value;
    // 识别结果里手改的字段同理：再传一张图就会重绘，改过的章节 / 考点 / 编号会被冲回原样
    const itemNode = e.target.closest?.('.add-item');
    const itemField = e.target.dataset?.field;
    if (itemNode && itemField) syncAddItemField(itemNode, itemField, e.target.value);
    // 复盘正文与单词改稿：都是长文，重绘（生成完一周总结、刷新墨墨）不该把它冲掉
    // 选词区搜索：只换词条那一片，不整页重绘（不然输入框焦点和滚动位置都没了）
    if (e.target.id === 'wordFilter') {
      state.pick.q = e.target.value;
      const host = document.querySelector('.word-chips');
      if (host) host.innerHTML = pickChipsHtml(pickVisibleWords());
      return;
    }
    if (e.target.id === 'journalText' && state.journal) state.journal.draft = e.target.value;
    if (e.target.id === 'storyEdit') state.storyDraft = e.target.value;
  });

  // 图片选择与拖拽
  $('#main').addEventListener('change', (e) => {
    if (e.target.id === 'journalDate') return go({ module: 'journal', date: e.target.value });
    if (e.target.id === 'fileInput' && e.target.files?.length) {
      uploadFiles(e.target.files);
      e.target.value = '';
    }
    if (e.target.id === 'gradeFiles' && e.target.files?.length) {
      uploadGradeFiles(e.target.files);
      e.target.value = '';
    }
  });
  /** 拖拽落点：增题页的 #dropZone，或全屏卷子的 #gradeDrop */
  const dropZoneOf = (e) => e.target.closest?.('#dropZone, #gradeDrop') || null;
  $('#main').addEventListener('dragover', (e) => {
    const zone = dropZoneOf(e);
    if (!zone) return;
    e.preventDefault();
    zone.classList.add('is-over');
  });
  $('#main').addEventListener('dragleave', (e) => {
    const zone = dropZoneOf(e);
    if (zone) zone.classList.remove('is-over');
  });
  $('#main').addEventListener('drop', (e) => {
    const zone = dropZoneOf(e);
    if (!zone) return;
    e.preventDefault();
    zone.classList.remove('is-over');
    if (!e.dataTransfer?.files?.length) return;
    if (zone.id === 'gradeDrop') uploadGradeFiles(e.dataTransfer.files);
    else uploadFiles(e.dataTransfer.files);
  });

  // 阅读页侧栏：滚动（任何容器）/ 改窗口大小都重算一次高度
  document.addEventListener('scroll', queueFitReadRail, { capture: true, passive: true });
  window.addEventListener('resize', queueFitReadRail);

  /**
   * 点词浮层的按钮：**必须挂在 document 上**。
   * 浮层是 body 的孩子（fixed 定位，贴着点中的那个词），不在 #main 里 ——
   * 挂在 $('#main') 上那些 handler 收不到它的点击，「查看」和「关掉」就都成了死按钮。
   */
  document.addEventListener('click', (e) => {
    const wcBtn = e.target.closest('[data-word-card]');
    if (wcBtn) {
      const act = wcBtn.dataset.wordCard;
      if (act === 'close') {
        state.wordCard = null;
        return mountWordCard();
      }
      if (act === 'advance') {
        if (state.wordCard) state.wordCard.advance = wcBtn.checked;
        return paintWordCard();
      }
      if (act === 'annotate') return annotateWord();
      if (act === 'add') return addWordToPlan();
      return;
    }
    // 点别处就收起来；点正文里的词 / 浮层自己身上都不算「别处」
    if (state.wordCard && !e.target.closest('[data-rdword]') && !e.target.closest('.word-card')) {
      state.wordCard = null;
      mountWordCard();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.wordCard) {
      state.wordCard = null;
      mountWordCard();
    }
  });

  $('#search').addEventListener('input', (e) => {
    state.q = e.target.value;
    if (state.q && !(BOOK_OF[state.module] && state.sub === 'library')) go({ module: state.book, sub: 'library' });
    else render();
  });

  $('#btnRefresh').addEventListener('click', async () => {
    await reload({ silent: true });
    toast('已重新扫描错题本目录');
  });

  $('#btnExport').addEventListener('click', async () => {
    try {
      const out = await api('/api/export', { method: 'POST' });
      toast(`已导出 questions.json 与 stats.md（${out.count} 题）`, 'ok');
    } catch (err) {
      toast(`导出失败：${err.message}`, 'err');
    }
  });

  $('#btnSettings').addEventListener('click', () => go({ module: 'settings' }));

  $('#btnTheme').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('notebook-theme', next);
  });

  $('#main').addEventListener('click', (e) => {
    // 范围切换（范围条 / 科目卡片 / 复习页的快捷筹码）
    const sc = e.target.closest('[data-scope]');
    if (sc) {
      const kind = sc.dataset.scope;
      if (kind === 'reset') return go({ category: null, subject: null, chapter: null });
      const patch = {};
      patch[kind] = sc.dataset.value || null;
      if (sc.dataset.scope2) patch[sc.dataset.scope2] = sc.dataset.value2 || null;
      return go(patch);
    }

    const rv = e.target.closest('[data-review]');
    if (rv && !rv.disabled) {
      const action = rv.dataset.review;
      if (action === 'start' || action === 'again') return startReview();
      if (action === 'reveal') return revealReview();
      if (action === 'record') return requestReviewRecord(rv.dataset.result);
      if (action === 'skip') return skipReview();
      if (action === 'exit') return exitReview();
      if (action === 'back') return go({ module: state.book, sub: 'dashboard' });
    }

    const add = e.target.closest('[data-add]');
    if (add && !add.disabled) {
      const a = add.dataset.add;
      if (a === 'parse') return addParse();
      if (a === 'create') return addCreate();
      if (a === 'prompt') return addPrompt();
      if (a === 'pick') return $('#fileInput')?.click();
      if (a === 'del-upload') return deleteUpload(add.dataset.name);
      if (a === 'clear-uploads') return clearUploads();
      if (a === 'prompt-images') return promptImages();
      if (a === 'clear') {
        state.add = { raw: '', mode: state.add.mode, items: null, busy: false, uploads: state.add.uploads };
        return render();
      }
    }
    if (e.target.closest('[data-add-mode]')) {
      state.add.mode = e.target.closest('[data-add-mode]').dataset.addMode;
      if (state.add.raw) return addParse();
      return render();
    }
    if (e.target.closest('[data-rv-clear]')) {
      state.review.options.chapters = [];
      return render();
    }

    // 复习选项
    const rvCh = e.target.closest('[data-rv-chapter]');
    if (rvCh) {
      const key = rvCh.dataset.rvChapter;
      const list = state.review.options.chapters;
      state.review.options.chapters = list.includes(key) ? list.filter((x) => x !== key) : [...list, key];
      return render();
    }
    const rvOpt = e.target.closest('[data-rv-scope],[data-rv-order],[data-rv-count]');
    if (rvOpt) {
      const o = state.review.options;
      if (rvOpt.dataset.rvScope) o.scope = rvOpt.dataset.rvScope;
      if (rvOpt.dataset.rvOrder) o.order = rvOpt.dataset.rvOrder;
      if (rvOpt.dataset.rvCount) o.count = rvOpt.dataset.rvCount === 'all' ? 'all' : Number(rvOpt.dataset.rvCount);
      return render();
    }

    // 做题模式内的按钮
    const sv = e.target.closest('[data-solve]');
    if (sv) {
      const a = sv.dataset.solve;
      if (a === 'exit') return go({ module: state.book, sub: 'library' });
      if (a === 'reveal') {
        state.solve.revealed = true;
        return render();
      }
      if (a === 'record') {
        const result = sv.dataset.result;
        if (result === '完美') return doSolveCheckin('完美', null);
        state.solve.pendingResult = result;
        return render();
      }
    }

    // 错因选择（做题模式和复习模式共用）
    const reasonBtn = e.target.closest('[data-reason]');
    if (reasonBtn) {
      const reason = reasonBtn.dataset.reason || null;
      if (state.solve.pendingResult) return doSolveCheckin(state.solve.pendingResult, reason);
      if (state.review.pendingResult) return commitReview(state.review.pendingResult, reason);
      return;
    }

    // 单题拍照判分：判完之后结果 / 错因都能自己改（改完才记录）
    const svd = e.target.closest('[data-solve-verdict]');
    if (svd && state.solveVerdict) {
      state.solveVerdict.result = svd.dataset.solveVerdict;
      if (state.solveVerdict.result === '完美') state.solveVerdict.reason = '';
      return render();
    }
    const svr = e.target.closest('[data-solve-reason]');
    if (svr && state.solveVerdict) {
      state.solveVerdict.reason = svr.dataset.solveReason || '';
      return render();
    }
    if (e.target.closest('[data-reason-cancel]')) {
      state.solve.pendingResult = null;
      state.review.pendingResult = null;
      return render();
    }

    // 抽屉里的「开始做题」
    const solveStart = e.target.closest('[data-solve-start]');
    if (solveStart) return goSolve(solveStart.dataset.solveStart);

    // study 各页的跳转
    const goBtn = e.target.closest('[data-go]');
    if (goBtn) {
      const v = goBtn.dataset.go;
      if (v === 'journal') return go({ module: 'journal' });
      if (v === 'mistakes') return go({ module: 'mistakes', sub: 'dashboard' });
      return go({ module: v });
    }

    // 首页「本周进度」那排：点哪天就看哪天（空 data-day = 回到今天）
    const dayBtn = e.target.closest('[data-day]');
    if (dayBtn) return goViewDate(dayBtn.dataset.day || null);

    /* 单词（墨墨 → 考研题型） */
    const wd = e.target.closest('[data-words]');
    if (wd && !wd.disabled) {
      const a = wd.dataset.words;
      if (a === 'refresh') {
        return loadWords({ force: true }).then(() => {
          render();
          toast('已重新拉取墨墨数据');
        });
      }
      if (a === 'clear-pick') {
        state.pick.removed = poolAllWords().map((x) => x.voc_id);
        state.pick.added = [];
        return render();
      }
      if (a === 'reset-pick') {
        state.pick.removed = [];
        state.pick.added = [];
        return render();
      }
      if (a === 'save-token') return saveMaimemoToken();
      if (a === 'edit-story') {
        state.storyEdit = true;
        return render();
      }
      if (a === 'cancel-story') {
        state.storyEdit = false;
        state.storyDraft = null; // 取消就是不存，草稿也别留着
        return render();
      }
      if (a === 'save-story') return saveStoryDraft();
      if (a === 'exit-reading') {
        state.storyWide = false;
        state.storyEdit = false;
        state.storyDraft = null;
        return go({ module: 'words', rel: null });
      }
    }

    /* 内置 AI */
    const ai = e.target.closest('[data-ai]');
    if (ai && !ai.disabled) {
      if (ai.dataset.ai === 'save') return saveAIConfig();
      if (ai.dataset.ai === 'test') return testAIConnection();
    }
    const aip = e.target.closest('[data-ai-preset]');
    if (aip) return applyAIPreset(aip.dataset.aiPreset);
    const air = e.target.closest('[data-ai-reasoning]');
    if (air) {
      return (async () => {
        try {
          state.ai = await api('/api/ai/config', {
            method: 'POST',
            body: JSON.stringify({ reasoning: air.dataset.aiReasoning }),
          });
          render();
          toast(`思考模式：${air.textContent.trim()}`, 'ok');
        } catch (err) {
          toast(`保存失败：${err.message}`, 'err');
        }
      })();
    }
    if (e.target.closest('[data-set="selfcheck"]')) return runSelfCheck();
    // 服务：🔄 重启（两段式确认）/ 刷新状态（状态现在有两块：服务 + 手机访问开关）
    if (e.target.closest('[data-set="reload-health"]'))
      return Promise.all([loadHealth(), loadLan()]).then(() => render());
    // 手机访问开关：拨一下就生效，不用重启
    if (e.target.closest('[data-set="lan-on"]')) return toggleLan(true);
    if (e.target.closest('[data-set="lan-off"]')) return toggleLan(false);
    const restartBtn = e.target.closest('[data-set="restart"]');
    if (restartBtn && !restartBtn.disabled) {
      if (!state.restartArmed) {
        state.restartArmed = true;
        render();
        toast('再点一次就真的重启（5 秒内有效）');
        setTimeout(() => {
          if (state.restartArmed) {
            state.restartArmed = false;
            render();
          }
        }, 5000);
        return;
      }
      return restartServer(restartBtn);
    }
    // 进度面板上的两个按钮：中断这次生成 / 收起已经结束的面板
    const airBtn = e.target.closest('[data-air]');
    if (airBtn) {
      if (airBtn.dataset.air === 'abort') return abortAIRun();
      if (airBtn.dataset.air === 'close') {
        state.aiRun = null;
        return render();
      }
    }
    const airun = e.target.closest('[data-airun]');
    if (airun && !airun.disabled) {
      if (airun.dataset.airun === 'words') {
        const sel = buildSelection();
        if (!sel.picked.length) return toast('先勾几个词', 'err');
        const plan = plannedPapers();
        if (!state.pick.random && !state.pick.types.length) return toast('先勾一个题型', 'err');
        return runAI('words', {
          // 连拼写一起发过去，模型提示词里要写上具体的词
          words: sel.picked.map((w) => ({ voc_id: w.voc_id, spelling: w.spelling })),
          types: state.pick.types,
          papers: plan.count,
          random: state.pick.random,
          date: state.words?.overview?.date,
        });
      }
      if (airun.dataset.airun === 'test') return runAI('test', {});
      if (airun.dataset.airun === 'weekly') return runAI('weekly', {});
      if (airun.dataset.airun === 'add') {
        // 手头有什么就跑什么：粘了题干解题，传了图就读图，两样都有就一起
        const ups = state.add.uploads || [];
        const items = state.add.items || [];
        const book = state.book === 'good' ? 'good' : 'mistakes';
        const reasonEl = document.getElementById('imageReason');
        const reason = reasonEl ? reasonEl.value : '';
        const tasks = [];
        if (items.length) {
          tasks.push({ kind: 'questions', stems: items.map((x) => x.stem || x.raw || '').filter(Boolean), book });
        }
        if (ups.length) {
          tasks.push({ kind: 'images', names: ups.map((f) => f.name), book, reason });
        }
        if (!tasks.length) return toast('先粘题干，或者拖一张题目截图进来', 'err');
        return runAI('add', { tasks });
      }
      if (airun.dataset.airun === 'questions') {
        const items = state.add.items || [];
        if (!items.length) return toast('先解析题干', 'err');
        return runAI('questions', {
          stems: items.map((x) => x.stem || x.raw || '').filter(Boolean),
          book: state.book === 'good' ? 'good' : 'mistakes',
        });
      }
    }

    /* 今日测试 */
    const td = e.target.closest('[data-test]');
    if (td && !td.disabled) {
      const a = td.dataset.test;
      if (a === 'refresh') {
        return loadTests().then(() => {
          render();
          toast('已重新整理今天的内容');
        });
      }
      if (a === 'exit') {
        state.testWide = false;
        return go({ module: 'test', rel: null });
      }
      if (a === 'toggle-all') {
        const show = td.dataset.testAll === 'show';
        const next = {};
        for (const q of state.test?.items || []) if (q.answer) next[q.n] = show;
        state.testShown = next;
        return render();
      }
    }
    const ta = e.target.closest('[data-test-answer]');
    if (ta) {
      const n = Number(ta.dataset.testAnswer);
      state.testShown = { ...state.testShown, [n]: !state.testShown[n] };
      return render();
    }

    // 试卷计时器：暂停 / 继续 / 重置
    const tm = e.target.closest('[data-timer]');
    if (tm) {
      if (tm.dataset.timer === 'reset') return resetPaperTimer();
      return togglePaperTimer();
    }

    // 拍照判分（今日测试整卷 / 错题本单题）
    const gr = e.target.closest('[data-grade]');
    if (gr && !gr.disabled) {
      const a = gr.dataset.grade;
      if (a === 'pick') return document.getElementById('gradeFiles')?.click();
      if (a === 'run') return state.grade.kind === 'question' ? runQuestionGrade() : runGrade();
      if (a === 'clear') return clearGradeImages();
      if (a === 'del') return removeGradeImage(gr.dataset.name);
      if (a === 'bank') return addWrongToBank();
      if (a === 'record') return recordSolveVerdict();
      if (a === 'discard') {
        state.solveVerdict = null;
        return render();
      }
    }
    // 删除试卷 / 单词题（按钮在 #main 里，两段式确认）
    const delTest = e.target.closest('[data-del-test]');
    if (delTest) return confirmDelete('test', delTest.dataset.delTest, delTest.dataset.delKey);
    const delStory = e.target.closest('[data-del-story]');
    if (delStory) return confirmDelete('story', delStory.dataset.delStory, delStory.dataset.delKey);

    const tbOpen = e.target.closest('[data-test-bank-open]');
    if (tbOpen && !tbOpen.disabled) return openBankForm(Number(tbOpen.dataset.testN), tbOpen.dataset.testBankOpen);

    // 加入题库前的填写面板
    const bReason = e.target.closest('[data-bank-reason]');
    if (bReason && state.bankDraft) {
      state.bankDraft.reason =
        state.bankDraft.reason === bReason.dataset.bankReason ? '' : bReason.dataset.bankReason;
      return render();
    }
    const bDiff = e.target.closest('[data-bank-diff]');
    if (bDiff && state.bankDraft) {
      state.bankDraft.difficulty = Number(bDiff.dataset.bankDiff);
      return render();
    }
    const bHeat = e.target.closest('[data-bank-heat]');
    if (bHeat && state.bankDraft) {
      state.bankDraft.heat = Number(bHeat.dataset.bankHeat);
      return render();
    }

    const tb = e.target.closest('[data-test-bank]');
    if (tb && !tb.disabled) {
      const a = tb.dataset.testBank;
      if (a === 'cancel') return closeBankForm();
      if (a === 'confirm') {
        const d = state.bankDraft || {};
        // 归类是三个输入框，重绘前先把当前值收回来
        for (const el of document.querySelectorAll('[data-bank-field]')) {
          d[el.dataset.bankField] = el.value.trim();
        }
        return addTestToBank(Number(tb.dataset.testN), d.book, tb);
      }
    }
    const to = e.target.closest('[data-test-open]');
    if (to) return go({ module: 'test', rel: to.dataset.testOpen });

    // 词池来源（多选）
    const src = e.target.closest('[data-source]');
    if (src) {
      const k = src.dataset.source;
      const list = state.pick.sources;
      state.pick.sources = list.includes(k) ? list.filter((x) => x !== k) : [...list, k];
      return render();
    }
    const rusty = e.target.closest('[data-rusty]');
    if (rusty) {
      state.pick.rustyMin = Number(rusty.dataset.rusty);
      return render();
    }
    const rg = e.target.closest('[data-range]');
    if (rg) {
      state.pick.range = rg.dataset.range === 'all' ? 'all' : 'due200';
      return render();
    }
    const cm = e.target.closest('[data-count-mode]');
    if (cm) {
      state.pick.count = cm.dataset.countMode === 'auto' ? 'auto' : Math.max(1, recommendedCount());
      return render();
    }
    // 单个词：点掉 / 点回来（超出手动范围的走 added）
    const wc = e.target.closest('[data-word]');
    if (wc) {
      const id = wc.dataset.word;
      const isPicked = buildSelection().picked.some((x) => x.voc_id === id);
      if (isPicked) {
        state.pick.removed = [...new Set([...state.pick.removed, id])];
        state.pick.added = state.pick.added.filter((x) => x !== id);
      } else {
        state.pick.removed = state.pick.removed.filter((x) => x !== id);
        state.pick.added = [...new Set([...state.pick.added, id])];
      }
      return render();
    }
    // 题型（多选）
    const tp = e.target.closest('[data-type]');
    if (tp) {
      const id = tp.dataset.type;
      const list = state.pick.types;
      state.pick.types = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
      return render();
    }
    const pp = e.target.closest('[data-papers]');
    if (pp) {
      state.pick.papers = Number(pp.dataset.papers);
      return render();
    }

    // 题目：选选项 / 对答案 / 重做（全部在本地完成：不发请求，也不整页重绘）
    const pick = e.target.closest('[data-quiz-pick]');
    if (pick && !pick.disabled) {
      state.quiz.answers = { ...state.quiz.answers, [pick.dataset.q]: pick.dataset.k };
      return paintQuiz();
    }
    const qa = e.target.closest('[data-quiz]');
    if (qa) {
      if (qa.dataset.quiz === 'grade') {
        state.quiz.graded = true;
        // 对完答案就把「答案解析」也调出来（题目留在上面看对错，解析接在下面）
        state.railTabs = ['题目', '答案解析'];
        paintQuiz();
        render();
        const key = state.story?.key || {};
        const qs = state.story?.questions || [];
        const pts = state.story?.plan?.table?.byN || {};
        const full = state.story?.plan?.table?.full || qs.length;
        const score = quizScore(qs, state.quiz.answers || {}, key, (n) => Number(pts[n] ?? 0));
        toast(`得分 ${fmtPts(score)} / ${fmtPts(full)}`, score >= full ? 'ok' : '');
        // 对完答案就是做完了：计时停在这一刻（不停的话，之后挂在这一屏上时间会一直涨）
        stopPaperTimer(state.storyRel);
        // 顺手把这次成绩记进卷子的「成绩记录」—— 页面上的分数关掉就没了，写进去才留得住
        recordLocalQuiz();
      } else {
        state.quiz = { answers: {}, graded: false };
        paintQuiz();
      }
      return;
    }

    const so = e.target.closest('[data-story-open]');
    if (so) {
      state.storyEdit = false; // 换一篇就把编辑器收起来，别拿旧内容盖新的
      return go({ module: 'words', rel: so.dataset.storyOpen });
    }

    // 英语正文里点一个词 → 浮层（浮层自己的按钮在下面 document 那个监听器里处理）
    const rdWord = e.target.closest('[data-rdword]');
    if (rdWord) {
      e.preventDefault();
      return openWordCard(rdWord);
    }

    // 英语阅读的右侧栏：点一下开那个面板，再点一下收起（可以同时开几个）
    // 全收起时侧栏缩成窄边条、原文回到中间 —— 位置跟着动，不用自己去对
    const rail = e.target.closest('[data-rail]');
    if (rail) {
      const name = rail.dataset.rail;
      const list = state.railTabs || [];
      state.railTabs = list.includes(name) ? list.filter((x) => x !== name) : [...list, name];
      return render();
    }
    const wr = e.target.closest('[data-words="exit-reading"]');
    if (wr) {
      state.storyWide = false;
      state.storyEdit = false;
      return go({ module: 'words', rel: null });
    }
    const popen = e.target.closest('[data-pattern-open]');
    if (popen) return go({ module: 'patterns', rel: popen.dataset.patternOpen });
    if (e.target.closest('[data-pattern-back]')) return go({ module: 'patterns', rel: null });
    if (e.target.closest('[data-doc-back]')) return history.length > 1 ? history.back() : go({ module: 'today' });
    if (e.target.closest('[data-doc-raw]')) {
      state.docRaw = !state.docRaw;
      return render();
    }
    const wl = e.target.closest('[data-wikilink]');
    if (wl) return openWikiLink(wl.dataset.wikilink);
    const dopen = e.target.closest('[data-doc-open]');
    if (dopen) return openDoc(dopen.dataset.docOpen);

    const planBtn = e.target.closest('[data-plan]');
    if (planBtn) return go({ module: 'plan', rel: planBtn.dataset.plan });
    const jOpen = e.target.closest('[data-journal-open]');
    if (jOpen) return openJournalFile(jOpen.dataset.journalOpen);
    const jBtn = e.target.closest('[data-journal]');
    if (jBtn && jBtn.dataset.journal) return go({ module: 'journal', date: jBtn.dataset.journal });
    if (e.target.closest('[data-journal-save]')) return saveJournal();
    const mv = e.target.closest('[data-journal-move]');
    if (mv) return go({ module: 'journal', date: shiftDate(state.journal?.date, Number(mv.dataset.journalMove)) });

    const open = e.target.closest('[data-open]');
    if (open) return openDrawer(open.dataset.open);

    // 点总览里的考点 → 跳到题库并按该考点过滤
    const ptRow = e.target.closest('[data-point]');
    if (ptRow) {
      state.filters = { status: null, difficulty: null, heat: null, point: ptRow.dataset.point };
      state.q = '';
      $('#search').value = '';
      return go({ module: state.book, sub: 'library' });
    }

    const fchip = e.target.closest('[data-filter]');
    if (fchip) {
      const key = fchip.dataset.filter;
      const raw = fchip.dataset.value;
      let val = raw === '' ? null : raw;
      if (key === 'difficulty' || key === 'heat') val = val === null ? null : Number(val);
      state.filters[key] = state.filters[key] === val ? null : val;
      return render();
    }

    if (e.target.closest('#resetFilters')) {
      state.filters = { status: null, difficulty: null, heat: null, point: null, kind: null };
      state.q = '';
      $('#search').value = '';
      return render();
    }
  });

  $('#drawer').addEventListener('click', (e) => {
    if (e.target.closest('[data-close-drawer]')) return closeDrawer();
    // 下面这些按钮在抽屉内部，抽屉不在 #main 里，得单独接
    const start = e.target.closest('[data-solve-start]');
    if (start) return goSolve(start.dataset.solveStart);

    const wl2 = e.target.closest('[data-wikilink]');
    if (wl2) return openWikiLink(wl2.dataset.wikilink);

    const dopen2 = e.target.closest('[data-doc-open]');
    if (dopen2) return openDoc(dopen2.dataset.docOpen);

    const topup = e.target.closest('[data-topup]');
    if (topup) return topUpCheckins(topup.dataset.topup);

    // 题库详情里那个删除 —— 按钮在抽屉里，抽屉不在 #main 中，得单独接
    const delQ = e.target.closest('[data-del-question]');
    if (delQ) return confirmDelete('question', delQ.dataset.delQuestion, delQ.dataset.delKey);

    const c = e.target.closest('[data-checkin]');
    if (c) return doCheckin(c.dataset.id, c.dataset.checkin, c);
    const u = e.target.closest('[data-undo]');
    if (u) return doUndo(u.dataset.id, Number(u.dataset.undo), u.dataset.result);
    const rm = e.target.closest('[data-rm-point]');
    if (rm) {
      const list = document.getElementById('pointsList');
      const current = [...list.querySelectorAll('.point-chip')]
        .map((n) => n.firstChild.textContent.trim())
        .filter((x) => x !== rm.dataset.rmPoint);
      return doSetPoints(list.dataset.id, current);
    }
    const g = e.target.closest('.gauge-edit button');
    if (g) {
      const wrap = g.closest('.gauge-edit');
      const idx = [...wrap.querySelectorAll('button')].indexOf(g) + 1;
      return doSetGauge(wrap.dataset.id, wrap.dataset.gauge, idx);
    }
  });

  // 首次错因下拉
  $('#drawer').addEventListener('change', (e) => {
    const sel = e.target.closest('[data-reason-select]');
    if (sel) doSetReason(sel.dataset.reasonSelect, sel.value);
  });

  // 考点输入框：回车添加
  $('#drawer').addEventListener('keydown', (e) => {
    if (e.target.id !== 'pointInput' || e.key !== 'Enter') return;
    e.preventDefault();
    const val = e.target.value.trim();
    if (!val) return;
    const list = document.getElementById('pointsList');
    const current = [...list.querySelectorAll('.point-chip')].map((n) => n.firstChild.textContent.trim());
    if (current.includes(val)) return toast('这个考点已经有了', 'err');
    return doSetPoints(list.dataset.id, [...current, val]);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.pickerOpen) return closePicker();
    if (e.key === 'Escape' && !$('#drawer').hidden) return closeDrawer();
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;

    // 全屏做题模式
    // 快捷键在「错题」和「好题」两本书里都要能用
    if (BOOK_OF[state.module] && state.sub === 'solve' && !typing) {
      if (e.key === ' ') {
        e.preventDefault();
        if (!state.solve.revealed) {
          state.solve.revealed = true;
          render();
        }
        return;
      }
      if (['1', '2', '3'].includes(e.key) && state.solve.revealed && !state.solve.pendingResult) {
        e.preventDefault();
        const r = RESULTS[Number(e.key) - 1].key;
        if (r === '完美') return doSolveCheckin('完美', null);
        state.solve.pendingResult = r;
        return render();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        return go({ module: state.book, sub: 'library' });
      }
      return;
    }

    if (BOOK_OF[state.module] && state.sub === 'drill' && state.review.phase === 'run' && !typing) {
      const r = state.review;
      if (e.key === ' ') { e.preventDefault(); return revealReview(); }
      if (['1', '2', '3'].includes(e.key)) {
        e.preventDefault();
        if (r.revealed) return requestReviewRecord(RESULTS[Number(e.key) - 1].key);
        return;
      }
      if (e.key === 's' || e.key === 'S') { e.preventDefault(); return skipReview(); }
      if (e.key === 'Escape') { e.preventDefault(); return exitReview(); }
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      $('#search').focus();
    }
  });
}

/* ============================================================
   动作
   ============================================================ */
function goSolve(id) {
  closeDrawer();
  // 题目属于哪一本，URL 就用哪一本（题库「全部（共通）」里可能点到另一本的题）
  const p = state.data?.problems.find((x) => x.id === id);
  const book = p ? p.kind || 'mistakes' : state.book;
  const h = buildHash({ module: book, sub: 'solve', solveId: id });
  if (location.hash === h) applyHash();
  else location.hash = h;
}

/** 续上空白打卡位置（次数不封顶） */
async function topUpCheckins(id) {
  try {
    const out = await api('/api/checkin-slots', { method: 'POST', body: JSON.stringify({ id }) });
    await reload({ silent: true });
    toast(
      out.added > 0
        ? `已续上 ${out.added} 次空白打卡位置（笔记里那张 \`- [ ] 第 N 次\` 列表）`
        : '还够勾，不用续 —— 这个按钮只在笔记里的打卡位置勾完了才有用',
      'ok'
    );
  } catch (err) {
    toast(`续不上：${err.message}`, 'err');
  }
}

/** 保存「首次错因」 */
async function doSetReason(id, reason) {
  try {
    await api('/api/reason', { method: 'POST', body: JSON.stringify({ id, reason }) });
    await reload({ silent: true });
    toast(reason ? `首次错因已记为「${reason}」` : '已清除首次错因');
  } catch (err) {
    toast(`保存错因失败：${err.message}`, 'err');
  }
}

async function doCheckin(id, result, btn) {
  if (btn) btn.disabled = true;
  try {
    // 详情页从打开到点打卡的时长，作为这次做题用时
    const seconds = state.drawerOpenedAt ? Math.round((Date.now() - state.drawerOpenedAt) / 1000) : null;
    await api('/api/checkin', {
      method: 'POST',
      body: JSON.stringify({ id, result, seconds: seconds && seconds > 3 ? seconds : null }),
    });
    state.drawerOpenedAt = Date.now(); // 记完重新计时，方便再练一次
    await reload({ silent: true });
    toast(`已打卡：${result}${seconds > 3 ? `（用时 ${fmtSec(seconds)}）` : ''}`, result === '完美' ? 'ok' : '');
  } catch (err) {
    toast(`打卡失败：${err.message}`, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/** 保存考点标签 */
async function doSetPoints(id, points) {
  try {
    await api('/api/points', { method: 'POST', body: JSON.stringify({ id, points }) });
    await reload({ silent: true });
    toast(points.length ? `考点已更新（${points.length} 个）` : '考点已清空');
  } catch (err) {
    toast(`保存考点失败：${err.message}`, 'err');
  }
}

async function doUndo(id, attempt, result) {
  try {
    await api('/api/undo', { method: 'POST', body: JSON.stringify({ id, attempt, result }) });
    await reload({ silent: true });
    toast('已撤销该条打卡');
  } catch (err) {
    toast(`撤销失败：${err.message}`, 'err');
  }
}

async function doSetGauge(id, field, value) {
  try {
    const body = { id };
    body[field] = value;
    await api('/api/question', { method: 'PATCH', body: JSON.stringify(body) });
    await reload({ silent: true });
    toast(field === 'heat' ? `热度已改为 ${value}` : `难度已改为 ${value}`);
  } catch (err) {
    toast(`修改失败：${err.message}`, 'err');
  }
}

/* ============================================================
   启动
   ============================================================ */
(async function boot() {
  initMath();
  document.documentElement.dataset.theme = localStorage.getItem('notebook-theme') || 'dark';
  loadTimers(); // 试卷计时器：刷新页面后接着算，不把这一份的用时清零
  bindEvents();
  // AI 状态全局读一次：好几个页面（增题 / 今日 / 单词 / 测试）都要靠它决定显示哪个按钮。
  // 只在某一页读的话，别的页面会一直以为「没配 AI」—— 增题页就是这么被漏掉的。
  loadAI().then(() => render());
  try {
    await reload();
    applyHash();
  } catch {
    /* 错误界面已在 reload 里渲染 */
  }
})();
