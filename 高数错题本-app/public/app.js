import { mdToHtml, plainText, initMath } from './markdown.js';

/* ============================================================
   状态
   ============================================================ */
const state = {
  view: 'dashboard',
  data: null,
  q: '',
  filters: { chapter: null, status: null, difficulty: null, heat: null },
  openId: null,
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
  },
};

const PALETTE = ['#6d8cff', '#3fb950', '#e3b341', '#f85149', '#a371f7', '#39c5cf', '#ff8c42'];

const STATUS_META = {
  完成: { cls: 'badge-done', text: '✅ 复习完成', cls2: 's-done' },
  进行中: { cls: 'badge-start', text: '⏳ 待复习·做过', cls2: 's-start' },
  未做: { cls: 'badge-none', text: '⏳ 待复习·未做', cls2: 's-none' },
};

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

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 320);
  }, 2400);
}

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ============================================================
   图表（手写 SVG，无第三方图表库）
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
      <span>${esc(row.key)}</span>
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
    .join('')}</div>`;
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
    .map((p, i) =>
      trend[i].total
        ? `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.2" fill="var(--accent)"></circle>`
        : ''
    )
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
  <div class="spark-legend">
    <span>近 30 天</span>
    <span>峰值 ${max} 次/天</span>
    <span>累计 ${trend.reduce((s, d) => s + d.total, 0)} 次</span>
  </div>`;
}

/* ============================================================
   总览
   ============================================================ */
function renderDashboard() {
  const { stats } = state.data;
  const t = stats.totals;

  const cards = `
  <div class="stat-grid">
    <div class="stat-card">
      <div class="stat-label">题目总数</div>
      <div class="stat-value">${t.total}</div>
      <div class="stat-foot">覆盖 <b>${state.data.chapters.length}</b> 个章节 · <b>${stats.byType.length}</b> 种题型</div>
    </div>
    <div class="stat-card is-done">
      <div class="stat-label">✅ 复习完成</div>
      <div class="stat-value">${t.done}</div>
      <div class="stat-foot">完成率 <b>${t.completionRate}%</b></div>
      <div class="progress"><i style="width:${t.completionRate}%"></i></div>
    </div>
    <div class="stat-card is-pending">
      <div class="stat-label">⏳ 待复习</div>
      <div class="stat-value">${t.pending}</div>
      <div class="stat-foot">做过但没完美 <b>${t.started}</b> · 一次没做 <b>${t.untouched}</b></div>
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

  const charts = `
  <div class="chart-grid">
    <section class="panel">
      <div class="panel-head"><h3>章节分布</h3><span class="hint">按大章节</span></div>
      <div class="panel-body"><div class="donut-wrap">${donutChart(stats.byChapter)}${legend(stats.byChapter)}</div></div>
    </section>
    <section class="panel">
      <div class="panel-head"><h3>数一热度分布</h3><span class="hint">🔥 越多越该优先</span></div>
      <div class="panel-body">${barRows(
        [...stats.byHeat].reverse(),
        (k) => fires(k),
        () => 'linear-gradient(90deg,#ff8c42,#f85149)'
      )}</div>
    </section>
    <section class="panel">
      <div class="panel-head"><h3>难度分布</h3><span class="hint">⭐ 越多越难</span></div>
      <div class="panel-body">${barRows(
        [...stats.byDifficulty].reverse(),
        (k) => stars(k),
        () => 'linear-gradient(90deg,#6d8cff,#a371f7)'
      )}</div>
    </section>
    <section class="panel">
      <div class="panel-head"><h3>近 30 天打卡</h3><span class="hint">每天完成了多少次</span></div>
      <div class="panel-body">${sparkline(stats.trend)}</div>
    </section>
  </div>`;

  const pendingTable = `
  <section class="panel" style="margin-top:14px">
    <div class="panel-head">
      <h3>待复习 · 按优先级排序</h3>
      <span class="hint">热度权重最高，失败过的会加权往前排</span>
    </div>
    <div class="table-wrap"><table class="data">
      <thead><tr>
        <th>题目</th><th>章节</th><th>类型</th><th>难度</th><th>热度</th>
        <th>完美</th><th>普通</th><th>失败</th><th>状态</th><th>最近一次</th>
      </tr></thead>
      <tbody>
        ${
          stats.pending.length
            ? stats.pending
                .map(
                  (p) => `<tr data-open="${esc(p.id)}">
          <td><b>${esc(p.num)}</b></td>
          <td>${esc(p.chapter)}</td>
          <td><span class="badge badge-type">${esc(p.type)}</span></td>
          <td>${stars(p.difficulty)}</td>
          <td>${fires(p.heat)}</td>
          <td class="num-cell">${p.stats.perfect}</td>
          <td class="num-cell">${p.stats.normal}</td>
          <td class="num-cell">${p.stats.fail}</td>
          <td><span class="badge ${STATUS_META[p.stats.status].cls}">${STATUS_META[p.stats.status].text}</span></td>
          <td style="color:var(--text-3)">${p.stats.last ? `${esc(p.stats.last.result)} ${esc(p.stats.last.date || '')}` : '—'}</td>
        </tr>`
                )
                .join('')
            : `<tr><td colspan="10" class="empty-row">全部完成 🎉</td></tr>`
        }
      </tbody>
    </table></div>
  </section>`;

  const troubledTable = stats.troubled.length
    ? `<section class="panel" style="margin-top:14px">
      <div class="panel-head"><h3>⚠️ 失败过的题</h3><span class="hint">这些最该重做</span></div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>题目</th><th>章节</th><th>失败次数</th><th>难度</th><th>热度</th><th>状态</th></tr></thead>
        <tbody>${stats.troubled
          .map(
            (p) => `<tr data-open="${esc(p.id)}">
          <td><b>${esc(p.num)}</b></td>
          <td>${esc(p.chapter)}</td>
          <td class="num-cell" style="color:var(--fail);font-weight:650">${p.stats.fail}</td>
          <td>${stars(p.difficulty)}</td>
          <td>${fires(p.heat)}</td>
          <td><span class="badge ${STATUS_META[p.stats.status].cls}">${STATUS_META[p.stats.status].text}</span></td>
        </tr>`
          )
          .join('')}</tbody>
      </table></div>
    </section>`
    : '';

  return cards + charts + pendingTable + troubledTable;
}

/* ============================================================
   题库
   ============================================================ */
function filteredProblems() {
  const q = state.q.trim().toLowerCase();
  const f = state.filters;
  return state.data.problems.filter((p) => {
    if (f.chapter && p.chapter !== f.chapter) return false;
    if (f.status && p.stats.status !== f.status) return false;
    if (f.difficulty && p.difficulty !== f.difficulty) return false;
    if (f.heat && p.heat !== f.heat) return false;
    if (q && !p.searchText.toLowerCase().includes(q)) return false;
    return true;
  });
}

function filterChips(label, options, key) {
  return `<div class="filter-group">
    <h4>${label}</h4>
    <div class="filter-list">
      ${options
        .map(
          ({ value, text, count }) => `<button class="chip ${state.filters[key] === value ? 'is-on' : ''}"
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
  const { stats, chapters, problems } = state.data;
  const countIn = (pred) => problems.filter(pred).length;

  const sidebar = `
  <aside class="sidebar">
    ${filterChips('章节', [
      { value: null, text: '全部', count: problems.length },
      ...chapters.map((c) => ({ value: c, text: c, count: countIn((p) => p.chapter === c) })),
    ], 'chapter')}
    ${filterChips('复习状态', [
      { value: null, text: '全部' },
      { value: '完成', text: '✅ 已完成', count: countIn((p) => p.stats.status === '完成') },
      { value: '进行中', text: '⏳ 做过', count: countIn((p) => p.stats.status === '进行中') },
      { value: '未做', text: '⭕ 未做', count: countIn((p) => p.stats.status === '未做') },
    ], 'status')}
    ${filterChips('难度', [
      { value: null, text: '全部' },
      ...[5, 4, 3, 2, 1].map((n) => ({ value: n, text: stars(n), count: countIn((p) => p.difficulty === n) })),
    ], 'difficulty')}
    ${filterChips('数一热度', [
      { value: null, text: '全部' },
      ...[5, 4, 3, 2, 1].map((n) => ({ value: n, text: fires(n), count: countIn((p) => p.heat === n) })),
    ], 'heat')}
    <div class="sidebar-foot">
      共 <b>${problems.length}</b> 题，筛出 <b>${list.length}</b> 题
      ${Object.values(state.filters).some((v) => v !== null) || state.q ? '<br><button class="link-btn" id="resetFilters">清除全部筛选</button>' : ''}
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
   详情抽屉
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
    .map(
      (n) =>
        `<button class="${n <= value ? 'on' : ''}" title="点为 ${n} 分">${n <= value ? on : '☆'}</button>`
    )
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
      <div class="drawer-expr">${mdToHtml('$' + p.expr + '$')}</div>
    </div>
    <button class="drawer-close" data-close-drawer title="关闭">✕</button>
  </div>

  <div class="drawer-body">
    ${warn}

    <div class="meta-row">
      <span class="meta-item">章节 <b>${esc(p.chapter)}</b></span>
      <span class="meta-item">难度 ${gaugeEditor(p.id, 'difficulty', p.difficulty)}</span>
      <span class="meta-item">数一热度 ${gaugeEditor(p.id, 'heat', p.heat)}</span>
      <span class="meta-item">累计打卡 <b>${p.stats.total}</b> 次</span>
    </div>

    <section class="checkin-panel">
      <h4>📌 打卡　<span style="font-weight:400;color:var(--text-3)">做完一次，点一个结果</span></h4>
      <div class="checkin-actions">
        ${RESULTS.map(
          (r) =>
            `<button class="checkin-btn ${r.cls}" data-checkin="${r.key}" data-id="${esc(p.id)}">
              <span>${r.icon} ${r.key}</span><small>${r.hint}</small>
            </button>`
        ).join('')}
      </div>
      <div style="margin-top:14px;color:var(--text-3);font-size:12.5px">
        目前：完美 <b style="color:var(--done)">${p.stats.perfect}</b> ·
        普通 <b style="color:var(--warn)">${p.stats.normal}</b> ·
        失败 <b style="color:var(--fail)">${p.stats.fail}</b>
        （勾到「完美」即为复习完成）
      </div>
      ${timeline}
    </section>

    <div class="stem-box">${mdToHtml(p.stem)}</div>

    ${foldBlock('fold-keypoints', '🔎', '核心考点与主要难点', '折叠', mdToHtml(p.keypoints))}
    ${foldBlock('fold-answer', '✅', '答案', '点击展开', mdToHtml(p.answer))}
    ${foldBlock('fold-solution', '📝', '解析', '点击展开', mdToHtml(p.solution))}
    ${
      p.pitfalls
        ? foldBlock('fold-pitfalls', '⚠️', '易错提醒', '点击展开', mdToHtml(p.pitfalls))
        : ''
    }

    <div style="color:var(--text-3);font-size:12px;border-top:1px solid var(--border-soft);padding-top:12px">
      源文件：${esc(p.relPath)}
    </div>
  </div>`;
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

function closeDrawer() {
  const drawer = $('#drawer');
  drawer.hidden = true;
  drawer.setAttribute('aria-hidden', 'true');
  state.openId = null;
  document.body.style.overflow = '';
}

function refreshDrawer() {
  if (state.openId && !$('#drawer').hidden) {
    const scrollTop = $('#drawerPanel').scrollTop;
    $('#drawerPanel').innerHTML = renderDrawer(state.openId);
    $('#drawerPanel').scrollTop = scrollTop;
  }
}

/* ============================================================
   动作
   ============================================================ */
async function doCheckin(id, result, btn) {
  btn && (btn.disabled = true);
  try {
    await api('/api/checkin', { method: 'POST', body: JSON.stringify({ id, result }) });
    await load({ silent: true });
    refreshDrawer();
    toast(`已打卡：${result}`, result === '完美' ? 'ok' : '');
  } catch (err) {
    toast(`打卡失败：${err.message}`, 'err');
  } finally {
    btn && (btn.disabled = false);
  }
}

async function doUndo(id, attempt, result) {
  try {
    await api('/api/undo', { method: 'POST', body: JSON.stringify({ id, attempt, result }) });
    await load({ silent: true });
    refreshDrawer();
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
    await load({ silent: true });
    refreshDrawer();
    toast(field === 'heat' ? `热度已改为 ${value}` : `难度已改为 ${value}`);
  } catch (err) {
    toast(`修改失败：${err.message}`, 'err');
  }
}

/* ============================================================
   复习模式
   ============================================================ */
const REVIEW_SCOPES = [
  { key: 'pending', label: '只抽待复习', hint: '还没做到「完美」的题' },
  { key: 'troubled', label: '只抽失败过', hint: '错得最狠的那几道' },
  { key: 'all', label: '全部题目', hint: '完整过一遍' },
  { key: 'done', label: '只抽已完成', hint: '巩固保温' },
];

const REVIEW_ORDERS = [
  { key: 'priority', label: '按优先级', hint: '热度高、失败过的排前面' },
  { key: 'heat', label: '最热优先', hint: '按数一热度从高到低' },
  { key: 'random', label: '纯随机', hint: '打乱顺序，防惯性记忆' },
];

const REVIEW_COUNTS = [5, 10, 20, 'all'];

const mmss = (ms) => {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
};

function scopeMatch(p, scope) {
  if (scope === 'pending') return p.stats.status !== '完成';
  if (scope === 'troubled') return p.stats.fail > 0;
  if (scope === 'done') return p.stats.status === '完成';
  return true;
}

function buildQueue() {
  const { chapters, scope, order, count } = state.review.options;
  let pool = state.data.problems.filter(
    (p) => scopeMatch(p, scope) && (!chapters.length || chapters.includes(p.chapter))
  );

  if (order === 'heat') {
    pool.sort((a, b) => b.heat - a.heat || b.difficulty - a.difficulty || a.num.localeCompare(b.num, 'zh'));
  } else if (order === 'priority') {
    // 优先级 + 轻微抖动，避免每次顺序完全一样
    pool = pool
      .map((p) => ({ p, key: priorityOf(p) * (0.8 + Math.random() * 0.4) }))
      .sort((a, b) => b.key - a.key)
      .map((x) => x.p);
  } else {
    pool = pool.map((p) => ({ p, key: Math.random() })).sort((a, b) => a.key - b.key).map((x) => x.p);
  }

  if (count !== 'all') pool = pool.slice(0, Number(count));
  return pool.map((p) => p.id);
}

function priorityOf(p) {
  return p.heat * 2 + p.difficulty - p.stats.total * 0.5 + (p.stats.fail > 0 ? 1.5 : 0);
}

function renderReviewSetup() {
  const r = state.review;
  const problems = state.data.problems;
  const poolCount = problems.filter((p) => scopeMatch(p, r.options.scope)).length;

  const chapterChips = [
    `<button class="chip ${r.options.chapters.length === 0 ? 'is-on' : ''}" data-rv-chapter="">全部章节</button>`,
    ...state.data.chapters.map(
      (c) =>
        `<button class="chip ${r.options.chapters.includes(c) ? 'is-on' : ''}" data-rv-chapter="${esc(c)}">${esc(c)}
          <span class="cnt">${problems.filter((p) => p.chapter === c).length}</span></button>`
    ),
  ].join('');

  return `<div class="rv-setup">
    <div class="rv-setup-head">
      <h2>开始一局复习</h2>
      <p>按热度加权抽题，一题一屏。键盘：<span class="kbd">空格</span> 看答案 · <span class="kbd">1</span><span class="kbd">2</span><span class="kbd">3</span> 记结果 · <span class="kbd">S</span> 跳过 · <span class="kbd">Esc</span> 退出</p>
    </div>

    <div class="rv-options">
      <div class="filter-group">
        <h4>复习范围</h4>
        <div class="filter-list">${chapterChips}</div>
      </div>

      <div class="filter-group">
        <h4>抽哪些题</h4>
        <div class="filter-list">
          ${REVIEW_SCOPES.map(
            (s) => `<button class="chip ${r.options.scope === s.key ? 'is-on' : ''}" data-rv-scope="${s.key}">
              ${s.label}<span class="cnt">${problems.filter((p) => scopeMatch(p, s.key)).length}</span></button>`
          ).join('')}
        </div>
        <div class="rv-hint">${esc(REVIEW_SCOPES.find((s) => s.key === r.options.scope)?.hint || '')}</div>
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
            (c) =>
              `<button class="chip ${r.options.count === c ? 'is-on' : ''}" data-rv-count="${c}">${
                c === 'all' ? '全部' : `${c} 题`
              }</button>`
          ).join('')}
        </div>
      </div>
    </div>

    <div class="rv-start-row">
      <button class="btn-primary" data-review="start" ${poolCount === 0 ? 'disabled' : ''}>
        ▶ 开始复习　<span class="rv-pool">可选 ${poolCount} 题</span>
      </button>
      ${poolCount === 0 ? '<span class="rv-hint" style="color:var(--warn)">当前筛选条件下没有题目</span>' : ''}
    </div>
  </div>`;
}

function currentReviewProblem() {
  const id = state.review.queue[state.review.index];
  return state.data.problems.find((p) => p.id === id) || null;
}

function renderReviewSession() {
  const r = state.review;
  const p = currentReviewProblem();
  if (!p) return renderReviewDone();

  const total = r.queue.length;
  const pos = r.index + 1;
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

  const actions = r.revealed
    ? `<div class="rv-record">
        <span class="rv-record-label">这次做得怎么样？</span>
        ${RESULTS.map(
          (res, i) =>
            `<button class="checkin-btn ${res.cls}" data-review="record" data-result="${res.key}">
              <span>${res.icon} ${res.key}　<span class="kbd">${i + 1}</span></span><small>${res.hint}</small>
            </button>`
        ).join('')}
      </div>`
    : `<div class="rv-record">
        <button class="checkin-btn r-skip" data-review="skip"><span>跳过这题　<span class="kbd">S</span></span><small>不计入打卡</small></button>
      </div>`;

  return `<div class="review">
    <div class="rv-bar">
      <div class="rv-progress"><i style="width:${(r.index / total) * 100}%"></i></div>
      <span class="rv-count">第 <b>${pos}</b> / ${total} 题</span>
      <span class="rv-timer" id="reviewTimer">${mmss(Date.now() - r.startedAt)}</span>
      <button class="rv-exit" data-review="exit">退出复习</button>
    </div>

    <article class="rv-card">
      <div class="rv-head">
        <span class="rv-num">${esc(p.num)}</span>
        <span class="badge badge-type">${esc(p.type)}</span>
        ${stars(p.difficulty)}${fires(p.heat)}
        <span class="badge ${meta.cls}">${meta.text}</span>
      </div>
      <div class="rv-stem">${mdToHtml(p.stem)}</div>
      ${revealed}
    </article>

    ${actions}
  </div>`;
}

function renderReviewDone() {
  const r = state.review;
  const perfect = r.results.filter((x) => x.result === '完美').length;
  const normal = r.results.filter((x) => x.result === '普通').length;
  const fail = r.results.filter((x) => x.result === '失败').length;
  const skipped = r.results.filter((x) => x.result === '跳过').length;
  const used = Date.now() - r.startedAt;

  const card = (label, value, cls) =>
    `<div class="stat-card ${cls}"><div class="stat-label">${label}</div><div class="stat-value">${value}</div></div>`;

  return `<div class="rv-setup">
    <div class="rv-setup-head">
      <h2>本局结束 🎉</h2>
      <p>用时 ${mmss(used)}，平均每题 ${r.results.length ? mmss(used / r.results.length) : '—'}</p>
    </div>

    <div class="stat-grid">
      ${card('✅ 完美', perfect, 'is-done')}
      ${card('🟡 普通', normal, 'is-pending')}
      ${card('❌ 失败', fail, 'is-streak')}
      ${card('⏭ 跳过', skipped, '')}
    </div>

    <section class="panel" style="margin-top:14px">
      <div class="panel-head"><h3>逐题结果</h3><span class="hint">点击可回看这一题</span></div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>题目</th><th>章节</th><th>难度</th><th>热度</th><th>结果</th><th>用时</th></tr></thead>
        <tbody>${r.results
          .map(
            (x) => `<tr data-open="${esc(x.id)}">
            <td><b>${esc(x.num)}</b></td>
            <td>${esc(x.chapter)}</td>
            <td>${stars(x.difficulty)}</td>
            <td>${fires(x.heat)}</td>
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
  if (!state.data) return '';
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
  if (!r.queue.length) {
    toast('没有符合条件的题目', 'err');
    return;
  }
  r.phase = 'run';
  r.index = 0;
  r.revealed = false;
  r.results = [];
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

async function recordReview(result) {
  const r = state.review;
  if (r.phase !== 'run' || !r.revealed) return;
  const p = currentReviewProblem();
  if (!p) return;

  r.results.push({
    id: p.id,
    num: p.num,
    chapter: p.chapter,
    difficulty: p.difficulty,
    heat: p.heat,
    result,
    ms: Date.now() - r.questionAt,
  });

  // 先本地推进，保证刷题节奏不卡；写盘在后台进行
  advanceReview();

  try {
    await api('/api/checkin', { method: 'POST', body: JSON.stringify({ id: p.id, result }) });
    toast(`${p.num} → ${result}`, result === '完美' ? 'ok' : '');
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
      id: p.id,
      num: p.num,
      chapter: p.chapter,
      difficulty: p.difficulty,
      heat: p.heat,
      result: '跳过',
      ms: Date.now() - r.questionAt,
    });
  }
  advanceReview();
}

function advanceReview() {
  const r = state.review;
  r.index += 1;
  r.revealed = false;
  r.questionAt = Date.now();
  if (r.index >= r.queue.length) {
    stopReviewTimer();
    r.phase = 'done';
    render();
    load({ silent: true }).catch(() => {});
  } else {
    render();
  }
  window.scrollTo({ top: 0 });
}

function exitReview() {
  const r = state.review;
  stopReviewTimer();
  r.phase = 'setup';
  r.queue = [];
  r.index = 0;
  r.revealed = false;
  render();
  load({ silent: true }).catch(() => {});
}

/* ============================================================
   渲染 & 事件
   ============================================================ */
function render() {
  if (!state.data) return;
  const main = $('#main');
  main.innerHTML =
    state.view === 'dashboard'
      ? renderDashboard()
      : state.view === 'library'
        ? renderLibrary()
        : renderReview();
  $('#brandSub').textContent = `${state.data.problems.length} 题 · ${state.data.chapters.join(' / ')}`;
  for (const btn of document.querySelectorAll('.tab')) {
    btn.classList.toggle('is-active', btn.dataset.view === state.view);
  }
}

async function load({ silent = false } = {}) {
  try {
    const data = await api('/api/questions');
    state.data = data;
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

function go(view) {
  const target = `#${view}`;
  if (location.hash !== target) location.hash = target;
  else applyHash();
}

function applyHash() {
  const h = location.hash.replace(/^#/, '');
  const view = ['dashboard', 'library', 'review'].includes(h) ? h : 'dashboard';
  const changed = view !== state.view;
  state.view = view;
  if (state.data) render();
  if (view === 'review' && state.review.phase === 'run') startReviewTimer();
  else if (view !== 'review') stopReviewTimer();
  return changed;
}

function handleReviewClick(btn) {
  const action = btn.dataset.review;
  if (action === 'start' || action === 'again') return startReview();
  if (action === 'reveal') return revealReview();
  if (action === 'record') return recordReview(btn.dataset.result);
  if (action === 'skip') return skipReview();
  if (action === 'exit') return exitReview();
  if (action === 'back') {
    state.view = 'dashboard';
    state.review.phase = 'setup';
    return render();
  }
}

function bindEvents() {
  $('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    go(btn.dataset.view);
  });

  window.addEventListener('hashchange', applyHash);

  $('#search').addEventListener('input', (e) => {
    state.q = e.target.value;
    if (state.q && state.view !== 'library') go('library');
    else render();
  });

  $('#btnRefresh').addEventListener('click', async () => {
    await load({ silent: true });
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
    // 复习模式的按钮与选项
    const rvBtn = e.target.closest('[data-review]');
    if (rvBtn && !rvBtn.disabled) return handleReviewClick(rvBtn);

    const opt = e.target.closest('[data-rv-chapter],[data-rv-scope],[data-rv-order],[data-rv-count]');
    if (opt) {
      const o = state.review.options;
      if (opt.dataset.rvChapter !== undefined) {
        const c = opt.dataset.rvChapter;
        if (!c) o.chapters = [];
        else if (o.chapters.includes(c)) o.chapters = o.chapters.filter((x) => x !== c);
        else o.chapters = [...o.chapters, c];
      }
      if (opt.dataset.rvScope) o.scope = opt.dataset.rvScope;
      if (opt.dataset.rvOrder) o.order = opt.dataset.rvOrder;
      if (opt.dataset.rvCount) o.count = opt.dataset.rvCount === 'all' ? 'all' : Number(opt.dataset.rvCount);
      return render();
    }

    const open = e.target.closest('[data-open]');
    if (open) return openDrawer(open.dataset.open);

    const chip = e.target.closest('[data-filter]');
    if (chip) {
      const key = chip.dataset.filter;
      const raw = chip.dataset.value;
      let val = raw === '' ? null : raw;
      if (key === 'difficulty' || key === 'heat') val = val === null ? null : Number(val);
      state.filters[key] = state.filters[key] === val ? null : val;
      return render();
    }

    if (e.target.closest('#resetFilters')) {
      state.filters = { chapter: null, status: null, difficulty: null, heat: null };
      state.q = '';
      $('#search').value = '';
      return render();
    }
  });

  $('#drawer').addEventListener('click', (e) => {
    if (e.target.closest('[data-close-drawer]')) return closeDrawer();

    const checkBtn = e.target.closest('[data-checkin]');
    if (checkBtn) return doCheckin(checkBtn.dataset.id, checkBtn.dataset.checkin, checkBtn);

    const undoBtn = e.target.closest('[data-undo]');
    if (undoBtn) return doUndo(undoBtn.dataset.id, Number(undoBtn.dataset.undo), undoBtn.dataset.result);

    const gaugeBtn = e.target.closest('.gauge-edit button');
    if (gaugeBtn) {
      const wrap = gaugeBtn.closest('.gauge-edit');
      const field = wrap.dataset.gauge;
      const idx = [...wrap.querySelectorAll('button')].indexOf(gaugeBtn) + 1;
      return doSetGauge(wrap.dataset.id, field, idx);
    }
  });

  document.addEventListener('keydown', (e) => {
    // 抽屉打开时，Esc 先关抽屉
    if (e.key === 'Escape' && !$('#drawer').hidden) {
      closeDrawer();
      return;
    }

    // 正在输入框里打字时，不抢快捷键
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;

    // 复习模式快捷键
    if (state.view === 'review' && state.review.phase === 'run' && !typing) {
      const r = state.review;
      if (e.key === ' ') {
        e.preventDefault();
        return revealReview();
      }
      if (['1', '2', '3'].includes(e.key)) {
        e.preventDefault();
        if (r.revealed) return recordReview(RESULTS[Number(e.key) - 1].key);
        return;
      }
      if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        return skipReview();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        return exitReview();
      }
      return;
    }

    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      $('#search').focus();
    }
  });
}

/* ============================================================
   启动
   ============================================================ */
(async function boot() {
  initMath();
  document.documentElement.dataset.theme = localStorage.getItem('notebook-theme') || 'dark';
  state.view = 'dashboard';
  bindEvents();
  try {
    await load();
    applyHash();
  } catch {
    /* 错误界面已在 load 里渲染 */
  }
})();
