/**
 * weekly.mjs —— 生成「本周状态总结 + 下周建议」的提示词
 *
 * 程序不会自己下结论，它只负责把这一周的事实（计划完成情况、每日复盘原文、
 * 错题与错因数据）整理成一段提示词。你把它发给我，我把总结写回周计划的
 * `## 🤖 本周状态与建议` 一节，首页就会显示出来。
 */

import fs from 'node:fs';
import path from 'node:path';
import { scanPlans, weekPlanFor, monthPlanFor } from './plans.mjs';
import { listReviews } from './reviews.mjs';
import { readText } from './vault.mjs';

const pad2 = (n) => String(n).padStart(2, '0');
export const todayStr = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

const SUMMARY_HEADING = '## 🤖 本周状态与建议';

/** 从周计划原文里抠出已有的总结 */
function existingSummary(abs) {
  if (!fs.existsSync(abs)) return null;
  const lines = readText(abs).split('\n');
  const start = lines.findIndex((l) => l.trim() === SUMMARY_HEADING);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start + 1, end).join('\n').trim();
  return body ? { body, rel: abs } : null;
}

export function buildWeekly(cfg, mistakesStats) {
  const date = todayStr();
  const plans = scanPlans(cfg.planDir, cfg.vaultDir);
  const week = weekPlanFor(plans, date);
  const month = monthPlanFor(plans, date.slice(0, 7));

  if (!week) {
    return { date, week: null, summary: null, prompt: null, note: '没有找到本周的周计划，先去看看 考研/ 下的文件。' };
  }

  const tasks = week.taskGroups.flatMap((g) => g.tasks.map((t) => ({ ...t, group: g.name })));
  const undone = tasks.filter((t) => !t.done);

  // 这一周的每日复盘原文
  const all = listReviews(cfg.reviewDir, cfg.vaultDir);
  const inWeek = all
    .filter((r) => r.date && r.date >= week.range.start && r.date <= week.range.end)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((r) => ({ date: r.date, body: readText(path.join(cfg.vaultDir, r.rel)).trim() }));

  // 错题侧的数据
  const m = mistakesStats || {};
  const trouble = (m.troubled || []).slice(0, 8).map((p) => `${p.num}（失败 ${p.stats.fail} 次）`);
  const dueList = (m.due || []).slice(0, 10).map((p) => p.num);
  const reasons = (m.byReason?.rows || []).slice(0, 6).map((r) => `${r.key} ×${r.total}`);
  const points = (m.byPoint?.rows || []).slice(0, 8).map((r) => `${r.key}（${r.total} 题，失败 ${r.fail} 次）`);

  const summary = existingSummary(path.join(cfg.vaultDir, week.rel));

  const prompt = `请帮我总结这一周的学习状态，并给出下一周的建议。

## 本周事实

**周次**：${week.range.start} ~ ${week.range.end}（第 ${week.week} 周）
**主题**：${week.title}
**任务完成**：${week.done} / ${week.total}（${week.rate}%）

**没完成的任务**（${undone.length} 条）：
${undone.length ? undone.map((t) => `- [${t.group}] ${t.text}`).join('\n') : '（全部完成）'}

## 这一周的每日复盘

${inWeek.length ? inWeek.map((r) => `### ${r.date}\n${r.body}`).join('\n\n') : '（这周还没写复盘）'}

## 错题情况

- 题目总数 ${m.totals?.total ?? 0}，已复习 ${m.totals?.done ?? 0}，待复习 ${m.totals?.pending ?? 0}
- 到遗忘曲线的：${dueList.length ? dueList.join('、') : '无'}
- 反复做错的题：${trouble.length ? trouble.join('、') : '无'}
- 错因分布：${reasons.length ? reasons.join('、') : '还没记录'}
- 薄弱考点：${points.length ? points.join('、') : '还没打标签'}

## 请你输出

用 Markdown 写两节，直接给我可以粘贴回文件的内容：

**一、本周状态**（3–6 条，每条一句话，要具体到数字和事实，不要空话）
- 计划执行：完成率与偏差在哪
- 时间/节奏：从复盘里看出的问题
- 错题：哪类考点、哪种错法最突出
- 值得保持的

**二、下周建议**（3–5 条，必须是可执行的调整）
- 计划层面：哪些任务该拆小、该减、该延后
- 错题层面：优先重做哪些题、重点补哪个考点
- 习惯层面：具体到每天怎么做

要求：
1. 只说这一周的数据能支持的话，不要编造。
2. 语气直接、像教练，不要客套。
3. 最后用一行「一句话总结：……」收尾。

写完请把内容写进 \`${week.rel}\` 的 \`${SUMMARY_HEADING}\` 一节（没有就新建，放在文件最前面、H1 之后）。`;

  return {
    date,
    week: {
      rel: week.rel,
      title: week.title,
      range: week.range,
      week: week.week,
      total: week.total,
      done: week.done,
      rate: week.rate,
      undone: undone.length,
      monthRate: month ? month.rate : null,
    },
    reviewCount: inWeek.length,
    summary,
    prompt,
  };
}
