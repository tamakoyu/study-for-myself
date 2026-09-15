#!/usr/bin/env node
/**
 * server.mjs —— 零依赖本地服务
 *
 *   node server.mjs            启动并自动打开浏览器
 *   node server.mjs --no-open  只启动
 *   node server.mjs --port 4200
 *   node server.mjs --lan      这次启动就打开「手机访问」（不改配置）
 *   node server.mjs --local    这次启动不开「手机访问」
 *
 * 监听分成两个，**手机访问是设置页里一个可以随时开关的开关**：
 *   - 127.0.0.1:port  —— 永远在。本机（电脑端）不受开关影响；手机上误关了也能从电脑上开回来。
 *   - 0.0.0.0:port    —— 只在开关打开时才有。关掉是真的不听这个端口（不是回 403），
 *                        局域网里谁都连不上。开关状态存在 config.json 的 lanAccess。
 * 两个监听共用同一套处理逻辑（把 request 事件直接转过去），所以行为完全一致。
 * **注意：开着就等于把「能改你错题本」的接口暴露在局域网里** —— 只在可信网络下开。
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  loadConfig, snapshot, scoped, scopeFromUrl, checkin, undo, updateMeta, updatePoints, updateReason,
  exportAll, saveUpload, listUploads, deleteUploads, promptForImages, topUpCheckins,
  patternsSnapshot, patternPrompt, readRaw, readAsset, resolveNote, APP_DIR, configPath,
} from './lib/notebook.mjs';
import { detect as detectItems, addQuestions, promptFor } from './lib/notebook.mjs';
import { chapterOptions, buildPatternPrompt, bookOf } from './lib/create.mjs';
import { writePatternNote } from './lib/patterns.mjs';
import { filterByScope } from './lib/stats.mjs';
import { scanPlans, toggleTask } from './lib/plans.mjs';
import { readReview, writeReview, listReviews } from './lib/reviews.mjs';
import { buildToday, plansCached } from './lib/today.mjs';
import { buildWeekly } from './lib/weekly.mjs';
import { RESULTS, parseNote, today } from './lib/parse.mjs';
import { backupFile } from './lib/vault.mjs';
import {
  overview as maimemoOverview, pool as maimemoPool, paperPrompt, listStories, readStory,
  saveStory, saveStoryGrade, writeToken, tokenPath, readToken, clearCache as clearMaimemoCache,
  lookupVocIds, addWordsToPlan,
  PAPER_TYPES, PAPER_TYPE_LABEL, recommendedWords, resolveTypes,
} from './lib/maimemo.mjs';
import {
  collectToday, dailyTestPrompt, listTests, readTest, saveTest, saveTestGrade, testRelOf, splitAnswer,
} from './lib/dailytest.mjs';
import {
  gradePaper, gradePrompt, normalizeGrade, formatGradeRecord, readGradeRecords, fmtClock,
  questionGradePrompt, normalizeQuestionGrade,
} from './lib/grade.mjs';
import {
  aiStatus,
  writeAIConfig,
  chat,
  parseFilesEnvelopeEx,
  parseItemsEnvelopeEx,
  parseJsonEnvelope,
  patternFooter,
  snippet,
} from './lib/ai.mjs';
import { planJobs, aiTaskList, AI_TASKS, SYSTEM as AI_SYSTEM } from './lib/aigen.mjs';
import { writeWeeklySummary } from './lib/weekly.mjs';

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
  const args = { open: true, port: null, host: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--no-open') args.open = false;
    if (argv[i] === '--port') args.port = Number(argv[++i]);
    // 临时开 / 临时关局域网监听，不用去改 config.json
    if (argv[i] === '--lan') args.host = '0.0.0.0';
    if (argv[i] === '--local') args.host = '127.0.0.1';
    if (argv[i] === '--host') args.host = String(argv[++i] || '');
  }
  return args;
}

/**
 * 本机在局域网里的 IPv4 地址 —— 手机上要输的就是这几个里的一个。
 * 常见网段（192.168 / 10. / 172.16–31）排前面：虚拟网卡（Docker、VPN）
 * 也常常有 IP，但手机连不上那几个。
 */
function lanAddresses() {
  const isPrivate = (ip) => /^192\.168\./.test(ip) || /^10\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return [...new Set(out)].sort((a, b) => Number(isPrivate(b)) - Number(isPrivate(a)));
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

/**
 * 模型没按 JSON 返回时，把它这一整段原文留一份下来。
 *
 * 界面上只能放一小段摘要（几万字贴上去没人看），但「到底哪儿坏了」得查得动：
 * 是被截断了、是包了一层代码围栏、还是压根写成了一篇散文。
 * 只在排查时开：`AI_DUMP_RAW=1 node server.mjs`，文件写在 study-app/.ai-last-raw.txt（已 gitignore）。
 */
/** 点词注释的缓存：同一个「词 + 句子」只问一次模型 */
const annotateCache = new Map();

function dumpRawModelText(text, job = {}) {
  if (!process.env.AI_DUMP_RAW) return;
  try {
    const file = path.join(APP_DIR, '.ai-last-raw.txt');
    const head = `# ${new Date().toISOString()}\n# job=${job.label || job.rel || '?'} kind=${job.custom || job.mode || '?'}\n# ${String(text || '').length} 字\n\n`;
    fs.writeFileSync(file, head + String(text || ''), 'utf8');
    console.error(`[ai] 模型原文已存到 ${file}（${String(text || '').length} 字）`);
  } catch (err) {
    console.error(`[ai] 存模型原文失败：${err.message}`);
  }
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

/** 上传目录里的图片读成 data URL（给多模态模型用）；只认 uploads 里的文件名，防目录穿越 */
const IMG_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
};
function uploadToDataUrl(cfg, name) {
  const base = path.basename(String(name || ''));
  const abs = path.join(cfg.uploadDir, base);
  if (!abs.startsWith(cfg.uploadDir + path.sep)) throw Object.assign(new Error('非法文件名'), { status: 400 });
  if (!fs.existsSync(abs)) throw Object.assign(new Error(`找不到上传的图片：${base}`), { status: 404 });
  const ext = path.extname(abs).toLowerCase();
  const mime = IMG_MIME[ext];
  if (!mime) throw Object.assign(new Error(`不支持的图片格式：${ext}`), { status: 400 });
  return { name: base, url: `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}` };
}

/**
 * 删一个仓库里的文件：先备份到 backups/，再删。
 * root 传了就要求文件必须在那个目录里（生成的试卷 / 单词题）；
 * 传 null 表示调用方已经校验过路径（题库那本书自己的文件）。
 */
function deleteVaultFile(cfg, rel, root, what, knownAbs = null) {
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.includes('..')) throw Object.assign(new Error('路径不合法'), { status: 400 });
  const abs = knownAbs || path.resolve(cfg.vaultDir, clean);
  if (root && !abs.startsWith(root + path.sep)) {
    throw Object.assign(new Error(`只能删${what}目录里的文件`), { status: 403 });
  }
  if (!abs.endsWith('.md')) throw Object.assign(new Error('只能删 .md 文件'), { status: 400 });
  if (!fs.existsSync(abs)) throw Object.assign(new Error('文件不在了'), { status: 404 });
  const backup = backupFile(abs, cfg.vaultDir, cfg.backupDir, 'deleted');
  fs.unlinkSync(abs);
  return { ok: true, rel: path.relative(cfg.vaultDir, abs).split(path.sep).join('/'), backup };
}

/**
 * 把模型返回的文件写进仓库。只允许写两类：
 *   1. 某本书目录里的 .md（错题本 / 好题本）
 *   2. 某本书的 picture/ 里的图片（SVG 这种文本格式，或模型万一给的 base64 都不收）
 * 其它一律拒绝 —— 模型改路径、写别处、路径穿越都不行。
 */
function writeModelFile(cfg, rel, content) {
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.includes('..')) throw new Error(`路径不合法：${rel}`);
  const abs = path.resolve(cfg.vaultDir, clean);
  const books = [cfg.notebookDir, cfg.goodDir];
  const inBook = books.some((b) => abs.startsWith(b + path.sep));
  if (!inBook) throw new Error(`只能写进错题本 / 好题本，拒绝了：${rel}`);

  const ext = path.extname(abs).toLowerCase();
  const isNote = ext === '.md';
  const isFigure = ['.svg', '.txt'].includes(ext) && abs.includes(`${path.sep}picture${path.sep}`);
  if (!isNote && !isFigure) throw new Error(`不收这种文件：${rel}`);

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (fs.existsSync(abs)) backupFile(abs, cfg.vaultDir, cfg.backupDir, 'model');
  fs.writeFileSync(abs, String(content ?? ''), 'utf8');
  return { rel: clean, abs, isNote };
}

/* ============================================================
   判分用的公共部分：读卷子 → 分值 / 参考用时 → 写回成绩记录
   ============================================================ */

/**
 * 把一份卷子读成判分要的形状。
 * 今日测试看题干 + 标准答案 + 逐题分值；英语看题干 + 选项 + 答案速查 + 答案解析。
 */
function gradePaperFor(cfg, kind, rel) {
  if (kind === 'story') {
    const s = readStory(cfg, rel);
    if (!s.exists) throw Object.assign(new Error('找不到这一篇题目'), { status: 404 });
    return {
      kind: 'story',
      rel: s.rel,
      title: s.title || s.rel,
      type: s.type,
      questions: s.questions,
      key: s.key,
      analysis: s.analysis,
      content: s.content,
      grades: s.grades,
    };
  }
  const t = readTest(cfg, rel);
  if (!t.exists) throw Object.assign(new Error('找不到这份测试'), { status: 404 });
  return {
    kind: 'test',
    rel: t.rel,
    title: t.title || t.rel,
    minutes: t.minutes,
    full: t.full,
    items: t.items,
    content: t.content,
    grades: t.grades,
    // 成绩记录里的「考点」一列
    meta: Object.fromEntries((t.items || []).map((q) => [q.n, { type: q.type, topic: q.topic }])),
  };
}

/** 下一次是「第几次」判分：拿现有的最大序号 +1（删过中间几次也不会撞号） */
function nextGradeIndex(records) {
  return (records || []).reduce((m, r) => Math.max(m, Number(r.index) || 0), 0) + 1;
}

/** 把成绩写回试卷文件（今日测试走 test 目录，英语走 单词故事 目录） */
function writeGradeToPaper(cfg, paper, attempt) {
  const md = formatGradeRecord(attempt);
  if (paper.kind === 'story') saveStoryGrade(cfg, paper.rel, md);
  else saveTestGrade(cfg, paper.rel, md);
  clearMaimemoCache();
  return md;
}

/** 上传的图片名列表 → 过滤 + 去重（只认 uploads 里的文件名，别的交给 uploadToDataUrl 报错） */
function cleanImageNames(names) {
  return [...new Set((Array.isArray(names) ? names : []).map((n) => path.basename(String(n || ''))).filter(Boolean))];
}

function serveStatic(req, res, urlPath) {
  // 手机端：/m 和 /m/ 都指向 m.html —— 手机上少打几个字
  const p = urlPath === '/m' || urlPath === '/m/' ? '/m.html' : urlPath;
  let rel = decodeURIComponent(p === '/' ? '/index.html' : p);
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
          // 设置页那个「重启服务」靠 pid 判断新进程有没有起来
          pid: process.pid,
          port,
          uptimeSeconds: Math.round(process.uptime()),
          time: new Date().toISOString(),
        });
        return;
      }

      /**
       * 手机访问开关（设置页那一块）。
       *   GET  → 现在开着没有、手机该输哪个地址
       *   POST { on } → 开关。**立刻生效，不用重启**：
       *                开 = 起一个 0.0.0.0 的监听，关 = 把它关掉（真关，不是回 403）
       * 本机监听（127.0.0.1）不归这个开关管 —— 电脑端永远连得上。
       */
      if (p === '/api/lan' && req.method === 'GET') {
        sendJson(res, 200, lanState());
        return;
      }

      if (p === '/api/lan' && req.method === 'POST') {
        const body = await readBody(req);
        const on = !!body.on;
        if (on && !lan.srv) await lanStart();
        else if (!on && lan.srv) lanStop();
        const saved = lanSave(on);
        if (!saved.ok) {
          sendJson(res, 500, { error: `开关拨了，但状态没存进 config.json：${saved.error}`, ...lanState() });
          return;
        }
        sendJson(res, 200, { ok: true, ...lanState() });
        return;
      }

      /**
       * 一键重启：改了 server.mjs / lib 里的东西要重启才生效。
       *
       * **不能自己重启自己** —— 得先把端口让出来。所以叫一个看门人（scripts/relaunch.mjs），
       * 它脱离这个进程、轮询端口，空了再把 server.mjs 拉起来；这边回完响应就退出。
       * 新的进程带 --no-open（别再弹一个浏览器窗口），输出追加到 study-app/.server.log。
       */
      if (p === '/api/restart' && req.method === 'POST') {
        const relay = path.join(APP_DIR, 'scripts', 'relaunch.mjs');
        if (!fs.existsSync(relay)) {
          sendJson(res, 500, { error: `找不到重启脚本：${relay}` });
          return;
        }
        let child;
        try {
          child = spawn(process.execPath, [relay, path.join(APP_DIR, 'server.mjs'), String(port)], {
            cwd: APP_DIR,
            env: process.env,
            detached: true,
            stdio: 'ignore',
          });
          child.unref();
        } catch (err) {
          sendJson(res, 500, { error: `叫不动看门人：${err.message}` });
          return;
        }
        const log = process.env.RELAUNCH_LOG || path.join(APP_DIR, '.server.log');
        sendJson(res, 200, { ok: true, pid: process.pid, next: child.pid, port, log });
        // 响应发完再退出，不然页面拿不到这句「正在重启」
        res.on('finish', () => {
          setTimeout(() => {
            try {
              server.close();
            } catch {
              /* 关不掉就直接走 */
            }
            process.exit(0);
          }, 200);
        });
        return;
      }

      if (p === '/api/questions' && req.method === 'GET') {
        const snap = snapshot(cfg);
        const book = url.searchParams.get('book');
        const problems = book ? filterByScope(snap.problems, { book }) : snap.problems;
        sendJson(res, 200, {
          book: book || null,
          notebookDir: snap.notebookDir,
          taxonomy: snap.taxonomy,
          tree: snap.tree,
          trees: snap.trees,
          options: chapterOptions(),
          problems,
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
        sendJson(res, 200, detectItems(cfg, body.raw, body.mode, body.book));
        return;
      }

      if (p === '/api/new' && req.method === 'POST') {
        const body = await readBody(req);
        sendJson(res, 200, addQuestions(cfg, body.items, body.book || 'mistakes'));
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
        // ?date=2026-09-14 → 看那一周里某一天该做什么（缺省就是今天）
        const out = buildToday(cfg, snapshot(cfg).stats, new Date(), url.searchParams.get('date'));
        // 墨墨的背词情况：读不到就留 null，首页照常显示，只是卡片变灰
        out.words = await maimemoOverview(cfg, { force: url.searchParams.get('fresh') === '1' });
        sendJson(res, 200, out);
        return;
      }

      /* ---- 单词：墨墨进度 + 待背词池 + 考研题型 ---- */
      if (p === '/api/words' && req.method === 'GET') {
        const fresh = url.searchParams.get('fresh') === '1';
        const [ov, words] = await Promise.all([
          maimemoOverview(cfg, { force: fresh }),
          maimemoPool(cfg, { force: fresh }),
        ]);
        const auth = readToken(cfg);
        sendJson(res, 200, {
          hasToken: !!auth,
          tokenSource: auth ? auth.source : null,
          tokenFile: tokenPath(),
          overview: ov,
          pool: words,
          stories: listStories(cfg),
          storyDir: path.basename(cfg.storyDir),
          paperTypes: PAPER_TYPES.map((t) => ({
            id: t.id, group: t.group, label: t.label,
            full: PAPER_TYPE_LABEL[t.id], words: t.words,
          })),
        });
        return;
      }

      /**
       * 点词：文章里点一个词，先问墨墨这个词库有没有、voc_id 是什么。
       * body: { spellings: [...] } → { words: [{ spelling, voc_id }] }
       * **只读**，不改任何东西；词库里没有的词 voc_id 是 null（那种词加不进计划）。
       */
      if (p === '/api/words/lookup' && req.method === 'POST') {
        const body = await readBody(req);
        const ids = await lookupVocIds(cfg, body.spellings || []);
        sendJson(res, 200, {
          words: [...ids.entries()].map(([spelling, voc_id]) => ({ spelling, voc_id })),
        });
        return;
      }

      /**
       * 点词 → 加进我的墨墨学习计划。
       * body: { spellings?: [...], voc_ids?: [...], advance?: bool }
       *   - advance=true：顺便提前到「立即复习」（add_words 这条路不受等级限制）
       * 返回 added / requested：墨墨那边可能少加几个（词库没有、或已经在计划里了）。
       */
      if (p === '/api/words/add-to-plan' && req.method === 'POST') {
        const body = await readBody(req);
        let ids = (body.voc_ids || []).filter(Boolean);
        const missing = [];
        if (!ids.length && body.spellings?.length) {
          const map = await lookupVocIds(cfg, body.spellings);
          for (const [spelling, vocId] of map.entries()) {
            if (vocId) ids.push(vocId);
            else missing.push(spelling);
          }
        }
        const out = await addWordsToPlan(cfg, ids, { advance: body.advance });
        sendJson(res, 200, { ...out, missing });
        return;
      }

      /**
       * 点词 → 出一个「在这个句子里的意思」的注释。
       *
       * 墨墨的开放接口**不提供词典释义**（`GET /interpretations` 只能读你自己加的释义），
       * 所以这一条用内置 AI：带上这个词所在的句子，问它「本句里是什么意思」。
       * 结果按「词 + 句子」缓存 —— 同一个词点两次不该再花一次钱。
       */
      if (p === '/api/words/annotate' && req.method === 'POST') {
        const body = await readBody(req);
        const st = aiStatus(cfg);
        if (!st.ready) {
          sendJson(res, 400, {
            error: st.needsKey ? '还没填 API key' : '还没配置 AI 接口地址和模型',
            hint: '配好内置 AI 后，点任意一个词都能出「在本句里的意思」',
          });
          return;
        }
        const word = String(body.word || '').trim();
        if (!word) {
          sendJson(res, 400, { error: '没给词' });
          return;
        }
        const sentence = String(body.sentence || '').trim().slice(0, 600);
        const key = `${word.toLowerCase()}|${sentence}`;
        if (annotateCache.has(key)) {
          sendJson(res, 200, { ...annotateCache.get(key), cached: true });
          return;
        }
        const text = await chat(cfg, {
          system: AI_SYSTEM,
          user: `我在读一篇考研英语（一）的文章，想弄懂某个单词**在这一句里**是什么意思。

单词：${word}
它所在的句子：${sentence || '（没给句子）'}

请只给这些（严格按 JSON 返回，不要解释）：
- \`pos\`：词性，如 \`n.\` / \`v.\` / \`adj.\`，多个用 \`/\` 隔开
- \`meaning\`：**在这一句里**的意思（中文，一行说完，不要把词典里所有义项都抄上来）
- \`note\`：一句话提醒（常见搭配 / 易混词 / 为什么这里是这个意思），没有就给空字符串
{"pos":"","meaning":"","note":""}`,
          json: true,
          reasoning: 'none',
        });
        const j = parseJsonEnvelope(text) || {};
        const out = {
          word,
          pos: String(j.pos || '').trim(),
          meaning: String(j.meaning || '').trim() || '（模型没给出释义）',
          note: String(j.note || '').trim(),
        };
        annotateCache.set(key, out);
        if (annotateCache.size > 300) annotateCache.delete(annotateCache.keys().next().value);
        sendJson(res, 200, out);
        return;
      }

      /**
       * 生成提示词。
       * body: { voc_ids?, count?, types[], papers, random?, date? }
       *   - types：勾选的题型（自选时按勾的来；随机时作为候选池）
       *   - papers：出几篇 1–6
       *   - random：true 时从 types 里不重复抽 papers 个
       */
      if (p === '/api/words/prompt' && req.method === 'POST') {
        const body = await readBody(req);
        const poolData = await maimemoPool(cfg);
        const all = Object.values(poolData.groups || {}).flatMap((g) => g.words || []);
        const byId = new Map();
        for (const w of all) if (!byId.has(w.voc_id)) byId.set(w.voc_id, w);

        const date = body.date ? String(body.date).slice(0, 10) : undefined;
        const types = resolveTypes(body.types, body.papers, !!body.random);

        let picked;
        let missing = 0;
        if (Array.isArray(body.voc_ids) && body.voc_ids.length) {
          // 页面上的词池是加载那一刻的快照；这边重新取的时候墨墨可能已经变了，
          // 对不上的词**不静默丢掉** —— 数出来告诉界面，免得你以为选了 60 个结果只出了 59 个
          picked = body.voc_ids.map((id) => byId.get(id)).filter(Boolean);
          missing = body.voc_ids.length - picked.length;
        } else {
          // 没指定词：从词池里按顺序取「推荐数量」
          const want = Number(body.count) > 0 ? Number(body.count) : recommendedWords(types);
          picked = all.slice(0, want);
        }

        const out = paperPrompt(cfg, picked, {
          date,
          types,
          overviewData: await maimemoOverview(cfg),
        });
        sendJson(res, 200, { ...out, missing });
        return;
      }

      /** 存故事 / 题目（我写好的那份，或你自己粘进来的）—— rel 定位，一天可以多篇 */
      if (p === '/api/words/story' && req.method === 'POST') {
        const body = await readBody(req, 4 * 1024 * 1024);
        const out = saveStory(cfg, String(body.rel || ''), body.content ?? '', { words: body.words || [] });
        sendJson(res, 200, { ...out, stories: listStories(cfg) });
        return;
      }

      if (p === '/api/words/story' && req.method === 'GET') {
        sendJson(res, 200, readStory(cfg, url.searchParams.get('rel') || ''));
        return;
      }

      /* ---- 内置 AI：配置 / 连通性 / 一键生成 ---- */
      if (p === '/api/ai' && req.method === 'GET') {
        sendJson(res, 200, { ...aiStatus(cfg), tasks: aiTaskList(), hasMaimemo: !!readToken(cfg) });
        return;
      }

      /** 存 AI 配置（key 只落本机 .ai-config.json，接口永远不回显） */
      if (p === '/api/ai/config' && req.method === 'POST') {
        const body = await readBody(req);
        const file = writeAIConfig(body);
        sendJson(res, 200, { ok: true, file, ...aiStatus(cfg) });
        return;
      }

      /** 连通性自检：一句话的小请求，看 key / 地址 / 模型通不通 */
      if (p === '/api/ai/test' && req.method === 'POST') {
        const started = Date.now();
        try {
          // 这里必须给足 token 并关掉思考：deepseek-flash 这类模型默认先思考，
          // max_tokens 太小的话思考就把额度吃光，正文是空的（看起来像"连不通"）
          const text = await chat(cfg, {
            system: '你是连通性测试。',
            user: '只回复两个字：可用',
            maxTokens: 512,
            reasoning: 'none',
          });
          sendJson(res, 200, { ok: true, ms: Date.now() - started, reply: String(text).trim().slice(0, 40) });
        } catch (err) {
          sendJson(res, 200, { ok: false, error: String(err.message || err), ms: Date.now() - started });
        }
        return;
      }

      /**
       * 一键生成。走 NDJSON 流（一行一个 JSON），前端边收边显示进度。
       * body: { kind: 'words'|'test', ...任务参数 }
       */
      if (p === '/api/ai/run' && req.method === 'POST') {
        const body = await readBody(req, 2 * 1024 * 1024);
        const st = aiStatus(cfg);
        if (!st.ready) {
          sendJson(res, 400, { error: st.needsKey ? '还没填 API key' : '还没配置 AI 接口地址和模型' });
          return;
        }

        // 支持两种写法：{ kind } 单任务，或 { tasks: [{kind, ...}] } 多任务
        // 多任务是为了「粘了题干又传了图」时只出一个进度列表、只点一次按钮
        const taskList = Array.isArray(body.tasks) && body.tasks.length ? body.tasks : [body];
        let jobs = [];
        try {
          for (const t of taskList) {
            if (!t || !t.kind) continue;
            jobs = jobs.concat(planJobs(cfg, t.kind, t, { stats: snapshot(cfg).stats }).jobs);
          }
        } catch (err) {
          sendJson(res, err.status || 400, { error: String(err.message || err) });
          return;
        }
        if (!jobs.length) {
          sendJson(res, 400, { error: '这次没有要生成的内容' });
          return;
        }

        // 生成长文可能要几分钟，别让 Node 把请求掐了
        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Accel-Buffering': 'no',
        });
        const send = (obj) => {
          try {
            res.write(`${JSON.stringify(obj)}\n`);
          } catch {
            /* 客户端断了 */
          }
        };

        // 客户端关掉页面 → 中断模型请求
        const ac = new AbortController();
        let closed = false;
        req.on('close', () => {
          closed = true;
          ac.abort();
        });

        for (const j of jobs) j.kind = body.kind;
        // jobs 里带上各自的类型（questions / images / …）—— 前端靠它决定进度条那一行怎么写
        send({
          t: 'start',
          total: jobs.length,
          jobs: jobs.map((j) => ({ rel: j.rel, label: j.label, kind: j.custom || j.mode || '' })),
        });

        const saved = [];
        for (let i = 0; i < jobs.length; i += 1) {
          if (closed) break;
          const job = jobs[i];
          send({
            t: 'job',
            i,
            rel: job.rel,
            label: job.label,
            phase: 'start',
            kind: job.custom || job.mode || '',
          });
          let chars = 0;
          let lastTick = 0;
          let thinkChars = 0;
          /** 模型吐字 → 累计 + 限流推给前端（归类那一步复用同一个计数器，进度条才不会归零） */
          const feedDelta = (d, kind, thinkTotal) => {
            // 思考那一路传的是**累计字符数**（第三个参数），不是增量 —— 别拿 d.length 去加
            if (kind === 'reasoning') thinkChars = thinkTotal || 0;
            else chars += d.length;
            const now = Date.now();
            if (now - lastTick > 220) {
              lastTick = now;
              send({ t: 'delta', i, chars, think: thinkChars });
            }
          };
          /**
           * 心跳：模型在长思考时可能几十秒一个字节都不吐。
           * 没有心跳的话，前端分不清「在算」和「网线断了」，只能一路干等。
           * 心跳只说明服务端还活着，**不代表模型在回话** —— 前端拿它和 delta 分开计。
           */
          const heartbeat = setInterval(() => send({ t: 'ping', i, chars }), 5000);
          try {
            const text = await chat(cfg, {
              system: AI_SYSTEM,
              user: job.user,
              json: true,
              reasoning: body.reasoning || AI_TASKS[job.kind]?.reasoning || undefined,
              images: (job.images || []).map((n) => uploadToDataUrl(cfg, n).url),
              signal: ac.signal,
              onDelta: feedDelta,
            });
            // 三种落盘方式：整文件（阅读题/今日测试）、只回正文（周总结）、只回答案（增题）
            if (job.mode === 'text') {
              const body = String(text || '').trim();
              if (!body) throw new Error('模型返回了空内容');
              writeWeeklySummary(cfg, job.rel, body);
              saved.push({ rel: job.rel, chars: body.length, label: job.label });
              send({ t: 'saved', i, rel: job.rel, chars: body.length });
            } else if (job.custom === 'images') {
              const envelope = parseFilesEnvelopeEx(text);
              const files = envelope.files;
              if (!files) {
                dumpRawModelText(text, job);
                throw new Error(
                  `模型没有按 JSON 格式返回，这次没写盘${envelope.hint ? `（${envelope.hint}）` : ''}（它回的是：${snippet(text)}）`
                );
              }
              const written = [];
              const rejected = [];
              const warns = [];
              for (const f of files) {
                try {
                  const w = writeModelFile(cfg, f.rel, f.content);
                  written.push(w.rel);
                  // 顺手用程序自己的解析器验一遍格式，写得不对要告诉大家，不能默默收下
                  if (w.isNote) {
                    const parsed = parseNote(w.abs, cfg.notebookDir, job.meta.book);
                    if (parsed.warnings?.length) warns.push(`${w.rel}：${parsed.warnings.join('；')}`);
                  }
                } catch (e) {
                  rejected.push(`${f.rel}（${e.message}）`);
                }
              }
              if (!written.length) throw new Error(`模型给的文件一个都没收下：${rejected.join('；')}`);
              saved.push(...written.map((r) => ({ rel: r, chars: 0, label: job.label })));
              // 第二步：把这批新图题归进题型本（失败了也只是多一条提醒，笔记照旧）
              try {
                const cls = await autoClassifyPatterns(cfg, {
                  job: { ...job, meta: { ...(job.meta || {}), bookLabel: bookOf(job.meta.book).label } },
                  ac,
                  onStage: (text2) => send({ t: 'stage', i, text: text2 }),
                  onDelta: feedDelta,
                });
                warns.push(...cls.warns);
              } catch (e) {
                if (closed) break;
                warns.push(`笔记写好了，但自动归类没成：${String(e.message || e)}`);
              }
              send({ t: 'saved', i, rel: written.join('、'), created: written, rejected, warns });
            } else if (job.custom === 'questions') {
              const envelope = parseItemsEnvelopeEx(text);
              const items = envelope.items;
              // 认不出来的时候，把模型到底回了什么附上去 —— 只说「格式不对」等于没说
              if (!items) {
                dumpRawModelText(text, job);
                throw new Error(`模型没有按 JSON 格式返回，这次没写盘（它回的是：${snippet(text)}）`);
              }
              const { stems, book } = job.meta;
              // 再用程序自己的关键词识别分一次类（和「增题」页同一套逻辑）
              const detected = detectItems(cfg, stems.join('\n\n---\n\n'), 'rule', book);
              const base = detected.items || [];
              const toWrite = items
                .map((it) => {
                  const n = Number(it.n) || 0;
                  const b = base[n - 1] || {};
                  const stem = stems[n - 1];
                  if (!stem) return null;
                  return {
                    ...b,
                    stem,
                    slug: it.title || b.slug,
                    title: it.title || '',
                    type: it.type || b.type,
                    difficulty: it.difficulty,
                    heat: it.heat,
                    points: it.points || b.points,
                    keyPoints: it.keyPoints || '',
                    answer: it.answer || '',
                    analysis: it.analysis || '',
                    pitfall: it.pitfall || '',
                    reason: book === 'mistakes' ? body.reason || '概念不清' : undefined,
                  };
                })
                .filter(Boolean);
              if (!toWrite.length) throw new Error('模型没返回任何可用的题');
              const created = addQuestions(cfg, toWrite, book);
              const list = created.created || created || [];
              const rels = list.map((c) => c.file).filter(Boolean);
              saved.push(...rels.map((r) => ({ rel: r, chars: 0, label: job.label })));
              // 修过 / 只救回来一部分的，如实说 —— 少写了一道题不能瞒着
              const qWarns = [];
              if (envelope.repaired === 'partial') {
                qWarns.push(
                  `模型的 JSON 坏了，只救回来 ${items.length} 道 / 你给了 ${stems.length} 道，写进去 ${rels.length} 篇；没写进去的重新增一次`
                );
              } else if (envelope.repaired === 'repaired') {
                qWarns.push('模型的 JSON 有格式毛病（多半是 LaTeX 反斜杠没转义），程序修好后才认出来的');
              }
              // 第二步：把这批新题归进题型本（失败了也只是多一条提醒，笔记照旧）
              try {
                const cls = await autoClassifyPatterns(cfg, {
                  job: { ...job, meta: { ...(job.meta || {}), bookLabel: bookOf(book).label } },
                  ac,
                  onStage: (text2) => send({ t: 'stage', i, text: text2 }),
                  onDelta: feedDelta,
                });
                qWarns.push(...cls.warns);
              } catch (e) {
                if (closed) break;
                qWarns.push(`笔记写好了，但自动归类没成：${String(e.message || e)}`);
              }
              // chars 传 0、篇数放 created 里 —— 前端按「篇」显示，别把篇数说成字数
              send({ t: 'saved', i, rel: rels.join('、') || job.rel, chars: 0, created: rels, warns: qWarns });
            } else {
              const env = parseFilesEnvelopeEx(text);
              const files = env.files;
              if (!files) {
                dumpRawModelText(text, job);
                throw new Error(
                  `模型没有按 JSON 格式返回，这次没写盘${env.hint ? `（${env.hint}）` : ''}（它回的是：${snippet(text)}）`
                );
              }

              // 模型偶尔会自作主张改路径：只认我们指定的那些
              let wrote = 0;
              for (const f of files) {
                const want = jobs.find((x) => x.rel === f.rel);
                if (!want) continue;
                if (job.rel.endsWith('.md') && job.rel.includes('单词故事/')) {
                  saveStory(cfg, f.rel, f.content);
                } else {
                  saveTest(cfg, f.rel, f.content);
                }
                wrote += 1;
                saved.push({ rel: f.rel, chars: f.content.length, label: want.label });
              }
              if (!wrote) throw new Error('模型返回的路径对不上，这次没写盘');
              clearMaimemoCache();
              send({ t: 'saved', i, rel: job.rel, chars: files[0].content.length });
            }
          } catch (err) {
            if (closed) break;
            send({ t: 'error', i, rel: job.rel, message: String(err.message || err) });
          } finally {
            clearInterval(heartbeat);
          }
        }

        if (!closed) {
          send({ t: 'done', saved, aborted: false });
          res.end();
        }
        return;
      }

      /**
       * 增题写完之后的**第二步：把这批新题归进「题型本」**。
       *
       * 以前只有「复制提示词」那条老路带归类要求，一键生成这条路一个字都没提 ——
       * 于是界面上写着「归类也顺手做了」「下次增题会自动归进去」，实际上新题永远挂在「未归类」。
       *
       * 这里不新造轮子：提示词用现成的 `buildPatternPrompt`（题型页那份），
       * 落盘用 `writePatternNote`（只认 题型本/，写前备份，还不许把已有通解写瘦），
       * 走同一条流式调用，所以进度条上看得见它在动。
       *
       * **归类失败不牵连已经写好的笔记**：只把原因如实放进 warns。
       */
      async function autoClassifyPatterns(cfg, { job, ac, onStage, onDelta }) {
        const before = patternsSnapshot(cfg);
        // 顺手把以前积下来的未归类题也带上（上限 15 道，别把提示词撑爆）——
        // 那些题本来只能靠「复制提示词」那条老路手动补，现在一键生成也一起管了
        const todo = before.unlinked.slice(0, 15);
        if (!todo.length) return { warns: [], files: [] };

        const todoIds = new Set(todo.map((p) => p.id));
        const dirName = path.basename(cfg.patternDir);
        const prompt =
          buildPatternPrompt({
            patterns: before.patterns,
            unlinked: todo,
            notebookLabel: job.meta?.bookLabel || '错题本',
          }) + patternFooter(dirName);

        onStage(`正在把这 ${todo.length} 道题归入${dirName}`);
        const text = await chat(cfg, {
          system: AI_SYSTEM,
          user: prompt,
          json: true,
          reasoning: 'low', // 归类是整理活，想太久不值当
          signal: ac.signal,
          onDelta,
        });

        const parsed = parseFilesEnvelopeEx(text);
        if (!parsed.files) {
          dumpRawModelText(text, { ...job, custom: 'patterns' });
          return {
            warns: [
              `笔记都写好了，但自动归类没成（${parsed.hint || '模型没按 JSON 返回'}），这几道还标着「未归类」—— 题型页可以手动补`,
            ],
            files: [],
          };
        }

        const warns = [];
        const written = [];
        for (const f of parsed.files) {
          if (!f.rel.startsWith(`${dirName}/`)) {
            warns.push(`归类的返回里有越界路径，已拒绝：${f.rel}`);
            continue;
          }
          try {
            written.push(writePatternNote(cfg, f.rel, f.content));
          } catch (err) {
            warns.push(`这份通解没写进去：${String(err.message || err)}`);
          }
        }

        // 归没归上**不看模型怎么说，看程序自己算出来的关联**
        const after = patternsSnapshot(cfg);
        const still = after.unlinked.filter((p) => todoIds.has(p.id));
        if (still.length) {
          warns.push(`还有 ${still.length} 道没归进${dirName}（模型没把 id 写进 related），题型页上仍标着「未归类」`);
        }
        return { warns, files: written };
      }

      /**
       * 单题拍照判分（错题本 / 好题本的做题模式）——**一次只判这一道题**。
       * body: { id, names: [图片名], seconds }
       *
       * 只回判分建议，**一个字节都不写盘**：结果、错因、错因分析都会先填进面板，
       * 我自己改完再点「记进笔记」，那一步才走 /api/checkin 落盘。
       */
      if (p === '/api/grade/question' && req.method === 'POST') {
        const body = await readBody(req, 2 * 1024 * 1024);
        const st = aiStatus(cfg);
        if (!st.ready) {
          sendJson(res, 400, { error: st.needsKey ? '还没填 API key' : '还没配置 AI 接口地址和模型' });
          return;
        }
        const names = cleanImageNames(body.names);
        if (!names.length) {
          sendJson(res, 400, { error: '先上传这道题的手写过程（可以多张）' });
          return;
        }
        const problem = (snapshot(cfg).problems || []).find((x) => x.id === body.id || x.relPath === body.id);
        if (!problem) {
          sendJson(res, 404, { error: '找不到这道题' });
          return;
        }
        let images;
        try {
          images = names.map((n) => uploadToDataUrl(cfg, n).url);
        } catch (err) {
          sendJson(res, err.status || 400, { error: String(err.message || err) });
          return;
        }

        const seconds = Math.max(0, Number(body.seconds) || 0);
        const user = questionGradePrompt(problem, { images: names.length, seconds, date: today() });

        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Accel-Buffering': 'no',
        });
        const send = (obj) => {
          try {
            res.write(`${JSON.stringify(obj)}\n`);
          } catch {
            /* 客户端断了 */
          }
        };
        const ac = new AbortController();
        let closed = false;
        req.on('close', () => {
          closed = true;
          ac.abort();
        });

        send({ t: 'start', images: names.length, num: problem.num, title: problem.title || '' });
        try {
          let chars = 0;
          let thinkChars = 0;
          let lastTick = 0;
          const text = await chat(cfg, {
            system: AI_SYSTEM,
            user,
            json: true,
            reasoning: 'high', // 判一题也要按采分点抠，值得多想
            images,
            signal: ac.signal,
            onDelta: (d, k, thinkTotal) => {
              if (k === 'reasoning') thinkChars = thinkTotal || 0;
              else chars += d.length;
              const now = Date.now();
              if (now - lastTick > 220) {
                lastTick = now;
                send({ t: 'delta', chars, think: thinkChars });
              }
            },
          });
          if (closed) return;

          const envelope = parseJsonEnvelope(text);
          if (!envelope) throw new Error('模型没有按 JSON 格式返回，这次没判成（什么都没写盘）');
          const verdict = normalizeQuestionGrade(envelope);
          // 判完清掉暂存图片 —— 结论我要不要收是下一步的事，图先不占地方
          try {
            deleteUploads(cfg, names);
          } catch {
            /* 删不掉也不影响判分结果 */
          }
          send({ t: 'done', verdict, id: problem.id, num: problem.num });
          res.end();
        } catch (err) {
          if (closed) return;
          send({ t: 'error', message: String(err.message || err) });
          res.end();
        }
        return;
      }

      /* ---- 今日测试：按今天学的数学/408/笔记出题 ---- */
      if (p === '/api/test' && req.method === 'GET') {
        const todayCtx = collectToday(cfg, { mistakesStats: snapshot(cfg).stats });
        sendJson(res, 200, {
          today: todayCtx,
          prompt: dailyTestPrompt(cfg, todayCtx),
          tests: listTests(cfg),
          testDir: path.basename(cfg.testDir),
        });
        return;
      }

      if (p === '/api/test' && req.method === 'POST') {
        const body = await readBody(req, 4 * 1024 * 1024);
        const out = saveTest(cfg, String(body.rel || ''), body.content ?? '');
        sendJson(res, 200, { ...out, tests: listTests(cfg) });
        return;
      }

      if (p === '/api/test/paper' && req.method === 'GET') {
        sendJson(res, 200, readTest(cfg, url.searchParams.get('rel') || ''));
        return;
      }

      /** 加入题库前的预览：只跑关键词识别，不写盘 —— 界面上可以改 */
      if (p === '/api/test/to-bank/preview' && req.method === 'POST') {
        const body = await readBody(req);
        const paper = readTest(cfg, String(body.rel || ''));
        const item = (paper.items || []).find((q) => q.n === Number(body.n));
        if (!item) {
          sendJson(res, 404, { error: '找不到这道题' });
          return;
        }
        const book = body.book === 'good' ? 'good' : 'mistakes';
        const detected = detectItems(cfg, item.body, 'rule', book);
        const first = (detected.items || [])[0] || {};
        sendJson(res, 200, {
          item: {
            category: first.category || '',
            subject: first.subject || '',
            chapter: first.chapter || '',
            type: first.type || item.type || '',
            slug: item.topic || '',
            points: (first.points || []).join('、'),
            // 题库里现有的考点，前端补全用
            knownPoints: [...new Set((snapshot(cfg).problems || []).flatMap((x) => x.points || []))].slice(0, 80),
          },
        });
        return;
      }

      /** 一键把某道题加进错题本 / 好题本（复用增题的识别与写盘） */
      if (p === '/api/test/to-bank' && req.method === 'POST') {
        const body = await readBody(req);
        const paper = readTest(cfg, String(body.rel || ''));
        if (!paper.exists) {
          sendJson(res, 404, { error: '找不到这份测试' });
          return;
        }
        const book = body.book === 'good' ? 'good' : 'mistakes';
        // 批量（判分完「一键把错题加入错题本」）：items = [{ n, reason?, ... }]
        // 单个：就传 n（判分前那道题的「加入错题本」按钮）
        const list = Array.isArray(body.items) && body.items.length ? body.items : [body];
        const toWrite = [];
        const missing = [];
        for (const one of list) {
          const n = Number(one.n);
          const item = (paper.items || []).find((q) => q.n === n);
          if (!item) {
            missing.push(n);
            continue;
          }
          // 用增题那套关键词识别来分大类 / 科目 / 章节（界面上可以改）
          const detected = detectItems(cfg, item.body, 'rule', book);
          const first = (detected.items || [])[0] || {};
          // 界面带上来的字段优先；没带就退回识别结果 / 合理默认
          // （注意 Number(undefined) 是 NaN，NaN 也得当成「没带」）
          const pick = (v, fallback) =>
            v === undefined || v === null || v === '' || (typeof v === 'number' && !Number.isFinite(v))
              ? fallback
              : v;
          const points = Array.isArray(one.points)
            ? one.points.filter(Boolean)
            : String(one.points ?? '')
                .split(/[、,，;；\s]+/)
                .map((x) => x.trim())
                .filter(Boolean);
          // 这道题在标准答案里已经拆好了：小题给结果、大题给完整过程
          const split = splitAnswer(item.answer);
          // 判分时模型给的「丢分点 / 该怎么改」直接进笔记 —— 错题本要的就是这个。
          // 易错提醒 = 该怎么改 + 判分丢分点；没有就用界面上填的。
          const lost = String(one.lost || '').trim();
          const fix = String(one.fix || '').trim();
          const pitfall = pick(one.pitfall, [fix, lost && `判分丢分点：${lost}`].filter(Boolean).join('\n'));
          toWrite.push({
            ...first,
            category: pick(one.category, first.category),
            subject: pick(one.subject, first.subject),
            chapter: pick(one.chapter, first.chapter),
            stem: item.body,
            // 文件名用测试里的「考点」来起，别用从题干前几个字截出来的碎片
            slug: pick(one.slug, item.topic || item.type || '今日测试'),
            title: pick(one.title, item.topic || item.type || ''),
            type: pick(one.type, first.type || item.type || '解答题'),
            difficulty: pick(Number(one.difficulty), 3),
            heat: pick(Number(one.heat), 3),
            points: points.length ? points : first.points || [],
            // 错因：判分时模型从固定词表里选的那个（界面也可以改）；没有就留待补充
            reason: book === 'mistakes' ? pick(one.reason, '') : undefined,
            keyPoints: pick(one.keyPoints, item.topic ? `本题考点：${item.topic}` : ''),
            answer: split.answer,
            analysis: split.analysis,
            pitfall,
          });
        }
        if (!toWrite.length) {
          sendJson(res, 404, { error: missing.length ? `第 ${missing.join('、')} 题不在这份测试里` : '没有要加入的题' });
          return;
        }
        const created = addQuestions(cfg, toWrite, book);
        sendJson(res, 200, { ok: true, book, created, missing });
        return;
      }

      /**
       * 把英语选择题的本地判卷结果记一笔（我在页面上直接点选项，程序自己对答案）。
       * body: { rel, answers: { 1:'A', 2:'C' }, seconds }
       * 分数由**服务端按卷子自己的分值重算**，不信页面报上来的分。
       */
      if (p === '/api/grade/local' && req.method === 'POST') {
        const body = await readBody(req);
        const paper = gradePaperFor(cfg, 'story', String(body.rel || ''));
        const g = gradePaper(paper);
        if (!g.count) {
          sendJson(res, 400, { error: '这一篇里没解析出题目' });
          return;
        }
        const answers = body.answers && typeof body.answers === 'object' ? body.answers : {};
        const items = (paper.questions || []).map((q) => {
          const right = paper.key[String(q.n)] || '';
          const mine = String(answers[q.n] || '').trim().toUpperCase();
          const full = g.table.byN[q.n];
          const ok = !!right && mine === right;
          return {
            n: q.n,
            score: ok ? full : 0,
            full,
            verdict: !mine ? '未作答' : ok ? '正确' : '错误',
            reason: '',
            got: mine,
            lost: ok ? '无' : right ? `选了 ${mine}，正确答案是 ${right}` : '这份卷子没给答案速查',
            fix: '',
          };
        });
        const total = items.reduce((s, r) => s + r.score, 0);
        const right = items.filter((r) => r.verdict === '正确').length;
        const attempt = {
          index: nextGradeIndex(paper.grades),
          date: today(),
          total,
          full: g.table.full,
          seconds: Math.max(0, Number(body.seconds) || 0),
          refSeconds: g.ref.seconds,
          images: 0,
          source: 'local',
          withReason: false,
          items,
          summary: `客观题本地判卷：答对 ${right} 题、答错 ${items.length - right - items.filter((r) => r.verdict === '未作答').length} 题、未作答 ${items.filter((r) => r.verdict === '未作答').length} 题。`,
          weak: [],
          next: [],
        };
        writeGradeToPaper(cfg, paper, attempt);
        sendJson(res, 200, {
          ok: true,
          rel: paper.rel,
          attempt,
          grades: gradePaperFor(cfg, 'story', paper.rel).grades,
        });
        return;
      }

      /**
       * 上传手写答案 → 内置 AI 按考研标准打分。**只给数学 / 408 的今日测试用**：
       * 英语那些题全是选择题，程序对着「答案速查」自己判就完事了（见 /api/grade/local），
       * 又快又准，没必要让模型去认手写字母。
       * body: { rel, names: [图片名], seconds }
       * 走 NDJSON 流（一行一个 JSON），前端边收边显示进度。
       */
      if (p === '/api/grade' && req.method === 'POST') {
        const body = await readBody(req, 2 * 1024 * 1024);
        const st = aiStatus(cfg);
        if (!st.ready) {
          sendJson(res, 400, { error: st.needsKey ? '还没填 API key' : '还没配置 AI 接口地址和模型' });
          return;
        }
        if (body.kind === 'story') {
          sendJson(res, 400, { error: '英语题目全是选择题，程序本地就判了 —— 点「对答案」即可，不用拍照' });
          return;
        }
        const names = cleanImageNames(body.names);
        if (!names.length) {
          sendJson(res, 400, { error: '先上传手写答案的图片（可以多张）' });
          return;
        }

        let paper;
        let images;
        try {
          paper = gradePaperFor(cfg, 'test', String(body.rel || ''));
          if (!(paper.items || []).length) throw Object.assign(new Error('这份卷子里没解析出题目'), { status: 400 });
          images = names.map((n) => uploadToDataUrl(cfg, n).url);
        } catch (err) {
          sendJson(res, err.status || 400, { error: String(err.message || err) });
          return;
        }

        const g = gradePaper(paper);
        const seconds = Math.max(0, Number(body.seconds) || 0);
        const date = today();
        const built = gradePrompt(paper, { images: names.length, seconds, date });

        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Accel-Buffering': 'no',
        });
        const send = (obj) => {
          try {
            res.write(`${JSON.stringify(obj)}\n`);
          } catch {
            /* 客户端断了 */
          }
        };
        const ac = new AbortController();
        let closed = false;
        req.on('close', () => {
          closed = true;
          ac.abort();
        });

        send({ t: 'start', images: names.length, full: g.table.full, count: g.count, refSeconds: g.ref.seconds });
        try {
          let chars = 0;
          let thinkChars = 0;
          let lastTick = 0;
          const text = await chat(cfg, {
            system: AI_SYSTEM,
            user: built.prompt,
            json: true,
            // 判分要按采分点抠，值得多想一会儿
            reasoning: 'high',
            images,
            signal: ac.signal,
            onDelta: (d, k, thinkTotal) => {
              if (k === 'reasoning') thinkChars = thinkTotal || 0;
              else chars += d.length;
              const now = Date.now();
              if (now - lastTick > 220) {
                lastTick = now;
                send({ t: 'delta', chars, think: thinkChars });
              }
            },
          });
          if (closed) return;

          // 整份信封（items + 总评 / 薄弱点 / 下一步）一起交给判分 ——
          // 只要 items 的话，模型写的总评和薄弱点会被直接丢掉，成绩单上永远是空的
          const envelope = parseItemsEnvelopeEx(text);
          if (!envelope.envelope) throw new Error('模型没有按 JSON 格式返回，这次没判成（成绩没写盘）');
          const result = normalizeGrade(envelope.envelope, g.table);
          const attempt = {
            index: nextGradeIndex(paper.grades),
            date,
            total: result.total,
            full: result.full,
            seconds,
            refSeconds: g.ref.seconds,
            images: names.length,
            source: 'ai',
            withReason: true, // 今日测试的错题要进错题本，错因那一列有用
            items: result.items,
            summary: result.summary,
            weak: result.weak,
            next: result.next,
            meta: paper.meta || {},
            model: st.model,
          };
          writeGradeToPaper(cfg, paper, attempt);

          // 判完就把暂存图片清掉 —— 成绩已经落盘，没必要一直占着 uploads/
          try {
            deleteUploads(cfg, names);
          } catch {
            /* 删不掉也不影响判分结果 */
          }

          const fresh = readTest(cfg, paper.rel);
          send({ t: 'done', result: { ...result, attempt }, rel: paper.rel, grades: fresh.grades || [] });
          res.end();
        } catch (err) {
          if (closed) return;
          send({ t: 'error', message: String(err.message || err) });
          res.end();
        }
        return;
      }

      /* ---- 删除：生成的试卷 / 单词题 / 题库里的题 ---- */
      // 都走「先备份再删」，删错了还能从 backups/ 捞回来
      if (p === '/api/test' && req.method === 'DELETE') {
        const body = await readBody(req);
        const rel = String(body.rel || '');
        const out = deleteVaultFile(cfg, rel, cfg.testDir, '测试');
        sendJson(res, 200, { ...out, tests: listTests(cfg) });
        return;
      }

      if (p === '/api/words/story' && req.method === 'DELETE') {
        const body = await readBody(req);
        const rel = String(body.rel || '');
        const out = deleteVaultFile(cfg, rel, cfg.storyDir, '题目');
        sendJson(res, 200, { ...out, stories: listStories(cfg) });
        return;
      }

      if (p === '/api/question' && req.method === 'DELETE') {
        const body = await readBody(req);
        const snap = snapshot(cfg);
        const found = snap.problems.find((x) => x.id === body.id || x.relPath === body.id);
        if (!found) {
          sendJson(res, 404, { error: '找不到这道题' });
          return;
        }
        const out = deleteVaultFile(cfg, found.vaultRel, null, '题目', found.absPath);
        // 题库变了，缓存立刻失效
        snapshot(cfg, { force: true });
        sendJson(res, 200, { ok: true, ...out });
        return;
      }

      /** 更新墨墨 token（写进 study-app/.maimemo-token，不入库） */
      if (p === '/api/words/token' && req.method === 'POST') {
        const body = await readBody(req);
        const file = writeToken(body.token);
        clearMaimemoCache();
        sendJson(res, 200, { ok: true, file, hasToken: true });
        return;
      }

      if (p === '/api/weekly' && req.method === 'GET') {
        sendJson(res, 200, buildWeekly(cfg, snapshot(cfg).stats));
        return;
      }

      if (p === '/api/raw' && req.method === 'GET') {
        sendJson(res, 200, readRaw(cfg, url.searchParams.get('rel')));
        return;
      }

      /* 笔记里的 ![[图片]]：只读、只允许白名单目录里的图片后缀 */
      if (p === '/api/asset' && req.method === 'GET') {
        const asset = readAsset(cfg, url.searchParams.get('rel'));
        const st = fs.statSync(asset.abs);
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(asset.abs).toLowerCase()] || 'application/octet-stream',
          'Content-Length': st.size,
          'Cache-Control': 'no-cache',
        });
        fs.createReadStream(asset.abs).pipe(res);
        return;
      }

      /* 把 Obsidian 双链 [[笔记名]] 解析成程序里能打开的路径 */
      if (p === '/api/note' && req.method === 'GET') {
        sendJson(res, 200, resolveNote(cfg, url.searchParams.get('name')));
        return;
      }

      if (p === '/api/patterns' && req.method === 'GET') {
        const out = patternsSnapshot(cfg);
        sendJson(res, 200, {
          dir: out.dir,
          tree: out.tree,
          unlinkedCount: out.unlinked.length,
          patterns: out.patterns.map((x) => ({
            id: x.id, rel: x.rel, title: x.title, category: x.category, subject: x.subject, chapter: x.chapter,
            type: x.type, difficulty: x.difficulty, heat: x.heat, linkedCount: x.linkedCount,
            mastery: x.mastery, linkedRate: x.linkedRate, failCount: x.failCount,
            features: x.features, steps: x.steps, pitfalls: x.pitfalls, related: x.related, missing: x.missing,
          })),
        });
        return;
      }

      if (p === '/api/pattern-prompt' && req.method === 'GET') {
        sendJson(res, 200, patternPrompt(cfg));
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
        // analysis / setFirstReason：单题拍照判分之后，把 AI 写的错因分析一起记进去
        const out = checkin(cfg, body.id, body.result, body.date, body.seconds, body.reason, {
          analysis: body.analysis,
          setFirstReason: !!body.setFirstReason,
        });
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

      if (p === '/api/checkin-slots' && req.method === 'POST') {
        const body = await readBody(req);
        sendJson(res, 200, topUpCheckins(cfg, body.id));
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

  // 一键生成长文可能要跑几分钟；本地自用，别让 Node 的默认 5 分钟超时把请求掐了
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n✗ 端口 ${port} 已被占用。换一个：node server.mjs --port ${port + 1}\n`);
    } else {
      console.error('\n✗ 服务启动失败：', err.message, '\n');
    }
    process.exit(1);
  });

  /* ============================================================
     手机访问开关

     本机监听（127.0.0.1）**永远在** —— 电脑端和跑测试都不受这个开关影响，
     也不存在「手机上一关就把自己也关掉了、只能去终端救」这种事。
     局域网是另一个监听：开 = listen，关 = close，**关掉是真的不听这个端口**。
     ============================================================ */
  const lan = { on: false, srv: null, error: null };

  /** 手机要输的地址（同一 Wi-Fi 下） */
  const lanUrls = () => lanAddresses().map((ip) => `http://${ip}:${port}/m`);

  /** 开关的当前状态（设置页要用；地址是现算的，换了 Wi-Fi 也不怕） */
  const lanState = () => ({
    on: lan.on,
    port,
    addresses: lanAddresses(),
    urls: lanUrls(),
    error: lan.error,
    configFile: configPath(),
  });

  /**
   * 开关状态写回 config.json。
   * **只改这一行**（不整份重写）：你那上面写了注释、留了排版，别因为拨个开关就没了。
   * 写完先自检一遍是不是合法 JSON（校验时按 loadConfig 的规矩把 `//` 注释行去掉），
   * 不合法就报错、不落盘 —— 宁可这次没记住，也不能把你配置文件写坏。
   */
  function lanSave(on) {
    const file = configPath();
    try {
      if (!fs.existsSync(file)) {
        fs.writeFileSync(file, `{\n  "lanAccess": ${!!on}\n}\n`, 'utf8');
        return { ok: true };
      }
      const text = fs.readFileSync(file, 'utf8');
      let next;
      if (/("lanAccess"\s*:\s*)(true|false)/.test(text)) {
        next = text.replace(/("lanAccess"\s*:\s*)(true|false)/, `$1${!!on}`);
      } else {
        const i = text.lastIndexOf('}');
        if (i < 0) throw new Error('config.json 里找不到结尾的 }');
        const head = text.slice(0, i).replace(/[\s,]+$/, '');
        next = `${head},\n  "lanAccess": ${!!on}\n${text.slice(i)}`;
      }
      // 顺手把老的 host:0.0.0.0 写法收干净，免得两套说法打架
      next = next.replace(/("host"\s*:\s*)"0\.0\.0\.0"/, '$1"127.0.0.1"');
      JSON.parse(next.replace(/^\s*\/\/.*$/gm, '')); // 自检
      fs.writeFileSync(file, next, 'utf8');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  }

  /** 打开局域网监听。等 listen 真的成功（或失败）再 resolve，调用方才能如实回话 */
  function lanStart() {
    if (lan.srv) return Promise.resolve();
    return new Promise((resolve) => {
      // 复用同一套处理逻辑：把 request 事件转给主服务，行为一字不差
      const srv = http.createServer((req, res) => server.emit('request', req, res));
      // 判分那种长请求别被 Node 的超时掐了 —— 和主监听同一个规矩
      srv.requestTimeout = 0;
      srv.headersTimeout = 60_000;
      srv.once('error', (err) => {
        lan.error = err.code === 'EADDRINUSE' ? `端口 ${port} 被别的程序占了` : String(err.message || err);
        lan.on = false;
        lan.srv = null;
        resolve();
      });
      srv.listen(port, '0.0.0.0', () => {
        lan.srv = srv;
        lan.on = true;
        lan.error = null;
        resolve();
      });
    });
  }

  function lanStop() {
    const srv = lan.srv;
    lan.srv = null;
    lan.on = false;
    if (!srv) return;
    // 光 close() 只是不再接新连接，已经连上的还活着 —— 既然是个安全开关，就得真断
    try {
      srv.closeAllConnections();
    } catch {
      /* 老 Node 没有就算了 */
    }
    srv.close();
  }

  const lanBindHost = args.host || cfg.host || '127.0.0.1';

  /** 启动时把手机访问的状态说清楚。want 是「打算开还是关」——
   *  局域网监听是异步起的，这里先按打算打印，起不来再补一行（不然这几行会跑到
   *  「按 Ctrl+C 退出」后面去，看着像没生效）。 */
  function printLan(want) {
    if (!want) {
      console.log('  📱 手机访问  已关闭（局域网连不上）。想在手机上做题：设置页打开「📱 手机访问」');
      return;
    }
    const urls = lanUrls();
    if (!urls.length) {
      console.log('  📱 手机访问  要打开，但没找到局域网 IP —— 先确认电脑连着 Wi-Fi / 网线');
      return;
    }
    console.log(`  📱 手机访问  已打开  ${urls[0]}`);
    for (const u of urls.slice(1)) console.log(`                       ${u}`);
    console.log('               （手机连同一个 Wi-Fi，地址栏输上面那条）');
    console.log('               ⚠️ 局域网里任何人都能打开、也能改你的笔记');
  }

  server.listen(port, lanBindHost, () => {
    const url = `http://${lanBindHost === '0.0.0.0' ? '127.0.0.1' : lanBindHost}:${port}`;
    const snap = snapshot(cfg, { force: true });
    // 开关初值：命令行 --lan / --local 优先，其次 config.json 的 lanAccess
    const lanWant = args.host ? args.host === '0.0.0.0' : !!cfg.lanAccess;
    console.log('');
    console.log('  📕 错题本');
    console.log(`  ${url}`);
    console.log('');
    printLan(lanWant);
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

    // 局域网监听是异步起的：真起不来（端口被占之类）再补一行，别让人以为开着
    if (lanWant) {
      lanStart().then(() => {
        if (!lan.on) console.log(`  ⚠ 手机访问没打开：${lan.error || '未知原因'}\n`);
      });
    }

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
