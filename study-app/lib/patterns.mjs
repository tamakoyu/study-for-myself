/**
 * patterns.mjs —— 题型大全（通解）
 *
 * 一篇笔记 = 一个题型的一份通解，放在 题型本/<大类>/<科目>/<章节>/ 下。
 *
 * 掌握度不手写 —— 由它关联的错题/好题算出来：
 * 每道关联题目有自己的「遗忘曲线掌握等级」，取平均就是这份通解的掌握度。
 * 关联断了或没关联，就显示「未关联」。
 */

import fs from 'node:fs';
import path from 'node:path';
import { readText, walkMarkdown, writeText, backupFile } from './vault.mjs';

export const PATTERN_TAGS = ['题型本', '通解'];

const FRONT_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function parseFront(text) {
  const m = text.match(FRONT_RE);
  const data = {};
  if (!m) return { data, body: text };
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
      data[key] = kv[2].trim() === '' ? [] : kv[2].trim();
    }
  }
  return { data, body: text.slice(m[0].length) };
}

const countChar = (s, ch) => (String(s || '').match(new RegExp(ch, 'gu')) || []).length;

/** 扫描题型本 */
export function scanPatterns(patternDir, vaultDir, problems = []) {
  if (!fs.existsSync(patternDir)) return { patterns: [], tree: [] };
  const byId = new Map(problems.map((p) => [p.id, p]));

  const files = walkMarkdown(patternDir, { deny: new Set(['.obsidian', '.git']) });
  const patterns = files.map((f) => {
    const text = readText(f.abs);
    const { data, body } = parseFront(text);
    const segs = f.rel.split('/').slice(0, -1);
    const category = segs[0] || '未分类';
    const subject = segs[1] || '未分类';
    const chapter = segs[2] || subject;

    const h1 = (body.match(/^#\s+(.+)$/m) || [])[1] || path.basename(f.abs, '.md');
    const related = Array.isArray(data.related) ? data.related : data.related ? [data.related] : [];

    const linked = related.map((id) => byId.get(id)).filter(Boolean);
    const missing = related.filter((id) => !byId.has(id));

    // 掌握度 = 关联题目掌握等级的平均
    const levels = linked.filter((p) => p.stats.schedule).map((p) => {
      const s = p.stats.schedule;
      return s.levelMax ? s.level / s.levelMax : 0;
    });
    const mastery = levels.length ? Math.round((levels.reduce((a, b) => a + b, 0) / levels.length) * 100) : null;
    const doneCount = linked.filter((p) => p.stats.status === '完成').length;
    const failCount = linked.reduce((s, p) => s + p.stats.fail, 0);

    // 通解正文里的几个小节（按 `## ` 切，别用带 m 标志的 $ —— 那会在行尾就截断）
    const bodyLines = body.split('\n');
    const section = (name) => {
      const start = bodyLines.findIndex((l) => new RegExp(`^##\\s+${name}`).test(l));
      if (start === -1) return '';
      let end = bodyLines.length;
      for (let i = start + 1; i < bodyLines.length; i += 1) {
        if (/^##\s/.test(bodyLines[i])) {
          end = i;
          break;
        }
      }
      return bodyLines.slice(start + 1, end).join('\n').trim();
    };

    return {
      id: `${category}/${subject}/${chapter}/${path.basename(f.abs, '.md')}`,
      rel: f.rel,
      abs: f.abs,
      title: h1,
      category,
      subject,
      chapter,
      type: data.category || data.type || '',
      difficulty: countChar(data.difficulty, '⭐'),
      heat: countChar(data.heat, '🔥'),
      related,
      linkedCount: linked.length,
      missing,
      mastery,
      linkedRate: linked.length ? Math.round((doneCount / linked.length) * 100) : 0,
      failCount,
      steps: section('通解步骤'),
      features: section('适用特征'),
      example: section('例题'),
      pitfalls: section('易错点'),
      body,
      mtime: f.mtime,
    };
  });

  patterns.sort((a, b) => (b.failCount || 0) - (a.failCount || 0) || a.rel.localeCompare(b.rel, 'zh'));

  // 按 大类 / 科目 / 章节 汇总
  const tree = [];
  const ensure = (list, name) => {
    let n = list.find((x) => x.name === name);
    if (!n) {
      n = { name, total: 0, children: [] };
      list.push(n);
    }
    return n;
  };
  for (const pt of patterns) {
    const c = ensure(tree, pt.category);
    c.total += 1;
    const s = ensure(c.children, pt.subject);
    s.total += 1;
    const ch = ensure(s.children, pt.chapter);
    ch.total += 1;
  }
  return { patterns, tree };
}

/** 没有归入任何通解的题目 */
export function unlinkedProblems(problems, patterns) {
  const linked = new Set(patterns.flatMap((p) => p.related));
  return problems.filter((p) => !linked.has(p.id));
}
