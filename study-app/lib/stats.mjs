/**
 * stats.mjs —— 统计聚合
 * 所有数字都从题目的打卡记录现算，不存任何冗余状态，因此永不失真。
 *
 * 支持「范围」：全部 / 某大类 / 某大类某科目 / 某科目某章节。
 * 前端切换页面时只换 scope，算法只有这一份。
 */

import { RESULTS } from './parse.mjs';
import { today } from './parse.mjs';

const STATUS_LABEL = { 已复习: '✅ 已复习', 待复习: '⏳ 待复习', 未做: '⭕ 未做' };

/**
 * 复习进度：已复习 / 总题数。
 * 一个大类**一道题都没有**时不显示 0%，而是算 100% —— 没有欠着的题，
 * 显示 0% 会让人以为「408 全没复习」。
 */
export function progressRate(total, done) {
  return total ? Math.round((done / total) * 100) : 100;
}

export function statusLabel(status) {
  return STATUS_LABEL[status] || status;
}

/** 复习优先级：到期的最优先，其次热度、难度、失败次数 */
export function priorityOf(p) {
  const overdue =
    p.stats.status === '待复习' ? 3 + Math.min(p.stats.schedule?.overdue || 0, 14) * 0.2 : 0;
  return p.heat * 2 + p.difficulty - p.stats.total * 0.5 + (p.stats.fail > 0 ? 1.5 : 0) + overdue;
}

/** 按范围筛题。scope 里没给的层级表示不限 */
export function filterByScope(problems, scope = {}) {
  return problems.filter((p) => {
    if (scope.book && (p.kind || 'mistakes') !== scope.book) return false;
    if (scope.category && p.category !== scope.category) return false;
    if (scope.subject && p.subject !== scope.subject) return false;
    if (scope.chapter && p.chapter !== scope.chapter) return false;
    return true;
  });
}

function groupCount(problems, keyFn, keys) {
  const out = new Map(keys.map((k) => [k, { key: k, total: 0, done: 0, pending: 0 }]));
  for (const p of problems) {
    const k = keyFn(p);
    if (!out.has(k)) out.set(k, { key: k, total: 0, done: 0, pending: 0 });
    const row = out.get(k);
    row.total += 1;
    if (p.stats.status === '已复习') row.done += 1;
    else row.pending += 1;
  }
  return [...out.values()];
}

export function computeStats(problems, tree = []) {
  const total = problems.length;
  // 已复习 = 做过（不管对没对），下一次已经排进遗忘曲线
  const done = problems.filter((p) => p.stats.status === '已复习').length;
  const due = problems.filter((p) => p.stats.status === '待复习').length;
  const untouched = problems.filter((p) => p.stats.status === '未做').length;

  const checkinsAll = problems.flatMap((p) => p.checkins.filter((c) => c.done));
  const byResult = Object.fromEntries(RESULTS.map((r) => [r, checkinsAll.filter((c) => c.result === r).length]));

  // 近 30 天趋势
  const days = [];
  const now = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    days.push(today(d));
  }
  const trend = days.map((date) => {
    const hits = checkinsAll.filter((c) => c.date === date);
    return {
      date,
      total: hits.length,
      完美: hits.filter((c) => c.result === '完美').length,
      普通: hits.filter((c) => c.result === '普通').length,
      失败: hits.filter((c) => c.result === '失败').length,
    };
  });

  // 连续打卡天数
  const activeDates = new Set(checkinsAll.map((c) => c.date).filter(Boolean));
  let streak = 0;
  for (let i = 0; i < 365; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    if (activeDates.has(today(d))) streak += 1;
    else if (i > 0) break;
  }

  const pending = problems
    .filter((p) => p.stats.status !== '已复习')
    .map((p) => ({ ...p, priority: priorityOf(p) }))
    .sort((a, b) => b.priority - a.priority);

  const troubled = problems
    .filter((p) => p.stats.fail > 0)
    .sort((a, b) => b.stats.fail - a.stats.fail || priorityOf(b) - priorityOf(a));

  const recent = [...checkinsAll]
    .filter((c) => c.date)
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 12);

  const share = (node) => ({
    name: node.name,
    total: node.total,
    done: node.done,
    pending: node.total - node.done,
    rate: progressRate(node.total, node.done),
  });

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      total,
      done,
      due,
      untouched,
      pending: due + untouched,
      checkins: checkinsAll.length,
      byResult,
      completionRate: progressRate(total, done),
      streak,
      activeDays: activeDates.size,
    },
    // 只统计「当前范围里真实出现过的」大类 / 科目 / 章节
    byCategory: groupCount(problems, (p) => p.category, [...new Set(problems.map((p) => p.category))]),
    bySubject: groupCount(problems, (p) => p.subject, [...new Set(problems.map((p) => p.subject))]),
    byChapter: groupCount(problems, (p) => p.chapter, [...new Set(problems.map((p) => p.chapter))]),
    byHeat: groupCount(problems, (p) => p.heat, [1, 2, 3, 4, 5]),
    byDifficulty: groupCount(problems, (p) => p.difficulty, [1, 2, 3, 4, 5]),
    byType: groupCount(problems, (p) => p.type, [...new Set(problems.map((p) => p.type))]),
    byPoint: pointStats(problems),
    byReason: reasonStats(problems),
    timing: timingStats(problems),
    due: problems
      .filter((p) => p.stats.status === '待复习')
      .sort((a, b) => b.stats.schedule.overdue - a.stats.schedule.overdue)
      .map(slim),
    // 大类 / 科目的地板数据（含 0 题的科目），给导航和上层总览用
    tree: tree.map((cat) => ({ ...share(cat), subjects: cat.children.map(share) })),
    trend,
    pending: pending.map(slim),
    troubled: troubled.map(slim),
    recent: recent.map((c) => ({ ...c })),
  };
}

/**
 * 考点标签统计：每个标签下有多少题、其中多少已复习、累计失败几次。
 * 「失败次数」是找薄弱点最直接的信号。
 */
function pointStats(problems) {
  const map = new Map();
  for (const p of problems) {
    for (const point of p.points || []) {
      if (!map.has(point)) map.set(point, { key: point, total: 0, done: 0, pending: 0, fail: 0, checkins: 0, ids: [] });
      const row = map.get(point);
      row.total += 1;
      if (p.stats.status === '已复习') row.done += 1;
      else row.pending += 1;
      row.fail += p.stats.fail;
      row.checkins += p.stats.total;
      row.ids.push(p.id);
    }
  }
  const rows = [...map.values()].sort((a, b) => b.fail - a.fail || b.total - a.total);
  const untagged = problems.filter((p) => !(p.points || []).length).length;
  return { rows, untagged, taggedCount: rows.length };
}

/**
 * 错因统计：首次错因 + 每次做错的错因，合起来看「你到底是怎么错的」。
 * 计算失误和概念不清要用的复习策略完全不同，所以这个分布比总分更有用。
 */
function reasonStats(problems) {
  const map = new Map();
  for (const p of problems) {
    for (const r of p.reasons || []) {
      if (!map.has(r.reason)) map.set(r.reason, { key: r.reason, total: 0, first: 0, later: 0, ids: [] });
      const row = map.get(r.reason);
      row.total += 1;
      r.first ? (row.first += 1) : (row.later += 1);
      row.ids.push(p.id);
    }
  }
  const rows = [...map.values()].sort((a, b) => b.total - a.total);
  return {
    rows,
    total: rows.reduce((s, r) => s + r.total, 0),
    noFirstReason: problems.filter((p) => !p.firstReason).length,
    noReasonAtAll: problems.filter((p) => !(p.reasons || []).length).length,
  };
}

/**
 * 用时分析：找出「做对了但很慢」的题——这类题比不会的题更好拿分。
 * 以所有有计时记录的题的中位数为基准，超过 1.5 倍中位数就算慢。
 */
function timingStats(problems) {
  const timed = problems.filter((p) => p.stats.avgSec != null);
  if (!timed.length) {
    return { timedCount: 0, medianSec: null, avgSec: null, slowThreshold: null, slow: [], fastest: null, totalSec: 0 };
  }
  const avgs = timed.map((p) => p.stats.avgSec).sort((a, b) => a - b);
  const mid = Math.floor(avgs.length / 2);
  const medianSec = avgs.length % 2 ? avgs[mid] : Math.round((avgs[mid - 1] + avgs[mid]) / 2);
  const slowThreshold = Math.max(60, Math.round(medianSec * 1.5));

  const slow = timed
    .filter((p) => p.stats.avgSec >= slowThreshold)
    .sort((a, b) => b.stats.avgSec - a.stats.avgSec)
    .map((p) => ({ ...slim(p), avgSec: p.stats.avgSec, lastSec: p.stats.lastSec }));

  return {
    timedCount: timed.length,
    medianSec,
    avgSec: Math.round(avgs.reduce((s, n) => s + n, 0) / avgs.length),
    slowThreshold,
    slow,
    fastest: [...timed].sort((a, b) => a.stats.avgSec - b.stats.avgSec)[0]?.num || null,
    totalSec: timed.reduce((s, p) => s + p.stats.totalSec, 0),
  };
}

function slim(p) {
  return {
    id: p.id,
    num: p.num,
    category: p.category,
    subject: p.subject,
    chapter: p.chapter,
    title: p.title,
    type: p.type,
    difficulty: p.difficulty,
    heat: p.heat,
    points: p.points || [],
    firstReason: p.firstReason || '',
    stats: p.stats,
    priority: p.priority,
  };
}
