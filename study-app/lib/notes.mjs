/**
 * notes.mjs —— 学习笔记的浏览
 *
 * 只收「学习笔记」类目录，计划 / 复盘 / 错题各有自己的页面，不混在一起。
 */

import fs from 'node:fs';
import path from 'node:path';
import { readText } from './vault.mjs';

function walk(dir, vaultDir, depth = 0) {
  if (depth > 6) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  const dirs = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      const children = walk(abs, vaultDir, depth + 1);
      if (children.length) dirs.push({ name: e.name, type: 'dir', children });
    } else if (e.name.endsWith('.md')) {
      const st = fs.statSync(abs);
      files.push({
        name: e.name.replace(/\.md$/, ''),
        file: e.name,
        type: 'file',
        rel: path.relative(vaultDir, abs).split(path.sep).join('/'),
        size: st.size,
        mtime: st.mtimeMs,
      });
    }
  }
  return [...files.sort((a, b) => a.name.localeCompare(b.name, 'zh')), ...dirs];
}

/** 返回 { tree: [...], count, roots: [...] } */
export function scanNotes(vaultDir, noteDirs = []) {
  const roots = [];
  let count = 0;
  for (const rel of noteDirs) {
    const abs = path.join(vaultDir, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) continue;
    const children = walk(abs, vaultDir);
    const flat = (list) =>
      list.flatMap((x) => (x.type === 'file' ? [x] : flat(x.children || [])));
    count += flat(children).length;
    roots.push({ name: rel, type: 'dir', rel, children });
  }
  return { tree: roots, count, roots: noteDirs };
}

export function readNote(vaultDir, relPath) {
  const abs = path.join(vaultDir, relPath);
  if (!fs.existsSync(abs)) throw Object.assign(new Error('找不到这篇笔记'), { status: 404 });
  const st = fs.statSync(abs);
  return {
    rel: relPath,
    content: readText(abs),
    size: st.size,
    mtime: st.mtimeMs,
  };
}
