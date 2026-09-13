/**
 * reviews.mjs —— 每日复盘
 *
 * 归档规则和你现有的完全一致：
 *   复盘/26.9/第二周/9.13复盘.md
 * 目录按日期自动算：26.9 = 2026 年 9 月，第二周来自对应的周计划（找不到就按每月 7 天一段推算）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { readText, writeText, backupFile } from './vault.mjs';
import { cnWeek, weekPlanFor } from './plans.mjs';

const pad2 = (n) => String(n).padStart(2, '0');

/** 2026-09-13 → 26.9 */
export function monthFolder(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  return `${String(y).slice(2)}.${m}`;
}

/** 2026-09-13 → 9.13 */
export function dayLabel(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${m}.${d}`;
}

/** 落在第几周（优先用周计划里的真实周次） */
export function weekOf(dateStr, plans = []) {
  const plan = weekPlanFor(plans, dateStr);
  if (plan && plan.week) return plan.week;
  const d = Number(dateStr.split('-')[2]);
  return Math.min(5, Math.ceil(d / 7));
}

/** 复盘文件的相对路径 */
export function reviewRelPath(dateStr, plans = []) {
  return `复盘/${monthFolder(dateStr)}/${cnWeek(weekOf(dateStr, plans))}/${dayLabel(dateStr)}复盘.md`;
}

function template(dateStr, plan) {
  const week = plan ? `本周：${plan.title || plan.h1 || ''}` : '';
  return `# ${dayLabel(dateStr)} 复盘

${week ? `> ${week}\n\n` : ''}## 今天做了什么


## 卡住的地方


## 明天要调整
`;
}

/** 读某天的复盘；不存在就返回空模板 */
export function readReview(vaultDir, dateStr, plans = []) {
  const rel = reviewRelPath(dateStr, plans);
  const abs = path.join(vaultDir, rel);
  const exists = fs.existsSync(abs);
  return {
    date: dateStr,
    rel,
    exists,
    week: weekOf(dateStr, plans),
    content: exists ? readText(abs) : template(dateStr, weekPlanFor(plans, dateStr)),
    mtime: exists ? fs.statSync(abs).mtimeMs : null,
  };
}

/** 写某天的复盘（整篇替换；有备份） */
export function writeReview(vaultDir, backupDir, dateStr, content, plans = []) {
  const rel = reviewRelPath(dateStr, plans);
  const abs = path.join(vaultDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (fs.existsSync(abs)) backupFile(abs, vaultDir, backupDir, 'review');
  writeText(abs, content);
  return { rel, date: dateStr, bytes: Buffer.byteLength(content) };
}

/** 列出已有的复盘 */
export function listReviews(reviewDir, vaultDir) {
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
        const m = e.name.match(/^(\d{1,2})\.(\d{1,2})复盘\.md$/);
        const st = fs.statSync(abs);
        let date = null;
        if (m) {
          const rel = path.relative(reviewDir, abs).split(path.sep);
          const ym = (rel[0] || '').match(/^(\d{2})\.(\d{1,2})$/);
          if (ym) date = `20${ym[1]}-${pad2(Number(ym[2]))}-${pad2(Number(m[1]))}`;
        }
        out.push({
          rel: path.relative(vaultDir, abs).split(path.sep).join('/'),
          name: e.name,
          date,
          size: st.size,
          mtime: st.mtimeMs,
        });
      }
    }
  };
  walk(reviewDir, 0);
  out.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return out;
}
