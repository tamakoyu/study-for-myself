/**
 * vault.mjs —— 对 Obsidian 仓库的通用读写
 *
 * 所有涉及路径的接口都必须经过这里，确保只能碰白名单目录里的 .md，
 * 绝不越界、绝不写非 markdown 文件。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 把相对路径解析成绝对路径，并确认它落在 allowRoots 里 */
export function resolveInside(allowRoots, relPath) {
  const clean = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.includes('..')) {
    throw Object.assign(new Error('非法路径'), { status: 400 });
  }
  const abs = path.resolve(allowRoots[0].root ? allowRoots[0].root : allowRoots[0], clean);
  const ok = allowRoots.some((r) => {
    const root = typeof r === 'string' ? r : r.root;
    return abs === root || abs.startsWith(root + path.sep);
  });
  if (!ok) throw Object.assign(new Error('路径不在允许范围内'), { status: 403 });
  if (!abs.endsWith('.md')) throw Object.assign(new Error('只能操作 .md 文件'), { status: 400 });
  return abs;
}

export function readText(abs) {
  return fs.readFileSync(abs, 'utf8');
}

/** 保持「以恰好一个换行结尾」的写法，其余原样 */
export function writeText(abs, text) {
  fs.writeFileSync(abs, String(text).replace(/\n*$/, '\n'), 'utf8');
}

/** 写入前先备份到 app 的 backups 目录 */
export function backupFile(abs, vaultDir, backupRoot, tag = '') {
  try {
    const rel = path.relative(vaultDir, abs);
    const stamp = new Date().toISOString().slice(0, 10);
    const dest = path.join(backupRoot, stamp, tag ? `${tag}-${rel}` : rel);
    if (fs.existsSync(dest)) return dest;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(abs, dest);
    return dest;
  } catch {
    return null;
  }
}

/** 停用目录（不该被扫到的） */
const DENY_DIRS = new Set([
  '.obsidian', '.git', '.trash', 'node_modules', '_py_deps', 'picture',
  'study-app', '错题本-app', '错题本', '复盘', '考研',
]);

/** 目录树：只收 .md */
export function walkMarkdown(root, { deny = DENY_DIRS, maxDepth = 6 } = {}) {
  const out = [];
  const seen = new Set();
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) {
        if (deny.has(e.name)) continue;
        walk(path.join(dir, e.name), depth + 1);
      } else if (e.name.endsWith('.md')) {
        const abs = path.join(dir, e.name);
        if (seen.has(abs)) continue;
        seen.add(abs);
        let st = { size: 0, mtime: 0 };
        try {
          st = fs.statSync(abs);
        } catch {
          /* 忽略 */
        }
        out.push({ abs, rel: path.relative(root, abs), size: st.size, mtime: st.mtimeMs });
      }
    }
  };
  walk(root, 0);
  return out;
}
