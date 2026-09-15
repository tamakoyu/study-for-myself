/**
 * maimemo.mjs —— 墨墨背单词开放 API（学习数据）
 *
 * 只做四件事：
 *   1. 读背词进度：今日完成 / 今日应完成 / 学习时长 / 计划总量 / 今日到期 / 易忘词
 *   2. 把「近日还没背下来的词」整理成一份候选清单（今日没背完的 + 今天背了没记住的）
 *   3. 生成「用这些词写一篇短文」的提示词，交给 AI
 *   4. 把 AI 写好的故事存回仓库（`单词故事/YYYY-MM-DD-故事.md`）
 *
 * token 只从环境变量或 `study-app/.maimemo-token` 读（都已 gitignore），
 * **绝不写进 config.json** —— config.json 是要入库的。
 *
 * 接口都是 POST，路径前缀 /open/api/v1/memo，鉴权头 Authorization: Bearer <token>。
 * 频控：20 次/10 秒、40 次/60 秒、2000 次/5 小时 —— 所以这里所有读接口都带缓存。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { today } from './parse.mjs';
import { backupFile } from './vault.mjs';
import {
  ENGLISH_FULL, gradePaper, readGradeRecords, writeGradeRecord, preserveGradeSection,
} from './grade.mjs';

const API = 'https://open.maimemo.com/open/api/v1/memo';
const TIMEOUT_MS = 12000;

/** study-app/ 目录（与 notebook.mjs 的 APP_DIR 同一个地方） */
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ============================================================
   token
   ============================================================ */

/** token 落盘位置（study-app/.maimemo-token，已在 .gitignore 里） */
export function tokenPath() {
  return path.join(APP_DIR, '.maimemo-token');
}

/** 按 环境变量 → 本地文件 → config 的顺序找 token */
export function readToken(cfg = {}) {
  const env = String(process.env.MAIMEMO_TOKEN || '').trim();
  if (env) return { token: env, source: 'env' };
  const file = tokenPath();
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t) return { token: t, source: 'file', file };
  } catch {
    /* 没有就没有 */
  }
  const fromCfg = String(cfg.maimemoToken || '').trim();
  if (fromCfg) return { token: fromCfg, source: 'config' };
  return null;
}

/** 写入本地 token 文件（600 权限），返回落盘路径 */
export function writeToken(token) {
  const clean = String(token || '').trim();
  if (!clean) throw Object.assign(new Error('token 不能为空'), { status: 400 });
  const file = tokenPath();
  fs.writeFileSync(file, `${clean}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows 上可能不支持，忽略 */
  }
  return file;
}

/** 有 token 但接口说没授权 → 大概率是网页取的那份 7 天到期了 */
function humanError(err) {
  if (err?.code === 'no_token') return '还没配置墨墨 token，先在「单词」页点「设置 token」';
  if (err?.code === 'unauthorized') return 'token 无效或已过期（网页取的有效期只有 7 天），重新取一个粘贴进来即可';
  if (err?.code === 'offline') return '连不上墨墨服务器（检查网络，或者稍后再试）';
  if (err?.code === 'beta') return '墨墨学习数据接口处于公测，暂时不可用';
  return err?.message || '读取墨墨数据失败';
}

/** 完全断网模式：MAIMEMO_OFF=1 时一个请求都不发（跑端到端测试 / 离线用） */
export function isOff() {
  return String(process.env.MAIMEMO_OFF || '') === '1';
}

const OFF_RESULT = {
  ok: false,
  error: '墨墨接口已关闭（MAIMEMO_OFF=1）',
  code: 'off',
};

/* ============================================================
   HTTP
   ============================================================ */

async function call(cfg, route, body = {}) {
  const auth = readToken(cfg);
  if (!auth) throw Object.assign(new Error('没有 token'), { code: 'no_token' });

  let res;
  try {
    res = await fetch(API + route, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw Object.assign(new Error(err.message || '网络错误'), { code: 'offline' });
  }

  let json = null;
  try {
    json = JSON.parse(await res.text());
  } catch {
    throw Object.assign(new Error(`HTTP ${res.status}`), { code: 'offline' });
  }

  if (res.status === 401 || json?.success === false) {
    const first = json?.errors?.[0] || {};
    const err = new Error(first.msg || `HTTP ${res.status}`);
    if (res.status === 401 || first.code === 'common_unauthorized') err.code = 'unauthorized';
    else if (String(first.code || '').includes('invalid_param')) err.code = 'beta';
    else err.code = 'api';
    err.detail = first;
    throw err;
  }
  // 真实返回是 { errors: [], data: {...}, success: true }，值都在 data 里
  return json?.data ?? {};
}

/* ============================================================
   缓存（接口有频控，首页又会被反复加载）
   ============================================================ */

const memo = new Map();

function ttlOf(cfg) {
  const n = Number(cfg?.maimemoCacheSeconds);
  return Number.isFinite(n) && n >= 0 ? n * 1000 : 90_000;
}

/** 带 TTL 的缓存；force 时跳过；失败时把上一次的好数据回吐出去 */
async function cached(key, ttl, force, fn) {
  const hit = memo.get(key);
  if (!force && hit && Date.now() - hit.at < ttl) return hit.data;
  try {
    const data = await fn();
    memo.set(key, { at: Date.now(), data });
    return data;
  } catch (err) {
    if (hit) {
      err.stale = { data: hit.data, at: hit.at };
    }
    throw err;
  }
}

export function clearCache() {
  memo.clear();
}

/* ============================================================
   点词：拼写 → voc_id，以及「加进我的学习计划」
   官方接口（open.maimemo.com/open/api/v1）：
     POST /vocabulary/query   { spellings:[...] }        → { voc:[{id, spelling}] }
     POST /study/add_words    { words:[{id}], advance }  → { added_count }
   词库里没有的词不会出现在返回里 —— 那种词加不进计划，要如实告诉用户。
   ============================================================ */

/** 拼写 → voc_id（没查到存 null，免得同一个词反复重查；接口有 20/10s 的频控） */
const vocIdCache = new Map();

export async function lookupVocIds(cfg, spellings) {
  const list = [
    ...new Set((spellings || []).map((x) => String(x || '').trim().toLowerCase()).filter(Boolean)),
  ];
  const out = new Map();
  const need = [];
  for (const s of list) {
    if (vocIdCache.has(s)) out.set(s, vocIdCache.get(s));
    else need.push(s);
  }
  if (need.length) {
    for (let i = 0; i < need.length; i += 100) {
      const batch = need.slice(i, i + 100);
      const data = await call(cfg, '/vocabulary/query', { spellings: batch });
      const got = new Map();
      for (const v of data?.voc || []) {
        if (v?.id && v?.spelling) got.set(String(v.spelling).toLowerCase(), v.id);
      }
      for (const s of batch) {
        const id = got.get(s) || null;
        vocIdCache.set(s, id);
        out.set(s, id);
      }
    }
  }
  return out;
}

/**
 * 把词加进墨墨的学习计划。
 *
 * `advance: true` = 顺便提前到「立即复习」（`add_words` 这条路**不受等级限制**，
 * 而单独的 advance_study 要 10 级以上 —— 所以这里直接用 add_words 的 advance）。
 */
export async function addWordsToPlan(cfg, vocIds, { advance = false } = {}) {
  const ids = [...new Set((vocIds || []).filter(Boolean))];
  if (!ids.length) throw Object.assign(new Error('没有可加入的词'), { status: 400 });
  const data = await call(cfg, '/study/add_words', {
    words: ids.map((id) => ({ id })),
    advance: !!advance,
  });
  clearCache(); // 计划变了，首页 / 单词页那些缓存要作废
  return { added: Number(data?.added_count) || 0, requested: ids.length, advance: !!advance };
}

function agoText(at) {
  const min = Math.round((Date.now() - at) / 60000);
  return min <= 0 ? '刚刚' : `${min} 分钟前`;
}

/* ============================================================
   概览：今日进度 + 总的
   ============================================================ */

/** 北京时区「今天结束」，用来数今天到期该复习多少词 */
function endOfToday() {
  return `${today()}T23:59:59+08:00`;
}

async function fetchOverview(cfg) {
  const [progress, plan, due, sticking] = await Promise.all([
    call(cfg, '/study/get_study_progress'), // 今日完成 / 今日应完成 / 学习时长
    call(cfg, '/study/query_study_records', { as_count: true }), // 计划总词数
    call(cfg, '/study/query_study_records', { next_study_date: { end: endOfToday() }, as_count: true }),
    call(cfg, '/study/query_study_records', { tags: 'STICKING', as_count: true }), // 易忘词
  ]);

  const p = progress.progress || {};
  const finished = p.finished ?? 0;
  const total = p.total ?? 0;
  return {
    date: today(),
    progress: {
      finished,
      total,
      remaining: Math.max(0, total - finished),
      rate: total ? Math.round((finished / total) * 100) : 0,
      studyTimeMs: p.study_time ?? 0,
      studyMinutes: Math.round((p.study_time ?? 0) / 60000),
    },
    plan: {
      totalWords: plan.count ?? 0, // 计划里一共多少词
      dueToday: due.count ?? 0, // 今天到期该复习多少词
      sticking: sticking.count ?? 0, // 一直记不住的词（墨墨打标）
    },
    fetchedAt: Date.now(),
  };
}

/**
 * 读概览。**永远不抛异常** —— 首页不能因为墨墨挂了就打不开。
 * 失败时回吐上一次的好数据（带 stale 标记），没有就返回 { ok:false, error }。
 */
export async function overview(cfg, { force = false } = {}) {
  const hasToken = !!readToken(cfg);
  if (isOff()) return { ...OFF_RESULT, hasToken };
  const ttl = ttlOf(cfg);
  try {
    const data = await cached(`overview:${today()}`, ttl, force, () => fetchOverview(cfg));
    return { ok: true, hasToken: true, ...data };
  } catch (err) {
    const base = { ok: false, hasToken, error: humanError(err), code: err.code || null };
    if (err.stale) {
      return { ...err.stale.data, ok: false, hasToken, error: base.error, stale: agoText(err.stale.at) };
    }
    return base;
  }
}

/* ============================================================
   近日还没背下来的词
   ============================================================ */

/**
 * 词池的「来源」。一个词可能同时命中好几类，前端可以多选，按 voc_id 去重。
 *
 * 数据来源分两边：
 *   - `get_today_items`：今日词表，带 is_finished / is_new / first_response
 *   - `query_study_records`：整个计划的记录，带 study_count / last_response / add_date / tags
 *     注意这个接口**只能一页 1000 条**（而且不按 next_study_date 排序，翻页翻不动），
 *     所以「背了多次还不熟」「今日新加」「易忘词」都是**在前 1000 条里筛的**，
 *     计划超过 1000 词时会漏。界面上会把这件事标出来。
 */
const RESPONSE_LABEL = {
  FAMILIAR: '认识',
  VAGUE: '模糊',
  FORGET: '忘记',
  WELL_FAMILIAR: '熟知',
  CANCEL_WELL_FAMILIAR: '取消熟知',
  STUDY_RESPONSE_UNSPECIFIED: '还没背',
};

/**
 * 统一成一个形状，前端好处理。
 * 拼写是空的直接丢掉 —— 墨墨的返回里确实混着这种脏数据（一条 `voc_spelling: ""` 的记录），
 * 留着它会让「选了 60 个词」实际只出 59 个。
 */
function shapeWord({
  voc_id, spelling, why, order = 0, is_new = false, study_count = null, response = null, due = 0,
}) {
  const text = String(spelling || '').trim();
  if (!voc_id || !text) return null;
  return {
    voc_id,
    spelling: text,
    why,
    order,
    is_new,
    study_count,
    response,
    responseLabel: response ? RESPONSE_LABEL[response] || response : null,
    // 到期时间戳（ms）。漏了这一个字段，「整个计划」既排不了序、排期统计也全是 0
    due: Number(due) || 0,
  };
}

/** 去掉 shapeWord 丢出来的 null */
const clean = (list) => list.filter(Boolean);

/**
 * 把整个计划的记录拉全。
 *
 * 官方文档：`query_study_records` 一页最多 1000 条，用 `next_study_date.start`
 * 往后滑窗口就能翻页（实测有效：1000 + 175 条 = 计划里 1027 个词）。
 * 原来这里只取一页，于是计划一超过 1000 词，「易忘词 / 背了多次还不熟 / 今日新加」
 * 这几类来源就会漏 —— 界面上只写了句「记录只取了前 1000 条」。
 *
 * 跟 `as_count` 数出来的总数对不上一点（1027 vs 1133）是接口自己的事，
 * 那部分记录列不出来，只能如实标「记录只拿到 N 条」。
 */
async function fetchAllRecords(cfg) {
  const seen = new Map();
  let start = null;
  let page = 0;
  for (;;) {
    const body = { limit: 1000 };
    if (start) body.next_study_date = { start };
    const data = await call(cfg, '/study/query_study_records', body);
    const recs = data.records || [];
    for (const r of recs) if (r?.voc_id && !seen.has(r.voc_id)) seen.set(r.voc_id, r);
    page += 1;
    const last = recs[recs.length - 1]?.next_study_date;
    if (recs.length < 1000 || !last || page >= 6) break; // 6 页够 6000 词，别把接口打爆
    start = last;
  }
  return { records: [...seen.values()], pages: page, complete: page < 6 };
}

async function fetchPool(cfg) {
  const day = today();
  const [todayData, recData] = await Promise.all([
    call(cfg, '/study/get_today_items', { limit: 1000 }),
    fetchAllRecords(cfg),
  ]);
  const items = todayData.today_items || [];
  const recs = recData.records || [];

  const todayItem = (x) =>
    shapeWord({
      voc_id: x.voc_id,
      spelling: x.voc_spelling,
      order: x.order ?? 0,
      is_new: !!x.is_new,
      response: x.first_response === 'STUDY_RESPONSE_UNSPECIFIED' ? null : x.first_response,
      why: !x.is_finished
        ? '今天该背还没背'
        : x.first_response === 'FORGET'
          ? '今天背了 · 忘了'
          : '今天背了 · 模糊',
    });

  // ① 今天还没背下来的：没背完的 + 背了但模糊/忘记的
  const todayWords = clean(
    items
      .filter((x) => !x.is_finished || x.first_response === 'FORGET' || x.first_response === 'VAGUE')
      .map(todayItem)
  ).sort((a, b) => Number(!!a.response) - Number(!!b.response) || a.order - b.order);

  // ② 今日新学（今天第一次背的新词）
  const newWords = clean(items.filter((x) => x.is_new).map(todayItem)).sort((a, b) => a.order - b.order);

  // ③ 今日新加（今天才加进计划的）
  const addedWords = clean(
    recs
      .filter((r) => String(r.add_date || '').slice(0, 10) === day)
      .map((r) =>
        shapeWord({
          voc_id: r.voc_id,
          spelling: r.voc_spelling,
          why: '今天刚加进计划',
          study_count: r.study_count,
          response: r.last_response,
        })
      )
  );

  // ④ 背了多次还不熟：复习过几遍，最近一次还是模糊/忘记（study_count 由前端按阈值再筛）
  const rustyWords = clean(
    recs
      .filter((r) => r.last_response === 'FORGET' || r.last_response === 'VAGUE')
      .map((r) =>
        shapeWord({
          voc_id: r.voc_id,
          spelling: r.voc_spelling,
          why: `背了 ${r.study_count} 次 · 最近一次${RESPONSE_LABEL[r.last_response] || r.last_response}`,
          study_count: r.study_count,
          response: r.last_response,
        })
      )
  ).sort((a, b) => (b.study_count || 0) - (a.study_count || 0));

  // ⑤ 易忘词（墨墨自己打的标）
  const stickingWords = clean(
    recs
      .filter((r) => (r.tags || []).includes('STICKING'))
      .map((r) =>
        shapeWord({
          voc_id: r.voc_id,
          spelling: r.voc_spelling,
          why: `墨墨标的易忘词 · 背了 ${r.study_count} 次`,
          study_count: r.study_count,
          response: r.last_response,
        })
      )
  ).sort((a, b) => (b.study_count || 0) - (a.study_count || 0));

  // ⑥ 整个计划：把翻页拉到的所有记录都摆出来，按**到期日**排（最近要复习的在前）。
  //    这是「不从今天的词表里挑」的那条路 —— 计划里 1000 多个词都能选到。
  const dayMs = 86400000;
  const now = Date.now();
  const planWords = clean(
    recs.map((r) => {
      const due = r.next_study_date ? Date.parse(r.next_study_date) : NaN;
      const days = Number.isFinite(due) ? Math.round((due - now) / dayMs) : null;
      const seen = r.study_count ? `背过 ${r.study_count} 次` : '还没背过';
      const last = r.last_response ? `最近一次${RESPONSE_LABEL[r.last_response] || r.last_response}` : '';
      return shapeWord({
        voc_id: r.voc_id,
        spelling: r.voc_spelling,
        why: [days == null ? '排期未知' : days <= 0 ? '已到期' : `${days} 天后到期`, seen, last]
          .filter(Boolean)
          .join(' · '),
        study_count: r.study_count,
        response: r.last_response,
        due: Number.isFinite(due) ? due : 0,
      });
    })
  ).sort((a, b) => (a.due || 0) - (b.due || 0));

  const groups = {
    today: { label: '今天没背完', hint: '今日词表里还没背、或者背了没记住的', words: todayWords },
    new: { label: '今日新学', hint: '今天第一次背的新词', words: newWords },
    rusty: { label: '背了多次还不熟', hint: '复习过好几遍，最近一次还是模糊 / 忘记', words: rustyWords, byCount: true },
    sticking: { label: '易忘词', hint: '墨墨标了「一直记不住」的词', words: stickingWords },
    added: { label: '今日新加', hint: '今天才加进墨墨计划的词', words: addedWords },
    // 默认不勾：选词默认还是「今天的词池」，这一条是给「想从整个计划里挑」的时候用的
    plan: {
      label: '整个计划',
      hint: '计划里的全部单词，按到期日排（最近要复习的在前）——不从今天词表里挑时用这个',
      words: planWords,
      wholePlan: true,
    },
  };

  return {
    all: items.length,
    studied: items.filter((x) => x.is_finished).length,
    unfinished: items.filter((x) => !x.is_finished).length,
    fresh: newWords.length,
    groups,
    /**
     * 整个计划的进度/统计。
     *
     * **一律从 planWords（已经过 shapeWord：去重、丢掉空拼写的脏数据）里算** ——
     * 之前分子分母分别取自 recs 和 planWords，于是出现「已学 1027 / 共 1026」这种鬼话。
     * 「今天到期」也用 `endOfToday()` 这个口径，跟首页那张卡（接口自己数出来的）对得上；
     * 「此刻已过期」是另一个概念（今天还没过完，大部分今天的词并不算过期），单独给。
     */
    planStats: (() => {
      const endToday = Date.parse(endOfToday());
      const now = Date.now();
      const withDue = planWords.filter((w) => w.due);
      return {
        listed: planWords.length, // 接口能列出来的词数（count 数得到、列表拿不到的会少一点）
        studied: planWords.filter((w) => (w.study_count || 0) > 0).length, // 至少背过一次
        neverStudied: planWords.filter((w) => !w.study_count).length,
        dueToday: withDue.filter((w) => w.due <= endToday).length, // 和首页「今日到期」同一个口径
        overdueNow: withDue.filter((w) => w.due <= now).length, // 此刻就已经过了复习点的
        dueWeek: withDue.filter((w) => w.due > endToday && w.due <= endToday + 7 * 86400000).length,
      };
    })(),
    // 记录接口一页最多 1000 条，这里是翻页拉全的；对不上总数时如实说明
    recordsSeen: recs.length,
    recordsPages: recData.pages || 1,
    recordsTruncated: recData.complete === false,
    fetchedAt: Date.now(),
  };
}

/** 待背词池。同样不抛 —— 失败给空池 + error */
export async function pool(cfg, { force = false } = {}) {
  const empty = {
    all: 0, studied: 0, unfinished: 0, fresh: 0,
    groups: {}, recordsSeen: 0, recordsTruncated: false,
  };
  if (isOff()) return { ...OFF_RESULT, ...empty };
  const ttl = ttlOf(cfg);
  try {
    const data = await cached(`pool:${today()}`, ttl, force, () => fetchPool(cfg));
    return { ok: true, ...data };
  } catch (err) {
    const base = { ok: false, error: humanError(err), code: err.code || null, ...empty };
    if (err.stale) return { ...err.stale.data, ok: false, error: base.error, stale: agoText(err.stale.at) };
    return base;
  }
}

/* ============================================================
   故事：提示词 + 存取
   ============================================================ */

/** 故事目录（仓库里，默认 `单词故事/`） */
export function storyDirOf(cfg) {
  return cfg.storyDir || path.join(cfg.vaultDir, '单词故事');
}

/** 一天可以出多篇，所以文件名带序号和题型：`2026-09-14-01-传统阅读·主旨题.md` */
export function paperRelOf(cfg, date, seq, typeId) {
  const t = paperTypeOf(typeId);
  const tag = t ? (t.group === t.label ? t.label : `${t.group}·${t.label}`) : '故事';
  return `${path.basename(storyDirOf(cfg))}/${date}-${String(seq).padStart(2, '0')}-${tag}.md`;
}

/** 把 rel 解析成绝对路径，并确保只在故事目录里（不接受 ../、不接受别的目录） */
function storyAbsOf(cfg, rel) {
  const dir = storyDirOf(cfg);
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.includes('..')) throw Object.assign(new Error('非法路径'), { status: 400 });
  const abs = path.resolve(cfg.vaultDir, clean);
  if (!abs.startsWith(dir + path.sep)) throw Object.assign(new Error('只能读写故事目录里的文件'), { status: 403 });
  if (!abs.endsWith('.md')) throw Object.assign(new Error('只能操作 .md 文件'), { status: 400 });
  return abs;
}

/** 抠出 frontmatter 里的 words / title（只认本项目自己写的简单格式） */
function parseStory(text) {
  const fm = {};
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (m) {
    let key = null;
    for (const line of m[1].split(/\r?\n/)) {
      const item = line.match(/^\s+-\s+(.+?)\s*$/);
      if (item && key) {
        if (!Array.isArray(fm[key])) fm[key] = [];
        fm[key].push(item[1]);
        continue;
      }
      const kv = line.match(/^([^\s:][^:]*?)\s*:\s*(.*)$/);
      if (kv) {
        key = kv[1].trim();
        fm[key] = kv[2].trim();
      }
    }
  }
  const h1 = String(text).match(/^#\s+(.+)$/m);
  // 剥掉 frontmatter，顺手去掉它后面残留的空行，正文从头开始
  const body = (m ? String(text).slice(m[0].length) : String(text)).replace(/^\s*\n/, '');
  const questions = parseQuestions(body);
  return {
    title: fm.title || (h1 ? h1[1].trim() : ''),
    words: Array.isArray(fm.words) ? fm.words : [],
    body,
    prose: proseOf(body),
    questions,
    key: parseKey(body),
    // 判分时要把「每个干扰项为什么错」的依据给模型，所以整段解析一起带上
    analysis: sectionOf(body, '答案解析'),
    frontmatter: fm,
    grades: readGradeRecords(body),
    plan: gradePaper({
      kind: 'story',
      title: fm.title || (h1 ? h1[1].trim() : ''),
      type: fm.type || '',
      full: ENGLISH_FULL,
      questions,
    }),
  };
}

/** 取 `## 名字` 这一节（到下一个 `##` 为止） */
function sectionOf(body, name) {
  const m = new RegExp(`^##\\s*${name}\\s*$`, 'm').exec(String(body));
  if (!m) return '';
  const rest = String(body).slice(m.index + m[0].length);
  const cut = rest.search(/^##\s/m);
  return (cut === -1 ? rest : rest.slice(0, cut)).trim();
}

/**
 * 「生词回收」表按**词在文中出现的先后**重排（只影响读出来的样子，文件一个字节都不动）。
 *
 * 顺序不该由模型的心情决定，也不该逼着我为了排序去重生成老笔记 —— 读的时候排一遍就行。
 * 认词形变化的口径和正文标蓝一致：文中那个词**以目标词开头**就算命中（obtain → obtained）；
 * 一个都没在正文里找到的排在最后，并保持它们原来的相对顺序。
 */
export function sortVocabByArticleOrder(body, prose = '') {
  const text = String(body || '');
  // 定位 `## 生词回收` 那一节（到下一个 `## ` 或文件末尾为止）
  const re = /(^##[ \t]*生词回收[ \t]*\r?\n)([\s\S]*?)(?=^##[ \t]|(?![\s\S]))/m;
  const m = re.exec(text);
  if (!m) return text;

  const lines = m[2].split(/\r?\n/);
  const first = lines.findIndex((l) => l.trim().startsWith('|'));
  if (first === -1) return text;
  let last = first;
  while (last + 1 < lines.length && lines[last + 1].trim().startsWith('|')) last += 1;

  const block = lines.slice(first, last + 1);
  const isSep = (l) => /^\|[\s:|-]+\|?$/.test(l.trim());
  const sepAt = block.findIndex(isSep);
  const head = block.slice(0, sepAt === -1 ? 1 : sepAt + 1); // 表头 + 分隔线
  const rows = block.slice(head.length);
  if (rows.length < 2) return text; // 只有一行，排不排都一样

  const lower = String(prose).replace(/\*\*/g, '').toLowerCase();
  const posOf = (row) => {
    const cell = row.split('|')[1] || '';
    const word = (cell.match(/[A-Za-z][A-Za-z'-]*/g) || [])[0];
    if (!word) return Number.POSITIVE_INFINITY;
    const target = word.toLowerCase();
    const scan = /[a-z][a-z'-]*/g;
    let t;
    while ((t = scan.exec(lower))) if (t[0].startsWith(target)) return t.index;
    return Number.POSITIVE_INFINITY;
  };
  const sorted = rows
    .map((row, i) => ({ row, i, pos: posOf(row) }))
    .sort((a, b) => a.pos - b.pos || a.i - b.i)
    .map((x) => x.row);

  const rebuilt = [...lines.slice(0, first), ...head, ...sorted, ...lines.slice(last + 1)].join('\n');
  return text.replace(re, (all, header) => header + rebuilt);
}

/**
 * 解析 `## 题目`。
 * 约定的格式（提示词里写死的）：
 *   1. 题干
 *   A. 选项
 *   B. 选项
 *
 * 解析不动就返回空数组 —— 前端会退回普通 Markdown 渲染，不至于白屏。
 */
function parseQuestions(body) {
  const sec = sectionOf(body, '题目');
  if (!sec) return [];
  const out = [];
  let cur = null;
  for (const raw of sec.split(/\r?\n/)) {
    const line = raw.trim().replace(/^\*\*(.+)\*\*$/, '$1');
    if (!line) continue;
    const opt = line.match(/^([A-H])[.、．)）:：]\s*(.+)$/);
    if (opt && cur) {
      cur.options.push({ key: opt[1], text: opt[2].trim().replace(/\*\*/g, '') });
      continue;
    }
    const q = line.match(/^(\d{1,2})\s*[.、．)）]\s*(.+)$/);
    if (q) {
      cur = { n: Number(q[1]), stem: q[2].trim().replace(/\*\*/g, ''), options: [] };
      out.push(cur);
      continue;
    }
    if (cur && !cur.options.length) cur.stem += ` ${line.replace(/\*\*/g, '')}`;
  }
  return out.filter((q) => q.options.length >= 2);
}

/** 解析 `## 答案速查` 里的 `1.A 2.C 3.B` */
function parseKey(body) {
  const sec = sectionOf(body, '答案速查');
  if (!sec) return {};
  const key = {};
  for (const m of sec.matchAll(/(\d{1,2})\s*[.、．)）:：-]?\s*([A-H])(?![A-Za-z])/g)) {
    if (!(m[1] in key)) key[m[1]] = m[2];
  }
  return key;
}

/** 只取 # 标题之后、下一个 ## 之前的那段 —— 也就是英文正文，别把生词表也算进词数 */
function proseOf(body) {
  const afterH1 = String(body).replace(/^[\s\S]*?^#\s+.*$/m, '');
  const cut = afterH1.search(/^##\s/m);
  return (cut === -1 ? afterH1 : afterH1.slice(0, cut)).trim();
}

/** 英文词数（按字母词切分） */
function wordCount(text) {
  return (String(text).match(/[A-Za-z][A-Za-z'-]*/g) || []).length;
}

/** 列出已有故事（新的在前） */
export function listStories(cfg) {
  const dir = storyDirOf(cfg);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const abs = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const dateMatch = name.match(/^(\d{4}-\d{2}-\d{2})/);
    const seqMatch = name.match(/^\d{4}-\d{2}-\d{2}-(\d+)-/);
    let parsed = { title: '', words: [], body: '', prose: '', grades: [], plan: null };
    try {
      parsed = parseStory(fs.readFileSync(abs, 'utf8'));
    } catch {
      /* 读不了就只当个文件名 */
    }
    const last = parsed.grades?.[0] || null;
    out.push({
      date: dateMatch ? dateMatch[1] : name.replace(/\.md$/, ''),
      seq: seqMatch ? Number(seqMatch[1]) : 0,
      rel: `${path.basename(dir)}/${name}`,
      name,
      title: parsed.title || name.replace(/\.md$/, ''),
      type: parsed.frontmatter.type || '',
      words: parsed.words,
      // 正文词数（不含生词回收表 / 中文大意），用来核对篇幅
      length: wordCount(parsed.prose),
      questions: parsed.questions.length,
      // 这一篇在考研英语一里值多少分、该花多少时间（完形 / 阅读 / 新题型都是 10 分）
      full: parsed.plan?.table?.full || ENGLISH_FULL,
      refMinutes: parsed.plan?.ref?.minutes || 0,
      last: last ? { total: last.total, full: last.full, date: last.date, seconds: last.seconds } : null,
      size: st.size,
      mtime: st.mtimeMs,
    });
  }
  // 新的日期在前；同一天按序号升序（01、02、03…），没有序号的旧文件（`-故事.md`）排在最后
  return out.sort(
    (a, b) => b.date.localeCompare(a.date) || (a.seq || 999) - (b.seq || 999) || b.mtime - a.mtime
  );
}

export function readStory(cfg, rel) {
  const abs = storyAbsOf(cfg, rel);
  const cleanRel = `${path.basename(storyDirOf(cfg))}/${path.basename(abs)}`;
  if (!fs.existsSync(abs)) {
    return { rel: cleanRel, exists: false, content: '', body: '', words: [], title: '', questions: [], grades: [] };
  }
  const content = fs.readFileSync(abs, 'utf8');
  const parsed = parseStory(content);
  return {
    rel: cleanRel,
    exists: true,
    content, // 带 frontmatter 的完整原文（编辑器用）
    // 去掉 frontmatter，渲染用（前端再按 ## 切块）。
    // 顺手把「生词回收」表按文中出现顺序重排 —— 只改读出来的样子，文件不动。
    body: sortVocabByArticleOrder(parsed.body, parsed.prose),
    title: parsed.title,
    type: parsed.frontmatter.type || '',
    words: parsed.words,
    questions: parsed.questions,
    key: parsed.key,
    analysis: parsed.analysis,
    length: wordCount(parsed.prose),
    // 分值 + 参考用时（考研英语一单篇 10 分）+ 历次成绩
    plan: parsed.plan,
    grades: parsed.grades,
    last: parsed.grades?.[0] || null,
    mtime: fs.statSync(abs).mtimeMs,
  };
}

/**
 * 存一篇题目（写盘前备份，和错题本一套规矩）。
 * **重新生成时把成绩记录接回去** —— 那是我做过这套题的证据，不该被覆盖掉。
 */
export function saveStory(cfg, rel, content, { words = [] } = {}) {
  const abs = storyAbsOf(cfg, rel);
  let body = String(content ?? '').trim();
  if (!body) throw Object.assign(new Error('故事是空的'), { status: 400 });

  const date = (path.basename(abs).match(/^\d{4}-\d{2}-\d{2}/) || [today()])[0];

  // 粘进来的故事没有 frontmatter 就补一份 —— 不然页面上认不出目标词，也没法高亮
  if (!/^---\r?\n/.test(body)) {
    const h1 = body.match(/^#\s+(.+)$/m);
    const head = ['---', `date: ${date}`, `title: ${h1 ? h1[1].trim() : `${date} 单词故事`}`];
    const list = (Array.isArray(words) ? words : []).filter(Boolean);
    if (list.length) head.push('words:', ...list.map((w) => `  - ${w}`));
    head.push('---', '');
    body = `${head.join('\n')}\n${body}`;
  }

  if (fs.existsSync(abs)) {
    try {
      body = preserveGradeSection(fs.readFileSync(abs, 'utf8'), body);
    } catch {
      /* 旧的读不了就照新写 */
    }
  }

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (fs.existsSync(abs)) backupFile(abs, cfg.vaultDir, cfg.backupDir, 'story');
  fs.writeFileSync(abs, `${body}\n`, 'utf8');
  return { ok: true, rel: `${path.basename(storyDirOf(cfg))}/${path.basename(abs)}`, abs, words };
}

/** 把一次判分成绩写回题目文件的 `## 成绩记录` 一节（先备份，只动这一节） */
export function saveStoryGrade(cfg, rel, recordMarkdown) {
  const abs = storyAbsOf(cfg, rel);
  if (!fs.existsSync(abs)) throw Object.assign(new Error('这一篇不在了'), { status: 404 });
  const content = fs.readFileSync(abs, 'utf8');
  const next = writeGradeRecord(content, recordMarkdown);
  backupFile(abs, cfg.vaultDir, cfg.backupDir, 'grade');
  fs.writeFileSync(abs, next, 'utf8');
  return { ok: true, rel: `${path.basename(storyDirOf(cfg))}/${path.basename(abs)}`, abs };
}

/* ============================================================
   题型目录（全部按考研英语一）
   ============================================================ */

/**
 * 8 个可选题型。每个都写清楚了「考研英语一里长什么样」，
 * 生成时整段塞进提示词，AI 照着这个规格出题。
 *
 * `words` 是这个题型推荐配多少个目标词，`title` 是被选中的那个题型名（多篇随机时保证不重复）。
 */
export const PAPER_TYPES = [
  {
    id: 'cloze',
    group: '完形填空',
    label: '完形填空',
    words: 12,
    spec: `**Section I Use of English（完形填空）**
- 一段 **240–280 词**的短文（考研英语一完形的篇幅），**不分段或分 2–3 段**
- 文中挖 **20 个空**，写成 \`(1)\` \`(2)\` … \`(20)\` 的形式，空的位置要均匀分布、不能连着挖
- 每空 **4 个选项（A/B/C/D）**，考点按考研规律分布：
  词义辨析（动词/名词/形容词辨析）约 10 空、固定搭配与介词约 4 空、逻辑关系连接词约 3 空、语法（从句引导词/非谓语/时态）约 3 空
- 首句**不挖空**（考研惯例，首句是全文主旨句）；上下文线索必须充分，答案唯一
- 干扰项要**同类同形**（都是动词就都是动词，都是介词就都是介词），靠语境和搭配区分`,
  },
  {
    id: 'read-main',
    group: '传统阅读',
    label: '主旨题',
    words: 15,
    spec: `**Section II Part A 传统阅读 —— 一篇完整的考研阅读（本篇重点练【主旨题】）**
- **一整篇**：400–450 词、5–6 段的说明文或议论文（像 The Economist / Nature / The Times 那种报道），有明确的论点与推进
- **5 道题，每题 A/B/C/D 四个选项** —— 这就是考研英语一传统阅读的标准格式，一道不多一道不少
- **5 道题的题型按真题的自然分布，不要全压在一个类型上**。常见配比：
  主旨/标题 1 道 · 细节 1–2 道 · 推理 1 道 · 词义句意 1 道 · 态度或例证 0–1 道
- 其中**至少 1 道必须是【主旨题】**（这是这次的重点），并在「答案解析」的「题型」一列里写清楚
- 题干和选项都用真题的措辞与长度（题干与每个选项 ≤ 20 词，四个选项长度相当）

**主旨题长什么样**
- 题干措辞：\`The text mainly discusses…\` / \`Which of the following would be the best title for the text?\` / \`Paragraph 3 is mainly about…\` / \`The author's purpose in writing this text is to…\`
- 正确项：**覆盖面刚好** + 高度概括 + 上位词同义替换
- 干扰项：**以偏概全**（只概括了某一两段）、**范围过大**、**张冠李戴**、**只是文中的一个细节**`,
  },
  {
    id: 'read-detail',
    group: '传统阅读',
    label: '细节题',
    words: 15,
    spec: `**Section II Part A 传统阅读 —— 一篇完整的考研阅读（本篇重点练【细节题】）**
- **一整篇**：400–450 词、5–6 段的说明文或议论文（像 The Economist / Nature / The Times 那种报道），有明确的论点与推进
- **5 道题，每题 A/B/C/D 四个选项** —— 这就是考研英语一传统阅读的标准格式，一道不多一道不少
- **5 道题的题型按真题的自然分布，不要全压在一个类型上**。常见配比：
  主旨/标题 1 道 · 细节 1–2 道 · 推理 1 道 · 词义句意 1 道 · 态度或例证 0–1 道
- 其中**至少 1 道必须是【细节题】**（这是这次的重点），并在「答案解析」的「题型」一列里写清楚
- 题干和选项都用真题的措辞与长度（题干与每个选项 ≤ 20 词，四个选项长度相当）

**细节题长什么样**
- 题干措辞：\`According to Paragraph 2, …\` / \`Why did X do Y?\` / \`Which of the following is true of …?\` / \`The study mentioned in Paragraph 3 found that …\`
- 每题都要能**回原文定位到具体一句**，正确项是那句话的**同义替换**（换词不换意）
- 干扰项：**偷换概念**、**张冠李戴**、**无中生有**、**正反混淆**（多一个或少一个否定词）`,
  },
  {
    id: 'read-infer',
    group: '传统阅读',
    label: '推理判断题',
    words: 15,
    spec: `**Section II Part A 传统阅读 —— 一篇完整的考研阅读（本篇重点练【推理判断题】）**
- **一整篇**：400–450 词、5–6 段的说明文或议论文（像 The Economist / Nature / The Times 那种报道），有明确的论点与推进
- **5 道题，每题 A/B/C/D 四个选项** —— 这就是考研英语一传统阅读的标准格式，一道不多一道不少
- **5 道题的题型按真题的自然分布，不要全压在一个类型上**。常见配比：
  主旨/标题 1 道 · 细节 1–2 道 · 推理 1 道 · 词义句意 1 道 · 态度或例证 0–1 道
- 其中**至少 1 道必须是【推理判断题】**（这是这次的重点），并在「答案解析」的「题型」一列里写清楚
- 题干和选项都用真题的措辞与长度（题干与每个选项 ≤ 20 词，四个选项长度相当）

**推理判断题长什么样**
- 题干措辞：\`It can be inferred from the last paragraph that …\` / \`We can learn from the text that …\` / \`The author implies that …\` / \`What can be concluded from the passage?\`
- 考研铁律：**答案必须有原文依据，只是一步之遥的推断**；推得太远就是错的
- 干扰项：**过度推断**、**无中生有**、**照抄原文原句**（原句往往正是错的，因为那不是「推断」）、**绝对化措辞**（must / never / all）`,
  },
  {
    id: 'read-vocab',
    group: '传统阅读',
    label: '猜测题',
    words: 15,
    spec: `**Section II Part A 传统阅读 —— 一篇完整的考研阅读（本篇重点练【猜测题】）**
- **一整篇**：400–450 词、5–6 段的说明文或议论文（像 The Economist / Nature / The Times 那种报道），有明确的论点与推进
- **5 道题，每题 A/B/C/D 四个选项** —— 这就是考研英语一传统阅读的标准格式，一道不多一道不少
- **5 道题的题型按真题的自然分布，不要全压在一个类型上**。常见配比：
  主旨/标题 1 道 · 细节 1–2 道 · 推理 1 道 · 词义句意 1 道 · 态度或例证 0–1 道
- 其中**至少 1 道必须是【猜测题】**（这是这次的重点），并在「答案解析」的「题型」一列里写清楚
- 题干和选项都用真题的措辞与长度（题干与每个选项 ≤ 20 词，四个选项长度相当）

**猜测题（词义句意）长什么样**
- 题干措辞：\`The word "X" (Line 3, Para. 2) most probably means …\` / \`The phrase "Y" in Paragraph 4 refers to …\` / \`By saying "…", the author means that …\`
- **用来考的词必须在原文里能靠上下文推出来**（让步转折、并列举例、同位解释、破折号）
- 正确项：**回原文那个语境里读得通**，往往是该词的**非本义**（熟词僻义尤其如此）
- 干扰项：**该词的常见义**（考的就是你不看上下文）、**字面意思**、**近音近形词**`,
  },
  {
    id: 'read-example',
    group: '传统阅读',
    label: '例证题',
    words: 15,
    spec: `**Section II Part A 传统阅读 —— 一篇完整的考研阅读（本篇重点练【例证题】）**
- **一整篇**：400–450 词、5–6 段的说明文或议论文（像 The Economist / Nature / The Times 那种报道），有明确的论点与推进
- **5 道题，每题 A/B/C/D 四个选项** —— 这就是考研英语一传统阅读的标准格式，一道不多一道不少
- **5 道题的题型按真题的自然分布，不要全压在一个类型上**。常见配比：
  主旨/标题 1 道 · 细节 1–2 道 · 推理 1 道 · 词义句意 1 道 · 态度或例证 0–1 道
- 其中**至少 1 道必须是【例证题】**（这是这次的重点），并在「答案解析」的「题型」一列里写清楚
- 题干和选项都用真题的措辞与长度（题干与每个选项 ≤ 20 词，四个选项长度相当）

**例证题长什么样**
- 题干措辞：\`The author mentions X in order to …\` / \`The example of Y is used to illustrate …\` / \`Why does the author quote Z?\`
- 考研铁律：**问的是「为什么举这个例子」，答案在例子前面那一句论点**，答案不在例子里
- 干扰项：**就事论事**（把例子本身的内容当答案）、**张冠李戴**（安到别的段落的论点上）、**答非所问**`,
  },
  {
    id: 'read-attitude',
    group: '传统阅读',
    label: '态度题',
    words: 15,
    spec: `**Section II Part A 传统阅读 —— 一篇完整的考研阅读（本篇重点练【态度题】）**
- **一整篇**：400–450 词、5–6 段的说明文或议论文（像 The Economist / Nature / The Times 那种报道），有明确的论点与推进
- **5 道题，每题 A/B/C/D 四个选项** —— 这就是考研英语一传统阅读的标准格式，一道不多一道不少
- **5 道题的题型按真题的自然分布，不要全压在一个类型上**。常见配比：
  主旨/标题 1 道 · 细节 1–2 道 · 推理 1 道 · 词义句意 1 道 · 态度或例证 0–1 道
- 其中**至少 1 道必须是【态度题】**（这是这次的重点），并在「答案解析」的「题型」一列里写清楚
- 题干和选项都用真题的措辞与长度（题干与每个选项 ≤ 20 词，四个选项长度相当）

**态度题长什么样**
- 题干措辞：\`The author's attitude towards X is …\` / \`What is the author's view on …?\` / \`The author's tone in the last paragraph can be described as …\`
- 选项必须是**考研常考的态度词**：objective / indifferent / sympathetic / skeptical / critical / approval / ambiguous / impartial / tolerant / disappointed
- 考研铁律：**indifferent、disinterested 这类词永远不是正确答案**（作者写文章不可能不关心），专门把它们设成干扰项
- 正确项：**措辞有分寸**（partly / to some extent / cautiously），能从文中的评价性形容词和转折词读出来`,
  },
  {
    id: 'newtype',
    group: '新题型',
    label: '英1新题型',
    words: 12,
    spec: `**Section II Part B 新题型（英语一）**
从英语一的三种备选题型里**挑一种**来出（不要混着出），并在文中注明是哪一种：
1. **七选五（段落填空题）**：一篇 **500–600 词**的文章，挖 **5 个空**（\`(1)\` … \`(5)\`），
   给出 **7 个候选段落（A–G）**，选出 5 个填入，**2 个是干扰项**。干扰项要与正确项在话题上高度相关，靠**逻辑衔接和指代**区分。
2. **排序题**：**7–8 个段落（A–H）**，已给出 1–2 个的位置（如 \`[D] → (41) → (42) → …\`），
   其余要求排序，考的是段落间的**指代、连接词、时间与逻辑顺序**。
3. **小标题匹配题**：**6–7 个段落**，给出 **6–7 个小标题（A–G）**，为其中 5 个段落选出对应小标题。
   （英语一的小标题题通常**有 1 个干扰标题**、且**段落数多于标题数**）
- 无论哪一种，最终在「题目」一节都写成 **5 道题、每题一组选项**的形式；
  七选五/小标题的选项是 **A–G 七选一**，排序题的选项是 **A–H 八选一**
- 考点必须落在**段落主旨、逻辑衔接、指代关系**上，不要考细节`,
  },
];

/**
 * 单篇满分（考研英语一）：完形 20 空 × 0.5 分、传统阅读 5 题 × 2 分、新题型 5 题 × 2 分
 * —— **8 个题型都是 10 分**。所以「每题多少分」由程序按 `满分 ÷ 题数` 算，不靠 AI 写。
 */
for (const t of PAPER_TYPES) t.full = ENGLISH_FULL;

export const PAPER_TYPE_LABEL = Object.fromEntries(
  PAPER_TYPES.map((t) => [t.id, t.group === t.label ? t.label : `${t.group} · ${t.label}`])
);

export function paperTypeOf(id) {
  return PAPER_TYPES.find((t) => t.id === id) || null;
}

/** 选中若干题型时，推荐配多少目标词 */
export function recommendedWords(typeIds) {
  return (typeIds || []).reduce((s, id) => s + (paperTypeOf(id)?.words || 15), 0);
}

/**
 * 决定这次出哪几篇。
 * - 自选：按你勾的题型来（勾几个出几篇）
 * - 随机：从 8 个题型里**不重复**抽 count 个
 */
export function resolveTypes(selected, count, random) {
  const all = PAPER_TYPES.map((t) => t.id);
  if (!random) {
    const picked = all.filter((id) => (selected || []).includes(id));
    if (!picked.length) throw Object.assign(new Error('先勾一个题型'), { status: 400 });
    return picked.slice(0, Math.max(1, Math.min(6, count || picked.length)));
  }
  const n = Math.max(1, Math.min(6, count || 1));
  const pool = (selected || []).length ? all.filter((id) => selected.includes(id)) : all;
  if (pool.length < n) {
    throw Object.assign(new Error(`只有 ${pool.length} 个题型可选，出不了 ${n} 篇 —— 少出几篇或者多勾几个题型`), { status: 400 });
  }
  // Fisher–Yates，保证多篇不重样
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, n);
}

/** 把选中的词轮流分到每一篇里 —— 顺序被打散，多篇之间分布均匀 */
export function distributeWords(words, n) {
  const buckets = Array.from({ length: n }, () => []);
  (words || []).forEach((w, i) => buckets[i % n].push(w));
  return buckets;
}

/**
 * 把「选中的词 + 选中的题型」写成一段可以直接粘给 AI 的提示词。
 *
 * 关键设计：**词由程序来分配**，不是让 AI 自己分。
 * 多篇时按轮转（round-robin）把词打散到每一篇里，提示词里逐篇写明「这一篇只用这几个词」，
 * 这样「均匀分布」是程序保证的，不靠 AI 自觉。
 */
export function paperPrompt(cfg, words, { date = today(), types = [], overviewData = null } = {}) {
  const list = (words || []).filter((w) => w && w.spelling);
  if (!list.length) throw Object.assign(new Error('先选几个单词'), { status: 400 });
  if (!types.length) throw Object.assign(new Error('先勾一个题型'), { status: 400 });

  const o = overviewData?.ok ? overviewData : null;
  const facts = o
    ? `- 今日进度：${o.progress.finished} / ${o.progress.total}（${o.progress.rate}%），学习时长 ${o.progress.studyMinutes} 分钟
- 计划总量：${o.plan.totalWords} 词，其中今天到期 ${o.plan.dueToday} 词，易忘词（墨墨打标）${o.plan.sticking} 词`
    : '- （这次没读到墨墨的实时数据，按单词本身来写就好）';

  const buckets = distributeWords(list, types.length);

  const papers = types.map((id, i) => {
    const t = paperTypeOf(id);
    const mine = buckets[i];
    const rel = paperRelOf(cfg, date, i + 1, id);
    const spellings = mine.map((w) => w.spelling);
    return {
      seq: i + 1,
      type: t,
      rel,
      words: mine,
      spellings,
      block: `### 第 ${i + 1} 篇 ｜ 题型：**${PAPER_TYPE_LABEL[id]}**

**这一篇必须用上的目标词（${mine.length} 个）**：
${spellings.join('、') || '（这次词不够分了，按题型自由发挥）'}

${t.spec}

**输出到**：\`${rel}\``,
    };
  });

  const outList = papers
    .map(
      (p) => `**第 ${p.seq} 篇（${PAPER_TYPE_LABEL[p.type.id]}）** → 写进 \`${p.rel}\`

\`\`\`
---
date: ${date}
type: ${PAPER_TYPE_LABEL[p.type.id]}
title: 标题
words:
${p.spellings.map((s) => `  - ${s}`).join('\n')}
---

# 标题

（英文原文。传统阅读/完形：目标词用 **word** 加粗；完形：挖空写作 (1) (2) …）

## 题目

1. 题干（英文）
A. 选项
B. 选项
C. 选项
D. 选项

2. 题干（英文）
A. 选项
…

## 答案速查

1.A 2.C 3.B 4.D 5.A

## 答案解析

| 题号 | 题型 | 答案 | 定位句（原文照抄） | 同义替换 | 其他选项为什么错 |
| --- | --- | --- | --- | --- | --- |
| 1 | 细节题 | A | 第 2 段第 3 句原句 | 原文 X ↔ 选项 A 的 Y | B 张冠李戴；C 无中生有；D 正反混淆 |

### 逐题精讲

**1.**
- **为什么选它**：题干问的是 ……，回原文第 2 段第 3 句「……」，
  正确项把原文的 X 换成了同义的 Y（**同义替换**是考研正确项的标志）。
- **怎么排除**：B 把第 3 段的信息安到了第 2 段（**张冠李戴**）；
  C 原文根本没提（**无中生有**）；D 与原文的否定词相反（**正反混淆**）。

**2.**（同上，每题都要有）

## 长难句拆解

挑出原文里**最难的 3–4 句**，逐句按下面的格式拆（这是这份题最该看的部分）：

### 1.（原句照抄）

- **断句**：按意群切开，用 \`/\` 标出 —— 主干 / 从句 / 插入语 / 非谓语
- **主干**：去掉所有修饰之后剩下的「主 + 谓 + 宾」
- **修饰**：每个从句、非谓语、介词短语**分别挂在谁身上**、起什么作用
- **翻译**：整句的准确中文（要能对上每一个成分，不要写「大意」）

## 逐句分析

全文**每一句**都要有，按出现顺序编号，每句三行（这一节是精读用的，一句都不能漏）：

**S1.** （英文原句照抄）
- **结构**：主句是什么、从句是什么、修饰挂在谁身上 —— 一句话说清，不要展开成长篇
- **翻译**：准确的中文

**S2.**（同上，一直写到全文最后一句）

## 生词回收

| 单词 | 词性 · 释义 | 文中原句 |
| --- | --- | --- |
（按词在文中**出现的先后**排，最先出现的放最前面）

## 中文大意

（3–5 句中文，讲清文章说了什么，不要逐句翻译）
\`\`\``
    )
    .join('\n\n');

  const prompt = `请按**考研英语（一）**的标准，为我出 ${papers.length} 篇题，并存进我的仓库。

## 我今天的背词情况

${facts}

## 一共 ${papers.length} 篇，每篇的题型和目标词都已经定好了

${papers.map((p) => p.block).join('\n\n---\n\n')}

## 通用要求

1. **原文难度**：严格对标考研英语（一）——
   - 句子平均 **25–35 词**，每篇至少 **2 个 50 词以上的长难句**；
   - 用**定语从句、同位语、插入语、非谓语动词、被动语态、倒装、比较结构**，但不要为了复杂而复杂；
   - **题材**参考考研真题的选材方向：科技、经济、教育、社会、文化、法律、环境、心理、传媒；
     文体是**说明文或议论文**（像 The Economist / Nature / The Times 的报道），**不要写成童话或小故事**；
   - 除目标词外，用词**严格控制在考研英语（一）大纲词汇范围内**（约 5500 词，含常见派生形式），
     不出现生僻词和俚语；不出现「目标词」「本段」「考研」这类元话语。
   - **万一必须出现大纲外的词**（专有名词、行业术语、新事物名、缩写等）：
     **在文中就地注释** —— 第一次出现时写成 \`word（中文）\`，例如 \`superconductor（超导体）\`、
     \`the Federal Reserve（美联储）\`；同一个词只在**第一次**注释，之后直接用，别每出现一次注一次。
     **不要给目标词加注释**（那是要背的词），也不要给大纲内的词加注释。
2. **目标词**：每篇**只用分配给它的那一组**（上面写明了是哪几个），一个都不能漏，在原文里用 \`**word**\` 加粗。
   - 允许改变词形（obtain → obtained、statute → statutes）；
   - **一个词可以在同一篇里出现多次**，不用刻意只出现一次 —— 自然为要。
3. **题目**：严格按考研英语（一）的出题规律，题干和选项都要用真题的措辞与长度（题干和每个选项 ≤ 20 词，四个选项长度相当）。
4. **干扰项**：每个错项都必须是考研真题的典型套路之一 —— 张冠李戴、偷换概念、以偏概全、无中生有、过度推断、正反混淆、答非所问；不许凑数。
5. **【格式必须严格遵守】**：我要用程序解析，所以
   - 「题目」一节里，**每道题的题干以 \`数字.\` 开头单独一行**，**每个选项以 \`A.\` \`B.\` \`C.\` \`D.\` 开头各自单独一行**，选项之间不要空行；
   - 「答案速查」一节**只放一行**，写成 \`1.A 2.C 3.B 4.D 5.A\` 这种形式；
   - 这几节的标题原文照抄：\`## 题目\`、\`## 答案速查\`、\`## 答案解析\`、\`## 长难句拆解\`、
     \`## 逐句分析\`、\`## 生词回收\`、\`## 中文大意\`。
6. 「生词回收」表里把这个词在文中的**原句照抄**一遍，方便我回看；
   表里的词**按在文中出现的先后顺序排**（最先出现的排最前面），别按字母或词性排。
7. **解析要够细，不能只给翻译**：
   - 「答案解析」不只是说答案对不对，要写清**定位句、同义替换、每个干扰项错在哪**；
   - 必须有独立的「逐句分析」一节：**全文每一句**都要，按顺序编号 \`S1\` \`S2\` ……，
     每句给「结构」（主句 + 从句 + 修饰关系，一句话说清）和「翻译」（准确中文）——
     这一节是给我精读用的，**不许漏句、不许把两三句并成一句、不许只挑难的写**；
   - 还必须有独立的「长难句拆解」一节，挑 3–4 个最难的长句，
     把**断句、主干、修饰挂在哪、逐成分翻译**写全 —— 这一节是给我学长难句用的，别偷懒。
8. **分值和时间**：这一篇在考研英语一里值 **${ENGLISH_FULL} 分**
   （完形 20 空 × 0.5 分、传统阅读 5 题 × 2 分、新题型 5 题 × 2 分），
   所以**题量必须和真题对得上**（传统阅读 / 新题型 5 道小题、完形 20 个空）—— 我会做完整判分。
   参考用时 **${Math.round(ENGLISH_FULL * 1.8)} 分钟**（考研英语一 180 分钟 / 100 分），
   难度按这个时间来把握：**刚好够认真读完、把 5 道题的定位句都找一遍**，不要出成 40 分钟才做得完的题。

## 输出

把上面 ${papers.length} 个文件**分别写进对应的路径**（文件不存在就新建，已存在就覆盖），
写完后在对话里告诉我每篇的标题和文件路径就行，**不用把全文都贴给我**。

${outList}`;

  return {
    prompt,
    date,
    papers: papers.map((p) => ({
      seq: p.seq,
      type: p.type.id,
      typeLabel: PAPER_TYPE_LABEL[p.type.id],
      rel: p.rel,
      words: p.words,
    })),
    words: list,
    rel: papers[0].rel,
  };
}
