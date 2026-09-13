/**
 * create.mjs —— 增题：把粘贴的题干变成一篇结构完整的错题骨架
 *
 * 只负责「机械活」：分大类、分科目、分章节、定题型、编号、命名、套格式、写盘。
 * 答案/解析/考点/难点/易错 一律留 `⏳ 待补充` 占位，等真正会做题的大脑来填。
 */

import fs from 'node:fs';
import path from 'node:path';
import { detect, detectType, slugOf, TAXONOMY, CATEGORIES, UNCLASSIFIED } from './taxonomy.mjs';

export { detect, detectType, slugOf };

/** 把 \( \) \[ \] 统一成 $ $ / $$ $$ */
export function normalizeMath(src) {
  return String(src || '')
    .replace(/\\\[([\s\S]+?)\\\]/g, (_m, t) => `\n$$\n${t.trim()}\n$$\n`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_m, t) => `$${t.trim()}$`)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 文件名里不能出现的字符 */
export function safeName(s) {
  return (
    String(s || '新题')
      .replace(/[/\\:*?"<>|#[\]]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40) || '新题'
  );
}

/** 某科目某章节下已有的最大编号；chapter 为空表示直接放在科目目录下 */
export function nextNumber(rootDir, category, subject, chapter) {
  const dir = chapter
    ? path.join(rootDir, category, subject, chapter)
    : path.join(rootDir, category, subject);
  let max = 0;
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^[^-]+-(\d+)[-\s]/);
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return max + 1;
}

/** 按 `---` / 空行 / 整段 切分粘贴内容 */
export function splitProblems(raw, mode = 'rule') {
  const text = String(raw || '').trim();
  if (!text) return [];
  let parts;
  if (mode === 'whole') parts = [text];
  else if (mode === 'blank') parts = text.split(/\n\s*\n/);
  else parts = /\n\s*-{3,}\s*\n/.test(text) ? text.split(/\n\s*-{3,}\s*\n/) : [text];
  return parts.map((p) => p.trim()).filter(Boolean);
}

const DIFF_WORD = { 1: '送分', 2: '基础', 3: '中档', 4: '较难', 5: '压轴' };
const HEAT_WORD = { 1: '极少单独考', 2: '低频', 3: '中频', 4: '高频', 5: '超高频' };

/** 生成一篇骨架笔记 */
export function renderNote({ subject, chapter, num, slug, stem, type, difficulty = 3, heat = 3, title, reason }) {
  const pad = String(num).padStart(2, '0');
  const stars = '⭐'.repeat(difficulty) + '☆'.repeat(5 - difficulty);
  const fires = '🔥'.repeat(heat) + '☆'.repeat(5 - heat);
  const headline = title || slug;

  return `---
tags:
  - 错题本
  - ${subject}
  - ${chapter}
type: ${type}
difficulty: ${stars}
heat: ${fires}
---

# ${chapter}-${pad}　${headline}

## 本题档案

**考的类型**　${type}
**难度**　${stars} · ${DIFF_WORD[difficulty] || '中档'}
**考研热度**　${fires} · ${HEAT_WORD[heat] || '中频'}

> [!note]- 展开 · 核心考点与主要难点
> ⏳ 待补充

## 题干

${stem}

## 答案

> [!success]- 展开 · 答案
> ⏳ 待补充

## 解析

> [!example]- 展开 · 解析
> ⏳ 待补充

> [!warning]- 展开 · 易错提醒
> ⏳ 待补充

## 错因分析

> [!question]- 展开 · 错因（做题时别看）
> **首次错因**　${reason || '⏳ 待补充'}

## 打卡记录

> 做完一次勾一个结果（每次只勾一个）。勾到「完美」= 进入遗忘曲线；「普通 / 失败」= 仍待复习。
> 做错的记一下错因，程序会统计你到底是怎么错的。

- [ ] 第 1 次 · 完美
- [ ] 第 1 次 · 普通
- [ ] 第 1 次 · 失败

- [ ] 第 2 次 · 完美
- [ ] 第 2 次 · 普通
- [ ] 第 2 次 · 失败

- [ ] 第 3 次 · 完美
- [ ] 第 3 次 · 普通
- [ ] 第 3 次 · 失败
`;
}

/**
 * 批量建题。item 需要 { category, subject, chapter, stem, type, difficulty, heat, slug, title }
 * 编号会自动避开已存在的文件，绝不覆盖。
 */
export function createQuestions(rootDir, items) {
  const created = [];
  const pending = new Set();

  for (const item of items) {
    const category = safeName(item.category || UNCLASSIFIED);
    const subject = safeName(item.subject || UNCLASSIFIED);
    // 章节留空时直接放在科目目录下，不再套一层同名文件夹
    const chapter = item.chapter ? safeName(item.chapter) : '';
    const prefix = chapter || subject;
    const dir = chapter
      ? path.join(rootDir, category, subject, chapter)
      : path.join(rootDir, category, subject);
    fs.mkdirSync(dir, { recursive: true });

    const slug = safeName(item.slug);
    const key = (n) => `${category}/${subject}/${chapter}#${n}`;

    let num = item.num ? Number(item.num) : null;
    if (!num || pending.has(key(num))) {
      num = nextNumber(rootDir, category, subject, chapter);
      while (pending.has(key(num))) num += 1;
    }
    pending.add(key(num));

    let file = path.join(dir, `${prefix}-${String(num).padStart(2, '0')}-${slug}.md`);
    let bump = 1;
    while (fs.existsSync(file)) {
      file = path.join(dir, `${prefix}-${String(num).padStart(2, '0')}-${slug}-${++bump}.md`);
    }

    const body = renderNote({
      subject,
      chapter: prefix,
      num,
      slug,
      stem: normalizeMath(item.stem),
      type: item.type || detectType(item.stem),
      difficulty: Number(item.difficulty) || 3,
      heat: Number(item.heat) || 3,
      title: item.title,
      reason: item.reason,
    });
    fs.writeFileSync(file, body, 'utf8');
    created.push({
      category,
      subject,
      chapter: prefix,
      num,
      slug,
      file: path.relative(rootDir, file).split(path.sep).join('/'),
      absPath: file,
      bytes: Buffer.byteLength(body),
    });
  }
  return created;
}

/** 全部「大类 / 科目 / 章节」组合，给前端下拉用 */
export function chapterOptions() {
  return CATEGORIES.flatMap((category) =>
    Object.entries(TAXONOMY[category]).flatMap(([subject, chapters]) =>
      chapters.map((chapter) => ({ category, subject, chapter }))
    )
  );
}

/** 生成一段可以直接丢给 AI 的提示词 */
export function buildPrompt(stems, { category, subject, chapter, reason, intro } = {}) {
  const body = stems.map((s, i) => `【第 ${i + 1} 题】\n${s}`).join('\n\n');
  const hint = [category, subject, chapter].filter(Boolean).join(' / ');
  const reasonLine = reason
    ? `这批题的错因是「${reason}」，请写进每篇的 \`**首次错因**\`。\n`
    : `**另外：每道题的 \`**首次错因**\` 先留「⏳ 待补充」，并在回复里问我这几道题分别是怎么错的。**\n`;
  return `${intro ? `${intro}\n\n` : ''}请把下面${stems.length > 1 ? ` ${stems.length} 道题` : '这道题'}做成我的错题本笔记，一题一篇。

${reasonLine}
结构：\`错题本/<大类>/<科目>/<章节>/<章节>-NN-<短标题>.md\`
- 大类：数学 或 408
- 数学的科目：高数 / 线代 / 概率论
- 408 的科目：数据结构 / 计算机组成原理 / 操作系统 / 计算机网络
- 章节：数学用标准章名（极限、连续、导数、微分、一元函数积分学、行列式、矩阵、随机事件与概率…）
${hint ? `\n我的初步判断是「${hint}」，如果不合适请自行更正。\n` : ''}
每篇格式必须严格是这样：

---
tags:
  - 错题本
  - <科目名>
  - <章节名>
type: <题型>
difficulty: <五格，用 ☆ 补满，如 ⭐⭐⭐☆☆>
heat: <五格，用 ☆ 补满，如 🔥🔥🔥🔥☆>
---

# <章节名>-<两位编号>　<用 LaTeX 写的核心式子>

## 本题档案

**考的类型**　<大类 · 小题型>
**难度**　<五格> · <一句话定位>
**考研热度**　<五格> · <一句话，考研视角>

> [!note]- 展开 · 核心考点与主要难点
> **核心考点**
> 1. …
>
> **主要难点**
> - …

## 题干

<题干原文>

## 答案

> [!success]- 展开 · 答案
> <最终结果>

## 解析

> [!example]- 展开 · 解析
> **第 1 步：** …

> [!warning]- 展开 · 易错提醒
> <本题特有的坑>

## 打卡记录

> 做完一次勾一个结果（每次只勾一个）。勾到「完美」= 进入遗忘曲线；「普通 / 失败」= 仍待复习。
> 做错的记一下错因，程序会统计你到底是怎么错的。

- [ ] 第 1 次 · 完美
- [ ] 第 1 次 · 普通
- [ ] 第 1 次 · 失败

- [ ] 第 2 次 · 完美
- [ ] 第 2 次 · 普通
- [ ] 第 2 次 · 失败

- [ ] 第 3 次 · 完美
- [ ] 第 3 次 · 普通
- [ ] 第 3 次 · 失败

硬性要求：
1. 正文开头只显示三行（考的类型 / 难度 / 考研热度）；考点、难点、答案、解析、易错提醒**全部折叠**（\`> [!xxx]-\` 里的 \`-\` 表示默认收起）。
2. 折叠块内每一行都要以 \`> \` 开头，块内空行写成单独一个 \`>\`，否则折叠会断开。
3. 公式用 \`$行内$\` 与 \`$$行间$$\`。
4. **答案必须自己算准**：算完用高精度数值代入复核一遍再写，不确定就明说「待复核」，不要编。
5. 难度 ⭐ 五格、热度 🔥 五格，都要用 ☆ 补满。
6. 不要改动我已有的文件，只新建。

${body}`;
}

/**
 * 给「上传图片 → 转成题目」用的提示词。
 * 关键在于：**不要原图**，要 AI 看懂之后用文字重写题干、用代码把图形重画一遍。
 */
export function buildImagePrompt(paths, opts = {}) {
  const n = paths.length;
  const intro = [
    `我上传了 ${n} 张题目图片，请你把它们逐张转成我的错题本笔记。`,
    '',
    '**第一步：读图。** 图片就在本机这些路径上，直接读：',
    ...paths.map((p, i) => `  ${i + 1}. ${p}`),
    '',
    '**第二步：按下面的规矩写题（这几条最重要）。**',
    '1. **不要把我上传的原图直接放进笔记。** 请你看懂图里的内容之后，用**文字 + LaTeX** 把题干重写出来。',
    '2. **图里有图形的（函数图像、几何图、二叉树、流程图、电路图、地址划分图…），请写代码重新画一张**：',
    '   用 Python(matplotlib) 或手写 SVG 生成图片，存到 `错题本/picture/` 下，再在笔记里用 `![[文件名]]` 引用。',
    '   要求：清晰、坐标/标注完整、信息与原图一致，风格与笔记整体协调。',
    '3. 图里手写模糊、印刷不清的地方，按最合理的理解补全，并在解析里说明你补了什么假设。',
    '4. 一张图里有多道题的，拆成多篇。',
  ].join('\n');

  return buildPrompt(
    paths.map((_, i) => `（内容见第 ${i + 1} 张图，路径：${paths[i]}）`),
    { ...opts, intro }
  );
}
