/**
 * mobile.js —— 手机做题端（/m）
 *
 * **为什么单开一页，而不是把桌面端改成响应式。**
 * 桌面端是八个页面 + 抽屉 + 键盘流的大前端（app.js 六千多行），挤进手机
 * 只会又难用又容易改坏。手机上真正要的只有一条链路：
 *
 *     看题 → 在纸上写 → 拍照传上来 → AI 按考研标准判 → 记进笔记
 *
 * 所以这里只做「今日 / 做题」两屏，界面自己写，**数据一律走同一套 /api** ——
 * 手机和电脑共用一份 Markdown，不存在第二份数据，谁写谁都能立刻看到。
 *
 * 电脑端有的这里也尽量对齐：同一套计时器语义（按卷子各记各的、存本地、刷新不丢）、
 * 同一套判分口径（总分由服务端加，不采信模型报的数）、同一套错因词表。
 */

import { mdToHtml, initMath, richInline } from './markdown.js';

initMath();

/* ============================================================
   一、常量与小工具
   ============================================================ */

/** 错因词表 —— 和 lib/grade.mjs 的 GRADE_REASONS 是同一份 */
const REASONS = ['概念不清', '方法不会', '思路方向错', '计算失误', '审题错误', '公式记错', '粗心大意', '时间不够'];

/** 打卡用的三个结果 —— 和 lib/parse.mjs 的 RESULTS 是同一份 */
const RESULTS = [
  { key: '完美', icon: '✅', hint: '独立做对、过程完整' },
  { key: '普通', icon: '🟡', hint: '做出来了但不顺' },
  { key: '失败', icon: '❌', hint: '没做出来或方法错' },
];

const VERDICT_ICON = { 正确: '✅', 部分正确: '🟡', 错误: '❌', 未作答: '⬜', 看不清: '🔍', 题号对不上: '❓' };
const STATUS_CLS = { 待复习: 's-due', 已复习: 's-done', 未做: 's-none' };

const $ = (sel, root = document) => root.querySelector(sel);

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** 秒 → 「3:12」 */
const fmtClock = (n) => (n == null ? '—' : `${Math.floor(n / 60)}:${String(Math.round(n) % 60).padStart(2, '0')}`);

/** 秒 → 「54 秒」/「4 分钟」（题旁边的参考用时） */
const fmtSpan = (sec) => {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return s < 90 ? `${s} 秒` : `${Math.round(s / 60)} 分钟`;
};

/** 分值：12 → 「12」；0.5 → 「0.5」 */
const fmtPts = (n) => {
  const v = Math.round(Number(n) * 100) / 100;
  return Number.isFinite(v) ? String(v) : '—';
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 4500 : 2400);
}

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ============================================================
   二、计时器 —— 和电脑端同一套语义

   按「一份卷子 / 一道题」各记各的，存在浏览器本地：锁屏、切出去看一眼、
   手滑刷新，回来时间还在。电脑上用过的键名这里照用，两边不会打架
   （localStorage 本来就是按设备存的）。
   ============================================================ */

const TIMER_KEY = 'study-paper-timer';
const TIMER_KEEP = 24;

const T = { timers: {}, current: null, id: null };

function loadTimers() {
  try {
    const raw = JSON.parse(localStorage.getItem(TIMER_KEY) || 'null');
    if (raw && raw.timers && typeof raw.timers === 'object') {
      T.timers = raw.timers;
      // 存的时候在跑 → 说明是刷新 / 锁屏那一刻中断的，接着往下算；
      // 但超过 3 小时说明早就不在做了，别把那几个小时算进去
      for (const t of Object.values(T.timers)) {
        if (t.running && Date.now() - (t.startedAt || 0) > 3 * 3600 * 1000) {
          t.accumulated = (t.accumulated || 0) + 3 * 3600 * 1000;
          t.running = false;
          t.startedAt = 0;
        }
      }
    }
  } catch {
    /* 存坏了就当没有 */
  }
}

function saveTimers() {
  try {
    const entries = Object.entries(T.timers).slice(-TIMER_KEEP);
    localStorage.setItem(TIMER_KEY, JSON.stringify({ current: T.current, timers: Object.fromEntries(entries) }));
  } catch {
    /* 私密模式存不了就算了，页面上照样计时 */
  }
}

const timerOf = (key) => {
  if (!key) return { startedAt: 0, accumulated: 0, running: false };
  if (!T.timers[key]) T.timers[key] = { startedAt: 0, accumulated: 0, running: false };
  return T.timers[key];
};

/** 这一份已经做了多久（毫秒） */
function elapsedMs(key = T.current) {
  if (!key) return 0;
  const t = timerOf(key);
  return (t.accumulated || 0) + (t.running && t.startedAt ? Date.now() - t.startedAt : 0);
}

/** 进一份卷子：同一份就接着算；换了一份先把上一份暂停，这份从零开始 */
function enterTimer(key) {
  if (!key) return;
  if (T.current && T.current !== key) {
    const prev = timerOf(T.current);
    if (prev.running) {
      prev.accumulated = elapsedMs(T.current);
      prev.running = false;
      prev.startedAt = 0;
    }
  }
  T.current = key;
  const t = timerOf(key);
  // 已经交过卷的（finished）不自动接着走：那一份的时间定死在那儿了，想再做一遍长按归零
  if (!t.running && !t.finished) {
    t.startedAt = Date.now();
    t.running = true;
  }
  saveTimers();
  startTick();
}

function toggleTimer() {
  const t = timerOf(T.current);
  if (t.running) {
    t.accumulated = elapsedMs(T.current);
    t.running = false;
    t.startedAt = 0;
  } else {
    t.startedAt = Date.now();
    t.running = true;
    t.finished = false; // 我又接着做了，交卷状态取消
  }
  saveTimers();
  paintTimer();
}

/** 记完一次之后重新计时，方便再练一遍 */
function resetTimer(key = T.current) {
  if (!key) return;
  Object.assign(timerOf(key), { startedAt: Date.now(), accumulated: 0, running: true, finished: false });
  saveTimers();
  paintTimer();
}

/**
 * 做完了（交卷判分 / 对完答案）→ 把计时停下来。
 *
 * 判分要等模型想半天，那几分钟不是我的做题用时；不停的话，之后在这一屏翻一翻，
 * 数字还在涨，成绩里的「用了多久」就成了假的。数字冻在交卷那一刻。
 */
function stopTimer(key = T.current) {
  if (!key) return;
  const t = timerOf(key);
  if (t.running) {
    t.accumulated = elapsedMs(key);
    t.running = false;
    t.startedAt = 0;
  }
  t.finished = true; // 再进这一屏也不自动接着走
  saveTimers();
  paintTimer();
}

function startTick() {
  if (T.id) return;
  T.id = setInterval(paintTimer, 500);
}

/** 只改顶栏那一个数字，绝不整页重绘 —— 一秒重绘一次会把滚动位置顶回去 */
function paintTimer() {
  const el = $('#mtimer');
  if (!el) {
    // 退出全屏那一屏了，定时器也跟着停
    if (T.id) {
      clearInterval(T.id);
      T.id = null;
    }
    return;
  }
  const ref = Number(el.dataset.ref) || 0;
  const used = Math.round(elapsedMs() / 1000);
  const t = timerOf(T.current);
  el.innerHTML = ref ? `<b>${fmtClock(used)}</b> / ${fmtClock(ref)}` : `<b>${fmtClock(used)}</b>`;
  el.querySelector('b').classList.toggle('is-over', ref > 0 && used > ref);
  el.classList.toggle('is-paused', !t.running);
}

/** 顶栏那块计时器：点一下暂停 / 继续，长按归零 */
function timerHtml(refSeconds) {
  const ref = Math.round(Number(refSeconds) || 0);
  const t = timerOf(T.current);
  const used = Math.round(elapsedMs() / 1000);
  return `<button class="mtimer${t.running ? '' : ' is-paused'}" id="mtimer" data-ref="${ref}"
    data-act="timer" title="点一下暂停 / 继续，长按归零">
    <b class="${ref > 0 && used > ref ? 'is-over' : ''}">${ref ? `${fmtClock(used)} / ${fmtClock(ref)}` : fmtClock(used)}</b>
  </button>`;
}

/* ============================================================
   三、状态
   ============================================================ */

const S = {
  tab: 'today',
  ready: false,
  today: null,
  tests: [],
  stories: [],
  problems: [],
  stats: null,
  ai: null,

  // 全屏那一屏：null = 在「今日 / 做题」首页
  view: null, // { kind:'paper'|'question'|'reading', rel|id }
  paper: null,
  problem: null,
  story: null,

  photos: [], // 暂存的手写答案 [{name, url, bytes}]
  photoBusy: false,
  grade: { busy: false, chars: 0, think: 0, error: null, t0: 0 },
  paperGrade: null, // 整卷成绩单
  bankDone: null, // 一键加入错题本之后记下的题号
  qVerdict: null, // 单题判分结论（可改）
  qPending: null, // 手动打卡：先选结果，再选错因
  drill: { queue: [], idx: 0 }, // 一局刷题的题号队列

  reading: { tab: 'text', answers: {}, attempt: null },
  qFilter: 'all',
  qSearch: '',
};

/* ============================================================
   四、数据
   ============================================================ */

async function loadToday({ silent = false } = {}) {
  try {
    S.today = await api('/api/today');
  } catch (err) {
    if (!silent) toast(`今日数据读不到：${err.message}`, 'err');
  }
}

async function loadDrillData({ silent = false } = {}) {
  const [test, questions, words, ai] = await Promise.all([
    api('/api/test').catch(() => ({ tests: [] })),
    api('/api/questions').catch(() => ({ problems: [], stats: null })),
    api('/api/words').catch(() => ({ stories: [] })),
    api('/api/ai').catch(() => null),
  ]);
  S.tests = test.tests || [];
  S.problems = questions.problems || [];
  S.stats = questions.stats || null;
  S.stories = (words && words.stories) || [];
  S.ai = ai;
  if (!silent && !S.problems.length) toast('错题本里还没有题', 'err');
}

async function refresh({ silent = false } = {}) {
  await Promise.all([loadToday({ silent }), loadDrillData({ silent })]);
  render({ keepScroll: false });
}

/* ============================================================
   五、拍照 —— 手机端的核心那一步

   两个入口分开：**拍照**走摄像头（capture=environment），**相册**走选图。
   iOS 上传了 capture 就只剩相机，想挑相册里的旧照片就没路了，所以必须都给。

   传之前先在本地缩一遍：手机原图 4000×3000、三四兆，base64 之后还要再涨三分之一，
   走 Wi-Fi 又慢又浪费模型额度。缩到长边 2000 像素，手写过程照样看得清。
   ============================================================ */

const PHOTO_MAX_EDGE = 2000;
const PHOTO_QUALITY = 0.9;

/**
 * 把手机原图缩小。**任何一步出问题都退回原图** —— 宁可传慢一点，
 * 也不能因为浏览器不认识某个 API 就把这道题的答案弄丢了。
 */
async function shrinkImage(file) {
  if (file.size < 700 * 1024) return file; // 本来就不大，别动它
  let bmp = null;
  try {
    // imageOrientation: 'from-image' 让手机照片的 EXIF 旋转在这一步就摆正，
    // 不然拍出来是横着的，模型和人都看不清
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return file;
  }
  try {
    const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    if (scale >= 1 && file.size < 3 * 1024 * 1024) return file;
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
    const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', PHOTO_QUALITY));
    if (!blob) return file;
    const name = `${String(file.name || 'photo').replace(/\.[^.]+$/, '')}.jpg`;
    return new File([blob], name, { type: 'image/jpeg' });
  } catch {
    return file;
  } finally {
    bmp.close?.();
  }
}

const readDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('图片读不出来'));
    r.readAsDataURL(file);
  });

async function addPhotos(fileList) {
  const files = [...(fileList || [])].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return toast('只支持图片', 'err');
  S.photoBusy = true;
  render();
  let ok = 0;
  for (const raw of files) {
    try {
      const f = await shrinkImage(raw);
      if (f.size > 15 * 1024 * 1024) {
        toast(`${raw.name || '这张'} 超过 15MB，已跳过`, 'err');
        continue;
      }
      const dataUrl = await readDataUrl(f);
      const out = await api('/api/upload', { method: 'POST', body: JSON.stringify({ name: f.name, dataUrl }) });
      S.photos.push({ name: out.name, url: `/uploads/${encodeURIComponent(out.name)}`, bytes: out.bytes });
      ok += 1;
    } catch (err) {
      toast(`上传失败：${err.message}`, 'err');
    }
  }
  S.photoBusy = false;
  render();
  if (ok) toast(`已传 ${ok} 张`);
}

/** 删掉暂存的图（服务端那份也一起删，别在 uploads 里堆垃圾） */
async function dropPhotos(names = S.photos.map((p) => p.name)) {
  S.photos = S.photos.filter((p) => !names.includes(p.name));
  if (!names.length) return;
  try {
    await api('/api/uploads', { method: 'DELETE', body: JSON.stringify({ names }) });
  } catch {
    /* 删不掉不影响判分，服务端判完本来也会清 */
  }
}

/* ============================================================
   六、渲染
   ============================================================ */

/** 重绘。默认保住滚动位置（传图、看进度时不该把页面顶回最上面） */
function render({ keepScroll = true } = {}) {
  const y = window.scrollY;
  // 画不出来也要看得见为什么 —— 手机上没法开控制台，总不能给人留一块白屏
  const safe = (fn, what) => {
    try {
      return fn();
    } catch (err) {
      console.error(`[手机端] ${what} 渲染失败`, err);
      return `<div class="callout callout-error"><div class="callout-head">⛔<span>${esc(what)}画不出来</span></div>
        <div class="callout-body">${esc(String(err.message || err))}</div></div>`;
    }
  };

  $('#mtop').innerHTML = safe(topHtml, '顶栏');
  $('#mmain').innerHTML = safe(mainHtml, '这一屏');

  const bar = $('#mbar');
  const barBody = S.view ? safe(barHtml, '底部操作条') : '';
  bar.innerHTML = barBody;
  bar.hidden = !barBody;
  // 把操作条的实际高度报给 CSS —— 正文的底边距和浮层提示的落点都按它算。
  // 缩略图几张、有没有「上一题/下一题」那一行，高度会差一百多像素，写死必然压住内容。
  document.documentElement.style.setProperty('--mbar-h', `${barBody ? bar.offsetHeight : 0}px`);

  $('#mtabs').hidden = !!S.view;
  document.body.classList.toggle('is-view', !!S.view);
  // is-full = 底下真的有操作条，正文要给它让出地方（英语判完之后没有条，就不让）
  document.body.classList.toggle('is-full', !!barBody);
  for (const b of document.querySelectorAll('.mtab')) b.classList.toggle('is-active', b.dataset.tab === S.tab);

  paintTimer();
  if (keepScroll) window.scrollTo(0, y);
  S.ready = true;
}

function topHtml() {
  if (!S.view) {
    const cd = S.today?.countdown;
    return `<div class="mtop-in">
      <div class="mtop-title">
        <b>study</b>
        <span>${cd ? `距考研 ${cd.days} 天 · ${esc(S.today.date)} ${esc(S.today.weekday || '')}` : '手机做题'}</span>
      </div>
      <div class="mtop-tools">
        <button data-act="refresh" title="重新读取">⟳</button>
      </div>
    </div>`;
  }
  const title = viewTitle();
  return `<div class="mtop-in">
    <button class="mtop-back" data-act="back" title="返回">←</button>
    <div class="mtop-title"><b>${esc(title.main)}</b><span>${esc(title.sub)}</span></div>
    ${title.timer ? `<div class="mtop-tools">${timerHtml(title.timer)}</div>` : ''}
  </div>`;
}

function viewTitle() {
  if (S.view.kind === 'paper') {
    const p = S.paper;
    return { main: p?.title || '试卷', sub: `${p?.items?.length || 0} 题 · 满分 ${fmtPts(p?.plan?.table?.full ?? 100)}`, timer: p?.plan?.ref?.seconds || 0 };
  }
  if (S.view.kind === 'question') {
    const p = S.problem;
    return {
      main: `${p?.num || ''}　${p?.type || ''}`.trim(),
      sub: `${p?.category || ''} · ${p?.subject || ''} · ${p?.chapter || ''}`,
      timer: refSecondsOfQuestion(p),
    };
  }
  const st = S.story;
  return { main: st?.title || '英语阅读', sub: `${st?.type || '阅读'} · 满分 ${fmtPts(st?.plan?.table?.full ?? 10)}`, timer: st?.plan?.ref?.seconds || 0 };
}

/** 单题的参考用时：优先用这道题自己的平均用时，没有就退到全库中位数，都没有就不显示 */
function refSecondsOfQuestion(p) {
  const avg = p?.stats?.avgSec;
  if (Number.isFinite(avg) && avg > 0) return Math.round(avg);
  const median = S.stats?.timing?.medianSec;
  return Number.isFinite(median) && median > 0 ? Math.round(median) : 0;
}

function mainHtml() {
  if (!S.ready && !S.today) return '<div class="loading"><div class="spinner"></div><p>正在读取…</p></div>';
  if (S.view?.kind === 'paper') return S.paper ? paperHtml() : loadingHtml('正在读这份卷子…');
  if (S.view?.kind === 'question') return S.problem ? questionHtml() : loadingHtml('正在读这道题…');
  if (S.view?.kind === 'reading') return S.story ? readingHtml() : loadingHtml('正在读这一篇…');
  return S.tab === 'today' ? todayHtml() : drillHomeHtml();
}

const loadingHtml = (text) => `<div class="loading"><div class="spinner"></div><p>${esc(text)}</p></div>`;

/* ---------- 今日 ---------- */

function todayHtml() {
  const t = S.today;
  if (!t) return loadingHtml('正在读取今日数据…');
  const cd = t.countdown;
  const w = t.week;
  const m = t.mistakes || {};
  const words = t.words;

  const taskRow = (x, occ) => {
    const label = x.daily ? x.text.replace(/^🔁\s*/, '') : x.text;
    // 🔁 每日任务：本周打了几次卡、都是哪几天
    const days = x.daily ? (x.checkins || []).map((d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`) : [];
    const shown = !days.length ? '' : days.length <= 3 ? days.join('、') : `${days[0]}…${days[days.length - 1]}`;
    return `<li class="md-task${x.done ? ' is-done' : ''}">
      <input type="checkbox" data-act="task" data-rel="${esc(w?.rel || '')}" data-text="${esc(x.text)}"
        data-occ="${occ}"${x.done ? ' checked' : ''} />
      <span>${richInline(label)}</span>
      ${x.daily ? `<em class="task-week">本周 ${(x.checkins || []).length}/${x.slots || 7}${shown ? ` · ${shown}` : ''}</em>` : ''}
      ${x.done && x.doneDate ? `<em class="task-date">✅ ${esc(x.doneDate)}</em>` : ''}
    </li>`;
  };
  const withOcc = (list) => {
    const seen = new Map();
    return list.map((x) => {
      const n = seen.get(x.text) || 0;
      seen.set(x.text, n + 1);
      return { ...x, occ: n };
    });
  };

  const todays = withOcc(t.todayTasks || []);
  const undated = withOcc((t.undated || []).filter((x) => !x.done));

  return `
  <section class="countdown-card">
    <div class="cd-main">
      <div class="cd-label">距离考研还有</div>
      <div class="cd-days">${cd.days}<span>天</span></div>
      <div class="cd-sub">${esc(cd.examDate)} · 约 ${cd.weeks} 周</div>
    </div>
  </section>

  <div class="stat-grid">
    <div class="stat-card is-done">
      <div class="stat-label">📅 今日完成</div>
      <div class="stat-value">${todays.filter((x) => x.done).length}<span class="unit">/${todays.length}</span></div>
      <div class="stat-foot">今天标了日期的任务</div>
    </div>
    <div class="stat-card is-pending">
      <div class="stat-label">📕 错题待复习</div>
      <div class="stat-value">${m.pending ?? 0}</div>
      <div class="stat-foot">刚加的 + 复习到期的</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">✅ 本周完成率</div>
      <div class="stat-value">${w ? w.rate : 0}<span class="unit">%</span></div>
      <div class="stat-foot">${w ? `${w.done} / ${w.total} 项` : '—'}</div>
    </div>
    <div class="stat-card is-streak">
      <div class="stat-label">🔥 连续打卡</div>
      <div class="stat-value">${m.streak ?? 0}<span class="unit">天</span></div>
      <div class="stat-foot">累计 ${m.checkins ?? 0} 次</div>
    </div>
  </div>

  ${
    words?.ok
      ? `<section class="panel" style="margin-top:14px">
    <div class="panel-head"><h3>📖 墨墨背单词</h3><span class="hint">今日 ${words.progress?.finished ?? 0} / ${words.progress?.total ?? 0}</span></div>
    <div class="panel-body">
      <div class="prog-row"><span>今日完成</span><div class="progress"><i style="width:${words.progress?.rate ?? 0}%"></i></div><b>${words.progress?.rate ?? 0}%</b></div>
      <div class="prog-row"><span>剩余</span><div class="progress"><i style="width:0%"></i></div><b>${words.progress?.remaining ?? 0} 词</b></div>
      <div class="prog-row"><span>今日到期</span><div class="progress"><i style="width:0%"></i></div><b>${words.plan?.dueToday ?? 0} 词</b></div>
    </div>
  </section>`
      : ''
  }

  <section class="panel" style="margin-top:14px">
    <div class="panel-head"><h3>今天的任务</h3><span class="hint">勾选直接写回 Obsidian</span></div>
    <div class="panel-body">
      ${
        todays.length
          ? `<ul class="task-list">${todays.map((x) => taskRow(x, x.occ)).join('')}</ul>`
          : '<div class="rv-hint">这周的周计划里没有标今天日期的任务。</div>'
      }
      ${
        undated.length
          ? `<div class="task-sub">本周其他待办（没标日期）</div><ul class="task-list">${undated.map((x) => taskRow(x, x.occ)).join('')}</ul>`
          : ''
      }
    </div>
  </section>

  ${
    w?.days?.length
      ? `<section class="panel" style="margin-top:14px">
    <div class="panel-head"><h3>本周进度</h3><span class="hint">${esc(w.title || '')}</span></div>
    <div class="panel-body">
      <div class="day-strip">${w.days
        .map(
          (d) => `<div class="day-cell${d.isToday ? ' is-today' : ''}${d.isPast ? ' is-past' : ''}">
        <span class="dc-week">${esc(d.weekday)}</span>
        <span class="dc-count">${d.total ? `${d.done}/${d.total}` : '—'}</span>
        <span class="dc-bar"><i style="width:${d.total ? Math.round((d.done / d.total) * 100) : 0}%"></i></span>
      </div>`
        )
        .join('')}</div>
    </div>
  </section>`
      : ''
  }`;
}

/* ---------- 做题首页 ---------- */

function drillHomeHtml() {
  const lastTest = S.tests[0];
  const dueCount = S.problems.filter((p) => p.stats.status === '待复习').length;

  const tests = S.tests.length
    ? S.tests
        .map(
          (t) => `<button class="mrow" data-act="open-paper" data-rel="${esc(t.rel)}">
      <div class="mrow-main">
        <div class="mrow-title">${esc(t.title)}</div>
        <div class="mrow-sub">${esc(t.date)} · ${t.count} 题 · 满分 ${fmtPts(t.full)} · 参考 ${t.refMinutes} 分钟${
            t.last ? ` · 上次 ${fmtPts(t.last.total)} 分` : ' · 还没做过'
          }</div>
      </div>
      <span class="mrow-go">›</span>
    </button>`
        )
        .join('')
    : '<div class="mempty">还没有试卷。在电脑上「测试」页出一份，手机这里就能做。</div>';

  const stories = S.stories.length
    ? S.stories
        .map(
          (st) => `<button class="mrow" data-act="open-reading" data-rel="${esc(st.rel)}">
      <div class="mrow-main">
        <div class="mrow-title">${esc(st.title || st.name)}</div>
        <div class="mrow-sub">${esc(st.date)} · ${esc(st.type || '')} · ${st.words?.length || 0} 个目标词${
            st.last ? ` · 上次 ${fmtPts(st.last.total)} 分` : ''
          }</div>
      </div>
      <span class="mrow-go">›</span>
    </button>`
        )
        .join('')
    : '<div class="mempty">还没有英语阅读。在电脑上「单词」页生成一篇。</div>';

  const problemRows = problemRowsHtml();

  return `
  ${
    !S.ai?.ready
      ? `<div class="callout callout-warning"><div class="callout-head">⚠️<span>还没配内置 AI</span></div>
    <div class="callout-body">拍照判分要调模型。手机上不配置，<b>先在电脑上进「设置」把接口和 key 填好</b>，这边立刻就能用。</div></div>`
      : ''
  }

  <div class="msec"><h2>📝 今日测试</h2><span class="hint">数学 / 408，拍照判分</span></div>
  ${
    lastTest
      ? `<button class="btn-primary big" data-act="open-paper" data-rel="${esc(lastTest.rel)}" style="width:100%;justify-content:center">
      ▶ 开始做：${esc(lastTest.title)}</button>`
      : ''
  }
  <div style="height:10px"></div>
  ${tests}

  <div class="msec"><h2>📕 错题刷题</h2><span class="hint">共 ${S.problems.length} 题</span></div>
  <div class="mstart">
    <button class="btn-primary" data-act="start-drill" data-mode="due"${dueCount ? '' : ' disabled'}>⏳ 待复习（${dueCount}）</button>
    <button class="btn-ghost" data-act="start-drill" data-mode="priority"${S.problems.length ? '' : ' disabled'}>🎲 全部混刷</button>
  </div>

  <div style="height:12px"></div>
  <label class="msearch"><span>⌕</span>
    <input id="qSearch" type="search" placeholder="搜题号 / 考点 / 题干…" value="${esc(S.qSearch)}" data-act="search" />
  </label>
  <div class="mchips">
    ${[
      ['all', '全部', S.problems.length],
      ['due', '待复习', dueCount],
      ['none', '没做过', S.problems.filter((p) => p.stats.status === '未做').length],
      ['fail', '错过', S.problems.filter((p) => p.stats.fail > 0).length],
      ['done', '已复习', S.problems.filter((p) => p.stats.status === '已复习').length],
    ]
      .map(
        ([key, label, cnt]) =>
          `<button class="chip${S.qFilter === key ? ' is-on' : ''}" data-act="filter" data-key="${key}">${label}<span class="cnt">${cnt}</span></button>`
      )
      .join('')}
  </div>
  <div id="qList">${problemRows}</div>

  <div class="msec"><h2>📖 英语阅读</h2><span class="hint">本地判卷，不用拍照</span></div>
  ${stories}`;
}

/** 题目列表那一段单独成函数：搜索框里打字时只重画这一块，不整页重绘（不丢焦点、不跳滚动） */
function problemRowsHtml() {
  const list = filteredProblems();
  if (!list.length) return '<div class="mempty">这里还没有题。</div>';
  return list
    .map((p) => {
      const badges = [
        `<span class="mbadge">难度 ${p.difficulty}</span>`,
        `<span class="mbadge">热度 ${p.heat}</span>`,
        `<span class="mbadge ${
          p.stats.status === '待复习' ? 'is-due' : p.stats.status === '已复习' ? 'is-done' : ''
        }">${p.stats.status === '待复习' ? '⏰ 待复习' : p.stats.status === '已复习' ? '✅ 已复习' : '⭕ 未做'}</span>`,
        p.stats.fail > 0 ? '<span class="mbadge is-fail">错过</span>' : '',
        p.stats.total ? `<span class="mbadge">练过 ${p.stats.total} 次</span>` : '',
      ].join('');
      return `<button class="mrow mqrow ${STATUS_CLS[p.stats.status] || 's-none'}" data-act="open-question" data-id="${esc(p.id)}">
      <div class="mrow-main">
        <div class="mrow-title">${esc(p.num)}　${esc(p.type || '')}</div>
        <div class="mrow-sub">${
          // 题目摘要是「考点 · 考点」，没有考点就退到题干的第一行 ——
          // **一律走 richInline**：题干里有 $公式$，esc 的话会原样漏出美元符号
          (p.points || []).length
            ? richInline((p.points || []).join(' · '))
            : richInline(String(p.title || '').replace(/^\S+[\s　]*/, ''))
        }</div>
        <div class="mqrow-badges">${badges}</div>
      </div>
      <span class="mrow-go">›</span>
    </button>`;
    })
    .join('');
}

function filteredProblems() {
  const q = S.qSearch.trim().toLowerCase();
  return S.problems.filter((p) => {
    const st = p.stats.status;
    if (S.qFilter === 'due' && st !== '待复习') return false;
    if (S.qFilter === 'done' && st !== '已复习') return false;
    if (S.qFilter === 'none' && st !== '未做') return false;
    if (S.qFilter === 'fail' && !(p.stats.fail > 0)) return false;
    if (!q) return true;
    const hay = `${p.num} ${p.title} ${p.type} ${(p.points || []).join(' ')} ${p.searchText || ''}`.toLowerCase();
    return hay.includes(q);
  });
}

/* ---------- 整卷 ---------- */

function paperHtml() {
  const p = S.paper;
  const g = S.paperGrade;
  const byN = new Map((g?.items || []).map((x) => [Number(x.n), x]));

  const items = (p.items || [])
    .map((item) => {
      const v = byN.get(Number(item.n));
      const ref = p.plan?.ref?.byN?.[item.n];
      return `<article class="mq" id="mq-${item.n}">
      <div class="mq-head">
        <span class="mq-n">${item.n}</span>
        <span class="mq-kind">${esc(item.type || '')}${item.topic ? ` ｜ ${esc(item.topic)}` : ''}</span>
        <span class="mq-tag">${fmtPts(p.plan?.table?.byN?.[item.n])} 分${ref ? ` · 参考 ${fmtSpan(ref)}` : ''}</span>
      </div>
      <div class="mq-body">${mdToHtml(item.body)}</div>
      ${
        item.answer
          ? `<details class="fold fold-answer"><summary>✅ 标准答案与解析</summary>
        <div class="fold-body">${mdToHtml(item.answerText || item.answer)}${
              item.analysisText ? mdToHtml(item.analysisText) : ''
            }</div></details>`
          : '<div class="do-hint">这份卷子没给这题的标准答案</div>'
      }
      ${v ? scoreLineHtml(v) : ''}
    </article>`;
    })
    .join('');

  return `
  ${g ? paperGradeHtml(g) : ''}
  ${p.answerMissing?.length ? `<div class="callout callout-warning"><div class="callout-head">⚠️<span>有题没答案</span></div><div class="callout-body">第 ${p.answerMissing.join('、')} 题在这份卷子里没有标准答案。</div></div>` : ''}
  ${items}
  ${gradePanelHtml()}`;
}

/** 每题判完之后挂在题下面的那一行 */
function scoreLineHtml(v) {
  const ok = Number(v.score) >= Number(v.full);
  return `<div class="mq-score-card">
    <div class="mq-score-top">
      <span class="num" style="color:${ok ? 'var(--done)' : Number(v.score) > 0 ? 'var(--warn)' : 'var(--fail)'}">${fmtPts(v.score)}</span>
      <span class="of">/ ${fmtPts(v.full)} 分</span>
      <span class="verdict">${VERDICT_ICON[v.verdict] || '•'} ${esc(v.verdict)}${v.reason ? ` · ${esc(v.reason)}` : ''}</span>
    </div>
    ${v.got ? `<div class="mq-kv"><b>你写的：</b>${richInline(v.got)}</div>` : ''}
    ${v.lost && v.lost !== '无' ? `<div class="mq-kv"><b>丢分点：</b>${richInline(v.lost)}</div>` : ''}
    ${v.fix && v.fix !== '保持' ? `<div class="mq-kv"><b>该怎么改：</b>${richInline(v.fix)}</div>` : ''}
  </div>`;
}

function paperGradeHtml(g) {
  const pct = g.full ? Math.round((g.total / g.full) * 100) : 0;
  const done = S.bankDone;
  const weak = (g.weak || []).filter(Boolean);
  const next = (g.next || []).filter(Boolean);
  const wrong = (g.items || []).filter((x) => Number(x.score) < Number(x.full)).length;
  return `<section class="mcard">
    <div class="mcard-total">
      <span class="big" style="color:${pct >= 85 ? 'var(--done)' : pct >= 60 ? 'var(--warn)' : 'var(--fail)'}">${fmtPts(g.total)}</span>
      <span class="of">/ ${fmtPts(g.full)} 分</span>
      <span class="pct" style="color:${pct >= 85 ? 'var(--done)' : pct >= 60 ? 'var(--warn)' : 'var(--fail)'}">${pct}%</span>
    </div>
    <div class="mcard-sub">${esc(g.date || '')} · 用了 ${fmtClock(g.seconds)}${g.refSeconds ? ` / 参考 ${fmtClock(g.refSeconds)}` : ''} · 照片 ${g.images || 0} 张${g.missing ? ` · ${g.missing} 题模型没判到（按 0 分算）` : ''}</div>
    ${g.summary ? `<div class="mcard-body">${richInline(g.summary)}</div>` : ''}
    ${weak.length ? `<div class="mcard-body"><b>薄弱点</b><ul>${weak.map((x) => `<li>${richInline(x)}</li>`).join('')}</ul></div>` : ''}
    ${next.length ? `<div class="mcard-body"><b>下一步</b><ul>${next.map((x) => `<li>${richInline(x)}</li>`).join('')}</ul></div>` : ''}
    <div class="mbar-row" style="margin-top:13px">
      ${
        done
          ? `<button class="btn-ghost grow" disabled>✅ 已加入错题本（第 ${done.join('、')} 题）</button>`
          : wrong
            ? `<button class="btn-primary grow" data-act="to-bank">➕ 把 ${wrong} 道错题加入错题本</button>`
            : '<button class="btn-ghost grow" disabled>这次没有做错的题 🎉</button>'
      }
    </div>
  </section>`;
}

/* ---------- 单题 ---------- */

function questionHtml() {
  const p = S.problem;
  const v = S.qVerdict;
  const meta = [
    `<span class="mbadge">难度 ${p.difficulty}</span>`,
    `<span class="mbadge">热度 ${p.heat}</span>`,
    `<span class="mbadge ${p.stats.status === '待复习' ? 'is-due' : p.stats.status === '已复习' ? 'is-done' : ''}">${esc(p.stats.status)}</span>`,
  ].join('');

  return `
  <article class="mq">
    <div class="mq-head">
      <span class="mq-n">${esc(p.num)}</span>
      <span class="mq-kind">${esc(p.type || '')}</span>
      <span class="mq-tag">已练 ${p.stats.total} 次${p.stats.last ? ` · 上次 ${esc(p.stats.last.result)}` : ''}</span>
    </div>
    <div class="mqrow-badges" style="margin-bottom:10px">${meta}</div>
    ${
      (p.points || []).length
        ? `<div class="rv-points" style="margin-bottom:10px">${p.points.map((x) => `<span class="point-chip static">${esc(x)}</span>`).join('')}</div>`
        : ''
    }
    <div class="mq-body">${mdToHtml(p.stem)}</div>
  </article>

  <details class="fold fold-answer">
    <summary>✅ 答案与解析</summary>
    <div class="fold-body">
      ${mdToHtml(p.answer || '（这道题没写答案）')}
      ${p.solution ? `<div style="margin-top:12px">${mdToHtml(p.solution)}</div>` : ''}
      ${p.keypoints ? `<hr class="md-hr">${mdToHtml(p.keypoints)}` : ''}
      ${p.pitfalls ? `<hr class="md-hr">${mdToHtml(p.pitfalls)}` : ''}
    </div>
  </details>

  <div style="height:12px"></div>
  ${v ? verdictPanelHtml(v) : recordPanelHtml(p)}
  ${gradePanelHtml()}`;
}

/** 手动打卡：先点结果，再点错因（做错才问错因） */
function recordPanelHtml(p) {
  if (!S.qPending) {
    return `<section class="mq">
      <div class="mq-head"><span class="mq-kind">这次做得怎么样？</span></div>
      <div class="mstart">
        ${RESULTS.map(
          (r) => `<button class="btn-ghost" data-act="record" data-result="${r.key}" title="${esc(r.hint)}">${r.icon} ${r.key}</button>`
        ).join('')}
      </div>
      <div class="do-hint">也可以直接拍照让 AI 判这一题，判完再决定记什么。</div>
    </section>`;
  }
  return `<section class="mq">
    <div class="mq-head">
      <span class="mq-kind">记「${esc(S.qPending)}」</span>
      <span class="mq-tag">做错才需要错因，做对了可以跳过</span>
    </div>
    <div class="mchips" style="flex-wrap:wrap;overflow:visible">
      ${REASONS.map((r) => `<button class="chip${S.qReason === r ? ' is-on' : ''}" data-act="pick-reason" data-reason="${esc(r)}">${esc(r)}</button>`).join('')}
    </div>
    <div class="mstart">
      <button class="btn-ghost" data-act="cancel-record">取消</button>
      <button class="btn-primary" data-act="commit-record">✍️ 记进笔记</button>
    </div>
  </section>`;
}

/**
 * 可编辑文本（错因分析）底下的**渲染预览**。
 * 分析里常有 `$x\to 0$` 这种公式，文本框里必须是原文（那是要写进笔记的内容），
 * 所以另起一行把渲染后的样子摆出来 —— 不然屏幕上就是一串反斜杠命令，看着像乱码。
 * 纯文字（既没 `$` 也没 `*`）就什么都不显示。
 */
function mdPreview(text) {
  const t = String(text ?? '').trim();
  if (!t || !/[$*`]/.test(t)) return '';
  return `<p style="margin:0"><b>渲染</b>${t.split(/\n+/).map((line) => richInline(line)).join('<br>')}</p>`;
}

/** 单题判分面板：得分 / 结果 / 错因 / 错因分析，全都能改，改完才落盘 */
function verdictPanelHtml(v) {
  const setFirst = !!v.setFirstReason;
  return `<section class="mcard">
    <div class="mcard-total">
      <span class="big" style="color:${v.score >= 85 ? 'var(--done)' : v.score >= 60 ? 'var(--warn)' : 'var(--fail)'}">${v.score}</span>
      <span class="of">/ 100 分</span>
      <span class="pct" style="font-size:20px">AI 建议 ${esc(v.result)}</span>
    </div>
    ${v.got ? `<div class="mcard-sub">你写的是：${richInline(v.got)}</div>` : ''}
    ${v.lost && v.lost !== '无' ? `<div class="mcard-body"><b>丢分点：</b>${richInline(v.lost)}</div>` : ''}
    ${v.fix && v.fix !== '保持' ? `<div class="mcard-body"><b>该怎么改：</b>${richInline(v.fix)}</div>` : ''}

    <div class="mcard-body"><b>结果</b>　<span class="hint">AI 建议的不对就自己点</span></div>
    <div class="mchips">
      ${RESULTS.map(
        (r) => `<button class="chip${v.result === r.key ? ' is-on' : ''}" data-act="set-result" data-result="${r.key}">${r.icon} ${r.key}</button>`
      ).join('')}
    </div>

    <div class="mcard-body"><b>错因</b></div>
    <div class="mchips" style="flex-wrap:wrap;overflow:visible">
      <button class="chip${v.reason ? '' : ' is-on'}" data-act="set-reason" data-reason="">不记</button>
      ${REASONS.map((r) => `<button class="chip${v.reason === r ? ' is-on' : ''}" data-act="set-reason" data-reason="${esc(r)}">${esc(r)}</button>`).join('')}
    </div>

    <div class="mcard-body"><b>错因分析</b>　<span class="hint">随便改、随便删</span></div>
    <textarea id="qAnalysis" rows="5" style="width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);font-family:inherit;font-size:14.5px;line-height:1.6">${esc(v.analysis || '')}</textarea>
    <div class="mcard-body" id="qAnalysisMd" style="color:var(--text-2);font-size:13.5px">${mdPreview(v.analysis)}</div>
    <label style="display:flex;align-items:center;gap:8px;margin-top:9px;color:var(--text-2);font-size:13.5px">
      <input type="checkbox" id="qFirstReason"${setFirst ? ' checked' : ''} />
      同时写进「首次错因」${v.hadFirstReason ? '（已经记过，勾上就覆盖）' : ''}
    </label>

    <div class="mbar-row" style="margin-top:13px">
      <button class="btn-ghost" data-act="drop-verdict">不要这次判分</button>
      <button class="btn-primary grow" data-act="commit-verdict">✍️ 记进笔记</button>
    </div>
  </section>`;
}

/* ---------- 英语阅读 ---------- */

function readingHtml() {
  const st = S.story;
  const r = S.reading;
  const attempt = r.attempt;
  const byN = new Map((attempt?.items || []).map((x) => [Number(x.n), x]));
  const done = !!attempt;

  const tab = `<div class="mseg">
    <button class="${r.tab === 'text' ? 'is-on' : ''}" data-act="reading-tab" data-tab="text">原文</button>
    <button class="${r.tab === 'quiz' ? 'is-on' : ''}" data-act="reading-tab" data-tab="quiz">题目（${(st.questions || []).length}）</button>
    <button class="${r.tab === 'notes' ? 'is-on' : ''}" data-act="reading-tab" data-tab="notes">解析</button>
  </div>`;

  if (r.tab === 'text') {
    const prose = storyProse(st.body);
    return `${tab}
    <article class="mq"><div class="mreading md">${highlightWords(mdToHtml(prose), st.words)}</div></article>
    ${attempt ? readingGradeHtml(attempt) : ''}`;
  }

  // 解析：手机上也要看得到逐句分析 / 长难句拆解 / 生词回收 / 中文大意。
  // 手机上屏幕小，四节做成可折叠的，先给最短的「中文大意」开着。
  if (r.tab === 'notes') {
    const order = ['中文大意', '逐句分析', '长难句拆解', '生词回收'];
    const all = storySections(st.body);
    const shown = order.map((n) => all.find(([k]) => k === n)).filter((x) => x && x[1]);
    if (!shown.length) {
      return `${tab}<section class="mcard"><div class="mcard-body">这一篇还没有解析。重新生成一次，或去电脑上看。</div></section>`;
    }
    return `${tab}${shown
      .map(
        ([name, text], i) =>
          `<details class="fold"${i === 0 ? ' open' : ''}><summary>${esc(name)}</summary><div class="fold-body md">${mdToHtml(text)}</div></details>`
      )
      .join('')}`;
  }

  const quiz = (st.questions || [])
    .map((q) => {
      const v = byN.get(Number(q.n));
      const mine = r.answers[q.n] || '';
      const right = st.key?.[String(q.n)] || '';
      const opts = (q.options || [])
        .map((o) => {
          let cls = '';
          if (done) {
            if (o.key === right) cls = 'is-right';
            else if (o.key === mine) cls = 'is-wrong';
          } else if (o.key === mine) cls = 'is-on';
          return `<button class="mopt ${cls}" data-act="answer" data-n="${q.n}" data-key="${esc(o.key)}"${done ? ' disabled' : ''}>
        <span class="mopt-key">${esc(o.key)}</span><span>${esc(o.text)}</span>
      </button>`;
        })
        .join('');
      return `<article class="mq">
      <div class="mq-head"><span class="mq-n">${q.n}</span><span class="mq-tag">${fmtPts(st.plan?.table?.byN?.[q.n])} 分</span></div>
      <div class="mq-body">${mdToHtml(q.stem)}</div>
      <div class="mopts">${opts}</div>
      ${v ? scoreLineHtml(v) : ''}
    </article>`;
    })
    .join('');

  return `${tab}${attempt ? readingGradeHtml(attempt) : ''}${quiz}`;
}

function readingGradeHtml(a) {
  const pct = a.full ? Math.round((a.total / a.full) * 100) : 0;
  const right = (a.items || []).filter((x) => x.verdict === '正确').length;
  return `<section class="mcard">
    <div class="mcard-total">
      <span class="big" style="color:${pct >= 85 ? 'var(--done)' : pct >= 60 ? 'var(--warn)' : 'var(--fail)'}">${fmtPts(a.total)}</span>
      <span class="of">/ ${fmtPts(a.full)} 分</span>
      <span class="pct" style="font-size:20px">${right} / ${a.items?.length || 0} 题</span>
    </div>
    <div class="mcard-sub">${esc(a.date || '')} · 用了 ${fmtClock(a.seconds)} / 参考 ${fmtClock(a.refSeconds)}</div>
    ${a.summary ? `<div class="mcard-body">${richInline(a.summary)}</div>` : ''}
  </section>
  ${
    S.story.analysis
      ? `<details class="fold"><summary>🔎 逐题定位与同义替换</summary><div class="fold-body">${mdToHtml(S.story.analysis)}</div></details>`
      : ''
  }`;
}

/** 按 `## 名字` 把正文切段（和桌面端 splitStorySections 一套规矩） */
function storySections(body) {
  const text = String(body || '');
  const idx = [...text.matchAll(/^##\s+(.+?)\s*$/gm)];
  return idx.map((m, i) => {
    const end = i + 1 < idx.length ? idx[i + 1].index : text.length;
    return [m[1].trim(), text.slice(m.index + m[0].length, end).trim()];
  });
}

/** 原文（去掉 ## 题目「答案速查」这些段，那些在「题目」页签里） */
function storyProse(body) {
  const text = String(body || '');
  const idx = [...text.matchAll(/^##\s+(.+?)\s*$/gm)];
  if (!idx.length) return text;
  const cut = idx.find((m) => /题目|答案|解析/.test(m[1]));
  return (cut ? text.slice(0, cut.index) : text).trim();
}

/** 目标词标蓝（只动标签之间的文本，不碰 HTML） */
function highlightWords(html, words) {
  const list = (words || []).map((x) => String(x).toLowerCase()).filter((x) => x.length >= 3);
  if (!list.length) return html;
  return html.replace(/>([^<]+)</g, (_m, text) =>
    `>${text.replace(/[A-Za-z][A-Za-z'-]*/g, (w) =>
      list.some((t) => w.toLowerCase().startsWith(t)) ? `<span class="story-word">${w}</span>` : w
    )}<`
  );
}

/* ---------- 底部操作条 ---------- */

function barHtml() {
  if (S.view.kind === 'reading') {
    const answered = Object.keys(S.reading.answers).length;
    // 这一篇还没读回来时也给个空条 —— 别在这里抛异常，那会把刚打开的那一屏卡在 loading
    const total = (S.story?.questions || []).length;
    if (S.reading.attempt) return '';
    return `<div class="mbar-row">
      <button class="btn-primary grow" data-act="local-grade"${answered ? '' : ' disabled'}>📊 对答案（已答 ${answered}/${total}）</button>
    </div>
    <div class="mbar-note">全是选择题，程序自己判 —— 不用拍照、不用调模型</div>`;
  }

  const rows = [photoStripHtml(), photoButtonsHtml()];
  if (S.view.kind === 'paper') {
    rows.push(`<div class="mbar-row">
      <button class="btn-primary grow" data-act="grade"${S.photos.length && !S.grade.busy && S.ai?.ready ? '' : ' disabled'}>
        🤖 判这${S.photos.length > 1 ? `${S.photos.length} 张` : '份'}答案</button>
    </div>`);
  } else {
    rows.push(`<div class="mbar-row">
      <button class="btn-primary grow" data-act="grade"${S.photos.length && !S.grade.busy && S.ai?.ready ? '' : ' disabled'}>
        🤖 判这一题</button>
    </div>`);
    const q = S.drill.queue;
    if (q.length > 1) {
      rows.push(`<div class="mbar-row">
        <button class="btn-ghost" data-act="prev"${S.drill.idx > 0 ? '' : ' disabled'}>‹ 上一题</button>
        <button class="btn-ghost" data-act="next"${S.drill.idx < q.length - 1 ? '' : ' disabled'}>下一题 ›</button>
        <span class="mbar-note" style="margin:0;align-self:center">${S.drill.idx + 1}/${q.length}</span>
      </div>`);
    }
  }
  return rows.join('');
}

function photoStripHtml() {
  if (!S.photos.length && !S.photoBusy) return '';
  return `<div class="mphoto-head">
      <b>手写答案</b><span>${S.photos.length} 张${S.photoBusy ? ' · 正在上传…' : ''}</span>
      ${S.photos.length ? '<button class="link-btn" data-act="clear-photos" style="margin-left:auto">清空</button>' : ''}
    </div>
    <div class="mphoto-strip">
      ${S.photos
        .map(
          (ph) => `<span class="mphoto">
        <img src="${ph.url}" alt="手写答案" data-act="zoom" data-src="${ph.url}" />
        <button data-act="drop-photo" data-name="${esc(ph.name)}" title="删掉这张">✕</button>
      </span>`
        )
        .join('')}
      <button class="mphoto-add" data-act="camera" title="再加一张">＋</button>
    </div>`;
}

function photoButtonsHtml() {
  return `<div class="mbar-row">
    <button class="btn-ghost grow" data-act="camera">📷 拍照</button>
    <button class="btn-ghost grow" data-act="album">🖼 相册</button>
  </div>`;
}

/** 判分 / 打包进度：只重画这一块，不动整页 */
function progressHtml() {
  if (!S.grade.busy && !S.grade.error) return '';
  if (S.grade.error) {
    return `<div class="callout callout-error"><div class="callout-head">⛔<span>判分失败</span></div>
      <div class="callout-body">${esc(S.grade.error)}</div></div>`;
  }
  const secs = Math.round((Date.now() - S.grade.t0) / 1000);
  return `<div class="mprog"><div class="spinner"></div>
    <div class="mprog-txt">正在按考研标准判…　已生成 <b>${S.grade.chars}</b> 字${
      S.grade.think ? ` · 思考 <b>${S.grade.think}</b> 字` : ''
    } · 等了 <b>${fmtClock(secs)}</b><br />大题的步骤要抠，通常要一两分钟，别锁屏</div></div>`;
}

function paintProgress() {
  const box = $('#mgradeZone');
  if (!box) return;
  const html = progressHtml();
  box.innerHTML = html;
  box.hidden = !html;
}

/** 判分区：进度 + 错误 + 一句提示 */
function gradePanelHtml() {
  return `<div id="mgradeZone"${progressHtml() ? '' : ' hidden'}>${progressHtml()}</div>
  ${
    !S.ai?.ready
      ? `<div class="callout callout-warning"><div class="callout-head">⚠️<span>还没配内置 AI</span></div>
    <div class="callout-body">手机端不配置接口 —— 先在电脑上进「设置」把接口和 key 填好，这边拍照判分立刻能用。</div></div>`
      : ''
  }`;
}

/* ============================================================
   七、打开某一屏
   ============================================================ */

async function openPaper(rel, { push = true } = {}) {
  await discardPhotos();
  S.view = { kind: 'paper', rel };
  S.paper = null;
  S.paperGrade = null;
  S.bankDone = null;
  S.grade = { busy: false, chars: 0, think: 0, error: null, t0: 0 };
  setHash(push);
  render({ keepScroll: false });
  try {
    const p = await api(`/api/test/paper?rel=${encodeURIComponent(rel)}`);
    if (!p.exists) throw new Error('找不到这份卷子');
    S.paper = p;
    S.paperGrade = p.last || null; // 上次判过分的话，一进来就能看到成绩
    enterTimer(`测试:${p.rel}`);
  } catch (err) {
    toast(`读不到这份卷子：${err.message}`, 'err');
    S.view = null;
  }
  render({ keepScroll: false });
}

async function openQuestion(id, { push = true, queue = null, idx = 0 } = {}) {
  await discardPhotos();
  S.view = { kind: 'question', id };
  S.problem = S.problems.find((x) => x.id === id) || null;
  S.qVerdict = null;
  S.qPending = null;
  S.qReason = '';
  S.grade = { busy: false, chars: 0, think: 0, error: null, t0: 0 };
  if (queue) S.drill = { queue, idx };
  setHash(push);
  render({ keepScroll: false });
  if (!S.problem) {
    // 队列里的题在别处被改过：重拉一次题库
    await loadDrillData({ silent: true });
    S.problem = S.problems.find((x) => x.id === id) || null;
    if (!S.problem) {
      toast('找不到这道题', 'err');
      S.view = null;
    }
    render({ keepScroll: false });
  }
  if (S.problem) enterTimer(`错题:${S.problem.id}`);
}

async function openReading(rel, { push = true } = {}) {
  await discardPhotos();
  S.view = { kind: 'reading', rel };
  S.story = null;
  S.reading = { tab: 'text', answers: {}, attempt: null };
  S.grade = { busy: false, chars: 0, think: 0, error: null, t0: 0 };
  setHash(push);
  render({ keepScroll: false });
  try {
    const st = await api(`/api/words/story?rel=${encodeURIComponent(rel)}`);
    if (!st.exists) throw new Error('找不到这一篇');
    S.story = st;
    S.reading.attempt = st.last || null;
    enterTimer(`阅读:${st.rel}`);
  } catch (err) {
    toast(`读不到这一篇：${err.message}`, 'err');
    S.view = null;
  }
  render({ keepScroll: false });
}

async function back() {
  await discardPhotos();
  S.view = null;
  S.paper = null;
  S.problem = null;
  S.story = null;
  S.paperGrade = null;
  S.qVerdict = null;
  S.drill = { queue: [], idx: 0 };
  setHash(true);
  render({ keepScroll: false });
  window.scrollTo(0, 0);
}

/** 换屏时把这一屏暂存但没用上的图删掉，别在 uploads 里堆垃圾 */
async function discardPhotos() {
  if (!S.photos.length) return;
  await dropPhotos();
  S.photos = [];
}

/* ---------- hash 路由：锁屏 / 刷新之后能回到刚才那一屏 ---------- */

/** 上一次已经路由过的 hash —— 用来吞掉 setHash 自己触发的那次 hashchange */
let routedHash = null;

function setHash(push) {
  const h = hashOf();
  routedHash = h;
  if (location.hash === h) return;
  if (push) location.hash = h;
  else history.replaceState(null, '', h);
}

function hashOf() {
  if (!S.view) return `#${S.tab}`;
  if (S.view.kind === 'paper') return `#paper=${encodeURIComponent(S.view.rel)}`;
  if (S.view.kind === 'question') return `#q=${encodeURIComponent(S.view.id)}`;
  return `#reading=${encodeURIComponent(S.view.rel)}`;
}

async function routeFromHash(rawHash) {
  // 优先用「这次变化的目标」（hashchange 事件自带的 newURL）：
  // 它不会被**之后的**改动带偏。以前比的是当下的 location.hash，
  // 手快连点两下（返回 → 马上进另一屏）时可能把旧那一屏又路由回来。
  const raw = rawHash || location.hash || '#today';
  // setHash() 自己会改 location.hash，那个 hashchange 不用再走一遍
  // （不然打开一份卷子会连拉两次 /api/test/paper）。
  if (raw === routedHash) return;
  routedHash = raw;
  const h = decodeURIComponent(raw.replace(/^#/, ''));
  if (h.startsWith('paper=')) return openPaper(h.slice(6), { push: false });
  if (h.startsWith('q=')) return openQuestion(h.slice(2), { push: false });
  if (h.startsWith('reading=')) return openReading(h.slice(8), { push: false });
  S.tab = h === 'drill' ? 'drill' : 'today';
  S.view = null;
  // **一定要重绘**：不能只在「刚才在全屏屏」时才画。
  // 手机浏览器左下角的后退、手改地址栏 hash，都会走到这里 ——
  // 不重绘的话点了没反应（页签不会切），或者停在一个已经退出的全屏屏上。
  render({ keepScroll: false });
}

/* ============================================================
   八、判分
   ============================================================ */

/** 读 NDJSON 流：服务端一行一个 JSON，边收边更新进度 */
async function readStream(res, onMessage) {
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
      onMessage(m);
    }
  }
}

async function runGrade() {
  if (!S.photos.length) return toast('先把答案的图片传上来', 'err');
  if (!S.ai?.ready) return toast('先在电脑上进「设置」把 AI 配好', 'err');

  const kind = S.view.kind;
  const names = S.photos.map((p) => p.name);
  const key = kind === 'paper' ? `测试:${S.paper.rel}` : `错题:${S.problem.id}`;
  const seconds = Math.round(elapsedMs(key) / 1000);
  // 交卷了：计时停在这一刻（判分要等模型，那几分钟不算我的做题用时）
  stopTimer(key);

  S.grade = { busy: true, chars: 0, think: 0, error: null, t0: Date.now() };
  render();
  $('#mgradeZone')?.scrollIntoView({ block: 'center' });

  try {
    const path = kind === 'paper' ? '/api/grade' : '/api/grade/question';
    const body = kind === 'paper' ? { rel: S.paper.rel, names, seconds } : { id: S.problem.id, names, seconds };
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${res.status}`);
    }
    await readStream(res, (m) => {
      if (m.t === 'delta') {
        S.grade.chars = m.chars;
        S.grade.think = m.think;
        paintProgress();
      } else if (m.t === 'done') {
        S.photos = []; // 服务端判完就把暂存图片清掉了
        if (kind === 'paper') S.paperGrade = m.result?.attempt || m.result || null;
        else S.qVerdict = { ...m.verdict, suggest: m.verdict.result, hadFirstReason: !!S.problem.firstReason };
      } else if (m.t === 'error') {
        S.grade.error = m.message;
      }
    });
  } catch (err) {
    S.grade.error = String(err.message || err);
  } finally {
    S.grade.busy = false;
    render();
    if (S.grade.error) toast(`判分失败：${S.grade.error}`, 'err');
    else if (kind === 'paper' && S.paperGrade) toast(`判完了：${fmtPts(S.paperGrade.total)} / ${fmtPts(S.paperGrade.full)}`, 'ok');
    else if (S.qVerdict) toast(`判完了：${S.qVerdict.score}/100（建议 ${S.qVerdict.result}）`, 'ok');
    $('#mgradeZone')?.scrollIntoView({ block: 'center' });
  }
}

/** 英语：本地判卷（全是选择题，不用拍照也不用调模型） */
async function localGrade() {
  const st = S.story;
  if (!Object.keys(S.reading.answers).length) return toast('先选几个答案', 'err');
  S.grade.busy = true;
  render();
  try {
    const out = await api('/api/grade/local', {
      method: 'POST',
      body: JSON.stringify({
        rel: st.rel,
        answers: S.reading.answers,
        seconds: Math.round(elapsedMs(`阅读:${st.rel}`) / 1000),
      }),
    });
    S.reading.attempt = out.attempt;
    S.reading.tab = 'quiz';
    // 对完答案就是做完了：计时停在这儿，别让它在阅读页上一直往上走
    stopTimer(`阅读:${st.rel}`);
    toast(`判完了：${fmtPts(out.attempt.total)} / ${fmtPts(out.attempt.full)}`, 'ok');
  } catch (err) {
    toast(`判卷失败：${err.message}`, 'err');
  } finally {
    S.grade.busy = false;
    render({ keepScroll: false });
  }
}

/** 一键把这次做错的题收进错题本（错因、丢分点、该怎么改一起带过去） */
async function addWrongToBank() {
  const g = S.paperGrade;
  const items = (g?.items || []).filter((x) => Number(x.score) < Number(x.full));
  if (!items.length) return toast('这次没有做错的题 🎉');
  try {
    const out = await api('/api/test/to-bank', {
      method: 'POST',
      body: JSON.stringify({
        rel: S.paper.rel,
        book: 'mistakes',
        items: items.map((x) => ({ n: x.n, reason: x.reason || '', lost: x.lost || '', fix: x.fix || '' })),
      }),
    });
    const created = out.created?.created || out.created || [];
    S.bankDone = items.map((x) => x.n);
    await loadDrillData({ silent: true });
    toast(`已加入错题本：${created.length || items.length} 道`, 'ok');
  } catch (err) {
    toast(`加入错题本失败：${err.message}`, 'err');
  }
  render();
}

/* ============================================================
   九、记进笔记
   ============================================================ */

/**
 * 把面板上**还没提交的改动**收回状态里。
 *
 * 判分面板上「结果 / 错因」是可点 chip，点一下要重绘；而「错因分析」是一个自由文本框，
 * 重绘会把 textarea 重新按 `S.qVerdict.analysis` 生成 —— 不先收回来，
 * 我刚敲的几百字就被自己冲掉了。所以凡是重绘之前，先把草稿同步进状态。
 */
function syncVerdictDraft() {
  if (!S.qVerdict) return;
  const ta = $('#qAnalysis');
  if (ta) S.qVerdict.analysis = ta.value;
  const cb = $('#qFirstReason');
  if (cb) S.qVerdict.setFirstReason = cb.checked;
}

/** 把这次单题判分按我现在定的内容记进笔记 */
async function commitVerdict() {
  const v = S.qVerdict;
  if (!v) return;
  syncVerdictDraft();
  const analysis = ($('#qAnalysis')?.value ?? v.analysis ?? '').trim();
  const setFirst = $('#qFirstReason') ? !!$('#qFirstReason').checked : !!v.setFirstReason;
  S.qVerdict = null;
  await checkin(v.result, v.reason || null, { analysis, setFirstReason: setFirst });
}

/** 手动打卡那条路 */
async function commitRecord() {
  await checkin(S.qPending, S.qReason || null, {});
}

async function checkin(result, reason, extra = {}) {
  const p = S.problem;
  if (!p) return;
  const key = `错题:${p.id}`;
  const seconds = Math.max(1, Math.round(elapsedMs(key) / 1000));
  S.qPending = null;
  S.qReason = '';
  try {
    await api('/api/checkin', {
      method: 'POST',
      body: JSON.stringify({
        id: p.id,
        result,
        seconds,
        reason: reason || null,
        analysis: extra.analysis || undefined,
        setFirstReason: !!extra.setFirstReason,
      }),
    });
    resetTimer(key); // 记完了重新计时，方便再练一遍
    await loadDrillData({ silent: true });
    S.problem = S.problems.find((x) => x.id === p.id) || S.problem;
    toast(`${p.num} → ${result}${reason ? `（${reason}）` : ''} · ${fmtSpan(seconds)}`, result === '完美' ? 'ok' : '');
  } catch (err) {
    toast(`打卡失败：${err.message}`, 'err');
  }
  render();
}

/* ============================================================
   十、事件
   ============================================================ */

const ACTIONS = {
  async refresh() {
    toast('正在重新读取…');
    await refresh({ silent: true });
    toast('已刷新', 'ok');
  },
  async back() {
    await back();
  },
  tab(el) {
    S.tab = el.dataset.tab;
    setHash(true);
    render({ keepScroll: false });
    window.scrollTo(0, 0);
  },
  timer() {
    toggleTimer();
  },
  async task(input) {
    const rel = input.dataset.rel;
    const done = input.checked;
    if (!rel) {
      input.checked = !done;
      return toast('这条任务没有来源文件，无法写回', 'err');
    }
    input.disabled = true;
    try {
      await api('/api/task', {
        method: 'POST',
        body: JSON.stringify({ rel, expect: input.dataset.text, occurrence: Number(input.dataset.occ) || 0, done }),
      });
      await loadToday({ silent: true });
      render();
      toast(done ? '已勾选' : '已取消勾选', 'ok');
    } catch (err) {
      input.checked = !done;
      input.disabled = false;
      toast(`写回失败：${err.message}`, 'err');
    }
  },
  'open-paper': (el) => openPaper(el.dataset.rel),
  'open-question': (el) => openQuestion(el.dataset.id),
  'open-reading': (el) => openReading(el.dataset.rel),
  filter(el) {
    S.qFilter = el.dataset.key;
    render();
  },
  'start-drill'(el) {
    const mode = el.dataset.mode;
    // 「按优先级」= 热度×2 + 难度 − 已打卡次数×0.5 + 失败过×1.5，再叠一点随机抖动
    const pool = (mode === 'due' ? S.problems.filter((p) => p.stats.status === '待复习') : S.problems)
      .map((p) => ({
        p,
        key:
          (p.heat * 2 + p.difficulty - p.stats.total * 0.5 + (p.stats.fail > 0 ? 1.5 : 0)) *
          (0.8 + Math.random() * 0.4),
      }))
      .sort((a, b) => b.key - a.key)
      .map((x) => x.p.id);
    if (!pool.length) return toast('这个范围里没有题', 'err');
    openQuestion(pool[0], { queue: pool, idx: 0 });
  },
  prev() {
    if (S.drill.idx <= 0) return;
    openQuestion(S.drill.queue[S.drill.idx - 1], { queue: S.drill.queue, idx: S.drill.idx - 1 });
  },
  next() {
    if (S.drill.idx >= S.drill.queue.length - 1) return;
    openQuestion(S.drill.queue[S.drill.idx + 1], { queue: S.drill.queue, idx: S.drill.idx + 1 });
  },
  camera() {
    $('#camShot').click();
  },
  album() {
    $('#albumPick').click();
  },
  'drop-photo': (el) => dropPhotos([el.dataset.name]).then(() => render()),
  'clear-photos': () => dropPhotos().then(() => render()),
  grade() {
    runGrade();
  },
  'local-grade'() {
    localGrade();
  },
  'to-bank'() {
    addWrongToBank();
  },
  'reading-tab'(el) {
    S.reading.tab = el.dataset.tab;
    render();
  },
  answer(el) {
    if (S.reading.attempt) return;
    S.reading.answers[el.dataset.n] = el.dataset.key;
    render();
  },
  record(el) {
    S.qPending = el.dataset.result;
    S.qReason = '';
    render();
  },
  'pick-reason'(el) {
    S.qReason = S.qReason === el.dataset.reason ? '' : el.dataset.reason;
    render();
  },
  'cancel-record'() {
    S.qPending = null;
    S.qReason = '';
    render();
  },
  'commit-record'() {
    commitRecord();
  },
  'set-result'(el) {
    syncVerdictDraft(); // 先把我改到一半的「错因分析」收回来，别被这次重绘冲掉
    S.qVerdict.result = el.dataset.result;
    render();
  },
  'set-reason'(el) {
    syncVerdictDraft();
    S.qVerdict.reason = el.dataset.reason;
    render();
  },
  'drop-verdict'() {
    S.qVerdict = null;
    render();
    toast('这次判分没记，笔记一个字节没动');
  },
  'commit-verdict'() {
    commitVerdict();
  },
  zoom(el) {
    const box = $('#mzoom');
    box.querySelector('img').src = el.dataset.src || el.src;
    box.hidden = false;
  },
};

document.addEventListener('click', async (ev) => {
  // 大图开着的时候，点哪儿都先关掉它（点另一张缩略图除外，那要换成新的一张）
  const zoom = $('#mzoom');
  if (!zoom.hidden && !ev.target.closest('[data-act="zoom"]')) {
    zoom.hidden = true;
    zoom.querySelector('img').src = '';
    return;
  }
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (act === 'search' || act === 'task') return; // 这两个走各自的事件
  const fn = ACTIONS[act];
  if (!fn) return;
  ev.preventDefault();
  try {
    await fn(el, ev);
  } catch (err) {
    toast(String(err.message || err), 'err');
  }
});

// 搜索框：输入即筛（纯本地筛，不打服务端）。只重画列表那一段，
// 整页重绘会把输入焦点和滚动位置一起弄丢。
document.addEventListener('input', (ev) => {
  // 错因分析的渲染预览跟着输入变（文本框里保持原文，那是要存进笔记的）
  if (ev.target.id === 'qAnalysis') {
    const host = $('#qAnalysisMd');
    if (host) host.innerHTML = mdPreview(ev.target.value);
  }
  if (ev.target.id !== 'qSearch') return;
  S.qSearch = ev.target.value;
  const box = $('#qList');
  if (box) box.innerHTML = problemRowsHtml();
});

// 勾选任务
document.addEventListener('change', (ev) => {
  const el = ev.target;
  if (el.dataset?.act === 'task') ACTIONS.task(el);
});

// 选图 → 上传
$('#camShot').addEventListener('change', (ev) => {
  addPhotos(ev.target.files);
  ev.target.value = ''; // 同一个文件再拍一次也要能触发
});
$('#albumPick').addEventListener('change', (ev) => {
  addPhotos(ev.target.files);
  ev.target.value = '';
});

// 长按计时器归零（手机上不容易误触）
let holdTimer = null;
document.addEventListener('pointerdown', (ev) => {
  const t = ev.target.closest('[data-act="timer"]');
  if (!t) return;
  holdTimer = setTimeout(() => {
    holdTimer = null;
    resetTimer();
    toast('计时已归零');
  }, 700);
});
for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
  document.addEventListener(type, () => {
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  });
}

window.addEventListener('hashchange', (ev) => {
  // 用事件自带的 newURL，而不是当下的 location.hash —— 后者可能已经被**后来**的
  // 一次改动改掉了，那样会把上一个 hash 当成新目标，莫名其妙地退回上一屏。
  let target = '';
  try {
    target = new URL(ev.newURL).hash;
  } catch {
    target = location.hash;
  }
  routeFromHash(target);
});

/* ============================================================
   十一、启动
   ============================================================ */

loadTimers();
await refresh({ silent: false });
await routeFromHash();
startTick();
render({ keepScroll: false });
