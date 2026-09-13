import { mdToHtml, plainText, initMath } from './markdown.js';

/* ============================================================
   状态
   ============================================================ */
const state = {
  module: 'today',
  book: 'mistakes',
  patterns: null,
  openPattern: null,
  doc: null,
  docRaw: false,
  sub: 'dashboard',
  view: 'dashboard',
  scope: { category: null, subject: null, chapter: null },
  data: null, // 全量：problems / tree / taxonomy / options
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
};

const MODULES = ['today', 'mistakes', 'good', 'patterns', 'plan', 'journal', 'doc'];
const BOOK_OF = { mistakes: 'mistakes', good: 'good' };
const SUBVIEWS = ['dashboard', 'library', 'drill', 'add', 'solve'];
const MODULE_LABEL = { today: '今日', mistakes: '错题', good: '好题', patterns: '题型', plan: '计划', journal: '复盘' };

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
function statCards(stats, extra = []) {
  const t = stats.totals;
  return `<div class="stat-grid">
    <div class="stat-card">
      <div class="stat-label">题目总数</div>
      <div class="stat-value">${t.total}</div>
      <div class="stat-foot">${extra[0] || ''}</div>
    </div>
    <div class="stat-card is-done">
      <div class="stat-label">✅ 已复习</div>
      <div class="stat-value">${t.done}</div>
      <div class="stat-foot">做过的题都排进了遗忘曲线 · <b>${t.completionRate}%</b></div>
      <div class="progress"><i style="width:${t.completionRate}%"></i></div>
    </div>
    <div class="stat-card is-pending">
      <div class="stat-label">⏳ 待复习</div>
      <div class="stat-value">${t.pending}</div>
      <div class="stat-foot">到日子了 <b>${t.due}</b> · 一次没做 <b>${t.untouched}</b></div>
    </div>
    <div class="stat-card is-streak">
      <div class="stat-label">累计打卡</div>
      <div class="stat-value">${t.checkins}<span style="font-size:15px;font-weight:500;color:var(--text-3)"> 次</span></div>
      <div class="stat-foot">完美 <b>${t.byResult['完美']}</b> · 普通 <b>${t.byResult['普通']}</b> · 失败 <b>${t.byResult['失败']}</b></div>
    </div>
    <div class="stat-card">
      <div class="stat-label">🔥 连续打卡</div>
      <div class="stat-value">${t.streak}<span style="font-size:15px;font-weight:500;color:var(--text-3)"> 天</span></div>
      <div class="stat-foot">有打卡记录的天数 <b>${t.activeDays}</b> 天</div>
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
      const rate = sub.total ? Math.round((sub.done / sub.total) * 100) : 0;
      return `<article class="subject-card" data-scope="subject" data-value="${esc(sub.name)}">
      <div class="sc-head"><span class="sc-name">${esc(sub.name)}</span>
        <span class="sc-count">${sub.total}<small>题</small></span></div>
      <div class="progress"><i style="width:${rate}%"></i></div>
      <div class="sc-foot">
        <span>✅ 已复习 <b>${sub.done}</b></span>
        <span>⏳ 待复习 <b>${sub.total - sub.done}</b></span>
        <span>占比 <b>${total ? Math.round((sub.total / total) * 100) : 0}%</b></span>
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
      <div class="panel-head"><h3>⏰ 遗忘曲线提醒</h3><span class="hint">做过的题按掌握等级 1 / 2 / 4 / 7 / 15 / 30 / 60 天回到队列，这些已到点</span></div>
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
            const rate = c.total ? Math.round((c.done / c.total) * 100) : 0;
            return `<article class="category-card" data-scope="category" data-value="${esc(c.name)}">
          <div class="cc-head">
            <span class="cc-mark">${c.name === '数学' ? '📐' : c.name === '408' ? '💻' : '📚'}</span>
            <div><div class="cc-name">${esc(c.name)}</div><div class="cc-sub">${c.children.length} 个科目</div></div>
            <span class="cc-count">${c.total}<small>题</small></span>
          </div>
          <div class="progress"><i style="width:${rate}%"></i></div>
          <div class="cc-foot"><span>✅ 已复习 ${c.done}</span><span>⏳ 待复习 ${c.total - c.done}</span><span>${rate}%</span></div>
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
        <button class="btn-ghost small" data-topup="${esc(p.id)}" title="在 Obsidian 里把打卡位置勾完了，点这里再续几组">➕ 续上打卡位置</button>
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
function enterSolve(id) {
  state.solve = { id, revealed: false, startedAt: Date.now(), timerId: null, pendingResult: null };
  if (!state.data?.problems.some((x) => x.id === id)) toast('找不到这道题', 'err');
}

function closeSolve() {
  stopSolveTimer();
  state.solve.id = null;
  state.solve.revealed = false;
  state.solve.pendingResult = null;
}

function startSolveTimer() {
  stopSolveTimer();
  if (state.sub !== 'solve' || !state.solve.id) return;
  state.solve.timerId = setInterval(() => {
    const el = document.getElementById('solveTimer');
    if (!el) return stopSolveTimer();
    el.textContent = `用时 ${mmss(Date.now() - state.solve.startedAt)}`;
  }, 500);
}
function stopSolveTimer() {
  if (state.solve.timerId) {
    clearInterval(state.solve.timerId);
    state.solve.timerId = null;
  }
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
      <span class="rv-timer" id="solveTimer">用时 0:00</span>
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
    <div class="solve-foot">
      <span>已练 ${p.stats.total} 次${p.stats.last ? ` · 上次 ${esc(p.stats.last.result)}` : ''}</span>
      ${p.stats.schedule ? `<span>遗忘曲线：${esc(scheduleText(p))}</span>` : ''}
      ${p.stats.avgSec != null ? `<span>平均用时 ${fmtSec(p.stats.avgSec)}</span>` : ''}
    </div>
  </div>`;
}

async function doSolveCheckin(result, reason) {
  const p = state.data.problems.find((x) => x.id === state.solve.id);
  if (!p) return;
  const seconds = Math.round((Date.now() - state.solve.startedAt) / 1000);
  state.solve.pendingResult = null;
  try {
    await api('/api/checkin', {
      method: 'POST',
      body: JSON.stringify({
        id: p.id,
        result,
        seconds: Math.max(1, seconds),
        reason: reason || null,
      }),
    });
    state.solve.startedAt = Date.now();
    await reload({ silent: true });
    startSolveTimer();
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
      <p>程序负责机械活：认章节、定题型、编号、建骨架、写进 <b>${esc(bookName)}</b>。
        <b>答案与解析留空</b>——把下面生成的提示词发给我，我来算、来写、来复核。
        ${
          isGood
            ? '好题不写错因分析；'
            : ''
        }生成提示词时会顺手把它归进「题型本」的对应通解。</p>
    </div>

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
          <div class="dz-text">把题目截图拖到这里，或 <button class="link-btn" data-add="pick">选择文件</button></div>
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
          <button class="btn-primary small" data-add="prompt-images" ${a.uploads && a.uploads.length ? '' : 'disabled'}>📋 生成提示词（发给我转成题目）</button>
          <button class="btn-ghost small" data-add="clear-uploads" ${a.uploads && a.uploads.length ? '' : 'disabled'}>清空暂存</button>
        </div>
        <div class="rv-hint">生成的提示词里会带上图片路径${isGood ? '' : '、错因'}和完整格式规范。把提示词发给我，我读完图就把题目写进${esc(bookName)}（图我会重画，不用你的原图）。</div>
      </div>
    </section>

    ${preview}

    <div class="rv-start-row">
      <button class="btn-primary" data-add="create" ${items && items.length ? '' : 'disabled'}>✚ 生成骨架并写入${esc(bookName)}</button>
      <button class="btn-ghost" data-add="prompt" ${items && items.length ? '' : 'disabled'}>📋 复制提示词给 AI</button>
      <button class="btn-ghost" data-add="clear">清空</button>
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

async function addParse() {
  const raw = $('#addStem')?.value ?? state.add.raw;
  state.add.raw = raw;
  if (!raw.trim()) return toast('先粘贴题干', 'err');
  try {
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
  if (ok) toast(`已上传 ${ok} 张，点「生成提示词」发给我`);
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
function taskLi(task, { rel = '', occ = 0 } = {}) {
  const label = task.daily ? task.text.replace(/^🔁\s*/, '') : task.text;
  return `<li class="md-task${task.done ? ' is-done' : ''}">
    <input type="checkbox" data-task="1" data-rel="${esc(rel)}" data-text="${esc(task.text)}" data-occ="${occ}"${task.done ? ' checked' : ''} />
    ${task.daily ? '<span class="daily-tag">每日</span>' : ''}
    <span>${esc(label)}</span>
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
    state.today = await api('/api/today');
    await loadWeekly();
  } catch (err) {
    state.today = null;
    toast(`读取今日数据失败：${err.message}`, 'err');
  }
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

  const dayStrip = w?.days?.length
    ? `<div class="day-strip">${w.days
        .map(
          (d) => `<div class="day-cell${d.isToday ? ' is-today' : ''}${d.isPast ? ' is-past' : ''}">
        <span class="dc-week">${esc(d.weekday)}</span>
        <span class="dc-date">${esc(d.label)}</span>
        <span class="dc-count">${d.total ? `${d.done}/${d.total}` : '—'}</span>
        <span class="dc-bar"><i style="width:${d.total ? Math.round((d.done / d.total) * 100) : 0}%"></i></span>
      </div>`
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
      <div class="cd-actions">
        <button class="btn-primary" data-go="journal">✍️ 写今日复盘${t.review.exists ? '（已有）' : ''}</button>
        <button class="btn-ghost" data-go="mistakes">📕 去刷错题${m.due ? `（${m.due} 题到期）` : ''}</button>
      </div>
    </section>

    <div class="today-grid">
      <section class="panel">
        <div class="panel-head">
          <h3>今天的任务</h3>
          <span class="hint">${esc(t.date)} ${esc(t.weekday)}　勾选直接写回 Obsidian</span>
        </div>
        <div class="panel-body">
          ${
            todayTasks.length
              ? `<ul class="task-list">${todayTasks.map((x) => taskLi(x, { rel: w?.rel })).join('')}</ul>`
              : '<div class="rv-hint">这周的周计划里没有标今天日期的任务。</div>'
          }
          ${
            undated.length
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
        <div class="stat-label">📅 今日完成</div>
        <div class="stat-value">${t.todayTasks.filter((x) => x.done).length}<span class="unit">/${t.todayTasks.length}</span></div>
        <div class="stat-foot">今天标了日期的任务</div>
      </div>
      <div class="stat-card is-done">
        <div class="stat-label">✅ 本周完成率</div>
        <div class="stat-value">${w ? w.rate : 0}<span class="unit">%</span></div>
        <div class="stat-foot">${w ? `${w.done} / ${w.total} 项` : '—'}</div>
      </div>
      <div class="stat-card is-pending">
        <div class="stat-label">📕 错题待复习</div>
        <div class="stat-value">${m.pending ?? '—'}</div>
        <div class="stat-foot">其中 <b>${m.due ?? 0}</b> 题到遗忘曲线了</div>
      </div>
      <div class="stat-card is-streak">
        <div class="stat-label">🔥 连续打卡</div>
        <div class="stat-value">${m.streak ?? 0}<span class="unit">天</span></div>
        <div class="stat-foot">错题累计打卡 <b>${m.checkins ?? 0}</b> 次</div>
      </div>
    </div>

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

  return `<section class="panel weekly" style="margin-top:14px">
    <div class="panel-head">
      <h3>🧭 本周状态与建议</h3>
      <span class="hint">${meta}</span>
    </div>
    <div class="panel-body">
      ${
        w.summary
          ? `<div class="md-doc weekly-body">${mdToHtml(w.summary.body)}</div>
             <div class="rv-start-row">
               <button class="btn-ghost small" data-weekly-prompt="1">🔄 重新生成提示词（覆盖这节）</button>
               <span class="rv-hint">写在 <code>${esc(w.week ? w.week.rel : '')}</code> 的「🤖 本周状态与建议」一节</span>
             </div>`
          : `<div class="rv-hint" style="margin-bottom:12px">
               程序自己不下结论。点下面的按钮生成提示词，复制发给我 ——
               我会读这一周的计划完成情况、每日复盘和错题数据，写好总结与下周建议，再写回你的周计划文件。
             </div>
             <button class="btn-primary" data-weekly-prompt="1">📋 生成本周状态总结提示词</button>`
      }
    </div>
  </section>`;
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

function planGroupsHtml(plan) {
  return plan.groups
    .filter((g) => g.tasks.length)
    .map((g) => {
      const done = g.tasks.filter((x) => x.done).length;
      const items = withOcc(g.tasks);
      return `<section class="plan-group">
        <div class="pg-head">
          <span>${esc(g.name)}</span>
          <span class="pg-count">${done}/${g.tasks.length}</span>
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
      <textarea id="journalText" class="journal-edit" rows="18" placeholder="今天做了什么、卡在哪、明天怎么调整…">${esc(j.content)}</textarea>
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

async function copyWeeklyPrompt() {
  const w = state.weekly;
  if (!w || !w.prompt) return toast('还没找到本周计划', 'err');
  await copyText(w.prompt);
  toast('提示词已复制 —— 粘给我，我读完就把总结写进周计划', 'ok');
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
    await api('/api/task', { method: 'POST', body: JSON.stringify({ rel, expect: text, occurrence: occ, done }) });
    state.planDetail = null;
    state.plans = null;
    await loadToday();
    await loadPlans();
    if (state.planRel) await loadPlanDetail(state.planRel);
    render();
    toast(done ? `已勾选：${text.slice(0, 18)}…` : '已取消勾选', 'ok');
  } catch (err) {
    input.checked = !done;
    toast(`写回失败：${err.message}`, 'err');
  } finally {
    input.disabled = false;
  }
}

function render() {
  const main = $('#main');

  let body = '';
  if (state.module === 'today') body = renderToday();
  else if (state.module === 'plan') body = renderPlan();
  else if (state.module === 'journal') body = renderJournal();
  else if (state.module === 'patterns') {
    body = renderPatterns();
  } else if (state.module === 'doc') {
    body = renderDoc();
  } else {
    if (!state.data || !state.stats) {
      main.innerHTML = '<div class="loading"><div class="spinner"></div><p>正在读取错题本…</p></div>';
      return;
    }
    if (state.sub === 'dashboard') body = renderDashboard();
    else if (state.sub === 'library') body = renderLibrary();
    else if (state.sub === 'drill') body = renderReview();
    else if (state.sub === 'solve') body = renderSolve();
    else body = renderAdd();
  }

  main.innerHTML = body;

  const inMistakes = state.module === 'mistakes' || state.module === 'good';
  if (inMistakes && state.data) renderScopeButton();
  $('#scopePicker').hidden = !inMistakes || state.sub === 'add' || state.sub === 'solve';
  document.body.classList.toggle('is-solving', inMistakes && state.sub === 'solve');
  $('#mistakeSubnav').hidden = !inMistakes;
  if (state.pickerOpen && inMistakes) $('#scopeMenu').innerHTML = renderScopeMenu();

  for (const btn of document.querySelectorAll('.tab')) {
    btn.classList.toggle('is-active', btn.dataset.module === state.module);
  }
  for (const btn of document.querySelectorAll('.subtab')) {
    btn.classList.toggle('is-active', btn.dataset.sub === state.sub);
  }
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
      render();
      startSolveTimer();
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
  closeSolveTimerOnly();

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

  // 今日
  loadToday().then(() => render());
  render();
}

function closeSolveTimerOnly() {
  /* 占位：切走模块时停掉做题计时 */
  if (state.solve.timerId) {
    clearInterval(state.solve.timerId);
    state.solve.timerId = null;
  }
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
  });

  // 图片选择与拖拽
  $('#main').addEventListener('change', (e) => {
    if (e.target.id === 'journalDate') return go({ module: 'journal', date: e.target.value });
    if (e.target.id === 'fileInput' && e.target.files?.length) {
      uploadFiles(e.target.files);
      e.target.value = '';
    }
  });
  const dz = (e) => {
    const zone = e.target.closest?.('#dropZone') || document.getElementById('dropZone');
    return zone;
  };
  $('#main').addEventListener('dragover', (e) => {
    const zone = e.target.closest('#dropZone');
    if (!zone) return;
    e.preventDefault();
    zone.classList.add('is-over');
  });
  $('#main').addEventListener('dragleave', (e) => {
    const zone = e.target.closest('#dropZone');
    if (zone) zone.classList.remove('is-over');
  });
  $('#main').addEventListener('drop', (e) => {
    const zone = e.target.closest('#dropZone');
    if (!zone) return;
    e.preventDefault();
    zone.classList.remove('is-over');
    if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
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
    if (e.target.closest('[data-weekly-prompt]')) return copyWeeklyPrompt();
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
      out.added > 0 ? `已续上 ${out.added} 组打卡位置（第 4、5、6 次这样的）` : '打卡位置还够用，不用续',
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
  bindEvents();
  try {
    await reload();
    applyHash();
  } catch {
    /* 错误界面已在 reload 里渲染 */
  }
})();
