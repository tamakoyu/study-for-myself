/**
 * parse.mjs —— 把 Markdown 错题笔记解析成内存对象
 *
 * 设计原则：只读、宽容。解析失败不抛异常，而是给该篇打上 warnings，
 * 交给上层决定「只读不写」。绝不因为解析失误而破坏用户文件。
 */

import fs from 'node:fs';
import path from 'node:path';
import { UNCLASSIFIED, CATEGORIES as CATEGORY_ORDER, SUBJECTS as SUBJECT_ORDER, TAXONOMY } from './taxonomy.mjs';

const CHAPTER_ORDER = Object.fromEntries(
  Object.entries(TAXONOMY).flatMap(([, subs]) => Object.entries(subs))
);

export const RESULTS = ['完美', '普通', '失败'];

/** 题目文件之外的、需要跳过的文件 */
const SKIP_FILES = new Set(['00-错题本总览.md', '_错题模板.md']);
const SKIP_PREFIX = ['00-'];

/** 识别用的笔记标签；后者是旧版命名，向后兼容 */
const NOTE_TAGS = ['错题本', '高数错题本'];

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
  // 三级结构：<大类>/<科目>/<章节>/题目.md（章节可省略，省略时以科目名占位）
  const segs = relPath.split('/').slice(0, -1);
  const category = segs[0] || UNCLASSIFIED;
  const subject = segs[1] || UNCLASSIFIED;
  const chapter = segs[2] || UNCLASSIFIED;
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
  if (!NOTE_TAGS.some((t) => tags.includes(t))) warnings.push('frontmatter 缺少 `错题本` 标签');
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
    category,
    subject,
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
  note.searchText = [note.num, note.category, note.subject, note.chapter, note.title, note.type, note.keypoints, note.stem]
    .join(' ')
    .replace(/\s+/g, ' ');
  return note;
}

/**
 * 按「大类 → 科目 → 章节」汇总题目，用于导航与总览。
 * 顺序优先跟随 TAXONOMY 里的编排，出现体系外的名字时排在最后。
 */
export function buildTree(problems) {
  const tree = [];
  const ensure = (list, key, name) => {
    let node = list.find((x) => x.name === name);
    if (!node) {
      node = { name, key, total: 0, done: 0, children: [] };
      list.push(node);
    }
    return node;
  };
  const tag = (node, p) => {
    node.total += 1;
    if (p.stats.status === '完成') node.done += 1;
  };

  // 先把「大类 / 科目」骨架铺好：哪怕 0 题，数学与 408 两个大页也始终存在。
  // 章节不预建，有题才出现，免得导航里全是空章节。
  for (const [catName, subjects] of Object.entries(TAXONOMY)) {
    const catNode = ensure(tree, 'category', catName);
    for (const subName of Object.keys(subjects)) ensure(catNode.children, 'subject', subName);
  }

  for (const p of problems) {
    const cat = ensure(tree, 'category', p.category);
    tag(cat, p);
    const sub = ensure(cat.children, 'subject', p.subject);
    tag(sub, p);
    const ch = ensure(sub.children, 'chapter', p.chapter);
    tag(ch, p);
  }

  // 按体系顺序排序：体系内的按 TAXONOMY 顺序，体系外的按题数降序排后面
  const orderOf = (list, getIndex, name) => {
    const i = getIndex(name);
    return i === -1 ? 999 + list.findIndex((x) => x.name === name) : i;
  };
  tree.sort(
    (a, b) =>
      orderOf(tree, (n) => CATEGORY_ORDER.indexOf(n), a.name) -
      orderOf(tree, (n) => CATEGORY_ORDER.indexOf(n), b.name)
  );
  for (const cat of tree) {
    cat.children.sort(
      (a, b) =>
        orderOf(cat.children, (n) => (SUBJECT_ORDER[cat.name] || []).indexOf(n), a.name) -
        orderOf(cat.children, (n) => (SUBJECT_ORDER[cat.name] || []).indexOf(n), b.name)
    );
    for (const sub of cat.children) {
      sub.children.sort(
        (a, b) =>
          orderOf(sub.children, (n) => (CHAPTER_ORDER[sub.name] || []).indexOf(n), a.name) -
          orderOf(sub.children, (n) => (CHAPTER_ORDER[sub.name] || []).indexOf(n), b.name)
      );
    }
  }
  return tree;
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

  problems.sort((a, b) => a.relPath.localeCompare(b.relPath, 'zh'));
  return { problems, errors: notes, tree: buildTree(problems) };
}
