/**
 * dailytest.mjs —— 今日测试
 *
 * 考什么：**只看今天**。
 *   1. 本周周计划里标了今天日期的任务，加上「每天都要做」的（数学 / 408）
 *   2. 今天动过的笔记（`noteDirs` 里 mtime 是今天的 .md）—— 「今日刚记录的内容」
 *   3. 今天的复盘（有的话）
 *   4. 最近的错题与薄弱考点 —— 用来挑「易错点」
 *
 * 程序不出题，它只把上面这些事实整理成提示词。你复制发给我，我出好题写进
 * `今日测试/<日期>-今日测试.md`，这个页面就会渲染成大屏试卷（答案默认藏着）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { scanPlans, weekPlanFor } from './plans.mjs';
import { walkMarkdown, backupFile } from './vault.mjs';
import { listReviews } from './reviews.mjs';
import { today } from './parse.mjs';
import {
  TEST_FULL, scoreFromHead, gradePaper, readGradeRecords, writeGradeRecord, preserveGradeSection,
} from './grade.mjs';

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 测试目录（仓库里，默认 `今日测试/`） */
export function testDirOf(cfg) {
  return cfg.testDir || path.join(cfg.vaultDir, '今日测试');
}

export function testRelOf(cfg, date) {
  return `${path.basename(testDirOf(cfg))}/${date}-今日测试.md`;
}

function testAbsOf(cfg, rel) {
  const dir = testDirOf(cfg);
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.includes('..')) throw Object.assign(new Error('非法路径'), { status: 400 });
  const abs = path.resolve(cfg.vaultDir, clean);
  if (!abs.startsWith(dir + path.sep)) throw Object.assign(new Error('只能读写测试目录里的文件'), { status: 403 });
  if (!abs.endsWith('.md')) throw Object.assign(new Error('只能操作 .md 文件'), { status: 400 });
  return abs;
}

/* ============================================================
   今天学了什么
   ============================================================ */

const MATH_RE = /数学|高数|线代|概率|微积分|导数|极限|积分|矩阵|行列式|随机变量/;
const CS_RE = /408|数据结构|操作系统|计算机组成|计算机网络|C 语言|算法|进程|TCP|链表|排序|树/;

/** 今天 00:00 的时间戳（本地时区） */
function startOfDay(date) {
  const [y, m, d] = String(date).split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0).getTime();
}

/** 笔记正文压一压：太长就截断，够 AI 判断考点就行 */
function excerpt(text, limit = 1400) {
  const clean = String(text || '')
    .replace(/^---[\s\S]*?---\s*/, '') // 去掉 frontmatter
    .trim();
  return clean.length > limit ? `${clean.slice(0, limit)}\n…（后面省略）` : clean;
}

/**
 * 收集今天的学习事实。
 * 不联外网、也不写盘 —— 只读仓库。
 */
export function collectToday(cfg, { date = today(), mistakesStats = null } = {}) {
  const plans = scanPlans(cfg.planDir, cfg.vaultDir);
  const week = weekPlanFor(plans, date);

  const tasks = week
    ? week.taskGroups.flatMap((g) => g.tasks.map((t) => ({ ...t, group: g.name })))
    : [];
  // 今天该做的：标了今天日期的 + 每天都要做的
  const todayTasks = tasks.filter((t) => t.daily || t.date === date);
  // 🔁 每日任务的完成按「今天」算：今天那行打卡在不在
  const doneOn = (t) => (t.daily ? t.checkins.includes(date) : !!t.done);

  const pick = (re) =>
    todayTasks
      .filter((t) => re.test(`${t.group} ${t.text}`))
      .map((t) => ({ group: t.group, text: t.text.replace(/^🔁\s*/, ''), done: doneOn(t) }));

  const math = pick(MATH_RE);
  const cs = pick(CS_RE);
  const used = new Set([...math, ...cs].map((t) => `${t.group}|${t.text}`));
  const other = todayTasks
    .filter((t) => !used.has(`${t.group}|${t.text}`))
    .map((t) => ({ group: t.group, text: t.text.replace(/^🔁\s*/, ''), done: doneOn(t) }));

  // 今天动过的笔记；今天没记的话，把最近 3 天的也带上（会标明「不是今天的」）
  const since = startOfDay(date);
  const sinceRecent = since - 3 * 86400000;
  const notes = [];
  const recentNotes = [];
  for (const dir of cfg.noteDirs || []) {
    const root = path.join(cfg.vaultDir, dir);
    if (!fs.existsSync(root)) continue;
    for (const f of walkMarkdown(root)) {
      if (f.mtime < sinceRecent) continue;
      let body = '';
      try {
        body = excerpt(fs.readFileSync(f.abs, 'utf8'));
      } catch {
        continue;
      }
      const row = { rel: f.rel, dir, mtime: f.mtime, body };
      if (f.mtime >= since) notes.push(row);
      else recentNotes.push(row);
    }
  }
  notes.sort((a, b) => b.mtime - a.mtime);
  recentNotes.sort((a, b) => b.mtime - a.mtime);

  // 今天的复盘
  let review = null;
  try {
    const found = listReviews(cfg.reviewDir, cfg.vaultDir).find((r) => r.date === date);
    if (found) {
      const abs = path.join(cfg.vaultDir, found.rel);
      if (fs.existsSync(abs)) review = { rel: found.rel, body: excerpt(fs.readFileSync(abs, 'utf8'), 900) };
    }
  } catch {
    /* 没复盘就算了 */
  }

  const m = mistakesStats || {};
  const weakPoints = (m.byPoint?.rows || []).slice(0, 10).map((r) => `${r.key}（${r.total} 题，失败 ${r.fail} 次）`);
  const troubled = (m.troubled || []).slice(0, 8).map((p) => `${p.num}${p.title ? ` ${p.title}` : ''}`);

  // 「今天学了多少」：题量要按这个动态定，别不管三七二十一都出 5 道
  const taskCount = math.length + cs.length;
  const noteChars = notes.reduce((n, x) => n + (x.body || '').length, 0);
  const score = taskCount + notes.length * 2 + Math.min(4, Math.floor(noteChars / 600)) + (review ? 1 : 0);
  const volume = score >= 8 ? '多' : score >= 4 ? '一般' : '少';

  return {
    date,
    weekday: WEEKDAY[new Date(`${date}T00:00:00`).getDay()],
    week: week ? { rel: week.rel, range: week.range, title: week.title } : null,
    learned: {
      tasks: taskCount,
      mathTasks: math.length,
      csTasks: cs.length,
      notes: notes.length,
      noteChars,
      hasReview: !!review,
      volume,
      score,
    },
    math,
    cs,
    other,
    notes,
    recentNotes,
    review,
    weakPoints,
    troubled,
    mistakes: m.totals ? { total: m.totals.total, pending: m.totals.pending, due: m.due?.length || 0 } : null,
  };
}

/* ============================================================
   提示词
   ============================================================ */

const listOr = (arr, fmt, empty = '（今天没有）') => (arr.length ? arr.map(fmt).join('\n') : empty);

/**
 * 出题提示词。核心是「只考今天学过的」，以及题量卡在 30 分钟以内。
 */
export function dailyTestPrompt(cfg, ctx) {
  const { date } = ctx;
  const rel = testRelOf(cfg, date);

  const mathBlock = listOr(ctx.math, (t) => `- [${t.group}] ${t.text}${t.done ? '（已完成）' : ''}`);
  const csBlock = listOr(ctx.cs, (t) => `- [${t.group}] ${t.text}${t.done ? '（已完成）' : ''}`);
  const noteBlock = listOr(
    ctx.notes,
    (n) => `### ${n.rel}\n${n.body}`,
    '（今天还没记笔记 —— 那就只按上面的计划和下面的最近笔记出题）'
  );
  const recentBlock = (ctx.recentNotes || []).length
    ? `## 最近几天记的笔记（**不是今天的**，只在今天的内容不够出题时参考）\n\n${ctx.recentNotes
        .map((n) => `### ${n.rel}\n${n.body}`)
        .join('\n\n')}\n`
    : '';

  const L = ctx.learned || {};
  // 上限一小时：宁可多覆盖几个知识点，也别漏
  const volumeHint =
    L.volume === '多'
      ? '**今天学得不少** → 出 10–14 道，总时长 45–60 分钟'
      : L.volume === '一般'
        ? '**今天学得一般** → 出 6–10 道，总时长 30–45 分钟'
        : '**今天学得不多** → 出 3–5 道，总时长 20–30 分钟';

  const prompt = `请根据我**今天实际学的内容**，出一份今日测试，写进我的仓库。

今天是 ${date}（${ctx.weekday}）。
${ctx.week ? `本周：${ctx.week.title}（${ctx.week.range.start} ~ ${ctx.week.range.end}）` : ''}

**先看这一行，它决定这次出多少题**：今天的输入是
${L.tasks || 0} 条计划任务（数学 ${L.mathTasks || 0} · 408 ${L.csTasks || 0}）、
${L.notes || 0} 篇今日笔记（约 ${L.noteChars || 0} 字）、
${L.hasReview ? '写了今日复盘' : '没写今日复盘'} → **判断：${L.volume || '一般'}**。
所以：${volumeHint}。

## 今天计划里的数学

${mathBlock}

## 今天计划里的 408

${csBlock}

## 今天刚记录的笔记（这是最要紧的：要考就考这里面的）

${noteBlock}

${recentBlock}
${ctx.review ? `## 今天的复盘（**这里面写了我今天到底学了什么、哪里没懂、哪里容易错，最该拿来出题**）\n\n${ctx.review.body}\n` : ''}
## 我最近的薄弱点（挑「易错点」时参考）

- 薄弱考点：${ctx.weakPoints.length ? ctx.weakPoints.join('、') : '还没打标签'}
- 反复做错的题：${ctx.troubled.length ? ctx.troubled.join('、') : '无'}

## 出题要求

1. **只考今天出现过的内容** —— 上面这些计划任务、今日笔记、今日复盘、薄弱点里出现过的知识点。
   今天没碰的东西**一个都别出**；每道题都要能对上「今天哪一条任务 / 哪一篇笔记」。
2. **覆盖优先，题量服从覆盖**：先盘点「今天真正学到的重要知识点」（今天学得多就多列几个），
   然后**每个重要知识点至少出一道题**，尽量**一个都不漏**。考完要能回答
   「今天学的东西我是不是都过了一遍」。
   - **一道题可以有多个小问**，用 (1)(2)(3) 分开 —— 这是把覆盖做全的好办法：
     比如「公式默写」一问写公式、二问写适用条件；「大题」一问证存在性、二问求值。
   - 反过来，**同一个小知识点不要连着出三道**；宁可用一个大题的两个小问把它考透。
   - 今天内容实在撑不起上面那个题量，就少出几道（内容说话），但**别漏知识点**、也别硬凑。
3. **题量按今天学了多少动态定**（就是上面那一行判断），**别不管学多学少都出 5 道**；
   **总时长最多 60 分钟，不要超过**。
4. **题型跟着内容走，这五种都能用，不要只用一种**：
   - **概念填空**：今天讲了新概念 / 新术语 → 做成填空，挖定义里的关键词。
     （例：「在单链表中，头结点的作用是 ______。」）
   - **公式默写**：今天出现或复习了公式 / 定理 / 结论 → 默写出来，**并注明适用条件**。
     （例：写出洛必达法则的三个前提；写出连续的定义式）
   - **选择题**：适合考**辨析**、边界条件、易混概念。4 个选项，干扰项要有道理（常见的想当然的错法）。
   - **计算 / 填空题**：有明确结果的小题，给具体数字 / 函数 / 矩阵，不要「试举一例说明」。
   - **大题**（解答 / 证明）：今天的主线知识点，需要完整过程的那种。
5. **基础阶段（刚开始学、内容是入门概念）** → 多出**概念填空和公式默写**，不要硬出大题；
   **进入计算 / 证明主线** → 多出计算题和大题。今天 408 如果只是装环境、讲存储模型这类，
   就该出概念填空而不是代码题。
6. 数学的公式、符号一律用 LaTeX 行内写法 \`$...$\`，行间公式单独成段用 \`$$...$$\`。
7. **不要为了难而难**：考的是「今天学的这些我到底掌握没有」，不是竞赛题。

## 分值（**这次必须标分值，我要拿它算分**）

1. **满分 100 分**：全部题的分值加起来**必须正好等于 100**，不许四舍五入凑。
2. 分值写在**每题标题的最后一段**，格式就是 \`｜ 12 分\`（见下面的输出格式）。
3. 怎么给分，按考研卷子的习惯来 —— **分值要跟这道题的分量对得上**：
   - **概念填空 / 公式默写**：4–8 分（一个空 2–4 分，别一空 10 分）
   - **选择题**：4–6 分（考研选择题就是这个量级）
   - **填空题 / 计算小题**：6–10 分
   - **大题（解答 / 证明）**：10–20 分（有多小问的按小问拆，比如 (1) 8 分、(2) 10 分）
4. **分值要能反映「这道题值多少时间」**：给分高的题就是该多花时间的题。
5. 小题多的时候（比如 8 道概念填空）别平均分 —— 挑其中更重要的给高一点。

## 参考用时怎么给（程序会按分值折算，你不用自己写每题用时）

我会用你写在 frontmatter 里的 \`minutes\`（整卷预计时长）**按分值比例**折算到每一题。
所以 \`minutes\` 要估得实在：**这是「认真做完、不慌不忙」要多久**，不是最快多久。
宁可估宽一点，别估得太乐观 —— 参考用时的用处就是让我知道「超时了没有」。

## 答案与解析的要求（这部分最重要）

- **大题的标准答案必须是考场上写在答题卡上的那种完整过程**：
  以「解：」开头、**一步一依据**（写清用了哪个定理/哪个公式）、行间公式单独成段、
  分类讨论写全、结尾出结论。**不要「显然」「易得」跳步，不要自创记号。**
  **不要那种「本题考察了…的思路」式的中文讲解** —— 答案就是答案。
- **解析**另起一段，逐步说清**每一步为什么这么做**：
  这一步的动机是什么（看到什么信号该想到什么方法）、容易在哪里出错
  （比如忘了讨论 $x=0$、忘了定义域、符号写反、边界条件漏了），
  以及**这道题属于今天哪条内容的延伸**。
- 选择题要写清**每个干扰项为什么错**。
- 填空和公式默写：答案给准确结果（有多个解的写全），解析说明怎么得到、以及常见的错法。

## 输出格式（请严格照抄，我要用程序解析）

**直接写进 \`${rel}\`**（文件不存在就新建，已存在就覆盖）：

---
date: ${date}
title: ${date.slice(5)} 今日测试
scope: （一句话写清覆盖了今天哪几块内容）
minutes: （这份测试预计做多少分钟，按上面的题量估）
full: 100
---

# ${date.slice(5)} 今日测试

> 覆盖：**把你这次考到的知识点列出来**（对应上面盘点的结果），用「、」隔开

## 题目

### 1. 题型 ｜ 具体考点 ｜ 12 分

（题干）

### 2. 题型 ｜ 具体考点 ｜ 8 分

（题干）

## 答案与解析

### 1. 题型 ｜ 具体考点 ｜ 12 分

**标准答案**

（直接把答案写出来）

**解析**

- 第一步……
- 易错点……

### 2. 题型 ｜ 具体考点 ｜ 8 分

**标准答案**

解：……

（完整、一步一依据的过程）

**解析**

- 为什么这样切入……
- 每一步的依据……
- 容易错在哪里……

## 说明

- 「题目」和「答案与解析」两节里的编号必须**一一对应**（都是 \`### 数字. 题型 ｜ 考点 ｜ 分值 分\`），
  连**分值也要一模一样** —— 程序要靠这一行把题和答案、分值对上。
- \`题型\` 用这五个之一：**概念填空 / 公式默写 / 选择题 / 填空题 / 大题**。
- **\`考点\` 要用中文可读的说法，不要写 LaTeX**：写「1的无穷大型」「等价无穷小替换」，
  **不要写** \`$1^{\\infty}$ 型\` 这种。考点名会被拿去做文件名和标签，带公式会很别扭。
  **考点名里不要出现 \`｜\`（竖线）**，也不要以「N 分」结尾。
- **每题最后那一段就是分值**，写成 \`｜ 12 分\`（数字 + 一个空格 + 「分」）。
  这是程序唯一的判分依据，**全卷加起来必须正好 100**。
- 序号从 1 连续排到底，中间不要跳号。
- 写完后在对话里只告诉我：**覆盖了哪几个知识点、一共几道题、分别是什么题型、每题多少分、预计多少分钟**，
  不用把全文贴给我。
`;

  return { prompt, date, rel, ctx };
}

/* ============================================================
   存取
   ============================================================ */

/** 取 `## 名字` 这一节 */
function sectionOf(body, name) {
  const m = new RegExp(`^##\\s*${name}\\s*$`, 'm').exec(String(body));
  if (!m) return '';
  const rest = String(body).slice(m.index + m[0].length);
  const cut = rest.search(/^##\s/m);
  return (cut === -1 ? rest : rest.slice(0, cut)).trim();
}

/**
 * 把 `### 1. 填空 ｜ 考点 ｜ 8 分` 拆成 [{n, type, topic, score, body}]。
 * 分值写在最后一段（`｜ 8 分`）或者括号里（`（8 分）`），没有就是 null —— 见 grade.mjs。
 */
function splitItems(section) {
  const out = [];
  const re = /^###\s*(\d{1,2})\s*[.．、]\s*(.+?)\s*$/gm;
  const hits = [...String(section).matchAll(re)];
  hits.forEach((m, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].index : String(section).length;
    const head = m[2].trim();
    const parts = head.split(/[｜|]/).map((x) => x.trim());
    out.push({
      n: Number(m[1]),
      head,
      type: parts[0] || head,
      topic: parts[1] || '',
      score: scoreFromHead(head),
      body: String(section).slice(m.index + m[0].length, end).trim(),
    });
  });
  return out;
}

function parseTest(text) {
  const fm = {};
  const fmMatch = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmMatch) {
    for (const line of fmMatch[1].split(/\r?\n/)) {
      const kv = line.match(/^([^\s:][^:]*?)\s*:\s*(.*)$/);
      if (kv) fm[kv[1].trim()] = kv[2].trim();
    }
  }
  const body = (fmMatch ? String(text).slice(fmMatch[0].length) : String(text)).replace(/^\s*\n/, '');
  const h1 = body.match(/^#\s+(.+)$/m);

  const questions = splitItems(sectionOf(body, '题目'));
  const answers = splitItems(sectionOf(body, '答案与解析'));
  const byN = new Map(answers.map((a) => [a.n, a]));

  // 题和答案按题号对上；只有题目没答案也给，页面上那题就只显示题干
  const items = questions.map((q) => {
    const a = byN.get(q.n);
    const split = splitAnswer(a?.body || '');
    return {
      ...q,
      answerType: a?.type || '',
      answer: a?.body || '',
      // 拆好的两段：写进错题本 / 判分提示词都要用，省得各处再拆一遍
      answerText: split.answer,
      analysisText: split.analysis,
    };
  });

  const paper = { kind: 'test', minutes: Number(fm.minutes) || 30, full: Number(fm.full) || TEST_FULL, items };

  return {
    title: fm.title || (h1 ? h1[1].trim() : ''),
    scope: fm.scope || '',
    minutes: paper.minutes,
    full: paper.full,
    body,
    items,
    answerMissing: questions.filter((q) => !byN.get(q.n)).map((q) => q.n),
    grades: readGradeRecords(body),
    // 分值 + 参考用时：判分和页面上的「参考用时」都用它
    plan: gradePaper(paper),
  };
}

/**
 * 把一道题的答案块拆成「标准答案」和「解析」两段（给写进错题本用）。
 * 约定用 `**标准答案**` / `**解析**` 两个小标题分开；没有就整段当答案。
 */
export function splitAnswer(text) {
  const t = String(text || '').trim();
  if (!t) return { answer: '', analysis: '' };
  const m = t.match(/\*\*解析\*\*([\s\S]*)$/);
  const analysis = m ? m[1].trim() : '';
  const answer = t
    .replace(/\*\*解析\*\*[\s\S]*$/, '')
    .replace(/^\*\*标准答案\*\*\s*/, '')
    .trim();
  return { answer, analysis };
}

export function listTests(cfg) {
  const dir = testDirOf(cfg);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const abs = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    let parsed = { title: '', scope: '', minutes: 30, items: [], full: TEST_FULL, grades: [] };
    try {
      parsed = parseTest(fs.readFileSync(abs, 'utf8'));
    } catch {
      /* 读不了就只当文件名 */
    }
    const last = parsed.grades?.[0] || null;
    out.push({
      date: (name.match(/^(\d{4}-\d{2}-\d{2})/) || [, name.replace(/\.md$/, '')])[1],
      rel: `${path.basename(dir)}/${name}`,
      title: parsed.title || name.replace(/\.md$/, ''),
      scope: parsed.scope,
      minutes: parsed.minutes,
      full: parsed.full || TEST_FULL,
      // 参考用时（分钟）：出题时估的总时长，页面上跟「满分」并排显示
      refMinutes: parsed.plan?.ref?.minutes || parsed.minutes,
      count: parsed.items.length,
      done: parsed.items.filter((q) => q.answer).length,
      // 最近一次判分：列表上直接看得到分数，不用点进去
      // missing 一起带上：有题模型没判到时得在列表上说一声，不然总分看着像自己考砸了
      last: last
        ? { total: last.total, full: last.full, date: last.date, seconds: last.seconds, missing: last.missing || 0 }
        : null,
      mtime: st.mtimeMs,
    });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || b.mtime - a.mtime);
}

export function readTest(cfg, rel) {
  const abs = testAbsOf(cfg, rel);
  const cleanRel = `${path.basename(testDirOf(cfg))}/${path.basename(abs)}`;
  if (!fs.existsSync(abs)) {
    return { rel: cleanRel, exists: false, title: '', items: [], body: '', content: '', grades: [], full: TEST_FULL };
  }
  const content = fs.readFileSync(abs, 'utf8');
  const parsed = parseTest(content);
  const last = parsed.grades?.[0] || null;
  return {
    rel: cleanRel,
    exists: true,
    content,
    body: parsed.body,
    title: parsed.title,
    scope: parsed.scope,
    minutes: parsed.minutes,
    full: parsed.full,
    items: parsed.items,
    answerMissing: parsed.answerMissing,
    // 分值 + 参考用时（每题、整卷都有），页面上的计时器和判分都按它来
    plan: parsed.plan,
    grades: parsed.grades,
    last,
    mtime: fs.statSync(abs).mtimeMs,
  };
}

/**
 * 存一份试卷。**重新生成时把成绩记录接回去** ——
 * 那是学习记录，不该因为「今天重出了一次题」就没了。
 */
export function saveTest(cfg, rel, content) {
  const abs = testAbsOf(cfg, rel);
  let body = String(content ?? '').trim();
  if (!body) throw Object.assign(new Error('内容是空的'), { status: 400 });
  if (fs.existsSync(abs)) {
    try {
      body = preserveGradeSection(fs.readFileSync(abs, 'utf8'), body);
    } catch {
      /* 旧的读不了就照新写 */
    }
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (fs.existsSync(abs)) backupFile(abs, cfg.vaultDir, cfg.backupDir, 'test');
  fs.writeFileSync(abs, `${body}\n`, 'utf8');
  return { ok: true, rel: `${path.basename(testDirOf(cfg))}/${path.basename(abs)}`, abs };
}

/**
 * 把一次判分成绩写回试卷文件的 `## 成绩记录` 一节（先备份）。
 * 只动这一节，题干 / 答案 / 解析一个字节都不改。
 */
export function saveTestGrade(cfg, rel, recordMarkdown) {
  const abs = testAbsOf(cfg, rel);
  if (!fs.existsSync(abs)) throw Object.assign(new Error('这份试卷不在了'), { status: 404 });
  const content = fs.readFileSync(abs, 'utf8');
  const next = writeGradeRecord(content, recordMarkdown);
  backupFile(abs, cfg.vaultDir, cfg.backupDir, 'grade');
  fs.writeFileSync(abs, next, 'utf8');
  return { ok: true, rel: `${path.basename(testDirOf(cfg))}/${path.basename(abs)}`, abs };
}
