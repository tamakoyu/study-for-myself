#!/usr/bin/env node
/**
 * scripts/daily-checkins.mjs —— 把「每日任务」的旧勾选迁成按天打卡子行
 *
 * 以前 🔁 那一行自己带勾：
 *   - [x] 🔁 每日单词 130 个 ✅ 2026-09-14
 * 这行的勾会被整周共用，第二天还显示昨天勾了。现在改成：模板行永远是 - [ ]，
 * 打过卡的日期记在它下面的子行里：
 *   - [ ] 🔁 每日单词 130 个
 *     - [x] 2026-09-14
 *
 * 本脚本把已有的旧勾搬成子行。**幂等**，重复跑不会变样；只动 🔁 那一行和紧贴它的
 * 打卡子行，其余内容一个字符都不碰。
 *
 * 用法：
 *   node scripts/daily-checkins.mjs            # 只看结果，不写文件
 *   node scripts/daily-checkins.mjs --apply    # 真正写入（写入前自动备份）
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../lib/notebook.mjs';
import { backupFile, readText, writeText } from '../lib/vault.mjs';

const APPLY = process.argv.includes('--apply');
const cfg = loadConfig();

const TASK_RE = /^(\s*)- \[([ xX])\]\s+(.*)$/;
const DONE_DATE_RE = /\s*✅\s*(\d{4}-\d{2}-\d{2})\s*$/;
const CHECKIN_RE = /^\d{4}-\d{2}-\d{2}$/;
const pad2 = (n) => String(n).padStart(2, '0');
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

/** 只重写 🔁 那一行 + 它下面的打卡子行，别的不碰 */
function migrate(text, today) {
  const lines = text.split('\n');
  const out = [];
  const changed = [];

  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(TASK_RE);
    const body = m ? m[3].replace(DONE_DATE_RE, '').trim() : null;
    if (!m || !/^🔁\s*/.test(body)) {
      out.push(lines[i]);
      continue;
    }

    const parentIndent = m[1];
    const childIndent = `${parentIndent}  `;
    const dates = new Set();

    // 吃掉紧跟在下面的打卡子行（允许中间有空行）；遇到不更深的行就停
    let last = i;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^\s*$/.test(lines[j])) continue;
      const km = lines[j].match(TASK_RE);
      if (!km || km[1].length <= parentIndent.length || !CHECKIN_RE.test(km[3].trim())) break;
      if (km[2].toLowerCase() === 'x') dates.add(km[3].trim());
      last = j;
    }

    // 旧格式：模板行自己带着勾（有 ✅ 日期就用它，没有就当今天勾的）
    if (m[2].toLowerCase() === 'x') dates.add((m[3].match(DONE_DATE_RE) || [])[1] || today);

    const before = lines.slice(i, last + 1).join('\n');
    const rebuilt = [
      `${parentIndent}- [ ] ${body}`,
      ...[...dates].sort().map((d) => `${childIndent}- [x] ${d}`),
    ].join('\n');
    if (before !== rebuilt) changed.push({ line: i + 1, before, after: rebuilt });

    out.push(rebuilt);
    i = last; // 子行已经被吃进 rebuilt 里了
  }

  return { next: out.join('\n'), changed };
}

/* ---------------- 主流程 ---------------- */
const files = [];
const walk = (dir, depth = 0) => {
  if (depth > 3 || !fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, depth + 1);
    else if (/周计划\.md$/.test(e.name)) files.push(abs);
  }
};
walk(cfg.planDir);

const today = todayStr();
let touched = 0;
const report = [];
for (const abs of files.sort()) {
  const text = readText(abs);
  const { next, changed } = migrate(text, today);
  if (!changed.length) continue;
  touched += 1;
  report.push({ abs, changed });
  if (APPLY) {
    backupFile(abs, cfg.vaultDir, cfg.backupDir, 'plan');
    writeText(abs, next);
  }
}

console.log(
  `\n扫了 ${files.length} 份周计划，需要改动 ${touched} 份${APPLY ? '（已写入，改动前都备份了）' : '（预演，没写文件）'}：\n`
);
for (const r of report) {
  console.log(`📄 ${path.relative(cfg.vaultDir, r.abs)}`);
  for (const c of r.changed) {
    console.log(`   第 ${c.line} 行`);
    console.log(`   − ${c.before.replace(/\n/g, '\n     ')}`);
    console.log(`   + ${c.after.replace(/\n/g, '\n     ')}`);
  }
}
if (!APPLY && touched) console.log('\n确认没问题就加 --apply 真正写入。\n');
