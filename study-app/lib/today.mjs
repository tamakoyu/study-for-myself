/**
 * today.mjs —— 首页「今日」需要的聚合数据
 *
 * 倒计时 · 今日任务 · 本周与本月完成度 · 今日复盘状态 · 错题速览
 */

import { scanPlans, weekPlanFor, monthPlanFor } from './plans.mjs';
import { reviewRelPath } from './reviews.mjs';
import { quoteOfTheDay, parseExtraQuotes } from './quotes.mjs';
import fs from 'node:fs';
import path from 'node:path';

const pad2 = (n) => String(n).padStart(2, '0');
export const todayStr = (d = new Date()) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 'YYYY-MM-DD' → 0–6（周日=0） */
const weekdayOf = (dateStr) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
};

/** 天数差（本地日） */
export function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((new Date(by, bm - 1, bd) - new Date(ay, am - 1, ad)) / 86400000);
}

let planCache = { at: 0, data: null, key: '' };

/** 自己在 quotes.txt 里加的句子（一行一句 `句子 | 出处`）；读不到就当没有 */
export function extraQuotes(cfg) {
  try {
    if (!cfg.quotesFile || !fs.existsSync(cfg.quotesFile)) return [];
    return parseExtraQuotes(fs.readFileSync(cfg.quotesFile, 'utf8'));
  } catch {
    return [];
  }
}

/** 计划扫描带 3 秒缓存，避免首页每次请求都读 99 个文件 */
export function plansCached(cfg, force = false) {
  const key = cfg.planDir;
  const now = Date.now();
  if (!force && planCache.data && planCache.key === key && now - planCache.at < 3000) return planCache.data;
  const data = scanPlans(cfg.planDir, cfg.vaultDir);
  planCache = { at: now, data, key };
  return data;
}

/**
 * 首页「今日」的数据。
 * viewDate 传了某一天（YYYY-MM-DD）就是「看那一周里的那一天」：
 * 任务列表、复盘状态都换成那天的，倒计时 / 每日一句仍按真正的今天算。
 */
export function buildToday(cfg, mistakesStats, now = new Date(), viewDate = null) {
  const realToday = todayStr(now);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(viewDate || '')) ? String(viewDate) : realToday;
  const isToday = date === realToday;
  const month = realToday.slice(0, 7);
  const plans = plansCached(cfg);

  const week = weekPlanFor(plans, date);
  const monthPlan = monthPlanFor(plans, month);

  // 月计划文件只是索引页，任务都在周计划里 —— 所以本月进度要按当月所有周计划汇总
  const monthWeeks = plans.filter((p) => p.kind === 'week' && p.month === month);
  const monthTaskTotal = monthWeeks.reduce((s, p) => s + p.total, 0);
  const monthTaskDone = monthWeeks.reduce((s, p) => s + p.done, 0);

  // 倒数（永远按真正的今天算，看别的日子也不会变成另一天的倒计时）
  const days = daysBetween(realToday, cfg.examDate);

  // 今日任务：任务文本里写了这天日期的，加上每天都要做的
  // 🔁 每日任务的「完成」按天算 —— 那天那行打卡在不在，跟别的日子无关
  const weekTasks = week
    ? week.taskGroups
        .flatMap((g) => g.tasks.map((t) => ({ ...t, group: g.name })))
        .map((t) => (t.daily ? { ...t, done: t.checkins.includes(date), doneDate: t.checkins.includes(date) ? date : null } : t))
    : [];
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

  // 本周每一天的完成情况：标了那天的任务，加上每条每日任务（每天都占一个位子）
  const weekDates = [];
  if (week?.range) {
    const n = daysBetween(week.range.start, week.range.end) + 1;
    for (let i = 0; i < n; i += 1) {
      const [y, m, d] = week.range.start.split('-').map(Number);
      weekDates.push(todayStr(new Date(y, m - 1, d + i)));
    }
  }
  const byDay = {};
  for (const key of weekDates) byDay[key] = { total: 0, done: 0 };
  for (const t of weekTasks) {
    if (t.daily) {
      // 每日任务一周 7 个位子：那天打了卡就算当天完成
      for (const key of weekDates) {
        byDay[key].total += 1;
        if (t.checkins.includes(key)) byDay[key].done += 1;
      }
      continue;
    }
    if (!t.date) continue;
    byDay[t.date] = byDay[t.date] || { total: 0, done: 0 };
    byDay[t.date].total += 1;
    if (t.done) byDay[t.date].done += 1;
  }
  const weekDays = weekDates.map((key) => {
    const [y, m, d] = key.split('-').map(Number);
    return {
      date: key,
      label: `${m}/${d}`,
      weekday: WEEKDAY[new Date(y, m - 1, d).getDay()],
      isToday: key === realToday,
      isViewing: key === date,
      isPast: key < realToday,
      total: byDay[key].total,
      done: byDay[key].done,
    };
  });

  return {
    date,
    weekday: WEEKDAY[weekdayOf(date)],
    // 在看哪天：今天 / 本周里的某一天（首页点「本周进度」那排就能翻）
    viewing: { date, realToday, isToday, isFuture: date > realToday },
    month,
    countdown: { examDate: cfg.examDate, days, weeks: Math.floor(days / 7), months: Math.floor(days / 30) },
    // 每日一句：同一天永远同一句，跨天自动换（看别的日子也还是今天的这句）
    quote: quoteOfTheDay(realToday, extraQuotes(cfg)),
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
          // 每日任务的打卡进度：本周该打几次、已经打了几次
          daily: week.daily,
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
