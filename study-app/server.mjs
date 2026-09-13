#!/usr/bin/env node
/**
 * server.mjs —— 零依赖本地服务
 *
 *   node server.mjs            启动并自动打开浏览器
 *   node server.mjs --no-open  只启动
 *   node server.mjs --port 4200
 *
 * 只监听 127.0.0.1（本机）。若想在手机上访问，把 config.json 的 host 改成 0.0.0.0，
 * 但请注意：那等于把「能改你错题本」的接口暴露在局域网里。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  loadConfig, snapshot, scoped, scopeFromUrl, checkin, undo, updateMeta, updatePoints, updateReason,
  exportAll, saveUpload, listUploads, deleteUploads, promptForImages, APP_DIR,
} from './lib/notebook.mjs';
import { detect as detectItems, addQuestions, promptFor } from './lib/notebook.mjs';
import { chapterOptions } from './lib/create.mjs';
import { scanPlans, toggleTask } from './lib/plans.mjs';
import { readReview, writeReview, listReviews } from './lib/reviews.mjs';
import { buildToday, plansCached } from './lib/today.mjs';
import { buildWeekly } from './lib/weekly.mjs';
import { RESULTS } from './lib/parse.mjs';

const PUBLIC_DIR = path.join(APP_DIR, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

function parseArgs(argv) {
  const args = { open: true, port: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--no-open') args.open = false;
    if (argv[i] === '--port') args.port = Number(argv[++i]);
  }
  return args;
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, maxBytes = 1e6) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath === '/' ? '/index.html' : urlPath);
  const abs = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!abs.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
      return;
    }
    const ext = path.extname(abs).toLowerCase();
    const isVendor = abs.includes(`${path.sep}vendor${path.sep}`);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': isVendor ? 'public, max-age=86400' : 'no-cache',
    });
    fs.createReadStream(abs).pipe(res);
  });
}

/** 只服务 uploads 目录里的文件，防目录穿越 */
function serveUpload(cfg, req, res, rel) {
  const name = path.basename(decodeURIComponent(rel));
  const abs = path.join(cfg.uploadDir, name);
  if (!abs.startsWith(cfg.uploadDir) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
    return;
  }
  const ext = path.extname(abs).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': fs.statSync(abs).size,
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(abs).pipe(res);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const port = args.port || cfg.port || 4173;

  // 启动自检：错题本目录必须存在
  if (!fs.existsSync(cfg.notebookDir)) {
    console.error(`\n✗ 找不到错题本目录：${cfg.notebookDir}`);
    console.error(`  请在 ${path.join(APP_DIR, 'config.json')} 里修改 notebookDir\n`);
    process.exit(1);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;

    // 上传暂存的图片，直接以静态文件暴露（只读，且只能读 uploads 目录）
    if (p.startsWith('/uploads/')) {
      serveUpload(cfg, req, res, p.slice('/uploads/'.length));
      return;
    }

    if (!p.startsWith('/api/')) {
      serveStatic(req, res, p);
      return;
    }

    try {
      if (p === '/api/health') {
        sendJson(res, 200, {
          ok: true,
          notebookDir: cfg.notebookDir,
          appDir: APP_DIR,
          results: RESULTS,
          time: new Date().toISOString(),
        });
        return;
      }

      if (p === '/api/questions' && req.method === 'GET') {
        const snap = snapshot(cfg);
        sendJson(res, 200, {
          notebookDir: snap.notebookDir,
          taxonomy: snap.taxonomy,
          tree: snap.tree,
          options: chapterOptions(),
          problems: snap.problems,
          errors: snap.errors,
          stats: snap.stats,
        });
        return;
      }

      if (p === '/api/stats' && req.method === 'GET') {
        // 可选范围：?category=数学&subject=高数&chapter=极限
        const { stats, problems } = scoped(cfg, scopeFromUrl(url));
        sendJson(res, 200, { ...stats, scopedCount: problems.length });
        return;
      }

      if (p === '/api/detect' && req.method === 'POST') {
        const body = await readBody(req);
        sendJson(res, 200, detectItems(cfg, body.raw, body.mode));
        return;
      }

      if (p === '/api/new' && req.method === 'POST') {
        const body = await readBody(req);
        sendJson(res, 200, addQuestions(cfg, body.items));
        return;
      }

      if (p === '/api/prompt' && req.method === 'POST') {
        const body = await readBody(req);
        sendJson(res, 200, promptFor(cfg, body.stems, body));
        return;
      }

      /* ---- 图片：上传暂存 → 生成提示词交给 AI 转成题目 ---- */
      if (p === '/api/upload' && req.method === 'POST') {
        const body = await readBody(req, 24 * 1024 * 1024);
        sendJson(res, 200, { ok: true, ...saveUpload(cfg, body) });
        return;
      }

      if (p === '/api/uploads' && req.method === 'GET') {
        sendJson(res, 200, listUploads(cfg));
        return;
      }

      if (p === '/api/uploads' && req.method === 'DELETE') {
        const body = await readBody(req);
        sendJson(res, 200, { ok: true, ...deleteUploads(cfg, body.names) });
        return;
      }

      if (p === '/api/prompt-images' && req.method === 'POST') {
        const body = await readBody(req);
        sendJson(res, 200, promptForImages(cfg, body.names, body));
        return;
      }

      /* ---- study：今日 / 计划 / 笔记 / 复盘 ---- */
      if (p === '/api/today' && req.method === 'GET') {
        sendJson(res, 200, buildToday(cfg, snapshot(cfg).stats));
        return;
      }

      if (p === '/api/weekly' && req.method === 'GET') {
        sendJson(res, 200, buildWeekly(cfg, snapshot(cfg).stats));
        return;
      }

      if (p === '/api/plans' && req.method === 'GET') {
        const plans = plansCached(cfg, url.searchParams.get('fresh') === '1');
        sendJson(res, 200, {
          count: plans.length,
          plans: plans.map((x) => ({
            rel: x.rel,
            kind: x.kind,
            month: x.month,
            week: x.week,
            range: x.range,
            title: x.title,
            h1: x.h1,
            total: x.total,
            done: x.done,
            rate: x.rate,
            mtime: x.mtime,
          })),
        });
        return;
      }

      if (p === '/api/plan' && req.method === 'GET') {
        const rel = url.searchParams.get('rel') || '';
        const abs = path.resolve(cfg.vaultDir, rel);
        if (!abs.startsWith(cfg.planDir + path.sep)) {
          sendJson(res, 403, { error: '只能读计划目录里的文件' });
          return;
        }
        const plans = plansCached(cfg);
        const found = plans.find((x) => x.rel === rel);
        if (!found) {
          sendJson(res, 404, { error: '找不到这份计划' });
          return;
        }
        sendJson(res, 200, { ...found, content: fs.readFileSync(abs, 'utf8') });
        return;
      }

      if (p === '/api/task' && req.method === 'POST') {
        const body = await readBody(req);
        const abs = path.resolve(cfg.vaultDir, String(body.rel || ''));
        if (!abs.startsWith(cfg.planDir + path.sep)) {
          sendJson(res, 403, { error: '只能改计划目录里的文件' });
          return;
        }
        const out = toggleTask(cfg.vaultDir, cfg.backupDir, body.rel, body);
        plansCached(cfg, true);
        sendJson(res, 200, { ok: true, ...out });
        return;
      }

      if (p === '/api/reviews' && req.method === 'GET') {
        sendJson(res, 200, { reviews: listReviews(cfg.reviewDir, cfg.vaultDir), today: new Date().toISOString().slice(0, 10) });
        return;
      }

      if (p === '/api/review' && req.method === 'GET') {
        const date = String(url.searchParams.get('date') || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          sendJson(res, 400, { error: '日期格式应为 YYYY-MM-DD' });
          return;
        }
        sendJson(res, 200, readReview(cfg.vaultDir, date, plansCached(cfg)));
        return;
      }

      if (p === '/api/review' && req.method === 'POST') {
        const body = await readBody(req, 2 * 1024 * 1024);
        const date = String(body.date || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          sendJson(res, 400, { error: '日期格式应为 YYYY-MM-DD' });
          return;
        }
        const out = writeReview(cfg.vaultDir, cfg.backupDir, date, String(body.content ?? ''), plansCached(cfg));
        sendJson(res, 200, { ok: true, ...out });
        return;
      }

      if (p === '/api/export' && (req.method === 'POST' || req.method === 'GET')) {
        sendJson(res, 200, { ok: true, ...exportAll(cfg) });
        return;
      }

      if (p === '/api/checkin' && req.method === 'POST') {
        const body = await readBody(req);
        const out = checkin(cfg, body.id, body.result, body.date, body.seconds, body.reason);
        sendJson(res, 200, out);
        return;
      }

      if (p === '/api/reason' && req.method === 'POST') {
        const body = await readBody(req);
        const out = updateReason(cfg, body.id, body.reason);
        sendJson(res, 200, out);
        return;
      }

      if (p === '/api/points' && req.method === 'POST') {
        const body = await readBody(req);
        const out = updatePoints(cfg, body.id, body.points);
        sendJson(res, 200, out);
        return;
      }

      if (p === '/api/undo' && req.method === 'POST') {
        const body = await readBody(req);
        const out = undo(cfg, body.id, body.attempt, body.result);
        sendJson(res, 200, out);
        return;
      }

      if (p === '/api/question' && (req.method === 'PATCH' || req.method === 'POST')) {
        const body = await readBody(req);
        const out = updateMeta(cfg, body.id, body);
        sendJson(res, 200, out);
        return;
      }

      sendJson(res, 404, { error: 'No such API route' });
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error('[api]', err);
      sendJson(res, status, { error: String(err.message || err) });
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n✗ 端口 ${port} 已被占用。换一个：node server.mjs --port ${port + 1}\n`);
    } else {
      console.error('\n✗ 服务启动失败：', err.message, '\n');
    }
    process.exit(1);
  });

  server.listen(port, cfg.host || '127.0.0.1', () => {
    const url = `http://${cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host}:${port}`;
    const snap = snapshot(cfg, { force: true });
    console.log('');
    console.log('  📕 错题本');
    console.log(`  ${url}`);
    console.log('');
    console.log(`  错题目录  ${cfg.notebookDir}`);
    console.log(
      `  已收录    ${snap.problems.length} 题 · ${snap.tree
        .map((c) => `${c.name}(${c.total})`)
        .join(' ')}`
    );
    if (snap.errors.length) console.log(`  ⚠ 解析失败 ${snap.errors.length} 篇`);
    console.log(`  上传暂存  ${cfg.uploadDir}`);
    console.log('');
    console.log('  按 Ctrl+C 退出');
    console.log('');

    if (args.open) {
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      try {
        spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
      } catch {
        /* 打不开就算了，手动点链接即可 */
      }
    }
  });
}

main();
