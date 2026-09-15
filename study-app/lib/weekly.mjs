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
import { readText, writeText, backupFile } from './vault.mjs';

const pad2 = (n) => String(n).padStart(2, '0');
export const todayStr = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

const SUMMARY_HEADING = '## 🤖 本周状态与建议';

/**
 * 把 AI 写好的总结写回周计划的 `## 🤖 本周状态与建议` 一节。
 * 只动这一节：没写过就插在 H1 之后，写过就整段替换。其余内容一个字节都不碰。
 */
export function writeWeeklySummary(cfg, rel, body, backupRoot = cfg.backupDir) {
  const abs = path.join(cfg.vaultDir, rel);
  if (!fs.existsSync(abs)) throw Object.assign(new Error(`找不到 ${rel}`), { status: 404 });
  backupFile(abs, cfg.vaultDir, backupRoot, 'weekly');
  const text = readText(abs);
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === SUMMARY_HEADING);
  const block = [SUMMARY_HEADING, '', String(body).trim(), ''];

  if (start === -1) {
    // 没写过：插在 H1 之后（找不到 H1 就放最前面）
    const h1 = lines.findIndex((l) => /^#\s/.test(l));
    const at = h1 === -1 ? 0 : h1 + 1;
    // 顺手吃掉 H1 后面已有的空行，不然插完会多出一个空行
    let skip = 0;
    while (lines[at + skip] !== undefined && lines[at + skip].trim() === '') skip += 1;
    lines.splice(at, skip, '', ...block);
  } else {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^##\s/.test(lines[i])) {
        end = i;
        break;
      }
    }
    lines.splice(start, end - start, ...block);
  }
  writeText(abs, lines.join('\n'));
  return { ok: true, rel, chars: String(body).trim().length };
}

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

/**
 * 往前的周里最近一份写过总结的。
 * 周一一切周，上周写好的结论就不在当前周的文件里了 —— 不主动找出来，看起来就像「丢了」。
 */
function previousSummary(cfg, plans, week) {
  const earlier = plans
    .filter((p) => p.kind === 'week' && p.range && p.range.end < week.range.start)
    .sort((a, b) => b.range.start.localeCompare(a.range.start));
  for (const p of earlier) {
    const found = existingSummary(path.join(cfg.vaultDir, p.rel));
    if (found) {
      return { rel: p.rel, title: p.title, week: p.week, range: p.range, body: found.body };
    }
  }
  return null;
}

export function buildWeekly(cfg, mistakesStats) {
  const date = todayStr();
  const plans = scanPlans(cfg.planDir, cfg.vaultDir);
  const week = weekPlanFor(plans, date);
  const month = monthPlanFor(plans, date.slice(0, 7));

  if (!week) {
    return { date, week: null, summary: null, previous: null, prompt: null, note: '没有找到本周的周计划，先去看看 考研/ 下的文件。' };
  }

  const tasks = week.taskGroups.flatMap((g) => g.tasks.map((t) => ({ ...t, group: g.name })));
  // 每日任务不列进「没完成」—— 它是每天都要做的，只看这条周计划里打了几次卡
  const undone = tasks.filter((t) => !t.daily && !t.done);
  const dailyLine = week.daily?.total
    ? week.daily.rows.map((r) => `${r.text.replace(/^🔁\s*/, '')} ${r.done}/${r.slots}`).join('、')
    : null;

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
  const previous = summary ? null : previousSummary(cfg, plans, week);

  const prompt = `请帮我总结这一周的学习状态，并给出下一周的建议。

## 本周事实

**周次**：${week.range.start} ~ ${week.range.end}（第 ${week.week} 周）
**主题**：${week.title}
**任务完成**：${week.done} / ${week.total}（${week.rate}%）
${dailyLine ? `**每日任务打卡**（本周已打卡 / 应打卡）：${dailyLine}` : ''}

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

**总长控制在 250 字以内**，超了就是没抓住重点。直接给能粘贴回文件的 Markdown：

**一句话结论**：开头单独一行，**25 字以内**，把这一周最大的问题说透。

**一、本周状态**：**最多 3 条**，每条一行、**不超过 40 字**，必须带数字。
只写「数据说明了什么」，不要复述数据本身（原文里已经有完成率了，别抄一遍）。

**二、下周建议**：**最多 3 条**，每条一行、**不超过 40 字**，动词开头，落到「做什么 / 哪天做」。

硬要求：
1. **一条只说一件事**，不许用「；」把几件事塞进一条，也不要一句话里套三个分句。
2. 每条的**关键词用加粗**标出来，让人一眼扫到重点。
3. 只说这一周的数据能支持的话，不编造、不客套，语气直接像教练。
4. 不要「值得保持的」这类凑数条目，不要小标题套小标题 —— 两层结构到此为止。

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
      daily: week.daily,
      monthRate: month ? month.rate : null,
    },
    reviewCount: inWeek.length,
    summary,
    previous,
    prompt,
  };
}
