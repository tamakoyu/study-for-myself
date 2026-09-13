/**
 * notebook.mjs —— 错题本的门面（配置、缓存、读写编排）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanNotebook, today } from './parse.mjs';
import { computeStats, filterByScope } from './stats.mjs';
import { recordCheckin, undoCheckin, setMeta, setPoints, backup } from './write.mjs';
import { chapterOptions, createQuestions, splitProblems, detect as detectByKeywords, detectType, normalizeMath, slugOf, buildPrompt, nextNumber as nextNumberFor } from './create.mjs';
import { TAXONOMY, UNCLASSIFIED } from './taxonomy.mjs';

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig() {
  const cfgPath = path.join(APP_DIR, 'config.json');
  const defaults = {
    notebookDir: path.resolve(APP_DIR, '..', '错题本'),
    backupDir: path.join(APP_DIR, 'backups'),
    exportDir: path.join(APP_DIR, 'data'),
    port: 4173,
    host: '127.0.0.1',
  };
  // 兼容 JSON 里的 // 注释
  const readJson = (p) => {
    const raw = fs.readFileSync(p, 'utf8').replace(/^\s*\/\/.*$/gm, '');
    return JSON.parse(raw);
  };
  if (fs.existsSync(cfgPath)) {
    try {
      const user = readJson(cfgPath);
      const cfg = { ...defaults, ...user };
      cfg.notebookDir = path.resolve(APP_DIR, cfg.notebookDir);
      cfg.backupDir = path.resolve(APP_DIR, cfg.backupDir);
      cfg.exportDir = path.resolve(APP_DIR, cfg.exportDir);
      // 环境变量优先，方便指向另一份错题本（例如做测试）
      if (process.env.NOTEBOOK_DIR) cfg.notebookDir = path.resolve(process.env.NOTEBOOK_DIR);
      if (process.env.NOTEBOOK_PORT) cfg.port = Number(process.env.NOTEBOOK_PORT);
      return cfg;
    } catch (err) {
      console.warn(`[config] config.json 解析失败，改用默认配置：${err.message}`);
    }
  }
  if (process.env.NOTEBOOK_DIR) {
    return { ...defaults, notebookDir: path.resolve(process.env.NOTEBOOK_DIR) };
  }
  return defaults;
}

let cache = { at: 0, data: null };

/** 读取当前快照（带 1 秒 TTL，避免同一秒内重复扫盘） */
export function snapshot(cfg, { force = false } = {}) {
  const now = Date.now();
  if (!force && cache.data && now - cache.at < 1000) return cache.data;
  const { problems, errors, tree } = scanNotebook(cfg.notebookDir);
  const data = {
    problems,
    errors,
    tree,
    taxonomy: TAXONOMY,
    stats: computeStats(problems, tree),
    notebookDir: cfg.notebookDir,
  };
  cache = { at: now, data };
  return data;
}

/** 读某个「大类 / 科目 / 章节」范围内的题目与统计 */
export function scoped(cfg, scope = {}) {
  const snap = snapshot(cfg);
  const problems = filterByScope(snap.problems, scope);
  return { problems, stats: computeStats(problems, snap.tree) };
}

/** 解析 URL 查询串里的 scope */
export function scopeFromUrl(url) {
  const pick = (k) => {
    const v = url.searchParams.get(k);
    return v && v !== 'null' && v !== 'undefined' ? v : null;
  };
  return { category: pick('category'), subject: pick('subject'), chapter: pick('chapter') };
}

function findProblem(cfg, id) {
  const snap = snapshot(cfg, { force: true });
  const byId = snap.problems.find((p) => p.id === id);
  if (!byId) throw Object.assign(new Error(`找不到题目：${id}`), { status: 404 });
  return byId;
}

export function checkin(cfg, id, result, date, seconds) {
  const p = findProblem(cfg, id);
  if (p.warnings.some((w) => w.includes('打卡记录'))) {
    throw Object.assign(new Error('该笔记缺少 `## 打卡记录` 区块，为防误写已中止'), { status: 409 });
  }
  backup(p.absPath, cfg.notebookDir, cfg.backupDir);
  const res = recordCheckin(p.absPath, { result, date, seconds });
  return { ok: true, ...res, problem: findProblem(cfg, id) };
}

export function undo(cfg, id, attempt, result) {
  const p = findProblem(cfg, id);
  backup(p.absPath, cfg.notebookDir, cfg.backupDir);
  undoCheckin(p.absPath, { attempt, result });
  return { ok: true, problem: findProblem(cfg, id) };
}

export function updateMeta(cfg, id, patch) {
  const p = findProblem(cfg, id);
  const clean = {};
  if (patch.difficulty != null) clean.difficulty = Math.max(1, Math.min(5, Number(patch.difficulty)));
  if (patch.heat != null) clean.heat = Math.max(1, Math.min(5, Number(patch.heat)));
  if (patch.type) clean.type = String(patch.type).slice(0, 40);
  if (!Object.keys(clean).length) throw Object.assign(new Error('没有可更新的字段'), { status: 400 });
  backup(p.absPath, cfg.notebookDir, cfg.backupDir);
  setMeta(p.absPath, clean);
  return { ok: true, problem: findProblem(cfg, id) };
}

/** 改考点标签 */
export function updatePoints(cfg, id, points) {
  const p = findProblem(cfg, id);
  backup(p.absPath, cfg.notebookDir, cfg.backupDir);
  const res = setPoints(p.absPath, points);
  return { ok: true, ...res, problem: findProblem(cfg, id) };
}

/* ---------------- 增题 ---------------- */

/** 只做识别与预览，不写盘 */
export function detect(cfg, raw, mode = 'rule') {
  const parts = splitProblems(raw, mode);
  const items = parts.map((stem, index) => {
    const guessed = detectByKeywords(stem);
    return {
      index,
      stem: normalizeMath(stem),
      category: guessed.category,
      subject: guessed.subject,
      chapter: guessed.chapter,
      confidence: guessed.confidence,
      type: detectType(stem),
      slug: slugOf(stem),
      num: null,
    };
  });

  // 同科目同章节的编号接着往下排
  const counters = new Map();
  for (const it of items) {
    const sub = it.subject || UNCLASSIFIED;
    if (!counters.has(sub)) counters.set(sub, new Map());
    const byChapter = counters.get(sub);
    const ch = it.chapter || sub;
    if (!byChapter.has(ch)) byChapter.set(ch, nextNumberFor(cfg.notebookDir, it.category, sub, ch));
    it.num = byChapter.get(ch);
    byChapter.set(ch, it.num + 1);
  }
  return { items, count: items.length, mode };
}

/** 批量建题（写盘） */
export function addQuestions(cfg, items) {
  if (!Array.isArray(items) || !items.length) {
    throw Object.assign(new Error('没有要创建的题目'), { status: 400 });
  }
  const created = createQuestions(cfg.notebookDir, items);
  cache = { at: 0, data: null };
  return { ok: true, created, total: snapshot(cfg, { force: true }).problems.length };
}

/** 生成给 AI 用的提示词 */
export function promptFor(cfg, stems, scope = {}) {
  return {
    prompt: buildPrompt(Array.isArray(stems) ? stems : [stems], scope),
    options: chapterOptions(),
  };
}

/** 导出机器可读 JSON + 人类可读 Markdown 汇总 */
export function exportAll(cfg) {
  const snap = snapshot(cfg, { force: true });
  fs.mkdirSync(cfg.exportDir, { recursive: true });

  const payload = {
    generatedAt: new Date().toISOString(),
    notebookDir: cfg.notebookDir,
    stats: snap.stats,
    questions: snap.problems.map((p) => ({
      id: p.id,
      num: p.num,
      category: p.category,
      subject: p.subject,
      chapter: p.chapter,
      title: p.title,
      expr: p.expr,
      type: p.type,
      difficulty: p.difficulty,
      heat: p.heat,
      status: p.stats.status,
      stats: p.stats,
      relPath: p.relPath,
      checkins: p.checkins.filter((c) => c.done),
      warnings: p.warnings,
    })),
  };
  const jsonPath = path.join(cfg.exportDir, 'questions.json');
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), 'utf8');

  const md = renderMarkdownReport(snap);
  const mdPath = path.join(cfg.exportDir, 'stats.md');
  fs.writeFileSync(mdPath, md, 'utf8');

  return { jsonPath, mdPath, count: snap.problems.length };
}

function renderMarkdownReport(snap) {
  const { stats, problems } = snap;
  const t = stats.totals;
  const bar = (n, max) => '█'.repeat(Math.round((n / Math.max(1, max)) * 20));
  const maxHeat = Math.max(1, ...stats.byHeat.map((r) => r.total));
  const L = [];
  L.push(`# 错题本统计快照`);
  L.push('');
  L.push(`> 生成时间：${new Date().toLocaleString('zh-CN')}　数据源：\`${snap.notebookDir}\``);
  L.push('');
  L.push(`## 总览`);
  L.push('');
  L.push(`| 指标 | 数值 |`);
  L.push(`| --- | --- |`);
  L.push(`| 题目总数 | ${t.total} |`);
  L.push(`| ✅ 复习完成 | ${t.done}（${t.completionRate}%） |`);
  L.push(`| ⏳ 待复习·做过 | ${t.started} |`);
  L.push(`| ⏳ 待复习·未做 | ${t.untouched} |`);
  L.push(`| 累计打卡 | ${t.checkins} 次（完美 ${t.byResult['完美']} / 普通 ${t.byResult['普通']} / 失败 ${t.byResult['失败']}） |`);
  L.push(`| 连续打卡 | ${t.streak} 天 |`);
  L.push('');
  L.push(`## 分科目情况`);
  L.push('');
  L.push(`| 大类 | 科目 | 题数 | 完成 | 完成率 |`);
  L.push(`| --- | --- | --- | --- | --- |`);
  for (const cat of stats.tree) {
    for (const sub of cat.subjects) {
      L.push(`| ${cat.name} | ${sub.name} | ${sub.total} | ${sub.done} | ${sub.rate}% |`);
    }
  }
  L.push('');
  L.push(`## 逐题明细`);
  L.push('');
  L.push(`| 题目 | 大类 | 科目 | 章节 | 类型 | 难度 | 热度 | 完美 | 普通 | 失败 | 状态 | 最近一次 |`);
  L.push(`| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
  for (const p of problems) {
    const s = p.stats;
    L.push(
      `| ${p.num} | ${p.category} | ${p.subject} | ${p.chapter} | ${p.type} | ${'⭐'.repeat(p.difficulty)} | ${'🔥'.repeat(p.heat)} | ${s.perfect} | ${s.normal} | ${s.fail} | ${s.status} | ${
        s.last ? `${s.last.result} ${s.last.date || ''}` : '—'
      } |`
    );
  }
  L.push('');
  L.push(`## 待复习（按优先级）`);
  L.push('');
  for (const p of stats.pending.slice(0, 20)) {
    L.push(`- **${p.subject} · ${p.num}**　${'🔥'.repeat(p.heat)}　${p.type}　— 已打卡 ${p.stats.total} 次`);
  }
  if (!stats.pending.length) L.push('- 全部完成 🎉');
  L.push('');
  L.push(`## 考研热度分布`);
  L.push('');
  for (const row of [...stats.byHeat].reverse()) {
    if (!row.total) continue;
    L.push(`- ${'🔥'.repeat(row.key)}　${bar(row.total, maxHeat)} ${row.total} 题（完成 ${row.done}）`);
  }
  L.push('');
  return L.join('\n');
}

export { today };
