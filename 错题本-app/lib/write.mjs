/**
 * write.mjs —— 定点写回
 *
 * 铁律：只改「该改的那几行」，其余字节原样保留。
 * 绝不整篇重写，绝不重新格式化，绝不碰用户的正文、公式、空白。
 */

import fs from 'node:fs';
import path from 'node:path';
import { RESULTS, renderGauge } from './parse.mjs';

const PROFILE_LABEL = { type: '考的类型', difficulty: '难度', heat: '考研热度' };

/** 写入前先备份，出问题能一键回滚 */
export function backup(absPath, rootDir, backupRoot) {
  try {
    const rel = path.relative(rootDir, absPath);
    const stamp = new Date().toISOString().slice(0, 10);
    const dest = path.join(backupRoot, stamp, rel);
    if (fs.existsSync(dest)) return dest; // 同一天同一篇只留首次备份
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(absPath, dest);
    return dest;
  } catch {
    return null;
  }
}

/** 找出某个 `## 标题` 段的起止行号：[标题行, 下一段标题行) */
function findSection(lines, heading) {
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/** 把打卡记录渲染成规范的 Markdown 区块 */
export function renderCheckinBlock(checkins) {
  const done = (checkins || [])
    .filter((c) => c.done)
    .sort((a, b) => a.attempt - b.attempt);
  const maxAttempt = done.reduce((m, c) => Math.max(m, c.attempt), 0);

  const groups = [];
  for (let i = 1; i <= 3; i++) {
    const n = maxAttempt + i;
    groups.push(RESULTS.map((r) => `- [ ] 第 ${n} 次 · ${r}`).join('\n'));
  }
  const parts = [];
  if (done.length) {
    parts.push(done.map((c) => `- [x] 第 ${c.attempt} 次 · ${c.result}${c.date ? ` · ${c.date}` : ''}`).join('\n'));
  }
  parts.push(...groups);

  return [
    '## 打卡记录',
    '',
    '> 做完一次勾一个结果（每次只勾一个）：勾到「完美」= 复习完成；只勾了「普通 / 失败」= 仍待复习。',
    '',
    parts.join('\n\n'),
    '',
  ].join('\n');
}

/**
 * 记录一次打卡：追加一条记录。
 * 每次都先解出全部已完成记录，再整体规范化写回，因此不会出现编号错乱。
 */
export function recordCheckin(absPath, { result, date }) {
  if (!RESULTS.includes(result)) throw new Error(`未知结果：${result}`);
  const text = fs.readFileSync(absPath, 'utf8');
  const lines = text.split('\n');
  const range = findSection(lines, '打卡记录');
  if (!range) throw new Error('该笔记没有 `## 打卡记录` 区块，已跳过（避免误写）');

  const done = [];
  for (let i = range.start + 1; i < range.end; i++) {
    const m = lines[i].match(/^-\s*\[[xX]\]\s*第\s*(\d+)\s*次\s*·\s*(完美|普通|失败)\s*(?:·\s*(\d{4}-\d{2}-\d{2}))?\s*$/);
    if (m) done.push({ done: true, attempt: Number(m[1]), result: m[2], date: m[3] || null });
  }
  const nextAttempt = done.reduce((m, c) => Math.max(m, c.attempt), 0) + 1;
  done.push({ done: true, attempt: nextAttempt, result, date: date || today() });

  const block = renderCheckinBlock(done).split('\n');
  const next = [...lines.slice(0, range.start), ...block, ...lines.slice(range.end)];
  fs.writeFileSync(absPath, normalizeEof(next), 'utf8');
  return { attempt: nextAttempt, result };
}

/** 撤销一条打卡记录（点错了改回来） */
export function undoCheckin(absPath, { attempt, result }) {
  const text = fs.readFileSync(absPath, 'utf8');
  const lines = text.split('\n');
  const range = findSection(lines, '打卡记录');
  if (!range) throw new Error('该笔记没有 `## 打卡记录` 区块');

  const done = [];
  let removed = false;
  for (let i = range.start + 1; i < range.end; i++) {
    const m = lines[i].match(/^-\s*\[[xX]\]\s*第\s*(\d+)\s*次\s*·\s*(完美|普通|失败)\s*(?:·\s*(\d{4}-\d{2}-\d{2}))?\s*$/);
    if (!m) continue;
    const item = { done: true, attempt: Number(m[1]), result: m[2], date: m[3] || null };
    if (!removed && item.attempt === Number(attempt) && item.result === result) {
      removed = true;
      continue;
    }
    done.push(item);
  }
  if (!removed) throw new Error('没找到这条打卡记录');

  // 重排编号，保持 1..n 连续
  done.sort((a, b) => a.attempt - b.attempt).forEach((c, i) => (c.attempt = i + 1));

  const block = renderCheckinBlock(done).split('\n');
  const next = [...lines.slice(0, range.start), ...block, ...lines.slice(range.end)];
  fs.writeFileSync(absPath, normalizeEof(next), 'utf8');
  return { removed: true };
}

const DIFF_WORD = { 1: '送分', 2: '基础', 3: '中档', 4: '较难', 5: '压轴' };
const HEAT_WORD = { 1: '极少单独考', 2: '低频', 3: '中频', 4: '高频', 5: '超高频' };

/** 修改元信息：难度 / 考研热度 / 题型。同时同步 frontmatter 与「本题档案」两处 */
export function setMeta(absPath, patch) {
  let text = fs.readFileSync(absPath, 'utf8');
  const changed = [];

  const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmMatch) {
    let fm = fmMatch[1];
    const setField = (key, value) => {
      const re = new RegExp(`^(${key}\\s*:\\s*).*$`, 'm');
      if (re.test(fm)) fm = fm.replace(re, `$1${value}`);
      else fm = `${fm}\n${key}: ${value}`;
      changed.push(key);
    };
    if (patch.difficulty != null) setField('difficulty', renderGauge(patch.difficulty));
    if (patch.heat != null) setField('heat', renderGauge(patch.heat, '🔥'));
    if (patch.type) setField('type', patch.type);
    text = text.slice(0, fmMatch.index) + `---\n${fm}\n---` + text.slice(fmMatch.index + fmMatch[0].length);
  }

  const lines = text.split('\n');

  if (patch.difficulty != null) {
    const stars = renderGauge(patch.difficulty);
    const idx = lines.findIndex((l) => /^\*\*难度\*\*/.test(l));
    if (idx !== -1) {
      // 换掉星串，同时把「· 基础/中档/…」的档位词同步过去，避免出现「4 星却写着基础」的矛盾
      lines[idx] = lines[idx].replace(/[⭐☆]{3,}/, stars);
      lines[idx] = lines[idx].replace(/(\*\*难度\*\*\s*[　\s]*[⭐☆]{3,})(?:\s*·\s*.*)?$/, `$1 · ${DIFF_WORD[patch.difficulty] || ''}`);
    }
  }
  if (patch.heat != null) {
    const fires = renderGauge(patch.heat, '🔥');
    const idx = lines.findIndex((l) => /^\*\*考研热度\*\*/.test(l));
    if (idx !== -1) {
      lines[idx] = lines[idx].replace(/[🔥☆]{3,}/u, fires);
      lines[idx] = lines[idx].replace(/(\*\*考研热度\*\*\s*[　\s]*[🔥☆]{3,})(?:\s*·\s*.*)?$/u, `$1 · ${HEAT_WORD[patch.heat] || ''}`);
    }
  }
  if (patch.type) {
    const idx = lines.findIndex((l) => /^\*\*考的类型\*\*/.test(l));
    if (idx !== -1) lines[idx] = `**考的类型**　${patch.type}`;
  }

  fs.writeFileSync(absPath, normalizeEof(lines), 'utf8');
  return { changed };
}

/** 保证文件以恰好一个换行结尾 */
function normalizeEof(lines) {
  const out = Array.isArray(lines) ? lines.join('\n') : lines;
  return out.replace(/\n*$/, '\n');
}

export function today(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
