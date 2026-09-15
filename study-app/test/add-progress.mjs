/**
 * test/add-progress.mjs —— 「增题有没有进度、失败看不看得见」的回归测试
 *
 * 起因：增题页从来没挂过 AI 进度面板（只有「单词」和「今日测试」两页挂了）。
 * 粘完题干点「生成并写入」，请求发出去、界面一个字都不变，模型要跑两三分钟，
 * 看着就跟点坏了没区别；失败也只弹一句「看看下面的进度」，而下面根本没有进度可看。
 * 所以这个测试盯着三件事：
 *
 *   1. 点下去之后，增题页上得出现进度条，而且百分比要往前走
 *   2. 跑完得变「成功」，并且笔记真的落到盘上
 *   3. 模型返回垃圾时，失败原因要写在页面上，不能只留一句含糊的提示
 *
 * 全程不碰真笔记：仓库副本 + 假模型服务 + 无头 Edge。
 *
 *   node test/add-progress.mjs
 *   KEEP=1 node test/add-progress.mjs   跑完不删现场（方便手动看）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = process.env.EDGE_BIN || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const KEEP = process.env.KEEP === '1';
const PORT = Number(process.env.ADD_TEST_PORT || 4322);
const CDP = Number(process.env.ADD_TEST_CDP || 9335);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok });
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? `　— ${detail}` : ''}`);
};

/* ---------- 1. 假模型服务：慢慢吐，好让我们看见进度条在动 ---------- */
let mode = 'ok'; // ok | garbage | latex | hang
let sawMultimodal = false;

/** 真实翻车姿势：模型写 LaTeX 时漏了转义（`\lim` 而不是 `\\lim`），整份 JSON 就是坏的 */
const LATEX_ITEM = String.raw`{"items":[{"n":1,"title":"漏转义的题","type":"计算题","difficulty":3,"heat":4,"points":["等价无穷小"],"keyPoints":"考点：泰勒展开阶数要够。","answer":"解：$\lim_{x\to 0}\frac{\sin x}{x}=1$","analysis":"解析：用 $\frac{1}{2}$ 说明。","pitfall":"易错：展开阶数不够。"}]}`;

const item = (n) =>
  JSON.stringify({
    items: [
      {
        n: 1,
        title: `假题解 ${n}`,
        type: '计算题',
        difficulty: 3,
        heat: 4,
        points: ['等价无穷小'],
        keyPoints: '考点：泰勒展开的阶数要够。',
        answer: '解：第 1 题的标准过程。',
        analysis: '解析：第 1 题为什么这么做。',
        pitfall: '易错：展开阶数不够。',
      },
    ],
  });

const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const payload = JSON.parse(body || '{}');
    const raw = payload.messages?.at(-1)?.content;
    sawMultimodal = Array.isArray(raw) ? raw.some((c) => c.type === 'image_url') : false;
    const user = Array.isArray(raw)
      ? raw.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
      : String(raw || '');

    // 假模型服务本身不关心是哪一种任务：一律慢慢回一段
    const text =
      mode === 'garbage'
        ? '这不是 JSON，我随便写点东西。'
        : mode === 'latex'
          ? LATEX_ITEM
          : item(1);
    const chunks = text.match(/[\s\S]{1,60}/g) || [];

    if (!payload.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    if (mode === 'hang') {
      // 一直不吐正文：验证「已连上模型，等它开口…」能显示出来
      setTimeout(() => {
        res.write('data: [DONE]\n\n');
        res.end();
      }, 60000);
      return;
    }
    let i = 0;
    const tick = () => {
      if (i >= chunks.length) {
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      // 每 120ms 吐一段 —— 总共几秒，足够在前端看见进度条往前走
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i++] } }] })}\n\n`);
      setTimeout(tick, 120);
    };
    tick();
  });
});

await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const MOCK = `http://127.0.0.1:${mock.address().port}/v1`;

/* ---------- 2. 仓库副本 + 真服务 ---------- */
const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'add-progress-'));
fs.mkdirSync(path.join(RUN, 'vault', '错题本'), { recursive: true });
// 复制真的错题本？不必要：增题只需要一个能写进去的目录
const srv = spawn(process.execPath, [path.join(APP_DIR, 'server.mjs'), '--no-open', '--port', String(PORT)], {
  cwd: APP_DIR,
  env: {
    ...process.env,
    VAULT_DIR: path.join(RUN, 'vault'),
    BACKUP_DIR: path.join(RUN, 'backups'),
    EXPORT_DIR: path.join(RUN, 'data'),
    UPLOAD_DIR: path.join(RUN, 'uploads'),
    MAIMEMO_OFF: '1',
    AI_BASE_URL: MOCK,
    AI_API_KEY: 'fake-key-for-test',
    AI_MODEL: 'fake-model',
    AI_CONFIG_FILE: path.join(RUN, 'ai-config.json'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', () => {});
srv.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

const edge = spawn(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--remote-allow-origins=*',
    `--remote-debugging-port=${CDP}`,
    `--user-data-dir=${path.join(RUN, 'edge')}`,
    '--window-size=1400,1000',
    `http://127.0.0.1:${PORT}/`,
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] }
);
edge.stderr.on('data', () => {});

const cleanup = () => {
  for (const p of [srv, edge]) {
    try {
      p.kill();
    } catch {
      /* 已经没了 */
    }
  }
  try {
    mock.close();
  } catch {
    /* 已经关了 */
  }
  if (!KEEP) {
    // 浏览器刚被杀掉时 profile 目录还在写，删不掉是正常的，别为这个把测试判失败
    try {
      fs.rmSync(RUN, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch {
      /* 残留的临时目录交给系统清 */
    }
  } else console.log(`\n现场留着：${RUN}`);
};
process.on('exit', cleanup);

/* ---------- 3. 连上无头 Edge ---------- */
class Session {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      const slot = this.pending.get(msg.id);
      if (slot) {
        this.pending.delete(msg.id);
        msg.error ? slot.reject(new Error(JSON.stringify(msg.error))) : slot.resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} 超时`));
        }
      }, 20000);
    });
  }
  async js(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(function(){ ${expr} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || '页面脚本报错');
    return r.result.value;
  }
  async waitFor(expr, timeout = 10000, label = '') {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < timeout) {
      last = await this.js(expr);
      if (last) return last;
      await sleep(120);
    }
    throw new Error(`等不到：${label || expr}（最后的值 ${JSON.stringify(last)}）`);
  }
}

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        // 必须等 open 再发，不然调试通道会直接报「Sent before connected」
        await new Promise((res, rej) => {
          ws.addEventListener('open', res);
          ws.addEventListener('error', rej);
        });
        return new Session(ws);
      }
    } catch {
      /* 等浏览器起来 */
    }
    await sleep(500);
  }
  throw new Error('连不上无头 Edge 的调试端口');
}

let up = false;
for (let i = 0; i < 40; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) {
      up = true;
      break;
    }
  } catch {
    /* 还没起来 */
  }
  await sleep(250);
}
if (!up) {
  console.error('✗ 服务没起来');
  process.exit(1);
}

const s = await connect();
await s.send('Page.enable');
await sleep(1200);

console.log('\n=== 增题进度条（真界面 + 假模型）===\n');

const goAdd = async () => {
  await s.js(`location.hash='#mistakes/add';`);
  await s.waitFor(`return !!document.getElementById('addStem');`, 10000, '增题页文本框');
};

/* ---------- 4. 成功路径 ---------- */
await goAdd();
check(
  '增题页：配了 AI 时，按钮是「生成并写入错题本」',
  await s.js(
    `var b=document.querySelector('.rv-start-row button'); return !!b && b.dataset.airun==='add';`
  )
);
check(
  '增题页：还没点之前不该有进度面板',
  (await s.js(`return document.querySelectorAll('.ai-run').length;`)) === 0
);

await s.js(
  `var t=document.getElementById('addStem');
   t.value='计算 $\\\\lim_{x\\\\to 0}\\\\dfrac{\\\\tan x - x}{x^{3}}$';
   t.dispatchEvent(new Event('input',{bubbles:true}));`
);
await s.js(`document.querySelector('[data-add="parse"]').click();`);
await s.waitFor(`return document.querySelectorAll('.add-item').length===1;`, 10000, '识别结果');

/* ---------- 3.5 敲进去的东西不能被重绘冲掉 ---------- */
// 文本框里的题干、识别结果里手改的字段，以前只在写盘那一刻才从 DOM 里读；
// 中间任何一次重绘（换分题方式、切页回来、传图）都会拿 state 里的旧值重建输入框。
await s.js(`document.querySelector('[data-add-mode="blank"]').click();`);
await sleep(1000);
const keptStem = await s.js(`return document.getElementById('addStem')?.value || '';`);
check(
  '增题：换个分题方式（会整页重绘）不会把粘好的题干冲掉',
  keptStem.includes('tan x - x'),
  keptStem.slice(0, 40) || '(空)'
);
await s.js(`document.querySelector('[data-add-mode="rule"]').click();`);
// 换分题方式会重新识别一次（异步）：等这一轮真的画出来再改字段，
// 不然我改的是马上要被替换掉的旧节点，改了什么都没意义
await sleep(1800);
await s.waitFor(`return document.querySelectorAll('.add-item').length===1;`, 10000, '识别结果回来了');
await s.js(
  `var n=document.querySelector('.add-item [data-field="slug"]');
   n.value='E2E改过的短标题';
   n.dispatchEvent(new Event('input',{bubbles:true}));`
);
const slugNow = await s.js(`return document.querySelector('.add-item [data-field="slug"]')?.value || '';`);
check('增题：短标题输入框能改（预备验证它经得起重绘）', slugNow === 'E2E改过的短标题', slugNow || '(空)');
await s.js(`document.querySelector('.subtab[data-sub="dashboard"]').click();`);
await sleep(700);
await s.js(`document.querySelector('.subtab[data-sub="add"]').click();`);
await s.waitFor(`return !!document.querySelector('.add-item');`, 10000, '识别结果回来了（切页后）');
await sleep(900);
const keptSlug = await s.js(`return document.querySelector('.add-item [data-field="slug"]')?.value || '';`);
check('增题：手改的短标题经得起重绘（切页回来还在）', keptSlug === 'E2E改过的短标题', keptSlug || '(空)');

sawMultimodal = false;
await s.js(`document.querySelector('[data-airun="add"]').click();`);

// 面板得出现，而且得是「在跑」的样子
await s.waitFor(`return !!document.querySelector('.ai-run');`, 8000, '进度面板出现');
const atStart = await s.js(
  `var r=document.querySelector('.ai-run');
   return { state:r.dataset.airState, hasBar:!!r.querySelector('.air-bar > i'),
            pct:r.querySelector('.air-pct')?.textContent||'',
            head:r.querySelector('.air-head b')?.textContent||'',
            abort:!!r.querySelector('[data-air="abort"]') };`
);
check(
  '增题：一点下去增题页就出现进度条（以前这里什么都没有）',
  atStart.hasBar && atStart.state === 'running',
  `state=${atStart.state} · ${atStart.pct} · ${atStart.head}`
);
check('增题：进度面板上有中断按钮', atStart.abort === true);

// 百分比要往前走 —— 这是「没反应」和「在跑」的分界线
const widths = [];
for (let i = 0; i < 12; i++) {
  widths.push(
    await s.js(
      `var i=document.querySelector('.air-bar > i'); return i ? parseFloat(i.style.width)||0 : -1;`
    )
  );
  await sleep(250);
  if (await s.js(`return document.querySelector('.ai-run')?.dataset.airState !== 'running';`)) break;
}
check(
  '增题：进度条百分比确实在往前走',
  widths.some((w) => w > 0),
  widths.map((w) => `${w}%`).join(' → ')
);

// 跑完：状态变 done，行上有结果，笔记真的写下了
const ended = await s.waitFor(
  `var r=document.querySelector('.ai-run');
   if(!r || r.dataset.airState==='running') return null;
   return { state:r.dataset.airState, head:r.querySelector('.air-head b')?.textContent||'',
            pct:r.querySelector('.air-pct')?.textContent||'',
            rows:[...r.querySelectorAll('.air-list li')].map(x=>x.className),
            rights:[...r.querySelectorAll('.air-list li .air-right')].map(x=>x.textContent) };`,
  40000,
  '生成结束'
);
check(
  '增题：跑完进度面板变「成功」状态',
  ended.state === 'done' && ended.head.includes('生成完成'),
  `${ended.head} · ${ended.pct} · ${ended.rows.join('/')}`
);
check(
  '增题：那道题一行显示「已写入 N 篇」',
  ended.rows.some((c) => c.includes('is-done')) && ended.rights.some((t) => t.includes('已写入')),
  ended.rights.join(' | ')
);

const files = fs.existsSync(path.join(RUN, 'vault', '错题本'))
  ? fs.readdirSync(path.join(RUN, 'vault', '错题本'), { recursive: true }).filter((f) => String(f).endsWith('.md'))
  : [];
check('增题：笔记真的落到盘上了', files.length >= 1, files.join('、') || '一个文件都没有');

/* ---------- 4.5 跑完的结果不许飘到别的生成页去 ---------- */
// 真实反馈：在错题页增完题，切到别的生成页，那条「错题生成成功」还挂在那儿，
// 像是这一页生成出来的东西。
await s.js(`location.hash='#good/add';`);
await s.waitFor(`return !!document.getElementById('addStem');`, 10000, '好题本增题页');
await sleep(600);
const leakGood = await s.js(`return document.querySelectorAll('.ai-run').length;`);
check(
  '结果不飘页：好题本的增题页上看不到「错题本生成成功」那条面板',
  leakGood === 0,
  `${leakGood} 个面板`
);

await s.js(`location.hash='#today';`);
const weeklyUp = await s
  .waitFor(`return !!document.querySelector('.weekly') || !!document.querySelector('.ai-run');`, 12000, '今日页')
  .catch(() => null);
if (weeklyUp) {
  const leakToday = await s.js(`return document.querySelectorAll('.ai-run').length;`);
  check('结果不飘页：今日页（生成本周总结那一块）也看不到错题那条面板', leakToday === 0, `${leakToday} 个面板`);
}

await goAdd();
await sleep(800);
const backPanel = await s.js(
  `var r=document.querySelector('.ai-run'); return r ? r.dataset.airState : 'NONE';`
);
check(
  '转一圈回到错题增题页，那条结果还在（失败原因还能回看）',
  backPanel !== 'NONE',
  backPanel
);

/* ---------- 5. 失败路径：模型回垃圾，原因得写在页面上 ---------- */
mode = 'garbage';
await goAdd();
await s.js(
  `var t=document.getElementById('addStem');
   t.value='再算一道 $\\\\int_0^1 x\\\\,dx$';
   t.dispatchEvent(new Event('input',{bubbles:true}));`
);
await s.js(`document.querySelector('[data-add="parse"]').click();`);
await s.waitFor(`return document.querySelectorAll('.add-item').length===1;`, 10000, '识别结果 2');
await s.js(`document.querySelector('[data-airun="add"]').click();`);
const bad = await s.waitFor(
  `var r=document.querySelector('.ai-run');
   if(!r || r.dataset.airState==='running') return null;
   var row=r.querySelector('.air-list li');
   return { state:r.dataset.airState, head:r.querySelector('.air-head b')?.textContent||'',
            cls:row?.className||'', right:row?.querySelector('.air-right')?.textContent||'',
            text:r.innerText };`,
  40000,
  '失败结束'
);
check(
  '增题失败：进度面板变红（failed），失败原因写在那一行上',
  bad.state === 'failed' && bad.cls.includes('is-err') && bad.right.includes('失败'),
  `${bad.head} · ${bad.right}`
);
check(
  '增题失败：页面上看得到具体的失败原因，不是一句「看看下面的进度」',
  bad.text.includes('模型没有按 JSON 格式返回'),
  bad.right
);

/* ---------- 5.5 真实翻车姿势：模型漏转义 LaTeX —— 整批题必须还能写进去 ---------- */
mode = 'latex';
const filesBeforeLatex = () => {
  const dir = path.join(RUN, 'vault', '错题本');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.md'));
};
const beforeLatex = filesBeforeLatex();
await goAdd();
await s.js(
  `var t=document.getElementById('addStem');
   t.value='计算 $\\\\lim\\\\limits_{x\\\\to 0}\\\\dfrac{\\\\sin x}{x}$';
   t.dispatchEvent(new Event('input',{bubbles:true}));`
);
await s.js(`document.querySelector('[data-add="parse"]').click();`);
await s.waitFor(`return document.querySelectorAll('.add-item').length===1;`, 10000, '识别结果 latex');
await s.js(`document.querySelector('[data-airun="add"]').click();`);
const latexDone = await s.waitFor(
  `var r=document.querySelector('.ai-run');
   if(!r || !r.querySelector('[data-air="close"]')) return null;
   return { state:r.dataset.airState, text:r.innerText,
            warn:r.querySelector('.air-warn')?.textContent||'' };`,
  40000,
  '漏转义的 JSON 也能落盘'
);
check(
  '增题：模型漏转义 LaTeX 时不再整批失败（JSON 修好后就写进去了）',
  latexDone.state === 'done' && latexDone.text.includes('已写入'),
  `${latexDone.state} · ${latexDone.warn || latexDone.text.split('\n').slice(0, 4).join(' / ')}`
);
check(
  '增题：修过 JSON 要如实提醒一声，不闷声写一份可能不对的笔记',
  latexDone.warn.includes('格式毛病') || latexDone.warn.includes('没转义'),
  latexDone.warn || '(没有提醒)'
);
const afterLatex = filesBeforeLatex().filter((f) => !beforeLatex.includes(f));
const latexNote = afterLatex.length
  ? fs.readFileSync(path.join(RUN, 'vault', '错题本', afterLatex[0]), 'utf8')
  : '';
// 三个都要盯：原样带单个反斜杠（没被吃掉）／没有控制字符（换页、退格、回车）／没有被多补一个反斜杠
const exactLatex = latexNote.includes(String.raw`\lim_{x\to 0}\frac{\sin x}{x}=1`);
const hasCtrl = /[\u0008\u000b\u000c\u000d]/.test(latexNote);
const overEscaped = /\\{2}/.test(latexNote);
check(
  '增题：修完后 LaTeX 一个字符都没被改坏（\\frac 没变成换页符、\\to 没变成制表符）',
  exactLatex && !hasCtrl && !overEscaped,
  `${afterLatex.join('、') || '没有新文件'} · 原样=${exactLatex} · 控制字符=${hasCtrl} · 多补反斜杠=${overEscaped}`
);

/* ---------- 6. 中断 ---------- */
mode = 'hang';
await goAdd();
await s.js(
  `var t=document.getElementById('addStem');
   t.value='第三道 $\\\\lim_{x\\\\to\\\\infty}\\\\frac{1}{x}$';
   t.dispatchEvent(new Event('input',{bubbles:true}));`
);
await s.js(`document.querySelector('[data-add="parse"]').click();`);
await s.waitFor(`return document.querySelectorAll('.add-item').length===1;`, 10000, '识别结果 3');
await s.js(`document.querySelector('[data-airun="add"]').click();`);
await s.waitFor(
  `return !!document.querySelector('.ai-run[data-air-state="running"] .air-list li.is-doing');`,
  8000,
  '面板进入「这一道正在跑」'
);
const waiting = await s.js(
  `return document.querySelector('.ai-run .air-list li.is-doing .air-right')?.textContent||'';`
);
check(
  '增题：模型一个字还没吐时，面板也要说话（不是干等）',
  waiting.includes('等它开口') || waiting.includes('思考中') || waiting.includes('生成中'),
  waiting
);

const beforeAbort = await s.js(
  `return { panels:document.querySelectorAll('.ai-run').length,
            states:[...document.querySelectorAll('.ai-run')].map(x=>x.dataset.airState),
            abort:document.querySelectorAll('[data-air="abort"]').length };`
);
check(
  '增题：页面上只有一个进度面板，中断按钮就在上面',
  beforeAbort.panels === 1 && beforeAbort.abort === 1,
  JSON.stringify(beforeAbort)
);
await s.js(`document.querySelector('[data-air="abort"]').click();`);
// 点下去要立刻变成「正在中断…」，不能等流断完才给反应
const midAbort = await s.js(
  `var r=document.querySelector('.ai-run'); return r ? r.querySelector('.air-head b')?.textContent||'' : '';`
);
check('增题中断：点了马上有反应（正在中断…）', midAbort.includes('中断'), midAbort);
const stopped = await s.waitFor(
  `var r=document.querySelector('.ai-run');
   if(!r || !r.querySelector('[data-air="close"]')) return null;   // 等它彻底停下来
   return { state:r.dataset.airState, text:r.innerText, closing:true,
            panels:document.querySelectorAll('.ai-run').length,
            states:[...document.querySelectorAll('.ai-run')].map(x=>x.dataset.airState),
            head:r.querySelector('.air-head b')?.textContent||'' };`,
  20000,
  '中断生效'
);
check(
  '增题中断：点了「中断」就停下来，并把「已中断」写在面板上',
  stopped.state === 'failed' && stopped.text.includes('已中断') && stopped.closing,
  `state=${stopped.state} · head=${stopped.head} · panels=${stopped.panels}/${JSON.stringify(stopped.states)} · ${stopped.text
    .split('\n')
    .slice(0, 3)
    .join(' / ')}`
);

/* ---------- 7. 收起 ---------- */
await s.js(`document.querySelector('[data-air="close"]').click();`);
await sleep(500);
check(
  '增题：结束后的面板能收起',
  (await s.js(`return document.querySelectorAll('.ai-run').length;`)) === 0
);

/* ---------- 收尾 ---------- */
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} / ${results.length} 项通过`);
if (failed.length) {
  console.log('没过的是：');
  for (const f of failed) console.log(`  ✗ ${f.label}`);
  process.exit(1);
}
console.log('增题进度条：全过 🎉');
