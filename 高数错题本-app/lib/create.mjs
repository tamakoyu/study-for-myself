/**
 * create.mjs —— 增题：把粘贴的题干变成一篇结构完整的错题骨架
 *
 * 只负责「机械活」：分章节、定题型、编号、命名、套格式、写盘。
 * 答案/解析/考点/难点/易错 一律留 `⏳ 待补充` 占位，等真正会做题的大脑来填。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 章节识别关键词（顺序即优先级，命中数相同时靠前者胜） */
const CHAPTER_RULES = [
  { chapter: '极限', kw: ['极限', '\\lim', 'lim_', ' lim', '收敛', '单调有界', '夹逼', '无穷小', '无穷大', '等价无穷', '阶'] },
  { chapter: '连续', kw: ['连续', '间断', '零点定理', '介值定理', '一致连续', '渐近线'] },
  { chapter: '导数', kw: ['导数', '可导', '求导', '中值定理', '罗尔', '拉格朗日', '柯西', '极值', '单调性', '凹凸', '拐点', '高阶导', '驻点'] },
  { chapter: '微分', kw: ['微分', '可微', 'dy', '\\mathrm{d}', '近似计算', '泰勒', '麦克劳林'] },
  { chapter: '积分', kw: ['积分', '原函数', '不定积分', '定积分', '反常积分', '重积分', '曲线积分', '曲面积分'] },
  { chapter: '函数', kw: ['反函数', '定义域', '值域', '奇偶', '周期', '复合函数', '函数解析式', '有界性'] },
];

export const CHAPTER_ORDER = ['极限', '连续', '导数', '微分', '积分', '函数'];

/** 猜测章节，猜不出返回 '未分类' */
export function detectChapter(stem) {
  const text = String(stem || '');
  let best = null;
  let bestScore = 0;
  for (const rule of CHAPTER_RULES) {
    const score = rule.kw.reduce((s, k) => s + (text.includes(k) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      best = rule.chapter;
    }
  }
  return best || '未分类';
}

/** 猜测题型 */
export function detectType(stem) {
  const t = String(stem || '');
  const prove = t.includes('证明') || t.includes('证：') || t.includes('求证');
  const compute = t.includes('求') || t.includes('计算') || t.includes('解');
  if (prove && compute) return '证明+计算题';
  if (prove) return '证明题';
  if (t.includes('填空') || t.includes('选择')) return '填空/计算题';
  return '计算题';
}

/** 由题干首行生成短标题（给文件名与 H1 用），用户可在界面上改 */
export function slugOf(stem, maxLen = 14) {
  let s = String(stem || '').split('\n').find((l) => l.trim()) || '新题';
  s = s
    .replace(/\$\$?/g, '')
    .replace(/\\[a-zA-Z]+/g, ' ')
    .replace(/[{}^_]/g, ' ')
    .replace(/[（(][^）)]*[）)]/g, ' ')
    .replace(/[，。；：、,.;:!?！？"'“”]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s || '新题';
}

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
  return String(s || '新题')
    .replace(/[/\\:*?"<>|#[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40) || '新题';
}

/** 读某个章节已有的最大编号 */
export function nextNumber(rootDir, chapter) {
  const dir = path.join(rootDir, chapter);
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

/** 生成一篇骨架笔记 */
export function renderNote({ chapter, num, slug, stem, type, difficulty = 3, heat = 3, title }) {
  const pad = String(num).padStart(2, '0');
  const stars = '⭐'.repeat(difficulty) + '☆'.repeat(5 - difficulty);
  const fires = '🔥'.repeat(heat) + '☆'.repeat(5 - heat);
  const diffWord = { 1: '送分', 2: '基础', 3: '中档', 4: '较难', 5: '压轴' }[difficulty] || '中档';
  const heatWord = { 1: '极少单独考', 2: '低频', 3: '中频', 4: '高频', 5: '超高频' }[heat] || '中频';
  const headline = title || slug;

  return `---
tags:
  - 高数错题本
  - ${chapter}
type: ${type}
difficulty: ${stars}
heat: ${fires}
---

# ${chapter}-${pad}　${headline}

## 本题档案

**考的类型**　${type}
**难度**　${stars} · ${diffWord}
**考研热度**　${fires} · ${heatWord}

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

## 打卡记录

> 做完一次勾一个结果（每次只勾一个）：勾到「完美」= 复习完成；只勾了「普通 / 失败」= 仍待复习。

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
 * 批量建题。返回每篇的实际落盘路径。
 * 编号会自动避开已存在的文件，绝不覆盖。
 */
export function createQuestions(rootDir, items) {
  const created = [];
  // 同一批里同章节的编号要接着往下排
  const pending = new Map();

  for (const item of items) {
    const chapter = safeName(item.chapter || '未分类');
    const dir = path.join(rootDir, chapter);
    fs.mkdirSync(dir, { recursive: true });

    let num = item.num ? Number(item.num) : null;
    const used = new Set(fs.readdirSync(dir).map((f) => f));
    const taken = (n, slug) =>
      used.has(`${chapter}-${String(n).padStart(2, '0')}-${slug}.md`) ||
      (pending.get(chapter) || []).includes(n);

    if (!num || taken(num, safeName(item.slug))) {
      let n = nextNumber(rootDir, chapter);
      while (taken(n, safeName(item.slug))) n += 1;
      num = n;
    }
    pending.set(chapter, [...(pending.get(chapter) || []), num]);

    let slug = safeName(item.slug);
    let file = path.join(dir, `${chapter}-${String(num).padStart(2, '0')}-${slug}.md`);
    // 万一还是撞了，加后缀
    let bump = 1;
    while (fs.existsSync(file)) {
      file = path.join(dir, `${chapter}-${String(num).padStart(2, '0')}-${slug}-${++bump}.md`);
    }

    const body = renderNote({
      chapter,
      num,
      slug,
      stem: normalizeMath(item.stem),
      type: item.type || detectType(item.stem),
      difficulty: Number(item.difficulty) || 3,
      heat: Number(item.heat) || 3,
      title: item.title,
    });
    fs.writeFileSync(file, body, 'utf8');
    created.push({
      chapter,
      num,
      slug,
      file: path.relative(rootDir, file).split(path.sep).join('/'),
      absPath: file,
      bytes: Buffer.byteLength(body),
    });
  }
  return created;
}

/** 生成一段可以直接丢给 AI 的提示词 */
export function buildPrompt(stems, { chapterHint } = {}) {
  const body = stems.map((s, i) => `【第 ${i + 1} 题】\n${s}`).join('\n\n');
  return `请把下面${stems.length > 1 ? ` ${stems.length} 道题` : '这道题'}做成我的高数错题本笔记，一题一篇。

写入位置：\`高数错题本/<章节>/<章节>-NN-<短标题>.md\`（章节在 极限/连续/函数/导数/微分 里选，没有的文件夹要新建）${
    chapterHint ? `\n章节初判：${chapterHint}（如果不合适请自行更正）` : ''
  }

每篇格式必须是这样：

---
tags:
  - 高数错题本
  - <章节名>
type: <题型>
difficulty: <五格，用 ☆ 补满，如 ⭐⭐⭐☆☆>
heat: <五格，用 ☆ 补满，如 🔥🔥🔥🔥☆>
---

# <章节>-<两位编号>　<用 LaTeX 写的核心式子>

## 本题档案

**考的类型**　<大类 · 小题型>
**难度**　<五格> · <一句话定位>
**考研热度**　<五格> · <一句话，数一视角>

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

> 做完一次勾一个结果（每次只勾一个）：勾到「完美」= 复习完成；只勾了「普通 / 失败」= 仍待复习。

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
1. 正文一开始只显示三行（考的类型 / 难度 / 考研热度），考点、难点、答案、解析、易错提醒**全部折叠**（\`> [!xxx]-\` 里的 \`-\` 表示默认收起）。
2. 折叠块内每一行都要以 \`> \` 开头，块内空行写成单独一个 \`>\`，否则折叠会断开。
3. 公式用 \`$行内$\` 与 \`$$行间$$\`；**答案必须自己算准**，算完用高精度数值代入复核一遍再写。
4. 难度 ⭐ 五格、数一热度 🔥 五格，都要用 ☆ 补满。
5. 不要改动我原有的文件，只新建。

${body}`;
}
