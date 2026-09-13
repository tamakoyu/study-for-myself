/**
 * parse.mjs —— 把 Markdown 错题笔记解析成内存对象
 *
 * 设计原则：只读、宽容。解析失败不抛异常，而是给该篇打上 warnings，
 * 交给上层决定「只读不写」。绝不因为解析失误而破坏用户文件。
 */

import fs from 'node:fs';
import path from 'node:path';

export const RESULTS = ['完美', '普通', '失败'];

/** 题目文件之外的、需要跳过的文件 */
const SKIP_FILES = new Set(['00-错题本总览.md', '_错题模板.md']);
const SKIP_PREFIX = ['00-'];

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const CHECKIN_RE =
  /^-\s*\[([ xX])\]\s*第\s*(\d+)\s*次\s*·\s*(完美|普通|失败)\s*(?:·\s*(\d{4}-\d{2}-\d{2}))?\s*$/;

/** 数一个字符串里某个字符（含 emoji 码点）出现了几次 */
function countChar(str, ch) {
  if (!str) return 0;
  const m = String(str).match(new RegExp(ch, 'gu'));
  return m ? m.length : 0;
}

/** 五格还原：3 → ⭐⭐⭐☆☆ */
function renderGauge(filled, on = '⭐', off = '☆') {
  const n = Math.max(0, Math.min(5, filled | 0));
  return on.repeat(n) + off.repeat(5 - n);
}

export { renderGauge, countChar };

/** 解析 YAML frontmatter（只支持本项目用到的简单标量 + 列表） */
function parseFrontmatter(text) {
  const m = text.match(FM_RE);
  if (!m) return { data: {}, raw: '', length: 0 };
  const data = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const item = line.match(/^\s+-\s+(.+?)\s*$/);
    if (item && key) {
      if (!Array.isArray(data[key])) data[key] = data[key] ? [data[key]] : [];
      data[key].push(item[1]);
      continue;
    }
    const kv = line.match(/^([^\s:][^:]*?)\s*:\s*(.*)$/);
    if (kv) {
      key = kv[1].trim();
      const v = kv[2].trim();
      data[key] = v === '' ? [] : v;
    }
  }
  return { data, raw: m[0], length: m[0].length };
}

/** 按 `## ` 二级标题切段 */
function splitSections(body) {
  const map = new Map();
  let title = null;
  let buf = [];
  const flush = () => {
    if (title !== null || buf.length) {
      map.set(title ?? '', buf.join('\n'));
    }
  };
  for (const line of body.split(/\r?\n/)) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      flush();
      title = h[1];
      buf = [];
    } else {
      buf.push(line);
    }
  }
  flush();
  return map;
}

/** 抽出一个段落里所有的 callout：> [!type]- 标题 … */
export function extractCallouts(text) {
  const out = [];
  const lines = (text || '').split(/\r?\n/);
  let cur = null;
  for (const line of lines) {
    const head = line.match(/^>\s*\[!(\w+)\]([+-]?)\s*(.*)$/);
    if (head) {
      if (cur) out.push(cur);
      cur = { kind: head[1], fold: head[2], title: head[3].trim(), lines: [] };
      continue;
    }
    if (cur) {
      if (/^>/.test(line)) {
        cur.lines.push(line.replace(/^>\s?/, ''));
      } else if (line.trim() === '') {
        // callout 结束于空行（源码里 callout 内部的空行应写作单独的 `>`）
        out.push(cur);
        cur = null;
      } else {
        out.push(cur);
        cur = null;
      }
    }
  }
  if (cur) out.push(cur);
  return out.map((c) => ({ ...c, body: c.lines.join('\n').replace(/\s+$/, '') }));
}

/** 解析「本题档案」三行：**考的类型**　… */
function parseProfile(text) {
  const out = { type: '', difficulty: '', heat: '', raw: {} };
  for (const line of (text || '').split(/\r?\n/)) {
    const m = line.match(/^\*\*(考的类型|难度|考研热度)\*\*\s*[　\s]*(.*)$/);
    if (!m) continue;
    const key = { 考的类型: 'type', 难度: 'difficulty', 考研热度: 'heat' }[m[1]];
    out[key] = m[2].trim();
    out.raw[key] = line;
  }
  return out;
}

/** 解析打卡区 */
function parseCheckins(text) {
  const items = [];
  const lines = (text || '').split(/\r?\n/);
  lines.forEach((line, i) => {
    const m = line.match(CHECKIN_RE);
    if (!m) return;
    items.push({
      done: m[1].toLowerCase() === 'x',
      attempt: Number(m[2]),
      result: m[3],
      date: m[4] || null,
      line: i,
      raw: line,
    });
  });
  return items;
}

/** 打卡记录 → 统计 */
export function summarize(checkins) {
  const done = (checkins || []).filter((c) => c.done);
  const count = (r) => done.filter((c) => c.result === r).length;
  const perfect = count('完美');
  const normal = count('普通');
  const fail = count('失败');
  const sorted = [...done].sort((a, b) => {
    if (a.date && b.date && a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.attempt !== b.attempt) return a.attempt - b.attempt;
    return RESULTS.indexOf(a.result) - RESULTS.indexOf(b.result);
  });
  const last = sorted.length ? sorted[sorted.length - 1] : null;
  return {
    perfect,
    normal,
    fail,
    total: done.length,
    status: perfect > 0 ? '完成' : done.length > 0 ? '进行中' : '未做',
    last: last ? { result: last.result, date: last.date, attempt: last.attempt } : null,
  };
}

/** 解析单篇笔记 */
export function parseNote(absPath, rootDir) {
  const text = fs.readFileSync(absPath, 'utf8');
  const warnings = [];
  const fm = parseFrontmatter(text);
  const body = text.slice(fm.length);

  const relPath = path.relative(rootDir, absPath).split(path.sep).join('/');
  const fileName = path.basename(absPath);
  const chapter = path.dirname(relPath) === '.' ? '未分类' : path.dirname(relPath).split('/')[0];
  const id = fileName.replace(/\.md$/, '');

  const titleMatch = body.match(/^#\s+(.+?)\s*$/m);
  const title = titleMatch ? titleMatch[1].trim() : id;
  // 标题形如「极限-01　$式子$」——取编号与式子
  const numMatch = title.match(/^(\S+?)[\s　]+(.*)$/);
  const num = numMatch ? numMatch[1] : id;
  const exprPart = numMatch ? numMatch[2] : title;
  const exprMatch = exprPart.match(/\$([\s\S]+)\$/);

  const sections = splitSections(body);
  const get = (...names) => {
    for (const n of names) if (sections.has(n)) return sections.get(n);
    return '';
  };

  const profileText = get('本题档案');
  const profile = parseProfile(profileText);
  const profileCallouts = extractCallouts(profileText);

  const answerCallouts = extractCallouts(get('答案'));
  const solutionText = get('解析');
  const solutionCallouts = extractCallouts(solutionText);

  const tags = Array.isArray(fm.data.tags) ? fm.data.tags : [];
  if (!tags.includes('高数错题本')) warnings.push('frontmatter 缺少 `高数错题本` 标签');
  if (!fm.data.type) warnings.push('frontmatter 缺少 `type`');
  if (!fm.data.difficulty) warnings.push('frontmatter 缺少 `difficulty`');
  if (!fm.data.heat) warnings.push('frontmatter 缺少 `heat`');
  if (!sections.has('打卡记录')) warnings.push('缺少 `## 打卡记录` 区块，无法打卡');

  const difficultyRaw = fm.data.difficulty || profile.difficulty || '';
  const heatRaw = fm.data.heat || profile.heat || '';
  const typeRaw = fm.data.type || profile.type || '';

  const checkins = parseCheckins(get('打卡记录'));

  const note = {
    id,
    num,
    chapter,
    title,
    expr: exprMatch ? exprMatch[1].trim() : exprPart,
    relPath,
    fileName,
    absPath,
    type: typeRaw.split('·')[0].trim(),
    typeRaw,
    difficulty: countChar(difficultyRaw, '⭐'),
    heat: countChar(heatRaw, '🔥'),
    difficultyRaw,
    heatRaw,
    profile,
    keypoints: profileCallouts[0]?.body || '',
    stem: get('题干').trim(),
    answer: answerCallouts.map((c) => c.body).join('\n\n').trim(),
    answerKind: answerCallouts[0]?.kind || 'success',
    solution: solutionCallouts.filter((c) => c.kind !== 'warning').map((c) => c.body).join('\n\n').trim(),
    pitfalls: solutionCallouts.filter((c) => c.kind === 'warning').map((c) => c.body).join('\n\n').trim(),
    checkins,
    warnings,
  };
  note.stats = summarize(checkins);
  note.searchText = [note.num, note.title, note.type, note.keypoints, note.stem]
    .join(' ')
    .replace(/\s+/g, ' ');
  return note;
}

/** 扫描整个错题本目录，返回所有题目 */
export function scanNotebook(rootDir) {
  const notes = [];
  const problems = [];
  if (!fs.existsSync(rootDir)) return { notes, problems, chapters: [] };

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      if (SKIP_FILES.has(entry.name)) continue;
      if (SKIP_PREFIX.some((p) => entry.name.startsWith(p))) continue;
      try {
        const note = parseNote(abs, rootDir);
        problems.push(note);
      } catch (err) {
        notes.push({ file: abs, error: String(err && err.message) });
      }
    }
  };
  walk(rootDir);

  const chapters = [...new Set(problems.map((p) => p.chapter))].sort((a, b) => {
    const order = ['极限', '连续', '函数', '导数', '微分', '积分'];
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b, 'zh');
  });

  problems.sort((a, b) => a.relPath.localeCompare(b.relPath, 'zh'));
  return { problems, errors: notes, chapters };
}
