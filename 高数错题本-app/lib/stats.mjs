/**
 * stats.mjs —— 统计聚合
 * 所有数字都从题目的打卡记录现算，不存任何冗余状态，因此永不失真。
 */

import { RESULTS } from './parse.mjs';
import { today } from './write.mjs';

const STATUS_LABEL = { 完成: '✅ 复习完成', 进行中: '⏳ 待复习·做过', 未做: '⏳ 待复习·未做' };

export function statusLabel(status) {
  return STATUS_LABEL[status] || status;
}

/** 记录的日期（没有日期就按未记录处理） */
function datesOf(problem) {
  return problem.checkins.filter((c) => c.done && c.date).map((c) => c.date);
}

/** 复习优先级：热度权重最高，其次难度，再减去已打卡次数 */
export function priorityOf(p) {
  return p.heat * 2 + p.difficulty - p.stats.total * 0.5 + (p.stats.fail > 0 ? 1.5 : 0);
}

function groupCount(problems, keyFn, keys) {
  const out = new Map(keys.map((k) => [k, { key: k, total: 0, done: 0, pending: 0 }]));
  for (const p of problems) {
    const k = keyFn(p);
    if (!out.has(k)) out.set(k, { key: k, total: 0, done: 0, pending: 0 });
    const row = out.get(k);
    row.total += 1;
    if (p.stats.status === '完成') row.done += 1;
    else row.pending += 1;
  }
  return [...out.values()];
}

export function computeStats(problems, chapters) {
  const total = problems.length;
  const done = problems.filter((p) => p.stats.status === '完成').length;
  const started = problems.filter((p) => p.stats.status === '进行中').length;
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
    .filter((p) => p.stats.status !== '完成')
    .map((p) => ({ ...p, priority: priorityOf(p) }))
    .sort((a, b) => b.priority - a.priority);

  const troubled = problems
    .filter((p) => p.stats.fail > 0)
    .sort((a, b) => b.stats.fail - a.stats.fail || priorityOf(b) - priorityOf(a));

  const recent = [...checkinsAll]
    .filter((c) => c.date)
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 12);

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      total,
      done,
      started,
      untouched,
      pending: started + untouched,
      checkins: checkinsAll.length,
      byResult,
      completionRate: total ? Math.round((done / total) * 100) : 0,
      streak,
      activeDays: activeDates.size,
    },
    byChapter: groupCount(problems, (p) => p.chapter, chapters),
    byHeat: groupCount(problems, (p) => p.heat, [1, 2, 3, 4, 5]),
    byDifficulty: groupCount(problems, (p) => p.difficulty, [1, 2, 3, 4, 5]),
    byType: groupCount(problems, (p) => p.type, [...new Set(problems.map((p) => p.type))]),
    trend,
    pending: pending.map(slim),
    troubled: troubled.map(slim),
    recent: recent.map((c) => ({ ...c })),
  };
}

function slim(p) {
  return {
    id: p.id,
    num: p.num,
    chapter: p.chapter,
    title: p.title,
    type: p.type,
    difficulty: p.difficulty,
    heat: p.heat,
    stats: p.stats,
    priority: p.priority,
  };
}
