/**
 * aigen.mjs —— 「点一下直接生成」的任务编排
 *
 * 一个任务 = 若干 **job**，一个 job = 一次模型调用 = 一个文件。
 *
 * 为什么拆成一个文件一次调用，而不是一次让模型吐全部？
 *   - 一次要 6 篇阅读（每篇 400+ 词、5 道题、解析、长难句拆解）能到两万多 token，
 *     很容易被 max_tokens 截断，而且截断后整个 JSON 都废了；
 *   - 拆开之后每篇成功就落盘一篇，进度能看见，失败了也只损失一篇。
 */

import { paperPrompt, paperRelOf, resolveTypes, distributeWords, recommendedWords, paperTypeOf } from './maimemo.mjs';
import { collectToday, dailyTestPrompt, testRelOf } from './dailytest.mjs';
import { buildWeekly } from './weekly.mjs';
import { detect, bookOf } from './create.mjs';
import { snapshot } from './notebook.mjs';
import { machineFooter, filesFooter } from './ai.mjs';
import { today } from './parse.mjs';

const SYSTEM =
  '你是一位考研（英语一 / 数学 / 408）的命题与教研老师。' +
  '你严格按照用户给出的格式要求输出，不寒暄、不加解释、不自作主张地改变结构。' +
  '当用户要求输出 JSON 时，你只输出 JSON，第一个字符是 {，最后一个字符是 }。';

/** 单词页 → 考研英语一题目。body: { words[], types[], papers, random, date } */
function planWords(cfg, body) {
  const date = body.date ? String(body.date).slice(0, 10) : today();
  const words = (body.words || []).filter((w) => w && w.voc_id && w.spelling);
  if (!words.length) throw Object.assign(new Error('先选几个单词'), { status: 400 });
  const types = resolveTypes(body.types, body.papers, !!body.random);
  const buckets = distributeWords(words, types.length);

  return types.map((id, i) => {
    const rel = paperRelOf(cfg, date, i + 1, id);
    const t = paperTypeOf(id);
    // 每篇单独出一份提示词（只含这一篇的题型和这一篇分到的词），模型一次只想一件事
    const base = paperPrompt(cfg, buckets[i], { date, types: [id] });
    return {
      rel,
      label: `${t.group === t.label ? t.label : `${t.group} · ${t.label}`}（${buckets[i].length} 词）`,
      user: base.prompt + machineFooter([rel]),
    };
  });
}

/** 今日测试 → 今天学的数学/408/笔记。body: { date } */
function planTest(cfg, body, ctx) {
  const date = body.date ? String(body.date).slice(0, 10) : today();
  const rel = testRelOf(cfg, date);
  const base = dailyTestPrompt(cfg, { ...ctx, date });
  return [
    {
      rel,
      label: `${date.slice(5)} 今日测试`,
      user: base.prompt + machineFooter([rel]),
    },
  ];
}

/** 某个任务能不能跑（缺东西就早点告诉用户，别等模型跑完才报错） */
export const AI_TASKS = {
  words: {
    label: '考研英语一题目',
    hint: '按勾选的题型和词出整套题',
    plan: planWords,
    reasoning: 'none', // 写英语长文，思考帮助不大，还拖时间
  },
  test: {
    label: '今日测试',
    hint: '按今天学的数学 / 408 / 笔记出题',
    plan: planTest,
    needsContext: true,
    reasoning: 'medium', // 数学/408 要算对，值得想
  },
  weekly: {
    label: '本周状态与建议',
    hint: '读本周计划、复盘、错题，写一段总结与下周建议',
    plan: planWeekly,
    needsContext: true,
    reasoning: 'low',
  },
  images: {
    label: '图片转题目',
    hint: '看图 → 重写题干 + 重画图形 → 写进错题本 / 好题本',
    plan: planImages,
    reasoning: 'low',
  },
  questions: {
    label: '题目答案与解析',
    hint: '把粘进来的题做出来，直接写进错题本 / 好题本',
    plan: planQuestions,
    reasoning: 'medium', // 解题要准
  },
};

/**
 * 周状态总结 → 只回一段 Markdown 正文（不是整份周计划），
 * 由程序把它插进 `## 🤖 本周状态与建议` 那一节。
 * 让模型回整份文件太危险：它会把你的计划正文一起改写。
 */
function planWeekly(cfg, body, ctx, stats) {
  const wk = ctx?.weekly || buildWeekly(cfg, stats);
  if (!wk || !wk.week) throw Object.assign(new Error('没找到本周的周计划'), { status: 400 });
  return [
    {
      rel: wk.week.rel,
      label: `本周状态与建议（${wk.week.range.start} ~ ${wk.week.range.end}）`,
      mode: 'text',
      // 提示词里那句「写进某个文件」对模型没用，这里换成「只回正文」
      user: `${wk.prompt}

---

## 【程序调用 · 最高优先级，覆盖上面所有输出要求】

上面的提示词是写给「能直接改我电脑上文件的人」看的。**现在不是**：
你只需要**返回那段要写进 \`${'## 🤖 本周状态与建议'}\` 一节的 Markdown 正文**，
程序会自己插进周计划文件里。所以：

1. **不要**输出整份周计划，**不要**自己加 \`## 🤖 本周状态与建议\` 这个标题，只给正文。
2. **不要**加任何解释、开场白、结束语，**不要**用代码围栏包起来。
3. 第一个字符就是正文的第一个字符（比如「一句话结论」或「**一句话结论**」）。`,
    },
  ];
}

/**
 * 增题 → 让模型**只解答案与解析**，笔记文件由程序按固定模板生成。
 * 这样格式一定是对的（不会因为模型少写了一节就解析不出来）。
 */
function planQuestions(cfg, body) {
  const book = body.book === 'good' ? 'good' : 'mistakes';
  const stems = (body.stems || []).map((s) => String(s || '').trim()).filter(Boolean);
  if (!stems.length) throw Object.assign(new Error('先粘题干'), { status: 400 });
  const bk = bookOf(book);

  // 先用程序自己的关键词识别分好类，把结果告诉模型
  const detected = detect(cfg, stems.join('\n\n---\n\n'), 'rule', book);
  const items = detected.items || [];
  const knownPoints = [...new Set((snapshot(cfg).problems || []).flatMap((p) => p.points || []))];

  const lines = stems.map((s, i) => {
    const d = items[i] || {};
    const where = [d.category, d.subject, d.chapter].filter(Boolean).join(' / ') || '（让它自己判断）';
    return `【第 ${i + 1} 题】归类：${where}｜编号 ${d.num ?? i + 1}\n${s}`;
  });

  return [
    {
      rel: `增题·${stems.length} 道`,
      label: `解 ${stems.length} 道题（${bk.label}）`,
      mode: 'json',
      // 这个任务不落盘文件，走的是 /api/ai/run 里的专用分支
      custom: 'questions',
      // 交给路由用：重新跑一遍关键词识别拿到分类，再写盘
      meta: { stems, book },
      user: `请把下面这些题**做出来**，并给出可以直接写进我笔记的内容。

它们会进我的${bk.label}（目录 \`${bk.dir}/\`）。程序已经用关键词做了初判，仅供参考，不合适你可以在 \`type\` / \`points\` 里体现。

${lines.join('\n\n')}

## 每道题要给我这些（严格按 JSON 返回）

- \`title\`：**短标题**，8–16 字，概括这道题在考什么（不要带题号、不要带「第几题」）
- \`type\`：考的类型，用「计算题 / 证明题 / 解答题 / 选择题 / 填空题」之一
- \`difficulty\`：1–5 的整数
- \`heat\`：考研热度 1–5 的整数
- \`points\`：考点标签 2–5 个（**能复用就复用**，下面给了题库现有的标签；确实没有的再新建）
- \`keyPoints\`：核心考点与主要难点，2–3 句话
- \`answer\`：**答案**。小题给最终结果 + 一句校验；**大题给考场上写在答题卡上的完整标准过程** ——
  以「解：」开头、一步一依据（写清用了哪个定理/公式）、行间公式单独成段、分类讨论写全、结尾出结论。
  **不要「显然」「易得」跳步，不要自创记号，也不要写成「本题考察了…」式的中文讲解。**
- \`analysis\`：**解析**，只写思路与易错点，**不要重复答案里的过程**
- \`pitfall\`：易错提醒，1–2 句

${knownPoints.length ? `题库现有的考点标签：${knownPoints.slice(0, 60).join('、')}` : '题库里现在还没有考点标签，你按需要新建。'}

## 输出格式（严格）

只输出一个 JSON 对象，不要解释、不要代码围栏，第一个字符是 \`{\`：

{"items":[{"n":1,"title":"…","type":"…","difficulty":3,"heat":4,"points":["…"],"keyPoints":"…","answer":"…","analysis":"…","pitfall":"…"}]}

\`n\` 必须和上面的题号一一对应，一道都不能漏。`,
    },
  ];
}

/**
 * 图片 → 题目。模型**看图**，把题干用文字 + LaTeX 重写出来，
 * 图里的图形用 **SVG**（文本，能落盘、能被 Obsidian 直接显示）重画一张。
 *
 * 注意：模型没法生成 png/jpg 这类二进制图，所以这里统一走 SVG。
 */
function planImages(cfg, body) {
  const names = (body.names || []).map((n) => String(n || '').trim()).filter(Boolean);
  if (!names.length) throw Object.assign(new Error('先上传题目图片'), { status: 400 });
  const book = body.book === 'good' ? 'good' : 'mistakes';
  const bk = bookOf(book);
  const reason = String(body.reason || '').trim();
  const n = names.length;

  const reasonLine =
    book === 'good'
      ? '这是一批**好题**（做对了、但方法漂亮或值得反复回的题）：**不要写 `## 错因分析` 区块**。'
      : reason
        ? `这批题的错因是「${reason}」，请写进每篇的 \`**首次错因**\`。`
        : '每篇的 `**首次错因**` 先留「⏳ 待补充」。';

  const user = `我上传了 ${n} 张题目图片，请你**看图**，把它们逐张转成我的${bk.label}笔记。

${reasonLine}

## 一、读图（最重要）

1. **不要把我的原图放进笔记。** 你看懂图里的内容之后，用**文字 + LaTeX** 把题干**完整重写**出来。
   - 数学式子一律 LaTeX：行内 \`$...$\`，行间 \`$$...$$\`
   - 手写模糊、印刷不清、被裁掉的地方，按最合理的理解补全，并在「解析」里写明你补了什么假设
2. **图里有图形的**（函数图像、几何图、二叉树、流程图、电路图、地址划分图…），
   **用 SVG 重新画一张**：写成一整个 \`<svg>…</svg>\`（带 viewBox，坐标/标注完整，深色背景上看得清），
   存成 \`${bk.dir}/picture/<短名字>.svg\`，再在笔记里用 \`![[短名字.svg]]\` 引用。
   - 不要引用我的原图路径；不要写 \`<image>\` 嵌原图
   - 纯文字题就不需要 SVG 文件
3. **一张图里有多道题的，拆成多篇**（一题一篇）。

## 二、每篇笔记的格式（严格照抄，程序要解析）

\`\`\`markdown
---
tags:
  - ${bk.label}
  - <科目>
  - <章节>
type: <计算题 / 证明题 / 解答题 / 选择题 / 填空题>
difficulty: ⭐⭐⭐☆☆
heat: 🔥🔥🔥☆☆
points:
  - <考点标签>
---

# <章节>-NN　<短标题>

## 本题档案

**考的类型**　…
**难度**　… 
**考研热度**　…

> [!note]- 展开 · 核心考点与主要难点
> …

## 题干

（文字 + LaTeX 重写后的完整题干；有图的话在这里 ![[短名字.svg]]）

## 答案

> [!success]- 展开 · 答案
> 小题给最终结果 + 一句校验；**大题给考场上写在答题卡上的完整标准过程**：
> 以「解：」开头、一步一依据、行间公式单独成段、分类讨论写全、结尾出结论。
> 不要「显然」「易得」跳步，不要自创记号。

## 解析

> [!example]- 展开 · 解析
> 只写思路与易错点，不要重复答案里的过程。

> [!warning]- 展开 · 易错提醒
> …

## 打卡记录

> 做完一次勾一个结果。
- [ ] 第 1 次 · 完美
- [ ] 第 1 次 · 普通
- [ ] 第 1 次 · 失败
\`\`\`

> **callout 里的多行内容，每一行都要以 \`> \` 开头**（空行写成单独一个 \`>\`），否则 Obsidian 会提前截断。

## 三、放哪儿、叫什么名字

- 笔记放 \`${bk.dir}/<大类>/<科目>/<章节>/<章节>-NN-<短标题>.md\`
  - 大类：数学 或 408
  - 数学的科目：高数 / 线代 / 概率论；408 的科目：数据结构 / 计算机组成原理 / 操作系统 / 计算机网络
  - 章节用标准章名（极限、连续、导数、微分、一元函数积分学、行列式、矩阵、随机事件与概率…）
  - \`NN\` 从 01 开始；标题里的章节名要和路径一致
- SVF 图放 \`${bk.dir}/picture/\`

## 四、考点标签

\`points\` 里给 2–5 个标签，**能复用就复用**，确实没有的再新建。
${(snapshot(cfg).problems || []).flatMap((p) => p.points || []).length ? `题库现有的标签：${[...new Set((snapshot(cfg).problems || []).flatMap((p) => p.points || []))].slice(0, 50).join('、')}` : '题库里还没有标签，你按需要新建。'}`;

  return [
    {
      rel: `看图写题·${n} 张`,
      label: `读 ${n} 张图 → 写成 ${bk.label}笔记`,
      mode: 'files',
      custom: 'images',
      meta: { names, book, bookDir: bk.dir, reason },
      // 这条任务的路径由模型自己起，用不了 machineFooter（那份要求「原样照抄给定路径」），
      // 但**照样得把 JSON 结构告诉它**：以前漏了这句，模型就自己起了个 `path` 字段，
      // 程序认的是 `rel`，结果一个文件都收不下，界面上只说「模型没有按 JSON 格式返回」。
      user: user + filesFooter({ dir: bk.dir, label: bk.label }),
      images: names, // 路由会把它们读成 data URL
    },
  ];
}

export function aiTaskList() {
  return Object.entries(AI_TASKS).map(([id, t]) => ({ id, label: t.label, hint: t.hint }));
}

/**
 * 建这次要跑的所有 job。
 * 返回 [{ rel, label, user }]，以及用于落盘的回调。
 */
export function planJobs(cfg, kind, body, { stats = null } = {}) {
  const task = AI_TASKS[kind];
  if (!task) throw Object.assign(new Error(`没有这个任务：${kind}`), { status: 400 });
  if (task.needsContext) {
    const ctx = kind === 'weekly'
      ? { weekly: buildWeekly(cfg, stats) }
      : collectToday(cfg, { mistakesStats: stats });
    return { jobs: task.plan(cfg, body, ctx, stats), ctx };
  }
  return { jobs: task.plan(cfg, body), ctx: null };
}

/** 单词任务还需要的默认词数（前端没传 count 时用） */
export function defaultWordCount(types) {
  return recommendedWords(types);
}

export { SYSTEM };
