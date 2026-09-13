#!/usr/bin/env node
/**
 * scripts/date-plans.mjs —— 给 9 月 / 10 月周计划里的每个任务补上日期
 *
 * 只改「## 📋 本周任务」和「## 🔁 遗忘曲线复习」两个区块里的任务行，其余原样保留。
 *
 *   1. 已有日期的任务：保留；如果日期早于今天且没完成 → 顺延到今天（本周内）
 *   2. 「每日……」开头的任务：加 🔁 前缀，程序会每天列出来，不用复制 7 遍
 *   3. 其余没日期的任务：对齐「## 📅 每日安排建议」表格里当天的重点来落日期；
 *      对不上就分给当前任务最少的那天
 *
 * 用法：
 *   node scripts/date-plans.mjs            # 只看结果，不写文件
 *   node scripts/date-plans.mjs --apply    # 真正写入（写入前自动备份）
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../lib/notebook.mjs';

const APPLY = process.argv.includes('--apply');
const PREVIEW = (process.argv.find((a) => a.startsWith('--preview=')) || '').split('=')[1] || null;
const cfg = loadConfig();
const todayStr = new Date().toISOString().slice(0, 10);

const pad2 = (n) => String(n).padStart(2, '0');
const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const TASK_RE = /^(\s*)- \[([ xX])\]\s+(.*)$/;
const DONE_DATE_RE = /\s*✅\s*(\d{4}-\d{2}-\d{2})\s*$/;
const DATE_IN_TEXT = /(\d{1,2})[/.](\d{1,2})(?![.\d])/;

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

/** 从 H1 抠出日期范围 */
function planRange(h1) {
  const m = h1.match(/(\d{4})-(\d{2})\s*第\s*(\d+)\s*周/);
  const r = h1.match(/[（(]\s*(\d{1,2})\/(\d{1,2})\s*[–—~-]\s*(\d{1,2})\/(\d{1,2})\s*[）)]/);
  if (!m || !r) return null;
  const y = Number(m[1]);
  const start = `${y}-${pad2(Number(r[1]))}-${pad2(Number(r[2]))}`;
  const end = `${y}-${pad2(Number(r[3]))}-${pad2(Number(r[4]))}`;
  return { start, end, week: Number(m[3]) };
}

/**
 * 给没日期的任务挑日子：
 *   ① 文本里写了「周日/周日晚」→ 当周周日
 *   ② 否则填给当前任务最少的那天（并列取靠前的），
 *      这样每个科目会自然地一天铺一条，近似你「每日安排建议」的节奏
 */
function pickDay(taskText, days, load) {
  if (/周[日天]/.test(taskText)) {
    const sunday = days.find((d) => new Date(`${d}T00:00:00`).getDay() === 0);
    if (sunday) return sunday;
  }
  return [...days].sort((a, b) => (load[a] || 0) - (load[b] || 0) || (a < b ? -1 : 1))[0];
}

function processFile(abs) {
  const text = fs.readFileSync(abs, 'utf8');
  const lines = text.split('\n');
  const h1 = (lines.find((l) => /^#\s/.test(l)) || '').trim();
  const range = planRange(h1);
  if (!range) return { skipped: '读不出日期范围' };

  const days = [];
  for (let d = range.start; d <= range.end; d = addDays(d, 1)) days.push(d);

  // 只处理 本周任务 / 遗忘曲线复习 两个区块
  const zones = [];
  lines.forEach((l, i) => {
    if (/^##\s+.*(本周任务|遗忘曲线复习)/.test(l)) zones.push(i);
  });
  if (!zones.length) return { skipped: '没有任务区块' };
  const start = zones[0];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i]) && !/^##\s+.*(遗忘曲线复习)/.test(lines[i])) {
      end = i;
      break;
    }
  }

  // 收集区块里所有任务行（保留 group 结构）
  const taskIdx = [];
  for (let i = start; i < end; i += 1) {
    if (TASK_RE.test(lines[i])) taskIdx.push(i);
  }
  if (!taskIdx.length) return { skipped: '区块里没有任务' };

  // 计算落点
  const load = {};
  const assign = new Map();
  let dailyCount = 0;
  let rolled = 0;
  let rolledList = [];

  for (const idx of taskIdx) {
    const m = lines[idx].match(TASK_RE);
    const raw = m[3];
    const doneM = raw.match(DONE_DATE_RE);
    const body = doneM ? raw.replace(DONE_DATE_RE, '').trim() : raw.trim();
    const done = m[2].toLowerCase() === 'x';

    // ① 每日任务：加 🔁，不给日期
    if (/^每日/.test(body) || /^🔁/.test(body)) {
      dailyCount += 1;
      assign.set(idx, { type: 'daily', body: body.startsWith('🔁') ? body : `🔁 ${body}` });
      continue;
    }

    // ② 文本里自带日期
    // 文本里写了「9.14」这类日期：dm[1] 是月、dm[2] 是日
    const dm = DATE_IN_TEXT.exec(body);
    const explicit =
      dm && Number(dm[1]) === Number(range.start.slice(5, 7))
        ? `${range.start.slice(0, 7)}-${pad2(Number(dm[2]))}`
        : null;
    let date = explicit && days.includes(explicit) ? explicit : null;

    // ③ 没日期就按当天重点挑；本周还没过完时，不把未完成任务安排到过去的日期
    if (!date) {
      date = pickDay(body, days, load);
      if (date < todayStr && range.end >= todayStr) date = todayStr;
    }
    load[date] = (load[date] || 0) + 1;

    // ④ 逾期未完成 → 顺延到今天（限制在本周内）
    let target = date;
    if (!done && date < todayStr) {
      target = todayStr > range.end ? range.end : todayStr < range.start ? range.start : todayStr;
      if (target !== date) {
        rolled += 1;
        rolledList.push(`${date.slice(5)} → ${target.slice(5)}　${body.slice(0, 26)}`);
      }
    }
    assign.set(idx, { type: 'dated', date: target, body, done, doneDate: doneM ? doneM[1] : null });
  }

  // 生成新行（去掉原文本里的日期前缀，统一重写）
  const makeLine = (a) => {
    if (a.type === 'daily') return `- [ ] ${a.body}`;
    const d = new Date(`${a.date}T00:00:00`);
    // 只剥掉「行首的日期前缀」，正文中间的日期（比如 **9.14 开营直播**）要留着
    const stripped = a.body
      .replace(/^\d{1,2}[/.]\d{1,2}\s*[（(][^）)]*[）)]\s*/, '')
      .replace(/^\d{1,2}\/\d{1,2}\s+/, '')
      .trim();
    const prefix = `${Number(a.date.slice(5, 7))}/${Number(a.date.slice(8, 10))}（${WEEKDAY[d.getDay()]}）`;
    const tip = a.done && a.doneDate ? ` ✅ ${a.doneDate}` : '';
    return `- [${a.done ? 'x' : ' '}] ${prefix}${stripped}${tip}`;
  };

  const newLines = [...lines];
  // 按 group 分段重建：同一 group 内按日期排序，每日任务排最后
  let i = start;
  const rebuilt = new Map(); // 行号 → 新内容
  while (i < end) {
    const idxs = [];
    let j = i;
    while (j < end && !TASK_RE.test(lines[j])) j += 1;
    if (j >= end) break;
    while (j < end && TASK_RE.test(lines[j])) {
      idxs.push(j);
      j += 1;
    }
    const items = idxs.map((k) => ({ k, a: assign.get(k) }));
    items.sort((x, y) => {
      const ax = x.a, ay = y.a;
      if (ax.type === 'daily' && ay.type !== 'daily') return 1;
      if (ay.type === 'daily' && ax.type !== 'daily') return -1;
      if (ax.type === 'daily') return x.k - y.k;
      return ax.date < ay.date ? -1 : ax.date > ay.date ? 1 : x.k - y.k;
    });
    items.forEach((it, n) => rebuilt.set(idxs[n], makeLine(it.a)));
    i = j;
  }
  for (const [k, v] of rebuilt) newLines[k] = v;
  const next = newLines.join('\n');

  return {
    rel: path.relative(cfg.vaultDir, abs),
    range,
    tasks: taskIdx.length,
    daily: dailyCount,
    rolled,
    rolledList,
    changed: next !== text,
    next,
  };
}

/* ---------------- 主流程 ---------------- */
const dirs = ['考研/2026-09', '考研/2026-10'].map((d) => path.join(cfg.vaultDir, d));
const files = [];
for (const dir of dirs) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).sort()) {
    if (/周计划\.md$/.test(f)) files.push(path.join(dir, f));
  }
}

console.log(`今天：${todayStr}　${APPLY ? '【写入模式】' : '【预演，不写文件】'}\n`);
let changedCount = 0;
for (const abs of files) {
  const r = processFile(abs);
  if (r.skipped) {
    console.log(`⚠ ${path.basename(abs)}：${r.skipped}`);
    continue;
  }
  console.log(`${r.rel}`);
  console.log(`   ${r.range.start} ~ ${r.range.end}　任务 ${r.tasks} 条　每日任务 ${r.daily} 条　顺延 ${r.rolled} 条`);
  for (const x of r.rolledList) console.log(`     顺延：${x}`);
  if (PREVIEW && r.rel.includes(PREVIEW)) {
    console.log('   ── 改后预览 ──');
    const show = r.next.split('\n').filter((l) => /^- \[[ x]\]/.test(l)).slice(0, 30);
    for (const l of show) console.log(`   ${l}`);
    console.log('   ── ──');
  }
  if (!r.changed) {
    console.log('   （无需改动）');
    continue;
  }
  changedCount += 1;
  if (APPLY) {
    const stamp = new Date().toISOString().slice(0, 10);
    const bak = path.join(cfg.backupDir, stamp, r.rel);
    if (!fs.existsSync(bak)) {
      fs.mkdirSync(path.dirname(bak), { recursive: true });
      fs.copyFileSync(abs, bak);
    }
    fs.writeFileSync(abs, r.next.replace(/\n*$/, '\n'), 'utf8');
    console.log(`   ✅ 已写入（备份：${path.relative(cfg.vaultDir, bak)}）`);
  }
}
console.log(`\n共 ${files.length} 份周计划，需要改动 ${changedCount} 份。`);
if (!APPLY && changedCount) console.log('加 --apply 才会真正写入。');
