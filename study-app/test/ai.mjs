/**
 * test/ai.mjs —— 内置 AI 的集成测试（**不需要真的 API key**）
 *
 * 起一个假的「OpenAI 兼容」模型服务，让真的 server.mjs 去打它，
 * 验证整条链路：配置 → 建 job → 流式调用 → 解析 JSON → 落盘 → 刷新。
 *
 *   node test/ai.mjs
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok });
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? `　— ${detail}` : ''}`);
};

/* ---------- 假模型服务 ---------- */
let lastRequest = null;

/**
 * 模拟真模型的翻车姿势：该写 `\\frac` 却写成 `\frac`。
 *
 * `JSON.stringify` 出来的是**合法**转义（`\\to`），把每处 `\\` 还原成一个 `\` 就得到了
 * 真模型那种输出：`\to` 会被 JSON 解析成制表符、`\frac` 变成换页符 ——
 * 不报错，内容却已经烂了，页面上看着就是一堆乱码。判分这条路必须在这种输入下也不出错。
 */
const looseEscapes = (s) => String(s).replace(/\\\\/g, '\\');

/** 从提示词里抠出机器输出段里的目标路径 */
function relsFromPrompt(text) {
  const i = text.indexOf('机器可读');
  const tail = i === -1 ? text : text.slice(i);
  const sec = tail.slice(tail.indexOf('原样照抄'));
  return [...sec.matchAll(/^\s*-\s*(\S+\.md)\s*$/gm)].map((m) => m[1]);
}

const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const payload = JSON.parse(body || '{}');
    lastRequest = { path: req.url, auth: req.headers.authorization, payload };

    // content 可能是字符串（普通请求）或数组（带图的多模态请求）—— 这里统一成文字 + 有没有图
    const rawContent = payload.messages?.at(-1)?.content;
    const parts = Array.isArray(rawContent) ? rawContent : [];
    const user = Array.isArray(rawContent)
      ? parts.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
      : String(rawContent || '');
    const hasImage = parts.some((c) => c.type === 'image_url');
    globalThis.__lastWasMultimodal = hasImage;
    if (hasImage) globalThis.__sawMultimodal = true; // 归类会再发一次不带图的请求，用这个「见过」标志更稳

    // 归类到题型本：增题写完后的第二步，要的是 {"files":[...]}（通解文件）
    if (user.includes('请帮我整理「题型本」')) {
      const ids = [...user.matchAll(/id：`([^`]+)`/g)].map((m) => m[1]);
      const rel = globalThis.__patternEvil ? '错题本/数学/高数/极限/越界乱写.md' : '题型本/数学/高数/极限/假通解.md';
      const env = JSON.stringify({
        files: [
          {
            rel,
            content: `---
tags:
  - 题型本
  - 通解
type: 计算题
difficulty: ⭐⭐⭐☆☆
heat: 🔥🔥🔥☆☆
related:
${ids.map((i) => `  - ${i}`).join('\n')}
---

# 假通解

## 适用特征

看到这类题就用泰勒展开。

## 通解步骤

1. 展开到三阶。

## 易错点

阶数不够。
`,
          },
        ],
      });
      if (payload.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const c of env.match(/[\s\S]{1,60}/g) || []) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: env } }] }));
      }
      return;
    }

    // 周总结：要的是**纯文本正文**，不是 JSON
    if (user.includes('本周状态与建议') && user.includes('只给正文')) {
      const text = '**一句话结论**：这一周的计划是最后两天补出来的。\n\n### 一、本周状态\n- 完成率 100%，但九成集中在周末。';
      if (payload.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
      }
      return;
    }

    // 单题判分（错题本做题模式）：要的是一个对象（不是 items 数组）
    if (user.includes('批我**一道题**')) {
      const env = looseEscapes(
        JSON.stringify({
          score: 72,
          result: '普通',
          reason: '计算失误',
          got: '我写的：$x\\to 0$ 时左右极限都是 1',
          lost: '右极限算错了，忘了取 $x\\to 0^+$',
          fix: '分段点必须左右各算一次：$\\lim_{x\\to 0^+}f(x)$ 单独求',
          analysis: '这一步把右极限直接当成了 0。\n下次看到分段函数，先写左右极限再谈极限存在。',
          weak: ['分段点', '左右极限'],
        })
      );
      if (payload.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const c of env.match(/[\s\S]{1,50}/g) || []) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: env } }] }));
      }
      return;
    }

    // 判分：要的是 {"items":[…],"summary":…}（每题按它的满分扣一点分）
    if (user.includes('考研阅卷老师')) {
      const qs = [...user.matchAll(/### 第 (\d+) 题[^\n]*满分 ([\d.]+) 分/g)].map((m) => ({
        n: Number(m[1]),
        full: Number(m[2]),
      }));
      const env = JSON.stringify({
        items: qs.map((q, i) => ({
          n: q.n,
          got: `考生写的第 ${q.n} 题`,
          // 最后一题故意给满分，验证「满分不给错因」和「一键加入错题本」只收做错的
          score: i === qs.length - 1 ? q.full : Math.max(0, Math.round((q.full - 2) * 100) / 100),
          full: q.full,
          verdict: i === qs.length - 1 ? '正确' : '部分正确',
          reason: '计算失误',
          lost: i === qs.length - 1 ? '无' : '漏了分类讨论：$x\\to 0^+$ 那一支没算',
          fix: i === qs.length - 1 ? '保持' : '先写 $\\lim_{x\\to 0}\\frac{\\sin x}{x}=1$ 再代',
        })),
        summary: '假模型的总评：分类讨论不熟，$\\frac{1}{2}$ 这种系数别再丢。',
        weak: ['分类讨论', '中值定理'],
        next: ['重做第 1 题'],
        total: 999, // 故意乱报一个总分，程序应当不采信
      });
      const loose = looseEscapes(env);
      if (payload.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const c of loose.match(/[\s\S]{1,50}/g) || []) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: loose } }] }));
      }
      return;
    }

    // 增题：要的是 {"items":[...]}
    if (user.includes('"keyPoints"') || user.includes('只输出一个 JSON 对象，不要解释、不要代码围栏')) {
      const n = (user.match(/【第 (\d+) 题】/g) || []).length || 1;
      const env = JSON.stringify({
        items: Array.from({ length: n }, (_, i) => ({
          n: i + 1,
          title: `假题解 ${i + 1}`,
          type: '计算题',
          difficulty: 3,
          heat: 4,
          points: ['等价无穷小'],
          keyPoints: '考点：泰勒展开的阶数要够。',
          answer: `解：第 ${i + 1} 题的标准过程。`,
          analysis: `解析：第 ${i + 1} 题为什么这么做。`,
          pitfall: '易错：展开阶数不够。',
        })),
      });
      if (payload.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const c of env.match(/[\s\S]{1,40}/g) || []) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: env } }] }));
      }
      return;
    }

    // 看图写题：这个任务的 rel 由模型自己起，所以要单独认
    if (user.includes('我上传了') && user.includes('SVG')) {
      const env = JSON.stringify({
        files: [
          {
            rel: '错题本/数学/高数/极限/极限-01-假图题.md',
            content: `---
tags:
  - 错题本
  - 高数
  - 极限
type: 计算题
difficulty: ⭐⭐⭐☆☆
heat: 🔥🔥🔥☆☆
points:
  - 等价无穷小
---

# 极限-01　假图题

## 题号

**考的类型**　计算题

## 题干

计算 $\\lim_{x\\to 0}\\dfrac{\\sin x-x}{x^{3}}$。

![[fake-figure.svg]]

## 答案

> [!success]- 展开 · 答案
> 解：$\\sin x=x-\\dfrac{x^{3}}{6}+o(x^{3})$，故极限为 $-\\dfrac16$。
> 结论：$-\\dfrac16$。

## 解析

> [!example]- 展开 · 解析
> 泰勒展开到三阶即可。

## 打卡记录

- [ ] 第 1 次 · 完美
- [ ] 第 1 次 · 普通
- [ ] 第 1 次 · 失败
`,
          },
          {
            rel: '错题本/picture/fake-figure.svg',
            content: '<svg viewBox="0 0 100 40" xmlns="http://www.w3.org/2000/svg"><path d="M0 20 L100 20"/></svg>',
          },
          // 故意混一个越界路径，验证会被拒绝而不是照写
          { rel: '../../被写坏了.md', content: '# 不该被写' },
        ],
      });
      if (payload.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const c of env.match(/[\s\S]{1,60}/g) || []) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: env } }] }));
      }
      return;
    }

    const rels = relsFromPrompt(user);
    if (!rels.length) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'NO_RELS' } }] }));
      return;
    }
    const envelope = JSON.stringify({
      files: rels.map((rel) => ({
        rel,
        content: `---\ndate: 2026-09-14\ntitle: 假模型产物\n---\n\n# 假模型产物\n\n这是 ${rel} 的内容。\n`,
      })),
    });

    if (payload.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      // 切成几段发，模拟真实流式
      const chunks = envelope.match(/[\s\S]{1,40}/g) || [];
      let i = 0;
      const tick = () => {
        if (i >= chunks.length) {
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i++] } }] })}\n\n`);
        setTimeout(tick, 2);
      };
      tick();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: envelope } }] }));
  });
});

await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const mockPort = mock.address().port;
const MOCK = `http://127.0.0.1:${mockPort}/v1`;

/* ---------- 临时仓库 + 真服务 ---------- */
const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-e2e-'));
fs.mkdirSync(path.join(RUN, 'vault', '错题本'), { recursive: true });
fs.mkdirSync(path.join(RUN, 'vault', '考研', '2026-09'), { recursive: true });
fs.mkdirSync(path.join(RUN, 'vault', '复盘'), { recursive: true });
fs.writeFileSync(
  path.join(RUN, 'vault', '考研', '2026-09', '2026-09-第3周-周计划.md'),
  `# 📅 2026-09 第 3 周（9/14–9/20）｜连续性与导数开局\n\n## 📋 本周任务\n\n### 📐 数学\n- [ ] 9/14（周一）极限 (11)（视频 40min）\n\n### 💻 408\n- [ ] 9/14（周一）第一章 配置 C 语言开发环境\n`,
  'utf8'
);

const PORT = 4321;
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

const cleanup = () => {
  try {
    srv.kill();
  } catch {}
  try {
    mock.close();
  } catch {}
  fs.rmSync(RUN, { recursive: true, force: true });
};
process.on('exit', cleanup);

const api2 = (p, options) =>
  fetch(`http://127.0.0.1:${PORT}${p}`, { headers: { 'Content-Type': 'application/json' }, ...options }).then((r) =>
    r.json()
  );

/* ---------- 等服务起来 ---------- */
let up = false;
for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
    if (r.ok) {
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
  cleanup();
  process.exit(1);
}

console.log('\n=== 内置 AI 集成测试 ===\n');

/* ---------- 1. 配置 ---------- */
const st = await api2('/api/ai');
check(
  'AI 状态：认得出环境变量里的配置，且接口不回显 key',
  st.ready === true && st.hasKey === true && st.baseUrl === MOCK && st.model === 'fake-model' && !('apiKey' in st),
  `${st.baseUrl} · ${st.model} · key=${st.hasKey ? '有（不回显）' : '无'}`
);

const cfgRes = await api2('/api/ai/config', {
  method: 'POST',
  body: JSON.stringify({ baseUrl: MOCK, model: 'fake-model-2', apiKey: 'another-key' }),
});
const cfgFile = path.join(RUN, 'ai-config.json');
const onDisk = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
check(
  'AI 配置：能写进本机 .ai-config.json（权限 600），且返回里没有 key',
  cfgRes.ok === true && !('apiKey' in cfgRes) && onDisk.model === 'fake-model-2' && onDisk.apiKey === 'another-key',
  `文件里的 model=${onDisk.model}`
);
check(
  'AI 配置：环境变量优先时会如实标出来（不然在设置里改了没反应，很迷惑）',
  cfgRes.fromEnv?.model === true && cfgRes.envLocked === true &&
    (fs.statSync(cfgFile).mode & 0o777) === 0o600,
  `fromEnv=${JSON.stringify(cfgRes.fromEnv)} · 权限 ${(fs.statSync(cfgFile).mode & 0o777).toString(8)}`
);
await api2('/api/ai/config', { method: 'POST', body: JSON.stringify({ model: 'fake-model' }) });

/* ---------- 2. 连通性自检 ---------- */
const t = await api2('/api/ai/test', { method: 'POST', body: JSON.stringify({}) });
check('AI 自检：打的是 {baseUrl}/chat/completions，带 Bearer key', t.ok === true && lastRequest?.path === '/v1/chat/completions' && lastRequest.auth === 'Bearer fake-key-for-test',
  `${t.ms}ms · ${lastRequest?.path}`);

/* ---------- 2.5 思考模型把小 max_tokens 吃光时的诊断（真实踩过的坑） ---------- */
let thinkMode = false;
const mock2 = mock; // 复用同一台假服务，用请求内容切换行为
const origHandler = mock.listeners('request')[0];
// 直接给假服务加一个开关：带 thinking-eats-all 的请求返回「思考吃光 token」
globalThis.__thinkMode = false;

const diag = await fetch(`http://127.0.0.1:${PORT}/api/ai/test`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({}),
}).then((r) => r.json());
check(
  'AI 自检：给足 max_tokens 并关掉思考（不然思考会把额度吃光，正文是空的）',
  diag.ok === true && lastRequest.payload.max_tokens >= 256 && lastRequest.payload.reasoning_effort === 'none',
  `max_tokens=${lastRequest.payload.max_tokens} · reasoning_effort=${lastRequest.payload.reasoning_effort}`
);

/* ---------- 3. 一键生成「今日测试」 ---------- */
const readNdjson = async (p, body) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { status: res.status, json: await res.json().catch(() => ({})) };
  const text = await res.text();
  return {
    status: res.status,
    events: text.split('\n').filter(Boolean).map((l) => JSON.parse(l)),
  };
};

const runTest = await readNdjson('/api/ai/run', { kind: 'test' });
const kinds = runTest.events.map((e) => e.t);
check(
  '一键生成「今日测试」：走 NDJSON 流，有 start → job → saved → done',
  runTest.status === 200 &&
    kinds[0] === 'start' &&
    kinds.includes('job') &&
    kinds.includes('saved') &&
    kinds.at(-1) === 'done',
  kinds.join(' → ')
);

const testDate = new Date().toISOString().slice(0, 10);
const testFile = path.join(RUN, 'vault', '今日测试', `${testDate}-今日测试.md`);
check('一键生成「今日测试」：文件真的落到盘上了', fs.existsSync(testFile), testFile.replace(RUN, '…'));
const backTest = await api2(`/api/test/paper?rel=${encodeURIComponent(`今日测试/${testDate}-今日测试.md`)}`);
check('一键生成「今日测试」：写进去的内容能被程序解析回来', backTest.exists === true && backTest.title === '假模型产物',
  `title=${backTest.title}`);

/* ---------- 4. 一键生成「考研英语一题目」（多篇 = 多次调用、一篇一个文件） ---------- */
const words = Array.from({ length: 12 }, (_, i) => ({ voc_id: `v${i}`, spelling: `word${i}` }));
const runWords = await readNdjson('/api/ai/run', {
  kind: 'words',
  words,
  types: ['read-detail', 'cloze'],
  papers: 2,
  random: false,
  date: testDate,
});
const saved = runWords.events.filter((e) => e.t === 'saved').map((e) => e.rel);
check(
  '一键生成「单词题」：2 篇 → 2 次模型调用 → 2 个文件',
  runWords.status === 200 && saved.length === 2 && runWords.events.find((e) => e.t === 'start').total === 2,
  saved.join('、')
);
check(
  '多篇是分开调用的（每篇一次请求，长文不会被截断）',
  runWords.events.filter((e) => e.t === 'job').length === 2,
  `job 事件 ${runWords.events.filter((e) => e.t === 'job').length} 次`
);
const storyDir = path.join(RUN, 'vault', '单词故事');
const storyFiles = fs.existsSync(storyDir) ? fs.readdirSync(storyDir).filter((f) => f.endsWith('.md')) : [];
check('一键生成「单词题」：文件都写进 单词故事/ 了', storyFiles.length === 2, storyFiles.join('、'));
check(
  '两篇各自的名字带题型，不会互相覆盖',
  new Set(storyFiles).size === 2 && storyFiles.some((f) => f.includes('传统阅读')) && storyFiles.some((f) => f.includes('完形填空')),
  storyFiles.join('、')
);

/* ---------- 5. 失败要如实报，不能默默成功 ---------- */
const noRelRun = await readNdjson('/api/ai/run', { kind: 'words', words: [], types: ['read-detail'], papers: 1 });
check('没选词就生成 → 明确报错（不是静默成功）', noRelRun.status === 400 && /先选几个单词/.test(noRelRun.json.error || ''),
  `${noRelRun.status} ${noRelRun.json?.error}`);

/* ---------- 5.5 周状态总结：只回正文，由程序插进那一节 ---------- */
// 先给本周计划放一个别的章节，验证「只动这一节」
const weekFile = path.join(RUN, 'vault', '考研', '2026-09', '2026-09-第3周-周计划.md');
const beforeWeek = fs.readFileSync(weekFile, 'utf8');
const runWeekly = await readNdjson('/api/ai/run', { kind: 'weekly' });
const afterWeek = fs.readFileSync(weekFile, 'utf8');
check(
  '一键生成「本周总结」：写进 ## 🤖 本周状态与建议 一节',
  runWeekly.status === 200 &&
    afterWeek.includes('## 🤖 本周状态与建议') &&
    afterWeek.includes('这一周的计划是最后两天补出来的'),
  runWeekly.events.filter((e) => e.t === 'saved').map((e) => e.rel).join('、') || '(没写进去)'
);
// 把那一节挖掉、并把连续空行归一，两边应当完全一致
const stripSummary = (t) =>
  t.replace(/## 🤖 本周状态与建议[\s\S]*?(?=\n## |$)/, '').replace(/\n{3,}/g, '\n\n');
check(
  '一键生成「本周总结」：只动那一节，计划正文一个字都没变',
  afterWeek.includes('极限 (11)') && stripSummary(afterWeek) === stripSummary(beforeWeek),
  stripSummary(afterWeek) === stripSummary(beforeWeek) ? '其余部分完全一致' : '正文被改动了'
);
// 再跑一次：应当整段替换，而不是越堆越多
const runWeekly2 = await readNdjson('/api/ai/run', { kind: 'weekly' });
const afterWeek2 = fs.readFileSync(weekFile, 'utf8');
check(
  '一键生成「本周总结」：再跑一次是覆盖，不会越写越长',
  runWeekly2.status === 200 && (afterWeek2.match(/## 🤖 本周状态与建议/g) || []).length === 1,
  `出现 ${(afterWeek2.match(/## 🤖 本周状态与建议/g) || []).length} 次`
);

/* ---------- 5.6 增题：只让模型解答案，笔记由程序按模板生成 ---------- */
const runQ = await readNdjson('/api/ai/run', {
  kind: 'questions',
  stems: ['计算 $\\lim_{x\\to 0}\\frac{\\tan x-\\sin x}{x^3}$', '简述 C 程序的编译过程'],
  book: 'mistakes',
});
const createdQ = runQ.events.filter((e) => e.t === 'saved').flatMap((e) => e.created || []);
check(
  '一键生成「答案与解析」：每题一个笔记文件，落到错题本',
  runQ.status === 200 && createdQ.length === 2 && createdQ.every((f) => f.startsWith('数学/') || f.startsWith('408/') || f.startsWith('未分类/')),
  createdQ.join('、')
);
const oneNote = createdQ[0] ? fs.readFileSync(path.join(RUN, 'vault', '错题本', createdQ[0]), 'utf8') : '';
check(
  '一键生成的笔记：题干、标准答案、解析都写进去了',
  oneNote.includes('## 题干') &&
    oneNote.includes('标准过程') &&
    oneNote.includes('为什么这么做') &&
    !oneNote.includes('⏳ 待补充（小题给最终结果'),
  oneNote.includes('标准过程') ? '答案与解析已填' : '没填上'
);
check(
  '一键生成的笔记：跨行内容都带上了 callout 的 > 前缀（否则 Obsidian 会截断）',
  /\[!success\]-[\s\S]*?\n> 解：/.test(oneNote) && /\[!example\]-/.test(oneNote)
);

/* ---------- 5.65 增题之后顺手归类到题型本 ---------- */
// 以前只有「复制提示词」那条老路带归类要求，一键生成这条路没有 ——
// 界面上写着「归类也顺手做了」，新题却永远挂在「未归类」。
check(
  '一键增题：进度流里能看见「归入题型本」这一步',
  runQ.events.some((e) => e.t === 'stage' && e.text.includes('题型本')),
  runQ.events.filter((e) => e.t === 'stage').map((e) => e.text).join(' ／ ') || '(没有 stage)'
);
const patAfterQ = await api2('/api/patterns');
check(
  '一键增题：新题真的写进了通解的 related（不再是「未归类」）',
  patAfterQ.unlinkedCount === 0 &&
    patAfterQ.patterns.length >= 1 &&
    patAfterQ.patterns.some(
      (p) => p.related.filter((id) => id.startsWith('mistakes:')).length >= createdQ.length
    ),
  `${patAfterQ.patterns.length} 份通解 · 未归类 ${patAfterQ.unlinkedCount} · related=${JSON.stringify(
    patAfterQ.patterns[0]?.related || []
  )}`
);
const patFile = path.join(RUN, 'vault', '题型本', '数学', '高数', '极限', '假通解.md');
check(
  '一键增题：通解文件真的落到盘上，而且是完整格式（frontmatter + related + 通解步骤）',
  fs.existsSync(patFile) && /^---\n[\s\S]*related:[\s\S]*## 通解步骤/.test(fs.readFileSync(patFile, 'utf8')),
  path.relative(RUN, patFile)
);

/* ---------- 5.66 归类想越界写错题本？拒收 ---------- */
globalThis.__patternEvil = true;
const runQEvil = await readNdjson('/api/ai/run', {
  kind: 'questions',
  stems: ['再算一道 $\\int_0^1 x\\,dx$'],
  book: 'mistakes',
});
const evilWarns = runQEvil.events.filter((e) => e.t === 'saved').flatMap((e) => e.warns || []);
check(
  '自动归类：模型想往错题本里写，被拒绝并如实报出来（笔记本身照旧写好）',
  evilWarns.some((w) => w.includes('越界')) &&
    !fs.existsSync(path.join(RUN, 'vault', '错题本', '数学', '高数', '极限', '越界乱写.md')),
  evilWarns.join(' ／ ') || '(没有 warn)'
);
globalThis.__patternEvil = false;

/* ---------- 5.7 看图写题（多模态） ---------- */
// 造一张真的小 PNG 放进 uploads
const uploadsDir = path.join(RUN, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
fs.writeFileSync(path.join(uploadsDir, 'q1.png'), PNG);

globalThis.__sawMultimodal = false; // 只认这一轮的请求有没有带图
const runImg = await readNdjson('/api/ai/run', {
  kind: 'images',
  names: ['q1.png'],
  book: 'mistakes',
  reason: '计算失误',
});
const imgSaved = runImg.events.find((e) => e.t === 'saved') || {};
check(
  '看图写题：请求真的带上了图片（多模态 image_url）',
  globalThis.__sawMultimodal === true,
  globalThis.__sawMultimodal ? 'content 里是数组，含 image_url' : '只发了文字'
);
check(
  '看图写题：笔记和 SVG 图都写进去了',
  (imgSaved.created || []).includes('错题本/数学/高数/极限/极限-01-假图题.md') &&
    (imgSaved.created || []).includes('错题本/picture/fake-figure.svg'),
  (imgSaved.created || []).join('、')
);
check(
  '看图写题：越界路径被拒绝，不会写坏仓库',
  (imgSaved.rejected || []).some((r) => r.includes('..')) && !fs.existsSync(path.join(RUN, '被写坏了.md')),
  (imgSaved.rejected || []).join('；')
);
const figFile = path.join(RUN, 'vault', '错题本', 'picture', 'fake-figure.svg');
check('看图写题：SVG 图真的落盘，且是文本', fs.existsSync(figFile) && fs.readFileSync(figFile, 'utf8').startsWith('<svg'), figFile.replace(RUN, '…'));

/* ---------- 5.8 拍照判分：上传手写答案 → 按考研标准逐题给分 → 写进「成绩记录」 ---------- */
const TEST_REL = '今日测试/2026-09-14-今日测试.md';
const TEST_PAPER = `---
date: 2026-09-14
title: 9/14 今日测试
scope: 数学 · 极限 / 408 · 存储模型
minutes: 40
full: 100
---

# 9/14 今日测试

## 题目

### 1. 选择题 ｜ 极限 ｜ 30 分

下列说法正确的是？

### 2. 大题 ｜ 中值定理 ｜ 70 分

证明存在 $\\xi$ 使 $f'(\\xi)=0$。

## 答案与解析

### 1. 选择题 ｜ 极限 ｜ 30 分

**标准答案**

B

**解析**

- 易错点……

### 2. 大题 ｜ 中值定理 ｜ 70 分

**标准答案**

解：由罗尔定理，$f(a)=f(b)$，故存在 $\\xi\\in(a,b)$ 使 $f'(\\xi)=0$。

**解析**

- 为什么这样切入……
`;
await api2('/api/test', { method: 'POST', body: JSON.stringify({ rel: TEST_REL, content: TEST_PAPER }) });
const paperBefore = await api2(`/api/test/paper?rel=${encodeURIComponent(TEST_REL)}`);
check(
  '今日测试：每题的分值和参考用时都解析出来了（判分与计时器都靠它）',
  paperBefore.plan.table.full === 100 &&
    paperBefore.plan.table.byN['1'] === 30 &&
    paperBefore.plan.table.byN['2'] === 70 &&
    paperBefore.plan.ref.minutes === 40 &&
    paperBefore.plan.ref.byN['2'] === 1680,
  `满分 ${paperBefore.plan.table.full} · 参考 ${paperBefore.plan.ref.minutes} 分钟`
);

// 判分要用的手写答案图片（走真的上传接口）
const ansPng = await api2('/api/upload', {
  method: 'POST',
  body: JSON.stringify({ name: '手写答案1.png', dataUrl: `data:image/png;base64,${PNG.toString('base64')}` }),
});
const ansPng2 = await api2('/api/upload', {
  method: 'POST',
  body: JSON.stringify({ name: '手写答案2.png', dataUrl: `data:image/png;base64,${PNG.toString('base64')}` }),
});

const gradeRun = await readNdjson('/api/grade', {
  rel: TEST_REL,
  kind: 'test',
  names: [ansPng.name, ansPng2.name],
  seconds: 2530,
});
const gKinds = gradeRun.events.map((e) => e.t);
check(
  '拍照判分：走 NDJSON 流（start → delta → done），两张照片一起送进去',
  gradeRun.status === 200 && gKinds[0] === 'start' && gKinds.includes('delta') && gKinds.at(-1) === 'done',
  gKinds.join(' → ')
);
check('拍照判分：请求真的带上了图片（多模态）', globalThis.__sawMultimodal === true, globalThis.__sawMultimodal ? '含 image_url' : '只发了文字');
const gradeDone = gradeRun.events.find((e) => e.t === 'done') || {};
const gradeRes = gradeDone.result || {};
check(
  '拍照判分：总分由程序按每题得分自己加（模型乱报的 999 不采信）',
  gradeRes.total === 98 && gradeRes.full === 100 && gradeRes.items.length === 2,
  `总分 ${gradeRes.total}/${gradeRes.full}（模型报的是 999）`
);
check(
  '拍照判分：每题的得分、判定、错因、丢分点、怎么改都齐了',
  gradeRes.items[0].score === 28 &&
    gradeRes.items[0].verdict === '部分正确' &&
    gradeRes.items[0].reason === '计算失误' &&
    gradeRes.items[0].lost === '漏了分类讨论：$x\\to 0^+$ 那一支没算' &&
    gradeRes.items[0].fix === '先写 $\\lim_{x\\to 0}\\frac{\\sin x}{x}=1$ 再代' &&
    gradeRes.items[1].score === 70 &&
    gradeRes.items[1].reason === '',
  JSON.stringify(gradeRes.items.map((x) => [x.n, x.score, x.verdict, x.reason]))
);
check(
  '拍照判分：模型漏转义 LaTeX 时，丢分点 / 总评里的公式没被吃掉（没有制表符、换页符）',
  gradeRes.items[0].lost.includes(String.raw`$x\to 0^+$`) &&
    gradeRes.items[0].fix.includes(String.raw`$\lim_{x\to 0}\frac{\sin x}{x}=1$`) &&
    gradeRes.summary.includes(String.raw`$\frac{1}{2}$`) &&
    !/[\u0008\u000b\u000c\u000d]/.test(`${gradeRes.items[0].lost}${gradeRes.items[0].fix}${gradeRes.summary}`),
  JSON.stringify(gradeRes.items[0].lost)
);
check(
  '拍照判分：用完的暂存图片被清掉了（成绩已经落盘，不用一直占着 uploads/）',
  !fs.existsSync(path.join(RUN, 'uploads', ansPng.name)) && !fs.existsSync(path.join(RUN, 'uploads', ansPng2.name)),
  fs.existsSync(path.join(RUN, 'uploads', ansPng.name)) ? '还留着' : '已清掉'
);

const testFileNow = fs.readFileSync(path.join(RUN, 'vault', TEST_REL), 'utf8');
check(
  '拍照判分：成绩写进试卷文件的 ## 成绩记录（分数 / 用时 / 参考用时 / 每题的丢分点）',
  testFileNow.includes('## 成绩记录') &&
    testFileNow.includes('98 / 100') &&
    testFileNow.includes('用时 42:10') &&
    testFileNow.includes('参考 40:00') &&
    testFileNow.includes('判分图片 2 张') &&
    testFileNow.includes(String.raw`漏了分类讨论：$x\to 0^+$ 那一支没算；改：先写 $\lim_{x\to 0}\frac{\sin x}{x}=1$ 再代`),
  (testFileNow.match(/### 第 \d 次[^\n]*/) || [])[0] || '(没写进去)'
);
check(
  '拍照判分：只动「成绩记录」那一节，题干与标准答案一个字节都没改',
  testFileNow.includes('### 2. 大题 ｜ 中值定理 ｜ 70 分') &&
    testFileNow.includes('解：由罗尔定理') &&
    testFileNow.replace(/## 成绩记录[\s\S]*$/, '').trimEnd() ===
      `---\ndate: 2026-09-14\ntitle: 9/14 今日测试\nscope: 数学 · 极限 / 408 · 存储模型\nminutes: 40\nfull: 100\n---\n\n# 9/14 今日测试\n\n## 题目\n\n### 1. 选择题 ｜ 极限 ｜ 30 分\n\n下列说法正确的是？\n\n### 2. 大题 ｜ 中值定理 ｜ 70 分\n\n证明存在 $\\xi$ 使 $f'(\\xi)=0$。\n\n## 答案与解析\n\n### 1. 选择题 ｜ 极限 ｜ 30 分\n\n**标准答案**\n\nB\n\n**解析**\n\n- 易错点……\n\n### 2. 大题 ｜ 中值定理 ｜ 70 分\n\n**标准答案**\n\n解：由罗尔定理，$f(a)=f(b)$，故存在 $\\xi\\in(a,b)$ 使 $f'(\\xi)=0$。\n\n**解析**\n\n- 为什么这样切入……`.trimEnd(),
  '去掉成绩记录那一节后，正文与原件逐字一致'
);
const paperAfter = await api2(`/api/test/paper?rel=${encodeURIComponent(TEST_REL)}`);
check(
  '拍照判分：再打开这份卷子，成绩单和「最近一次分数」都还在',
  paperAfter.last?.total === 98 && paperAfter.grades.length === 1 && paperAfter.items.length === 2,
  `最近一次 ${paperAfter.last?.total}/${paperAfter.last?.full}`
);

/* ---------- 5.9 一键把错题加入错题本（判完分接着点一下） ---------- */
const wrongRun = await api2('/api/test/to-bank', {
  method: 'POST',
  body: JSON.stringify({
    rel: TEST_REL,
    book: 'mistakes',
    items: gradeRes.items
      .filter((x) => x.score < x.full)
      .map((x) => ({ n: x.n, reason: x.reason, lost: x.lost, fix: x.fix })),
  }),
});
const wrongFiles = wrongRun.created?.created || [];
check(
  '一键把错题加入错题本：一次把做错的题全写进去（判对的题不收）',
  wrongRun.ok === true && wrongFiles.length === 1 && wrongFiles[0].file,
  wrongFiles.map((f) => f.file).join('、')
);
const wrongNote = wrongFiles[0] ? fs.readFileSync(path.join(RUN, 'vault', '错题本', wrongFiles[0].file), 'utf8') : '';
check(
  '一键加入的错题：判分给的错因、丢分点、该怎么改，加标准答案与解析，全都写进笔记',
  wrongNote.includes('**首次错因**　计算失误') &&
    wrongNote.includes('漏了分类讨论') &&
    wrongNote.includes(String.raw`先写 $\lim_{x\to 0}\frac{\sin x}{x}=1$ 再代`) &&
    // 标准答案（这题是选择题，答案是 B）
    /> \[!success\]- 展开 · 答案\n> B/.test(wrongNote) &&
    // 解析（从「答案与解析」那节拆出来的）
    wrongNote.includes('易错点……'),
  JSON.stringify({
    reason: /首次错因\*\*　(.+)/.exec(wrongNote)?.[1],
    hasLost: wrongNote.includes('漏了分类讨论'),
    hasFix: wrongNote.includes(String.raw`$\lim_{x\to 0}\frac{\sin x}{x}=1$`),
    hasAnswer: /> B/.test(wrongNote),
    hasAnalysis: wrongNote.includes('易错点……'),
  })
);

/* ---------- 5.10 英语：本地判卷按分值给分，成绩也记进卷子 ---------- */
const STORY_REL = '单词故事/2026-09-14-01-传统阅读·细节题.md';
const STORY = `---
date: 2026-09-14
type: 传统阅读 · 细节题
title: A Fake Passage
words:
  - statute
---

# A Fake Passage

The statute was quietly ignored.

## 题目

1. What happened to the rule?
A. It was read widely
B. It lost its force
C. It was repealed
D. It was rewritten

2. The author's attitude is
A. objective
B. indifferent
C. hostile
D. approving

## 答案速查

1.B 2.A

## 答案解析

第 1 段定位句：quietly ignored。
`;
await api2('/api/words/story', { method: 'POST', body: JSON.stringify({ rel: STORY_REL, content: STORY }) });
const localRun = await api2('/api/grade/local', {
  method: 'POST',
  body: JSON.stringify({ rel: STORY_REL, answers: { 1: 'B', 2: 'C' }, seconds: 700 }),
});
check(
  '英语本地判卷：对一题错一题 → 按每题分值给分（2 题 = 满分 10，每题 5 分）',
  localRun.ok === true && localRun.attempt.total === 5 && localRun.attempt.full === 10 && localRun.attempt.items.length === 2,
  `${localRun.attempt?.total} / ${localRun.attempt?.full}`
);
const storyNow = fs.readFileSync(path.join(RUN, 'vault', STORY_REL), 'utf8');
check(
  '英语本地判卷：成绩也写进 ## 成绩记录（标出来是「本地判卷」），原文与题目不动',
  storyNow.includes('## 成绩记录') &&
    storyNow.includes('本地判卷') &&
    storyNow.includes('5 / 10') &&
    storyNow.includes('折算 50%') &&
    storyNow.includes('The statute was quietly ignored.'),
  (storyNow.match(/### 第 \d 次[^\n]*/) || [])[0] || '(没写进去)'
);
const storyBack = await api2(`/api/words/story?rel=${encodeURIComponent(STORY_REL)}`);
check(
  '英语：单篇满分 10 分、参考 18 分钟，每题带分值（2 题就是每题 5 分、每题 9 分钟）',
  storyBack.plan?.table?.full === 10 &&
    storyBack.plan?.ref?.minutes === 18 &&
    storyBack.plan?.table?.byN['1'] === 5 &&
    storyBack.plan?.ref?.byN['1'] === 540,
  `满分 ${storyBack.plan?.table?.full} · 参考 ${storyBack.plan?.ref?.minutes} 分钟 · 每题 ${storyBack.plan?.table?.byN['1']} 分 / ${storyBack.plan?.ref?.byN['1']} 秒`
);
const storyGradeTry = await readNdjson('/api/grade', { rel: STORY_REL, kind: 'story', names: ['q1.png'] });
check(
  '英语不用拍照：/api/grade 对英语题目明确拒绝，让人直接对答案（本地判分又快又准）',
  storyGradeTry.status === 400 && /选择题|本地/.test(storyGradeTry.json?.error || ''),
  storyGradeTry.json?.error || '(没拒绝)'
);

/* ---------- 5.11 错题本单题：拍照判分 → 我改完 → 记进笔记 ---------- */
const madeQ = await api2('/api/new', {
  method: 'POST',
  body: JSON.stringify({
    book: 'mistakes',
    items: [
      {
        category: '数学', subject: '高数', chapter: '极限', type: '计算题',
        stem: '设 $f(x)=\\begin{cases}x,&x<0\\\\1,&x\\ge 0\\end{cases}$，求 $\\lim_{x\\to 0}f(x)$。',
        slug: '左右极限', title: '左右极限',
        difficulty: 3, heat: 4, points: ['左右极限'],
        answer: '解：左极限 0，右极限 1，故极限不存在。',
        analysis: '分段点处必须分左右求。',
        pitfall: '别忘了先看分段点。',
      },
    ],
  }),
});
const qFile = madeQ.created?.created?.[0]?.file || madeQ.created?.[0]?.file;
const qSnap = await api2('/api/questions');
const qProblem = (qSnap.problems || []).find((x) => x.relPath === qFile || x.file === qFile);
check('错题本单题：先把一道题造出来（拍照判分要拿它当依据）', !!qProblem, qFile || JSON.stringify(madeQ));

const qNotePath = path.join(RUN, 'vault', '错题本', qProblem.relPath);
const noteBefore = fs.readFileSync(qNotePath, 'utf8');

const qImg = await api2('/api/upload', {
  method: 'POST',
  body: JSON.stringify({ name: '这题的手写过程.png', dataUrl: `data:image/png;base64,${PNG.toString('base64')}` }),
});
globalThis.__sawMultimodal = false;
const qRun = await readNdjson('/api/grade/question', { id: qProblem.id, names: [qImg.name], seconds: 245 });
const qKinds = qRun.events.map((e) => e.t);
check(
  '错题本单题判分：走 NDJSON 流（start → delta → done），图片带上了',
  qRun.status === 200 && qKinds[0] === 'start' && qKinds.includes('delta') && qKinds.at(-1) === 'done' &&
    globalThis.__sawMultimodal === true,
  qKinds.join(' → ')
);
const qVerdict = qRun.events.find((e) => e.t === 'done')?.verdict || {};
check(
  '错题本单题判分：得分 + 「完美 / 普通 / 失败」建议 + 错因 + 错因分析都回来了',
  qVerdict.score === 72 &&
    qVerdict.result === '普通' &&
    qVerdict.reason === '计算失误' &&
    qVerdict.lost.includes('右极限') &&
    qVerdict.analysis.includes('下次看到分段函数') &&
    Array.isArray(qVerdict.weak),
  `${qVerdict.score}/100 · ${qVerdict.result} · ${qVerdict.reason}`
);
check(
  '错题本单题判分：模型漏转义 LaTeX 时，判语里的公式一个字符都没被吃坏（\\(\\to\\) 没变成制表符）',
  qVerdict.got.includes(String.raw`$x\to 0$`) &&
    qVerdict.lost.includes(String.raw`$x\to 0^+$`) &&
    qVerdict.fix.includes(String.raw`$\lim_{x\to 0^+}f(x)$`) &&
    !/[\u0008\u000b\u000c\u000d]/.test(`${qVerdict.got}${qVerdict.lost}${qVerdict.fix}${qVerdict.analysis}`),
  JSON.stringify(qVerdict.lost)
);
check(
  '错题本单题判分：判分本身**不写盘** —— 记录什么由我在面板上改完才落盘',
  fs.readFileSync(qNotePath, 'utf8') === noteBefore,
  '判完笔记一个字节都没动'
);
check(
  '错题本单题判分：用完的暂存图片清掉了',
  !fs.existsSync(path.join(RUN, 'uploads', qImg.name)),
  fs.existsSync(path.join(RUN, 'uploads', qImg.name)) ? '还留着' : '已清掉'
);

// 手动改完再记（这里模拟面板上改成了「失败」+ 换了个错因 + 改写了分析）
const rec = await api2('/api/checkin', {
  method: 'POST',
  body: JSON.stringify({
    id: qProblem.id,
    result: '失败',
    seconds: 245,
    reason: '公式记错',
    analysis: '我自己改过的分析：右极限必须单独求。',
    setFirstReason: true,
  }),
});
const noteAfter = fs.readFileSync(qNotePath, 'utf8');
check(
  '记录：打卡行写进了结果 / 用时 / 错因（一次练习一条，和手动打卡同一套格式）',
  rec.ok === true &&
    rec.attempt === 1 &&
    /- \[x\] 第 1 次 · 失败 · \d{4}-\d{2}-\d{2} · 245s · 错因：公式记错/.test(noteAfter),
  noteAfter.split('\n').filter((l) => l.includes('第 1 次 · 失败')).join(' | ') || '(没写进去)'
);
check(
  '记录：错因写进「首次错因」，AI 的错因分析写进 ## 错因分析（写的是我改后的版本）',
  noteAfter.includes('**首次错因**　公式记错') &&
    noteAfter.includes('最近一次判分') &&
    noteAfter.includes('我自己改过的分析：右极限必须单独求。') &&
    !noteAfter.includes('这一步把右极限直接当成了 0'),
  noteAfter.includes('公式记错') ? '首次错因 + 判分分析都写进去了' : '没写进去'
);
check(
  '记录：只动「错因分析」和「打卡记录」两节，题干与标准答案一个字节没改',
  noteAfter.includes(qProblem.stem.slice(0, 20)) &&
    noteAfter.includes('解：左极限 0，右极限 1') &&
    noteAfter.replace(/## 错因分析[\s\S]*$/, '').trimEnd() === noteBefore.replace(/## 错因分析[\s\S]*$/, '').trimEnd(),
  '正文没被动'
);
const qBack = await api2('/api/questions');
const qNow = (qBack.problems || []).find((x) => x.id === qProblem.id);
check(
  '记录：程序读回来也认得出（打卡 1 次、结果是失败、错因是公式记错、已经排了下一次）',
  qNow?.stats?.total === 1 && qNow?.stats?.last?.result === '失败' && qNow?.firstReason === '公式记错' && !!qNow?.stats?.schedule,
  `练了 ${qNow?.stats?.total} 次 · 失败 ${qNow?.stats?.fail} 次 · 下次 ${qNow?.stats?.schedule?.due}`
);
// 自己造的脏数据自己收
try {
  fs.unlinkSync(qNotePath);
} catch {
  /* 已经不在就算了 */
}

/* ---------- 6. 没配 AI 时给明确提示 ---------- */
const before = process.env.AI_API_KEY;
delete process.env.AI_API_KEY;
// 服务进程里的环境变量改不了，这里只验证「配置不完整时 /api/ai 会说清楚」
const st2 = await api2('/api/ai');
check('AI 状态：永远带一份可用的配置信息（地址/模型/key 有无）',
  typeof st2.ready === 'boolean' && Array.isArray(st2.presets) && st2.presets.length >= 5,
  `${st2.presets.length} 个预设`);
if (before) process.env.AI_API_KEY = before;

/* ---------- 收尾 ---------- */
cleanup();
const failed = results.filter((r) => !r.ok);
console.log(`\n=== 内置 AI：${results.length - failed.length}/${results.length} 通过 ===`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log('  ❌', f.label);
  process.exitCode = 1;
}
