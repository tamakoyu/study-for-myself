/**
 * today.mjs —— 首页「今日」需要的聚合数据
 *
 * 倒计时 · 今日任务 · 本周与本月完成度 · 今日复盘状态 · 错题速览
 */

import { scanPlans, weekPlanFor, monthPlanFor } from './plans.mjs';
import { reviewRelPath } from './reviews.mjs';
import fs from 'node:fs';
import path from 'node:path';

const pad2 = (n) => String(n).padStart(2, '0');
export const todayStr = (d = new Date()) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 天数差（本地日） */
export function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((new Date(by, bm - 1, bd) - new Date(ay, am - 1, ad)) / 86400000);
}

let planCache = { at: 0, data: null, key: '' };

/** 计划扫描带 3 秒缓存，避免首页每次请求都读 99 个文件 */
export function plansCached(cfg, force = false) {
  const key = cfg.planDir;
  const now = Date.now();
  if (!force && planCache.data && planCache.key === key && now - planCache.at < 3000) return planCache.data;
  const data = scanPlans(cfg.planDir, cfg.vaultDir);
  planCache = { at: now, data, key };
  return data;
}

export function buildToday(cfg, mistakesStats, now = new Date()) {
  const date = todayStr(now);
  const month = date.slice(0, 7);
  const plans = plansCached(cfg);

  const week = weekPlanFor(plans, date);
  const monthPlan = monthPlanFor(plans, month);

  // 月计划文件只是索引页，任务都在周计划里 —— 所以本月进度要按当月所有周计划汇总
  const monthWeeks = plans.filter((p) => p.kind === 'week' && p.month === month);
  const monthTaskTotal = monthWeeks.reduce((s, p) => s + p.total, 0);
  const monthTaskDone = monthWeeks.reduce((s, p) => s + p.done, 0);

  // 倒数
  const days = daysBetween(date, cfg.examDate);

  // 今日任务：任务文本里写了今天日期的，加上本周未标日期的待办
  const weekTasks = week ? week.taskGroups.flatMap((g) => g.tasks.map((t) => ({ ...t, group: g.name }))) : [];
  const dailyTasks = weekTasks.filter((t) => t.daily);
  const todayTasks = [...weekTasks.filter((t) => t.date === date && !t.daily), ...dailyTasks];
  // 每日任务已经出现在 todayTasks 里了，这里别再列一遍
  const undated = weekTasks.filter((t) => !t.daily && !t.date && !t.done);
  const restUndone = weekTasks.filter(
    (t) => !t.daily && t.date && t.date !== date && !t.done && t.date > date
  );

  const doneOf = (list) => list.filter((t) => t.done).length;
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

  // 今日复盘
  const reviewRel = reviewRelPath(date, plans);
  const reviewExists = fs.existsSync(path.join(cfg.vaultDir, reviewRel));

  // 本周每一天的完成情况（按任务自带的日期聚合）
  const byDay = {};
  for (const t of weekTasks) {
    if (!t.date || t.daily) continue;
    byDay[t.date] = byDay[t.date] || { total: 0, done: 0 };
    byDay[t.date].total += 1;
    if (t.done) byDay[t.date].done += 1;
  }
  let weekDays = [];
  if (week?.range) {
    const n = daysBetween(week.range.start, week.range.end) + 1;
    for (let i = 0; i < n; i += 1) {
      const [y, m, d] = week.range.start.split('-').map(Number);
      const dt = new Date(y, m - 1, d + i);
      const key = todayStr(dt);
      weekDays.push({
        date: key,
        label: `${m}/${d + i}`,
        weekday: WEEKDAY[dt.getDay()],
        isToday: key === date,
        isPast: key < date,
        total: byDay[key]?.total || 0,
        done: byDay[key]?.done || 0,
      });
    }
  }

  return {
    date,
    weekday: WEEKDAY[now.getDay()],
    month,
    countdown: { examDate: cfg.examDate, days, weeks: Math.floor(days / 7), months: Math.floor(days / 30) },
    week: week
      ? {
          rel: week.rel,
          title: week.title,
          h1: week.h1,
          week: week.week,
          range: week.range,
          total: week.total,
          done: week.done,
          rate: week.rate,
          days: weekDays,
        }
      : null,
    monthPlan: {
      rel: monthPlan ? monthPlan.rel : null,
      title: monthPlan ? monthPlan.h1 : `${month} 月`,
      total: monthTaskTotal,
      done: monthTaskDone,
      rate: monthTaskTotal ? Math.round((monthTaskDone / monthTaskTotal) * 100) : 0,
      weeks: monthWeeks.length,
    },
    todayTasks,
    undated,
    restUndone: restUndone.slice(0, 12),
    todayRate: pct(doneOf(todayTasks), todayTasks.length),
    review: { rel: reviewRel, exists: reviewExists },
    mistakes: mistakesStats
      ? {
          total: mistakesStats.totals.total,
          done: mistakesStats.totals.done,
          pending: mistakesStats.totals.pending,
          due: mistakesStats.due?.length || 0,
          rate: mistakesStats.totals.completionRate,
          checkins: mistakesStats.totals.checkins,
          streak: mistakesStats.totals.streak,
        }
      : null,
    plansSummary: {
      count: plans.length,
      weeks: plans.filter((p) => p.kind === 'week').length,
      months: plans.filter((p) => p.kind === 'month').length,
    },
  };
}
