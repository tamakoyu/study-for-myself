/**
 * ai.mjs —— 内置 AI（OpenAI 兼容接口）
 *
 * 只认一种协议：`POST {baseUrl}/chat/completions`，所以
 * DeepSeek / Kimi / 智谱 / 通义 / 硅基流动 / OpenAI / 本地 Ollama 全都能直接用，
 * 换个 baseUrl + model 就行。
 *
 * key 只从环境变量或 `study-app/.ai-config.json`（已 gitignore）读，**绝不写进 config.json**，
 * 也**不会通过任何接口回传给页面**。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = '.ai-config.json';

/** 常用服务商预设：填好 baseUrl 和默认模型，省得手打 */
export const AI_PRESETS = [
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', note: 'V4.1-Flash，中文强、便宜' },
  { id: 'moonshot', label: 'Kimi 月之暗面', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-32k', note: '长文友好' },
  { id: 'zhipu', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus', note: '' },
  { id: 'dashscope', label: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', note: '' },
  { id: 'siliconflow', label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3', note: '多种开源模型' },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', note: '' },
  { id: 'ollama', label: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:14b', note: '不用 key，本机跑' },
];

/** 配置文件位置；跑测试时用 AI_CONFIG_FILE 指到临时目录，别污染真的配置 */
export function configPath() {
  return process.env.AI_CONFIG_FILE
    ? path.resolve(process.env.AI_CONFIG_FILE)
    : path.join(APP_DIR, CONFIG_FILE);
}

/** 读配置：环境变量优先 → 本地文件 → config.json 里的 ai 字段 */
export function readAIConfig(cfg = {}) {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    /* 没有就用空的 */
  }
  const fromCfg = cfg.ai || {};
  const pick = (envKey, fileKey, cfgKey) =>
    String(process.env[envKey] || file[fileKey] || fromCfg[cfgKey] || '').trim();

  const apiKey = pick('AI_API_KEY', 'apiKey', 'apiKey');
  const baseUrl = pick('AI_BASE_URL', 'baseUrl', 'baseUrl').replace(/\/+$/, '');
  const model = pick('AI_MODEL', 'model', 'model');
  const temperature = Number(process.env.AI_TEMPERATURE ?? file.temperature ?? fromCfg.temperature ?? 0.7);
  const maxTokens = Number(process.env.AI_MAX_TOKENS ?? file.maxTokens ?? fromCfg.maxTokens ?? 65536);
  const timeoutMs = Number(process.env.AI_TIMEOUT_MS ?? file.timeoutMs ?? fromCfg.timeoutMs ?? 420000);
  // 思考模式：deepseek-flash 这类模型默认会先「思考」，很吃 max_tokens，也可能让「测试连接」直接失败
  const rawReasoning = String(process.env.AI_REASONING ?? file.reasoning ?? fromCfg.reasoning ?? 'auto').trim();
  const reasoning = ['auto', 'none', 'low', 'medium', 'high'].includes(rawReasoning) ? rawReasoning : 'auto';

  const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(baseUrl);
  // 哪几项被环境变量顶掉了 —— 界面要如实说明，不然在设置里改了没反应会让人一头雾水
  const fromEnv = {
    baseUrl: !!String(process.env.AI_BASE_URL || '').trim(),
    model: !!String(process.env.AI_MODEL || '').trim(),
    apiKey: !!String(process.env.AI_API_KEY || '').trim(),
  };
  return {
    baseUrl,
    apiKey,
    model,
    fromEnv,
    temperature: Number.isFinite(temperature) ? temperature : 0.7,
    reasoning,
    maxTokens: Number.isFinite(maxTokens) ? maxTokens : 65536,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 420000,
    // 本地服务通常不需要 key
    ready: !!baseUrl && !!model && (!!apiKey || isLocal),
    needsKey: !apiKey && !isLocal,
    source: process.env.AI_API_KEY || process.env.AI_BASE_URL ? 'env' : Object.keys(file).length ? 'file' : 'none',
  };
}

/** 保存配置（只认这三个 + 可选参数），返回落盘路径；**不回显 key** */
export function writeAIConfig(patch = {}) {
  const file = configPath();
  let cur = {};
  try {
    cur = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* 空的 */
  }
  const next = { ...cur };
  for (const k of ['baseUrl', 'model', 'apiKey']) {
    if (patch[k] !== undefined) {
      const v = String(patch[k] || '').trim();
      if (k === 'apiKey' && !v) continue; // 空字符串 = 不改动 key
      if (k === 'baseUrl') next[k] = v.replace(/\/+$/, '');
      else next[k] = v;
    }
  }
  if (patch.reasoning !== undefined && ['auto', 'none', 'low', 'medium', 'high'].includes(String(patch.reasoning))) {
    next.reasoning = String(patch.reasoning);
  }
  for (const k of ['temperature', 'maxTokens', 'timeoutMs']) {
    if (patch[k] !== undefined && Number.isFinite(Number(patch[k]))) next[k] = Number(patch[k]);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows 忽略 */
  }
  return file;
}

/** 给界面看的配置状态 —— **永远不含 key 本身** */
export function aiStatus(cfg = {}) {
  const c = readAIConfig(cfg);
  return {
    ready: c.ready,
    needsKey: c.needsKey,
    baseUrl: c.baseUrl,
    model: c.model,
    reasoning: c.reasoning,
    hasKey: !!c.apiKey,
    source: c.source,
    fromEnv: c.fromEnv,
    envLocked: Object.values(c.fromEnv).some(Boolean),
    file: configPath(),
    presets: AI_PRESETS,
  };
}

function humanError(status, body) {
  if (status === 401 || status === 403) return 'API key 不对或没权限（401/403）';
  if (status === 404) return '接口地址不对（404）—— baseUrl 要写到 /v1 这一层';
  if (status === 429) return '被限流了（429），等一会儿再试';
  if (status >= 500) return `模型服务出错（${status}）`;
  const msg = (() => {
    try {
      const j = JSON.parse(body);
      return j?.error?.message || j?.message || '';
    } catch {
      return String(body || '').slice(0, 200);
    }
  })();
  return msg || `请求失败（${status}）`;
}

/**
 * 调模型。默认**流式**（好显示进度），onDelta 每收到一小段就回调一次。
 * 流式不可用会自动退回非流式。
 */
export async function chat(
  cfg,
  { system, user, json = false, maxTokens, temperature, signal, onDelta, reasoning, images } = {}
) {
  const c = readAIConfig(cfg);
  if (!c.baseUrl || !c.model) throw Object.assign(new Error('还没配置 AI：填一下接口地址和模型'), { code: 'no_ai' });
  if (c.needsKey) throw Object.assign(new Error('还没填 API key'), { code: 'no_key' });

  const headers = { 'Content-Type': 'application/json' };
  if (c.apiKey) headers.Authorization = `Bearer ${c.apiKey}`;

  // 图片走 OpenAI 的多模态格式：content 变成数组，图片是 image_url 部件
  const pics = (images || []).filter(Boolean);
  const userContent = pics.length
    ? [{ type: 'text', text: user }, ...pics.map((url) => ({ type: 'image_url', image_url: { url } }))]
    : user;

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: userContent });

  /** 候选地址：`{base}/chat/completions`；带不带 `/v1` 都试一次（各家写法不一样） */
  const endpoints = (() => {
    const list = [`${c.baseUrl}/chat/completions`];
    if (/\/v1$/i.test(c.baseUrl)) list.push(`${c.baseUrl.replace(/\/v1$/i, '')}/chat/completions`);
    else list.push(`${c.baseUrl}/v1/chat/completions`);
    return list;
  })();

  const level = reasoning || c.reasoning || 'auto';
  const attempt = async (stream, withJsonMode, withReasoning, endpoint) => {
    const payload = {
      model: c.model,
      messages,
      temperature: temperature ?? c.temperature,
      max_tokens: maxTokens ?? c.maxTokens,
      stream,
    };
    if (withJsonMode) payload.response_format = { type: 'json_object' };
    // 实测 deepseek-flash：`reasoning_effort: 'none'` 能完全不思考；
    // 'minimal'/'low' 只是少想一点。不支持的厂商会在下面被降级掉。
    if (withReasoning && level !== 'auto') payload.reasoning_effort = level;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: signal || AbortSignal.timeout(c.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(humanError(res.status, text));
      err.status = res.status;
      err.body = text;
      throw err;
    }

    if (!stream) {
      const j = await res.json();
      const msg = j?.choices?.[0]?.message || '';
      const text = msg.content || '';
      if (text && j?.choices?.[0]?.finish_reason === 'length') {
        throw Object.assign(
          new Error(`输出被 max_tokens 截断了（这次写了 ${text.length} 字，额度 ${maxTokens ?? c.maxTokens}）—— 把 max_tokens 调大，或者少出几道题`),
          { code: 'truncated' }
        );
      }
      if (!text) {
        const reasonTokens = j?.usage?.completion_tokens_details?.reasoning_tokens || 0;
        const cut = j?.choices?.[0]?.finish_reason === 'length';
        const why = reasonTokens
          ? `模型把这 ${reasonTokens} 个 token 全用在「思考」上了，没轮到正文 —— 把 max_tokens 调大，或把「思考模式」设成「关」`
          : cut
            ? '输出被 max_tokens 截断了 —— 把它调大'
            : '模型返回了空内容';
        throw Object.assign(new Error(why), { code: 'empty' });
      }
      if (onDelta) onDelta(text, 'content');
      return text;
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let out = '';
    let think = 0;
    let finishReason = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          const ch = j?.choices?.[0];
          if (ch?.finish_reason) finishReason = ch.finish_reason;
          const d = ch?.delta;
          // 思考内容单独算：不然「思考阶段」界面上一直是 0 字，看着像卡住了
          if (d?.reasoning_content) {
            think += d.reasoning_content.length;
            if (onDelta) onDelta('', 'reasoning', think);
          }
          if (d?.content) {
            out += d.content;
            if (onDelta) onDelta(d.content, 'content');
          }
        } catch {
          /* 半行 / 心跳，忽略 */
        }
      }
    }
    if (!out) throw Object.assign(new Error('模型没有返回内容（可能这个模型不支持流式）'), { code: 'empty_stream' });
    // 被截断的输出一定是残的（JSON 尤其直接废掉）—— 这时候要明说，别让它去猜「格式不对」
    if (finishReason === 'length') {
      throw Object.assign(
        new Error(`输出被 max_tokens 截断了（这次写了 ${out.length} 字，额度 ${maxTokens ?? c.maxTokens}）—— 把 max_tokens 调大，或者少出几道题`),
        { code: 'truncated' }
      );
    }
    return out;
  };

  // JSON 模式 → 流式 → 非流式，逐级退让
  const tries = [];
  if (json) tries.push([true, true, true]);
  tries.push([true, false, true], [false, false, true], [false, false, false]);
  let lastErr = null;
  outer: for (const endpoint of endpoints) {
    for (const [stream, withJsonMode, withReasoning] of tries) {
      try {
        return await attempt(stream, withJsonMode, withReasoning, endpoint);
      } catch (err) {
        lastErr = err;
        // 404 = 地址写法不对，换另一个候选地址；
        // 400/422 或流式空回 = 参数不被支持，换 JSON 模式 / 非流式
        if (err.status === 404 && endpoint !== endpoints[endpoints.length - 1]) continue outer;
        if (err.code === 'truncated') throw err; // 重试救不了截断
        const retryable =
          err.code === 'empty_stream' ||
          err.status === 400 ||
          err.status === 422 ||
          /response_format|stream|reasoning/i.test(String(err.body || err.message || ''));
        if (!retryable) throw err;
      }
    }
  }
  throw lastErr || new Error('调用模型失败');
}

/**
 * 一份模型输出 → 依次吐候选 JSON 文本。
 * 每个切法（整段 / ``` 围栏里 / 第一个 `{` 到最后一个 `}` 之间）都先给**修过的**，
 * 再给原样的：因为 `\frac` `\to` 这种「合法但会吃掉 LaTeX」的转义，
 * 原样也能解析成功，只是内容已经悄悄烂了 —— 排在后面才不会被它抢先。
 */
export function* jsonCandidates(raw) {
  const fence = String(raw).match(/```(?:json)?\s*([\s\S]*?)```/);
  const a = String(raw).indexOf('{');
  const b = String(raw).lastIndexOf('}');
  const slices = [raw, fence?.[1]?.trim(), a !== -1 && b > a ? String(raw).slice(a, b + 1) : ''];
  const seen = new Set();
  const push = function* (s, repaired) {
    if (!s || seen.has(s)) return;
    seen.add(s);
    yield { text: s, repaired };
  };
  for (const s of slices) {
    if (!s) continue;
    const fixed = repairJsonEscapes(s);
    const looseFixed = repairJsonLoose(fixed);
    const loose = repairJsonLoose(s);
    if (fixed !== s) {
      yield* push(fixed, true);
      yield* push(looseFixed, true);
    }
    yield* push(s, false);
    if (loose !== s) yield* push(loose, true);
  }
}

/** 路径字段名：我们教模型用 `rel`，但它经常写成别的 —— 认得出就收下，别让一道题的格式事故废掉一整批 */
const REL_KEYS = ['rel', 'path', 'file', 'filename', 'filepath', 'file_path', 'name'];
/** 正文字段名：同理 */
const CONTENT_KEYS = ['content', 'text', 'body', 'markdown', 'md'];

/**
 * 从模型输出里抠出 `{"files":[{"rel","content"}]}`。
 * 容错：``` 围栏 / 前后有解释文字 / LaTeX 反斜杠没转义 / 尾逗号 /
 *       **字段名写成 path、file、name 之类**（模型很爱这么干）。
 * 返回 `{ files, repaired, hint }`：一个都收不下时，`hint` 说清是哪儿对不上。
 */
export function parseFilesEnvelopeEx(text) {
  const raw = String(text || '').trim();
  const pick = (j) => {
    const files = Array.isArray(j) ? j : j?.files;
    if (!Array.isArray(files)) return null;
    const out = [];
    for (const f of files) {
      if (!f || typeof f !== 'object') continue;
      const relKey = REL_KEYS.find((k) => typeof f[k] === 'string' && f[k].trim());
      const bodyKey = CONTENT_KEYS.find((k) => typeof f[k] === 'string');
      if (!relKey || !bodyKey) continue;
      out.push({ rel: f[relKey].trim(), content: f[bodyKey] });
    }
    return out.length ? out : null;
  };
  for (const c of jsonCandidates(raw)) {
    try {
      const got = pick(JSON.parse(c.text));
      if (got) return { files: got, repaired: c.repaired, hint: '' };
    } catch {
      /* 试下一个候选 */
    }
  }
  // 一个都没收下：把「它到底用了什么字段名」查清楚，别只留一句「格式不对」
  const hint = (() => {
    for (const c of jsonCandidates(raw)) {
      try {
        const j = JSON.parse(c.text);
        const first = (Array.isArray(j) ? j : j?.files || [])[0];
        if (first && typeof first === 'object') {
          const keys = Object.keys(first).join('、');
          return `它给的对象字段是「${keys}」，程序要的是 rel + content`;
        }
      } catch {
        /* 继续找 */
      }
    }
    return '';
  })();
  return { files: null, repaired: null, hint };
}

/** 老接口：只要 files 数组，认不出来就返回 null */
export function parseFilesEnvelope(text) {
  return parseFilesEnvelopeEx(text).files;
}

/** LaTeX 里以 n 打头的常见命令：只有这些才把 `\n…` 当 LaTeX，其余 `\n` 都当真的换行 */
const LATEX_N = new Set([
  'nabla', 'natural', 'ne', 'nearrow', 'neq', 'nequiv', 'ngtr', 'ngeq', 'nleq', 'nless',
  'nmid', 'nonumber', 'nolimits', 'not', 'notin', 'nparallel', 'nrightarrow', 'nleftarrow',
  'nshortmid', 'nsubseteq', 'nsupseteq', 'nsim', 'ncong', 'nvDash', 'nvdash', 'nwarrow', 'nu',
]);

/**
 * 修「字符串里被 JSON 悄悄吃掉的 LaTeX 反斜杠」。
 *
 * 数学题最容易踩两个坑，都出自同一处：模型该写 `\\lim` 却写了 `\lim`。
 *
 * 1. **非法转义**：`\l` `\s` `\c` 这些在 JSON 里不合法，`JSON.parse` 整份报错 ——
 *    表现就是「模型没有按 JSON 格式返回，这次没写盘」，一道题都进不去，而模型其实答得好好的。
 * 2. **合法但吃内容的转义**（更阴）：`\frac` 会被解成「换页符 + rac」、`\to` 解成「制表符 + o」、
 *    `\rho` 解成「回车 + ho」—— 不报错，内容却已经烂了。
 *
 * 所以这两类都要在后头补一个反斜杠，判据是**后面跟着字母**（LaTeX 命令都是字母）：
 *   - `\frac` `\to` `\tan` `\right` `\beta` → LaTeX，补
 *   - 真换行 `\n\n`、`\n##`、`\n- `、`\n下一行` → 后面不是字母，原样留着
 *   - `\n` 单独再看一层：只认上面那张 LaTeX 命令表里的词（`\nabla` 补，`\nnext` 不补），
 *     因为「换行 + 小写英文单词」在 SVG 和英文段落里也常见，不能一刀切
 */
export function repairJsonEscapes(text) {
  const always = new Set(['"', '\\', '/']); // 这几个没有歧义
  const control = new Set(['b', 'f', 'n', 'r', 't']); // 合法、但会吃掉 LaTeX 的
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (!inStr) {
      out += ch;
      if (ch === '"') inStr = true;
      continue;
    }
    if (ch === '\\') {
      const next = text[i + 1];
      if (next === undefined) {
        out += '\\\\';
        continue;
      }
      if (next === 'u') {
        const hex = text.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += `\\u${hex}`;
          i += 4;
        } else {
          out += '\\\\u';
          i += 1;
        }
        continue;
      }
      if (always.has(next)) {
        out += ch + next;
        i += 1;
        continue;
      }
      if (control.has(next)) {
        const word = (/^[A-Za-z]+/.exec(text.slice(i + 2)) || [''])[0];
        const isLatex = next === 'n' ? LATEX_N.has(word) : !!word;
        if (isLatex) out += '\\\\';
        else {
          out += ch + next;
          i += 1;
        }
        continue;
      }
      out += '\\\\';
      continue;
    }
    if (ch === '"') inStr = false;
    out += ch;
  }
  return out;
}

/**
 * 再抹掉几个不改变内容的小毛病：开头的 BOM、对象/数组的尾逗号。
 * **不碰中文引号之类的正文内容** —— 那不是格式问题，改了就是把用户的内容改坏。
 */
export function repairJsonLoose(text) {
  return text.replace(/^\uFEFF/, '').replace(/,(\s*[}\]])/g, '$1');
}

/** 括号配对扫出文本里**所有**配平的 `{...}` 片段（字符串里的花括号不算数） */
export function scanJsonObjects(text) {
  const s = String(text);
  const out = [];
  const stack = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') stack.push(i);
    else if (ch === '}') {
      const start = stack.pop();
      if (start !== undefined) out.push(s.slice(start, i + 1));
    }
  }
  return out;
}

/** 一个救回来的片段「像不像一道题」—— 不像的别硬塞进去 */
function looksLikeItem(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  return (
    Number.isFinite(Number(o.n)) ||
    (typeof o.title === 'string' && (typeof o.answer === 'string' || typeof o.keyPoints === 'string'))
  );
}

/** 一段模型原文的摘要，用在失败提示里 —— 别只说「格式不对」，得让人看见它到底回了什么 */
export function snippet(text, n = 200) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * 从模型输出里抠出 `{"items":[...]}`（增题用）。
 *
 * 返回 `{ items, repaired, raw, envelope }`：
 *   - `items` 为 null 表示真的一个都认不出来
 *   - `repaired` 说明这份 JSON 是「修过才认出来的」，还是要逐题救回来的
 *     （界面上要如实说，不能默默写一份可能缺项的笔记）
 *   - `envelope` 是**整份对象**（`{items, summary, weak, next, …}`）。判分要用它：
 *     总评 / 薄弱点 / 下一步和 items 是平级的，光把 items 交出去，那三项就被丢了 ——
 *     成绩单上于是永远没有总评。（逐题救回来的那种，只有 items 能救回来，envelope 就只有 items）
 */
export function parseItemsEnvelopeEx(text) {
  const raw = String(text || '').trim();
  const pick = (j) => {
    const items = Array.isArray(j) ? j : j?.items;
    if (!Array.isArray(items)) return null;
    const out = items.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
    return out.length ? out : null;
  };

  for (const c of jsonCandidates(raw)) {
    try {
      const j = JSON.parse(c.text);
      const got = pick(j);
      if (got) {
        return {
          items: got,
          repaired: c.repaired ? 'repaired' : null,
          raw,
          envelope: Array.isArray(j) ? { items: got } : j,
        };
      }
    } catch {
      /* 试下一个候选 */
    }
  }

  // 整份 JSON 彻底坏了（常见于最后一道题被截断 / 中间少了个逗号）：
  // 逐题把完整的对象救回来 —— 能写几道是几道，别让一次格式事故废掉整批题
  const byN = new Map();
  const extra = [];
  for (const chunk of scanJsonObjects(raw)) {
    for (const c of jsonCandidates(chunk)) {
      try {
        const one = JSON.parse(c.text);
        if (!looksLikeItem(one)) break;
        if (Number.isFinite(Number(one.n))) byN.set(Number(one.n), one);
        else extra.push(one);
        break;
      } catch {
        /* 这一块再试下一种修法 */
      }
    }
  }
  const salvaged = [...byN.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]).concat(extra);
  if (salvaged.length) return { items: salvaged, repaired: 'partial', raw, envelope: { items: salvaged } };
  return { items: null, repaired: null, raw, envelope: null };
}

/**
 * 从模型输出里抠出任意一个 JSON 对象（不限定结构）。
 * 容错和上面两个一样：裸 JSON / 被 ``` 包住 / 前后有解释文字 / LaTeX 反斜杠没转义都认。
 * 单题判分那种「一个对象、不是 items 数组」的返回用这个。
 */
export function parseJsonEnvelope(text) {
  for (const c of jsonCandidates(String(text || '').trim())) {
    try {
      const j = JSON.parse(c.text);
      if (j && typeof j === 'object') return j;
    } catch {
      /* 试下一个候选 */
    }
  }
  return null;
}

/** 追加给模型的「只吐 JSON」的收尾指令（覆盖提示词里那些「写进文件」「回我一份」的说法） */
export function machineFooter(rels) {
  return `

---

## 【程序调用 · 最高优先级，覆盖上面所有输出要求】

上面的提示词是写给「能直接改我电脑上文件的人」看的。**现在不是那样**：你只需要**返回文本**，
由我的程序解析后落盘。所以：

1. **忽略**上面所有「直接写进某个文件」「写完在对话里告诉我」之类的话。
2. **只输出一个 JSON 对象**，不要任何解释、不要开场白、不要 Markdown 代码围栏。
3. 结构严格如下：

{"files":[{"rel":"<文件相对路径>","content":"<这个文件的完整 Markdown 全文>"}]}

4. \`rel\` 必须**原样照抄**下面这些路径，一个不多一个不少：
${rels.map((r) => `   - ${r}`).join('\n')}
5. \`content\` 是这个文件的**完整内容**（要包含 frontmatter），换行写成 \\n。
   不要在 content 里再嵌套 JSON，也不要把多个文件的内容合并到一个 rel 里。
6. 除 JSON 外不要输出任何字符 —— 第一个字符必须是 \`{\`，最后一个必须是 \`}\`。`;
}

/**
 * 「把这批新题归进题型本」用的收尾指令。
 *
 * 归类要改的是**已有的通解文件**（把新题 id 追加进 related），
 * 所以得说清：要返回的是整份文件的全文，正文一个字节都不能丢 ——
 * 程序是按整份替换写的。
 */
export function patternFooter(dir = '题型本') {
  return `

---

## 【程序调用 · 最高优先级，覆盖上面所有输出要求】

上面那些「写进某个文件」的话，是写给「能直接改我电脑上文件的人」看的。**现在不是那样**：
你只需要**返回文本**，由我的程序解析后落盘。所以：

1. **只输出一个 JSON 对象**，不要解释、不要开场白、不要 Markdown 代码围栏。
2. 结构严格如下：

{"files":[{"rel":"${dir}/数学/高数/极限/等价无穷小的替换与阶的判定.md","content":"<这份通解的完整 Markdown 全文>"}]}

3. **字段名只能是 \`rel\` 和 \`content\`**（不许叫 \`path\`、\`file\`、\`name\`）。
4. **只返回 \`${dir}/\` 下的文件**，不要动错题本 / 好题本里的任何东西。
5. 能并进已有通解的：把新题 id 追加进那份通解的 \`related:\`，**并把这份通解的完整内容一起返回**
   （程序整份替换，所以标题、正文、其他 related 一个字节都不能少，也别改写正文）。
   确实是新题型的，才在 \`${dir}/<大类>/<科目>/<章节>/<题型名>.md\` 新建一份。
6. \`related\` 里的 id **原样照抄**上面给的 id，一个字都不能改。
7. 除 JSON 外不要输出任何字符 —— 第一个字符必须是 \`{\`，最后一个必须是 \`}\`。`;
}

/**
 * 「看图写题」这类**路径由模型自己起**的任务用的收尾指令（增题的图片那条路）。
 *
 * 以前这条任务忘了加收尾指令 —— 提示词里只说了「存成 错题本/picture/xxx.svg」，
 * 从没说过要用什么结构返回。于是模型自己起了个字段名 `path`，
 * 程序认的是 `rel`，一个文件都收不下，界面却只说「模型没有按 JSON 格式返回」。
 * 所以这里不但给结构，还专门把**不许改的字段名**点名说清楚。
 */
export function filesFooter({ dir = '错题本', label = '错题本' } = {}) {
  return `

---

## 【程序调用 · 最高优先级，覆盖上面所有输出要求】

上面那些「存成某个文件」的话，是写给「能直接改我电脑上文件的人」看的。**现在不是那样**：
你只需要**返回文本**，由我的程序解析后落盘。所以：

1. **忽略**上面所有「直接写进某个文件」「写完告诉我」之类的话。
2. **只输出一个 JSON 对象**，不要解释、不要开场白、不要 Markdown 代码围栏。
3. 结构严格如下：

{"files":[{"rel":"${dir}/数学/高数/极限/极限-10-短标题.md","content":"<这篇笔记的完整 Markdown 全文>"}]}

4. **字段名只能是 \`rel\` 和 \`content\`** —— 不许叫 \`path\`、\`file\`、\`filename\`、\`name\`、\`files[].file\`。
   写错字段名，程序就一个文件都收不下，这一批题等于白做。
5. \`rel\` 从仓库根算起，以 \`${dir}/\` 开头（一题一篇 md，画了图的再给一份 \`${dir}/picture/xxx.svg\`），
   路径里的目录可以按题目内容自己起。**一个文件一个对象，别把两篇笔记并进一个 \`content\`。**
6. \`content\` 是这篇的完整内容（要含 frontmatter），换行写成 \\n，里面不要再嵌套 JSON。
7. 除 JSON 外不要输出任何字符 —— 第一个字符必须是 \`{\`，最后一个必须是 \`}\`。`;
}
