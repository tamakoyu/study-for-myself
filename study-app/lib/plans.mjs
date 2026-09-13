/**
 * plans.mjs —— 解析 Obsidian 里的周计划 / 月计划
 *
 * 你现有的格式：
 *   # 📅 2026-09 第 2 周（9/7–9/13）｜极限主线 · C 语言基础语法
 *   ## 📋 本周任务
 *   ### 📐 数学
 *   - [x] 9/7（周一）极限 (4)（视频 34min） ✅ 2026-09-09
 *   - [ ] 9/12（周六）极限 (9)（视频 47min）＋练习册补做
 *
 * 勾选写回也按这个约定：打勾时在行尾补 ` ✅ YYYY-MM-DD`，取消时把它去掉。
 */

import fs from 'node:fs';
import path from 'node:path';
import { readText, writeText, backupFile } from './vault.mjs';

const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
export const cnWeek = (n) => (n <= 10 ? `第${CN_NUM[n]}周` : `第${n}周`);

/** 只有这两节里的是「真任务」；错题四步法之类是方法说明，不该算进完成率 */
const zoneOf = (h2) => (/本周任务|遗忘曲线复习/.test(h2 || '') ? 'task' : 'other');

/** - [ ] 内容 / - [x] 内容 ✅ 2026-09-09 */
const TASK_RE = /^(\s*)- \[([ xX])\]\s+(.*)$/;
const DONE_DATE_RE = /\s*✅\s*(\d{4}-\d{2}-\d{2})\s*$/;
/** 任务里带的日期标注：9/7（周一） / 9/7 */
const TASK_DATE_RE = /(?:^|\s)(\d{1,2})\/(\d{1,2})(?=[（(\s]|$)/;

const pad2 = (n) => String(n).padStart(2, '0');

/** 从 H1 里抠出月份、周次、日期范围 */
function parsePlanHeading(h1, fileMonth) {
  const out = { month: fileMonth, week: null, range: null, title: '' };
  if (!h1) return out;
  const bar = h1.split('｜');
  out.title = (bar[1] || '').trim();
  const head = bar[0] || h1;

  const mw = head.match(/(\d{4})-(\d{2})\s*第\s*(\d+)\s*周/);
  if (mw) {
    out.month = `${mw[1]}-${mw[2]}`;
    out.week = Number(mw[3]);
  }
  const r = head.match(/[（(]\s*(\d{1,2})\/(\d{1,2})\s*[–—~-]\s*(\d{1,2})\/(\d{1,2})\s*[）)]/);
  if (r && out.month) {
    // r = [整体, 起月, 起日, 止月, 止日]
    const [y, m] = out.month.split('-').map(Number);
    const startMonth = Number(r[1]);
    const endMonthNo = Number(r[3]);
    const start = `${y}-${pad2(startMonth)}-${pad2(Number(r[2]))}`;
    const end = `${y}-${pad2(endMonthNo)}-${pad2(Number(r[4]))}`;
    out.range = start <= end ? { start, end } : { start: end, end: start };
    if (startMonth !== m) out.month = `${y}-${pad2(startMonth)}`;
  }
  return out;
}

/** 解析一份计划文件 */
export function parsePlan(abs, vaultDir) {
  const text = readText(abs);
  const rel = path.relative(vaultDir, abs).split(path.sep).join('/');
  const fileName = path.basename(abs, '.md');

  const kind = /月计划/.test(fileName) ? 'month' : /周计划/.test(fileName) ? 'week' : 'other';
  const fileMonth = (fileName.match(/(\d{4})-(\d{2})/) || []).slice(0, 3);
  const fallbackMonth = fileMonth.length === 3 ? `${fileMonth[1]}-${fileMonth[2]}` : null;

  const lines = text.split('\n');
  let h1 = null;
  const groups = [];
  let curGroup = null;
  let curH2 = '';
  const headings = [];

  lines.forEach((line, i) => {
    const h1m = line.match(/^#\s+(.*)$/);
    if (h1m && h1 === null) {
      h1 = h1m[1].trim();
      return;
    }
    const h2 = line.match(/^##\s+(.*)$/);
    if (h2) {
      curH2 = h2[1].trim();
      headings.push(curH2);
      curGroup = null;
      return;
    }
    const h3 = line.match(/^###\s+(.*)$/);
    if (h3) {
      curGroup = { name: h3[1].trim(), zone: zoneOf(curH2), tasks: [] };
      groups.push(curGroup);
      return;
    }
    const t = line.match(TASK_RE);
    if (!t) return;
    const raw = t[3];
    const doneM = raw.match(DONE_DATE_RE);
    const body = doneM ? raw.replace(DONE_DATE_RE, '').trim() : raw.trim();
    const dateM = body.match(TASK_DATE_RE);
    const month = fallbackMonth;
    let taskDate = null;
    // dateM = [整体, 月, 日]；month 已经是 'YYYY-MM'
    if (dateM && month) taskDate = `${month}-${pad2(Number(dateM[2]))}`;
    const task = {
      line: i,
      // 🔁 开头的任务表示「每天都要做」，程序会每天都列出来，不用在文件里复制 7 遍
      daily: /^🔁\s*/.test(body),
      text: body,
      done: t[2].toLowerCase() === 'x',
      doneDate: doneM ? doneM[1] : null,
      date: taskDate,
      indent: t[1].length,
    };
    if (curGroup) curGroup.tasks.push(task);
    else {
      const last = groups[groups.length - 1];
      if (!last || last.name !== '_未分组' || last.zone !== zoneOf(curH2)) {
        curGroup = { name: zoneOf(curH2) === 'task' ? '本周任务' : '_未分组', zone: zoneOf(curH2), tasks: [] };
        groups.push(curGroup);
      } else {
        curGroup = last;
      }
      curGroup.tasks.push(task);
      curGroup = null;
    }
  });

  const head = parsePlanHeading(h1, fallbackMonth);
  const taskGroups = groups.filter((g) => g.zone === 'task');
  const all = taskGroups.flatMap((g) => g.tasks);
  const doneCount = all.filter((t) => t.done).length;

  return {
    rel,
    abs,
    fileName,
    kind,
    month: head.month,
    week: head.week,
    range: head.range,
    title: head.title,
    h1,
    headings,
    groups,
    taskGroups,
    total: all.length,
    done: doneCount,
    rate: all.length ? Math.round((doneCount / all.length) * 100) : 0,
    mtime: fs.statSync(abs).mtimeMs,
  };
}

/** 扫描计划目录里的全部计划 */
export function scanPlans(planDir, vaultDir) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs, depth + 1);
      else if (e.name.endsWith('.md')) {
        try {
          out.push(parsePlan(abs, vaultDir));
        } catch {
          /* 单篇失败不影响整体 */
        }
      }
    }
  };
  walk(planDir, 0);
  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'month' ? -1 : b.kind === 'month' ? 1 : 0;
    return (a.range?.start || a.month || a.fileName).localeCompare(b.range?.start || b.month || b.fileName);
  });
  return out;
}

/**
 * 勾选 / 取消勾选某个任务，写回原文件。
 * 用「行号 + 内容指纹」双重校验，对不上就拒绝写，避免改错行。
 */
export function toggleTask(vaultDir, backupDir, relPath, { line, expect, done, occurrence }) {
  const abs = path.join(vaultDir, relPath);
  if (!fs.existsSync(abs)) throw Object.assign(new Error('找不到计划文件'), { status: 404 });

  const text = readText(abs);
  const lines = text.split('\n');

  // 定位任务：优先用行号（校验内容），没有行号就按文本 + 第几次出现来定位
  let idx = -1;
  const want = expect == null ? null : String(expect).trim();
  if (Number.isInteger(Number(line)) && Number(line) >= 0 && Number(line) < lines.length) {
    const m0 = lines[Number(line)].match(TASK_RE);
    if (m0 && (want == null || m0[3].replace(DONE_DATE_RE, '').trim() === want)) idx = Number(line);
  }
  if (idx === -1 && want != null) {
    const occ = Math.max(0, Number(occurrence) || 0);
    let seen = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const m1 = lines[i].match(TASK_RE);
      if (!m1) continue;
      if (m1[3].replace(DONE_DATE_RE, '').trim() !== want) continue;
      if (seen === occ) {
        idx = i;
        break;
      }
      seen += 1;
    }
  }
  if (idx === -1) {
    throw Object.assign(new Error('找不到这条任务，已中止（文件可能被改过）'), { status: 409 });
  }

  const m = lines[idx].match(TASK_RE);
  const curRaw = m[3];
  const curBody = curRaw.replace(DONE_DATE_RE, '').trim();
  if (want != null && curBody !== want) {
    throw Object.assign(new Error('任务内容与预期不符，已中止（文件可能被改过）'), { status: 409 });
  }

  const today = new Date();
  const stamp = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;

  lines[idx] = done
    ? `${m[1]}- [x] ${curBody} ✅ ${stamp}`
    : `${m[1]}- [ ] ${curBody}`;

  backupFile(abs, vaultDir, backupDir, 'plan');
  writeText(abs, lines.join('\n'));
  return { rel: relPath, line: idx, done: !!done, doneDate: done ? stamp : null, text: curBody };
}

/** 找出包含某一天的那份周计划 */
export function weekPlanFor(plans, dateStr) {
  return (
    plans.find((p) => p.kind === 'week' && p.range && p.range.start <= dateStr && dateStr <= p.range.end) || null
  );
}

/** 找出某个月的那份月计划 */
export function monthPlanFor(plans, month) {
  return plans.find((p) => p.kind === 'month' && p.month === month) || null;
}
