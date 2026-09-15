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
 *
 * 🔁 每日任务（「每天都要做」）不一样：模板行永远是 `- [ ]`，**哪几天打过卡记在它
 * 下面的缩进子行里**，一天一行：
 *
 *   - [ ] 🔁 每日单词 130 个（墨墨背单词）
 *     - [x] 2026-09-14
 *     - [x] 2026-09-15
 *
 * 这样第二天自然不会带着昨天的勾 —— 每天看的是「今天那一行在不在」。
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
/** 每日任务的打卡子行：内容就是一串 YYYY-MM-DD */
const CHECKIN_RE = /^\d{4}-\d{2}-\d{2}$/;

const pad2 = (n) => String(n).padStart(2, '0');

/** 本机「今天」（YYYY-MM-DD） */
export function localToday(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 含头含尾的天数 */
function spanDays(start, end) {
  const [ay, am, ad] = start.split('-').map(Number);
  const [by, bm, bd] = end.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000) + 1;
}

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

/** 解析一份计划文件（today 只是用来算「每日任务今天打没打卡」，可注入以便测试） */
export function parsePlan(abs, vaultDir, today = localToday()) {
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
  let lastTask = null;
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
    // 每日任务下面的日期子行 = 那天的打卡，不是一条独立任务
    if (lastTask?.daily && CHECKIN_RE.test(raw.trim())) {
      if (t[2].toLowerCase() === 'x') lastTask.checkins.push(raw.trim());
      return;
    }
    const doneM = raw.match(DONE_DATE_RE);
    const body = doneM ? raw.replace(DONE_DATE_RE, '').trim() : raw.trim();
    const dateM = body.match(TASK_DATE_RE);
    let taskDate = null;
    // dateM = [整体, 月, 日]；fallbackMonth 已经是 'YYYY-MM'
    // 跨月周（如 10 月文件里的 11/1、12 月文件里的 1/1）：任务自带的月份和文件月份相差 ±1 时，
    // 按任务自带的月份算，否则 11/1 会被算成 10/1。
    if (dateM && fallbackMonth) {
      const dayNum = Number(dateM[2]);
      const monthNum = Number(dateM[1]);
      if (dayNum >= 1 && dayNum <= 31 && monthNum >= 1 && monthNum <= 12) {
        let [yy, mm] = fallbackMonth.split('-').map(Number);
        let delta = monthNum - mm;
        if (delta > 6) delta -= 12;
        if (delta < -6) delta += 12;
        if (delta !== 0 && Math.abs(delta) <= 1) {
          const rolled = new Date(Date.UTC(yy, mm - 1 + delta, 1));
          yy = rolled.getUTCFullYear();
          mm = rolled.getUTCMonth() + 1;
        }
        taskDate = `${yy}-${pad2(mm)}-${pad2(dayNum)}`;
      }
    }
    const task = {
      line: i,
      // 🔁 开头的任务表示「每天都要做」，程序会每天都列出来，不用在文件里复制 7 遍
      daily: /^🔁\s*/.test(body),
      text: body,
      done: t[2].toLowerCase() === 'x',
      doneDate: doneM ? doneM[1] : null,
      date: taskDate,
      indent: t[1].length,
      checkins: [],
    };
    // 旧写法：🔁 那行自己勾着（- [x] 🔁 … ✅ 2026-09-14）—— 把它当成一次打卡收进来，
    // 下次写回时模板行会被恢复成 - [ ]，记录落到子行里，历史不丢。
    if (task.daily && task.done) task.checkins.push(task.doneDate || today);
    lastTask = task;
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
  const inRange = (d) => !head.range || (d >= head.range.start && d <= head.range.end);

  // 每日任务按天算：一周 7 个位子，打过几天卡就算几天。
  // done / doneDate 说的仍然是「今天」（第二天自然回到未勾），打卡历史在 checkins 里。
  let doneCount = 0;
  let totalCount = 0;
  for (const t of all) {
    if (!t.daily) {
      totalCount += 1;
      if (t.done) doneCount += 1;
      continue;
    }
    t.checkins = [...new Set(t.checkins)].sort();
    t.slots = head.range ? spanDays(head.range.start, head.range.end) : 7;
    t.weekDone = t.checkins.filter(inRange).length;
    t.done = t.checkins.includes(today);
    t.doneDate = t.done ? today : null;
    totalCount += t.slots;
    doneCount += t.weekDone;
  }

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
    tasks: all.length, // 任务条目数（每日任务算 1 条）
    total: totalCount, // 完成率的分母：每日任务按天占位
    done: doneCount,
    rate: totalCount ? Math.round((doneCount / totalCount) * 100) : 0,
    daily: {
      total: all.filter((t) => t.daily).length,
      slots: all.reduce((s, t) => s + (t.daily ? t.slots : 0), 0),
      done: all.reduce((s, t) => s + (t.daily ? t.weekDone : 0), 0),
      rows: all.filter((t) => t.daily).map((t) => ({ text: t.text, done: t.weekDone, slots: t.slots, checkins: t.checkins })),
    },
    mtime: fs.statSync(abs).mtimeMs,
  };
}

/** 扫描计划目录里的全部计划 */
export function scanPlans(planDir, vaultDir, today = localToday()) {
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
          out.push(parsePlan(abs, vaultDir, today));
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
 *
 * 🔁 每日任务走另一条路：勾 = 在它下面加一行当天的打卡，取消 = 把那行删掉。
 * 模板行永远保持 `- [ ]`，所以第二天不会带着昨天的勾。
 */
export function toggleTask(vaultDir, backupDir, relPath, { line, expect, done, occurrence, date }) {
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

  const stamp = date && /^\d{4}-\d{2}-\d{2}$/.test(String(date)) ? String(date) : localToday();

  // 🔁 每日任务：勾的是「哪一天」，不是这一行本身
  if (/^🔁\s*/.test(curBody)) {
    return toggleDailyCheckin({ vaultDir, backupDir, abs, relPath, lines, idx, m, curBody, curRaw, stamp, done });
  }

  lines[idx] = done
    ? `${m[1]}- [x] ${curBody} ✅ ${stamp}`
    : `${m[1]}- [ ] ${curBody}`;

  backupFile(abs, vaultDir, backupDir, 'plan');
  writeText(abs, lines.join('\n'));
  return { rel: relPath, line: idx, done: !!done, doneDate: done ? stamp : null, text: curBody, daily: false };
}

/**
 * 每日任务的打卡：勾 = 追加一行 `- [x] YYYY-MM-DD` 子行，取消 = 删掉那一天。
 * 顺手把旧格式（模板行自己勾着 + ✅ 日期）迁移成子行，历史不丢。
 */
function toggleDailyCheckin({ vaultDir, backupDir, abs, relPath, lines, idx, m, curBody, curRaw, stamp, done }) {
  const parentIndent = m[1];
  const childIndent = `${parentIndent}  `;

  // 紧跟在模板行下面的打卡子行（允许中间有空行）；遇到不更深的行就停
  const kidRows = [];
  const dates = new Set();
  for (let i = idx + 1; i < lines.length; i += 1) {
    if (/^\s*$/.test(lines[i])) continue;
    const km = lines[i].match(TASK_RE);
    if (!km || km[1].length <= parentIndent.length) break;
    if (!CHECKIN_RE.test(km[3].trim())) break;
    kidRows.push(i);
    if (km[2].toLowerCase() === 'x') dates.add(km[3].trim());
  }

  // 旧格式：模板行上那个 ✅ 日期也算一次打卡
  const legacy = (curRaw.match(DONE_DATE_RE) || [])[1];
  if (legacy) dates.add(legacy);

  if (done) dates.add(stamp);
  else dates.delete(stamp);

  const kids = [...dates].sort();
  // 模板行永远保持 - [ ]，打卡子行按日期排好插在它下面
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (kidRows.includes(i)) continue;
    out.push(i === idx ? `${parentIndent}- [ ] ${curBody}` : lines[i]);
    if (i === idx) for (const d of kids) out.push(`${childIndent}- [x] ${d}`);
  }

  backupFile(abs, vaultDir, backupDir, 'plan');
  writeText(abs, out.join('\n'));
  return {
    rel: relPath,
    line: idx,
    done: !!done,
    doneDate: done ? stamp : null,
    text: curBody,
    daily: true,
    checkins: kids,
  };
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
