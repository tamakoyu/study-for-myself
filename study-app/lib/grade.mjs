/**
 * grade.mjs —— 分值 · 参考用时 · 上传手写答案判分
 *
 * 三件事，都是**纯函数**（不读盘、不联网），所以单元测试能直接跑：
 *
 *   1. **分值**：试卷里每题标了「N 分」就按它来，满分是它们的和；
 *      老试卷（或模型漏写）没标，就按满分平均分 —— 程序不替模型编分值。
 *   2. **参考用时**：今日测试用 frontmatter 里的 `minutes`（出题时就估好了），
 *      英语按**考研真题的分值/时间比**算（180 分钟 / 100 分 = 1.8 分钟/分，
 *      一篇 10 分的阅读正好 18 分钟，和真题建议时间一致）。
 *      每题再按分值比例分摊。
 *   3. **判分**：把「题干 + 标准答案 + 每题分值」连同考生的手写照片交给模型，
 *      按考研阅卷标准（按步给分、不许放水）逐题给分，结果写回试卷文件的
 *      `## 成绩记录` 一节 —— 只动这一节，正文一个字节都不改。
 *
 * 分值口径（考研英语一）：完形 20 空 × 0.5 分、传统阅读 5 题 × 2 分、
 * 新题型 5 题 × 2 分 —— **单篇都是 10 分**。今日测试（数学 + 408）是 **100 分**。
 */

/* ============================================================
   常量
   ============================================================ */

/** 考研英语一：单篇满分（完形 / 传统阅读 / 新题型都是 10 分） */
export const ENGLISH_FULL = 10;
/** 考研英语一：180 分钟 / 100 分 */
export const ENGLISH_MIN_PER_POINT = 1.8;
/** 考研数学 / 408：180 分钟 / 150 分 */
export const EXAM_MIN_PER_POINT = 1.2;
/** 今日测试满分 */
export const TEST_FULL = 100;
/** 成绩写回试卷文件的哪一节 */
export const GRADE_SECTION = '成绩记录';
/** 判分用的判定词（模型给别的也行，只是这几个会被界面标色） */
export const VERDICTS = ['正确', '部分正确', '错误', '未作答', '看不清', '题号对不上'];
/**
 * 错因词表 —— 和错题本用的是**同一份**（前端 app.js 里的 REASONS、统计也按这几个字统计）。
 * 判分时让模型从这里面选一个，「一键把错题加入错题本」就有现成的错因可填，不用我一条条补。
 */
export const GRADE_REASONS = [
  '概念不清', '方法不会', '思路方向错', '计算失误', '审题错误', '公式记错', '粗心大意', '时间不够',
];

/* ============================================================
   小工具
   ============================================================ */

export function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/** 数字，不是数就 null */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v) {
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

/** 12.5 → 「12.5」；12 → 「12」（分值别显示成一堆零） */
export function fmtScore(n) {
  const v = round2(n);
  return Number.isInteger(v) ? String(v) : String(v);
}

/** 秒 → 「42:10」/「1:02:10」 */
export function fmtClock(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** 秒 → 「54 秒」/「4 分钟」（页面上标「参考用时」用，写盘不用） */
export function fmtSpan(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 90) return `${s} 秒`;
  return `${Math.round(s / 60)} 分钟`;
}

/** 取 `## 名字` 这一节（到下一个 `##` 为止）；grade / dailytest / maimemo 共用一套规矩 */
export function sectionOf(body, name) {
  const m = new RegExp(`^##\\s*${name}\\s*$`, 'm').exec(String(body ?? ''));
  if (!m) return '';
  const rest = String(body).slice(m.index + m[0].length);
  const cut = rest.search(/^##\s/m);
  return (cut === -1 ? rest : rest.slice(0, cut)).trim();
}

/* ============================================================
   一、分值
   ============================================================ */

/** `20 分` / `20分` → 20；别的一律 null（「20」这种裸数字不算分值，免得误伤考点名） */
export function parseScoreText(s) {
  const m = String(s ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*分$/);
  return m ? Number(m[1]) : null;
}

/**
 * 从题目标题里抠分值。约定写在第几段：
 *   `### 1. 大题 ｜ 中值定理 ｜ 20 分`     → 20
 *   `### 1. 选择题 ｜ 极限 ｜ 4分`         → 4
 *   `### 1. 大题 ｜ 中值定理（20 分）`      → 20（括号里也认）
 *   `### 1. 大题 ｜ 中值定理`               → null（没标）
 */
export function scoreFromHead(head) {
  const text = String(head ?? '');
  const parts = text.split(/[｜|]/).map((s) => s.trim()).filter(Boolean);
  // 第 0 段是题型，不碰；从最后一段往回找
  for (let i = parts.length - 1; i >= 1; i -= 1) {
    const n = parseScoreText(parts[i]);
    if (n != null) return n;
  }
  const m = text.match(/[（(【[]\s*(\d+(?:\.\d+)?)\s*分\s*[）)】\]]/);
  return m ? Number(m[1]) : null;
}

/**
 * 一份卷子的分值表。
 *
 * items: `[{ n, score? }]`（score = 题目自带的「N 分」）
 *   - **全都标了** → 满分就是它们的和（模型写多少就是多少，程序不替它改口径）
 *   - **有没标的** → 全部按 `full` 平均分，最后一个吃掉舍入余数（加起来正好等于满分）
 *
 * 返回 `{ full, byN, assumed, count }`，`assumed: true` = 分值是我们平摊出来的。
 */
export function scoreTable(items, { full = TEST_FULL } = {}) {
  const list = (items || []).map((x) => ({ n: Number(x.n), score: num(x.score) })).filter((x) => Number.isFinite(x.n));
  const n = list.length;
  if (!n) return { full: 0, byN: {}, assumed: false, count: 0 };

  const all = list.every((x) => x.score != null && x.score > 0);
  const byN = {};
  if (all) {
    for (const x of list) byN[x.n] = round2(x.score);
    return { full: round2(list.reduce((s, x) => s + x.score, 0)), byN, assumed: false, count: n };
  }

  const want = Number(full) > 0 ? Number(full) : TEST_FULL;
  const each = round2(want / n);
  list.forEach((x, i) => {
    byN[x.n] = i === n - 1 ? round2(want - each * (n - 1)) : each;
  });
  return { full: round2(want), byN, assumed: true, count: n };
}

/* ============================================================
   二、参考用时
   ============================================================ */

/**
 * 参考用时（秒）。
 *   minutes 给了就用它（今日测试的 frontmatter 里出题时就估好了）；
 *   没给就按「满分 × 每分钟顶几分」算：英语 1.8、数学 / 408 1.2。
 * 每题按分值比例分摊（分值大 = 该多花时间），下限 20 秒。
 */
export function referenceTime({ full, byN = {}, minutes = 0, perPoint = EXAM_MIN_PER_POINT } = {}) {
  const f = Number(full) > 0 ? Number(full) : TEST_FULL;
  const mm = Number(minutes) > 0 ? Number(minutes) : f * perPoint;
  const seconds = Math.max(60, Math.round(mm * 60));
  const out = {};
  for (const [n, s] of Object.entries(byN)) {
    out[n] = Math.max(20, Math.round((seconds * Number(s)) / f));
  }
  return { seconds, minutes: Math.round(seconds / 60), byN: out };
}

/**
 * 一份卷子的「分值 + 参考用时」。
 *
 * paper 两种形态（server 直接把 readTest / readStory 的结果给过来）：
 *   { kind:'test',  rel, title, minutes, items:[{n,type,topic,body,score,answerText,analysisText}] }
 *   { kind:'story', rel, title, type, questions:[{n,stem,options}], key, analysis }
 */
export function gradePaper(paper) {
  const kind = paper?.kind === 'story' ? 'story' : 'test';
  const rows =
    kind === 'story'
      ? (paper.questions || []).map((q) => ({ n: Number(q.n) }))
      : (paper.items || []).map((q) => ({ n: Number(q.n), score: q.score }));

  const table = scoreTable(rows, { full: kind === 'story' ? ENGLISH_FULL : Number(paper.full) || TEST_FULL });
  const ref = referenceTime({
    full: table.full,
    byN: table.byN,
    minutes: kind === 'story' ? 0 : paper.minutes,
    perPoint: kind === 'story' ? ENGLISH_MIN_PER_POINT : EXAM_MIN_PER_POINT,
  });
  return { kind, rel: paper.rel || '', title: paper.title || '', table, ref, count: rows.length };
}

/* ============================================================
   三、判分提示词（上传手写答案 → 按考研标准打分）
   ============================================================ */

/** 一题的「题干 + 标准答案 + 判分参考」，给模型看的 */
function testBlock(item, score) {
  const parts = [`### 第 ${item.n} 题 ｜ ${item.type || '题目'}${item.topic ? ` ｜ ${item.topic}` : ''} ｜ 满分 ${fmtScore(score)} 分`];
  parts.push('', '**题干**', '', String(item.body || '').trim() || '（题干缺失）');
  parts.push('', '**标准答案**', '', String(item.answerText || item.answer || '').trim() || '（这份卷子没写这题的标准答案）');
  if (item.analysisText) parts.push('', '**解析（判分参考）**', '', String(item.analysisText).trim());
  return parts.join('\n');
}

/**
 * 判分提示词 —— **只给数学 / 408 的今日测试用**。
 *
 * 英语那些题目全是选择题，程序自己对着「答案速查」判就完事了（见 server 的 /api/grade/local），
 * 又快又准，完全没有必要让模型去认手写字母。
 *
 * paper 见 gradePaper 的说明；opts: { images, seconds, date }
 */
export function gradePrompt(paper, { images = 1, seconds = 0, date = '' } = {}) {
  const g = gradePaper(paper);
  const { table, ref } = g;

  const blocks = (paper.items || []).map((q) => testBlock(q, table.byN[q.n])).join('\n\n---\n\n');
  const n = g.count;
  const used = Number(seconds) > 0 ? `考生这次用了 **${fmtClock(seconds)}**` : '（考生这次没记用时）';

  const user = `你是**考研阅卷老师**，现在要给我批一份卷子。我上传的是**我手写的整份答案**（可能有 ${images} 张照片，是一份卷子连着拍的，不是好几份）。

## 这份卷子（程序给的，不要改动）

- 卷子：**${g.title}**（\`${g.rel}\`）
- 类型：今日测试（数学 / 408）
- 共 **${n}** 道题，**满分 ${fmtScore(table.full)} 分**
- 参考用时 **${fmtClock(ref.seconds)}**；${used}${date ? `（判分日期 ${date}）` : ''}

## 逐题：题干、标准答案、每题满分

${blocks}

## 判分规则（**严格按考研标准，不要放水**）

1. **先对题号。** 我写的答案里**每一题都标了题号**，格式可能写成 \`1.\` \`1、\` \`(1)\` \`一、\` 这些样子。
   - 题号对得上 → 判这一题；
   - 题号写错、漏写、或者照片里根本找不到这一题 → 这一题 \`verdict\` 写「题号对不上」或「未作答」，给 **0 分**，**不要瞎猜我写了哪一题**；
   - 同一题号出现两次（写重了）→ 以**后写的那次**为准，并在 \`lost\` 里点一句。
2. **我可能不止写了答案，大题写了完整过程** —— 那就**按步给分**（考研就是这么给的，不是只看最后的答案）：
   - 逐条对照标准答案里的**采分点**：用对了定理 / 公式、前提条件写全、推导正确 → 拿这一步的分；
   - **结果算错但方法对** → 只扣结果那一步的分，**不要整题扣光**；
   - **方法错但结论碰巧对** → **不给分**；
   - 漏讨论（比如忘了 $x=0$、忘了定义域、忘了边界条件）、跳步没写依据、记号自创 → 从对应采分点里扣；
   - 过程完整、结论正确、没有跳步 → 给满分。
3. **选择题 / 填空题**：答案对 = 满分，错 = 0 分。填空题有多个解的要写全，**漏解按比例扣**。
4. **没做的题**要单独占一行，\`verdict\` 写「未作答」，0 分 —— **每一题都必须出现在 items 里，一道都不能少**（从 1 到 ${n}）。
5. **看不清**的地方：\`verdict\` 写「看不清」，在 \`lost\` 里说清是哪里看不清。**看不清就给 0 分，但绝不许猜我写了什么**，也不许按「他应该会做」给分。
6. 每一题都要给这些字段：
   - \`got\`：**我实际写的内容**（照抄我写的，公式用 LaTeX；看不清就写「看不清」）
   - \`score\`：这一题我拿到的分（可以是 0.5 这样的小数，**不能超过这道题的满分**）
   - \`verdict\`：从「正确 / 部分正确 / 错误 / 未作答 / 看不清 / 题号对不上」里选一个
   - \`reason\`：**错因**，从我错题本固定的这 8 个词里**选一个**（不要自己造词）：
     ${GRADE_REASONS.join(' / ')}。
     依据是「我为什么会丢这个分」：公式写错选「公式记错」、算错选「计算失误」、
     压根不会做选「方法不会」、想偏了选「思路方向错」、看错题选「审题错误」、
     会做但漏了选「粗心大意」、没做完选「时间不够」、概念本身没搞懂选「概念不清」。
     **拿到满分的题 \`reason\` 写空字符串 \"\"**。
   - \`lost\`：**丢分点**，具体到哪一步、为什么扣（满分就写「无」）
   - \`fix\`：正确写法 / 该怎么改（一两句，满分可以写「保持」）
7. **不要客套，不要鼓励性加分。** 这是模考判分，宁可严一点：
   我的目标是在考场上拿分，不是听安慰话。

## 输出（严格）

只输出一个 JSON 对象，不要解释、不要 Markdown 围栏，第一个字符是 \`{\`：

{"items":[{"n":1,"got":"…","score":8,"full":12,"verdict":"部分正确","reason":"计算失误","lost":"…","fix":"…"}],"summary":"总评，100 字以内，先说我这份卷子最要命的问题","weak":["薄弱点，2–4 条"],"next":["下一步该怎么练，2–3 条"]}

\`n\` 从 1 排到 ${n}，一道都不能漏；\`full\` 照抄上面每题的满分；\`reason\` 只能从上面那 8 个词里选。`;

  return { prompt: user, grade: g };
}

/* ============================================================
   四、单题判分（错题本 / 好题本的做题模式）

   错题本是一题一屏，所以是**每小题独立打分**：一次调用只判这一道题，
   给一个 0–100 的得分 + 「完美 / 普通 / 失败」的建议 + 错因 + 错因分析。
   记录什么由我自己在面板上改，改完才写盘（这里只负责判，不落盘）。
   ============================================================ */

/** 打卡用的三个结果，和 RESULTS 一模一样 —— 判分建议直接落在这个词表里 */
export const QUESTION_RESULTS = ['完美', '普通', '失败'];

/** 得分 → 结果 的兜底换算（模型没给 result，或给了个不认识的词） */
export function resultFromScore(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return '普通';
  return n >= 85 ? '完美' : n >= 60 ? '普通' : '失败';
}

/**
 * 单题判分提示词。problem 是题目笔记解析出来的对象：
 * `{ num, title, category, subject, chapter, type, difficulty, heat, points, stem, answer, solution, pitfalls, keypoints, firstReason, stats }`
 */
export function questionGradePrompt(problem, { images = 1, seconds = 0, date = '' } = {}) {
  const p = problem || {};
  const done = p.stats?.total || 0;
  const hist = [
    done ? `这道题我已经练过 ${done} 次` : '这道题是第一次练',
    p.stats?.last?.result ? `上一次是「${p.stats.last.result}」` : '',
    p.firstReason ? `我第一次做错的原因记的是「${p.firstReason}」` : '',
  ]
    .filter(Boolean)
    .join('，');
  const used = Number(seconds) > 0 ? `这次花了 **${fmtClock(seconds)}**` : '（这次没记用时）';

  return `你是**考研阅卷老师**，现在批我**一道题**的手写过程。我上传了 ${images} 张照片（同一道题连着拍的）。

## 这道题（程序给的，不要改动）

- 出处：${[p.category, p.subject, p.chapter].filter(Boolean).join(' · ') || '（没归类）'}　第 ${p.num ?? '?'} 题${
    p.title ? `　${p.title}` : ''
  }
- 类型：${p.type || '（没标）'}　难度 ${p.difficulty || '?'}/5　考研热度 ${p.heat || '?'}/5
- 考点：${(p.points || []).join('、') || '（没打标签）'}
- ${hist}；${used}${date ? `（判分日期 ${date}）` : ''}
${p.keypoints ? `\n**核心考点与主要难点**\n${p.keypoints}\n` : ''}
## 题干

${String(p.stem || '').trim() || '（题干缺失）'}

## 这道题的答案（标准答案 + 解析，判分依据）

${String(p.answer || '').trim() || '（这道题没写标准答案）'}

${String(p.solution || '').trim()}
${p.pitfalls ? `\n**我自己的易错提醒**\n${p.pitfalls}\n` : ''}
## 判分规则（**严格按考研标准，不要放水**）

1. **对着标准答案的采分点逐步核对**（考研就是按步给分，不是只看最后答案）：
   - 关键步骤、定理 / 公式用得对、前提条件写全、推导正确 → 拿这一步的分；
   - **结果算错但方法对** → 只扣结果那一步；
   - **方法错但结论碰巧对** → **不给分**；
   - 漏讨论（忘了 $x=0$、定义域、边界条件）、跳步没写依据、记号自创 → 从对应采分点扣；
   - 过程完整、结论正确、没有跳步 → 满分 100。
2. **给一个 0–100 的得分** \`score\`（考研卷面分，按上面这些采分点折算）。
3. **给一个结果建议** \`result\`，从这三个词里选（**这是我打卡用的词，别自己造**）：
   - \`完美\` —— 思路和方法都对、过程完整、**独立做出来了**（得分 85 以上一般是这个）；
   - \`普通\` —— 做出来了但不顺：卡过、跳过步、或者结果对而过程不严（60–84）；
   - \`失败\` —— 没做出来 / 方法错 / 只写了一半（60 以下）。
4. **看不清**的地方：在 \`lost\` 里说清是哪里看不清，**绝不许猜我写了什么**，也不能因为「他应该会做」就给分；
   完全看不清或者照片里没有这道题 → 结果给 \`失败\`，\`score\` 给 0。
5. 每项都要给：
   - \`got\`：**我实际写的内容**（照抄我写的，公式用 LaTeX；看不清就写「看不清」）
   - \`lost\`：**丢分点**，具体到哪一步、为什么扣（满分就写「无」）
   - \`fix\`：下次该怎么改 / 正确写法（一两句，满分可以写「保持」）
   - \`reason\`：**错因**，从我固定的这 8 个词里**选一个**（不要自己造词）：
     ${GRADE_REASONS.join(' / ')}。依据是「我为什么会丢这个分」。
     **结果建议是「完美」的，\`reason\` 写空字符串 ""**。
   - \`analysis\`：**错因分析**，2–4 句。讲清：这次卡在哪 / 为什么错（是概念没懂、方法没想到，还是算错的）、
     这类题的信号是什么、下次遇到同类题第一步该做什么。**这段会写进我的错因分析里，要具体、能落地**，
     不要写「继续加油」这种空话。
   - \`weak\`：这次暴露出来的薄弱点，1–3 条短标签。

## 输出（严格）

只输出一个 JSON 对象，不要解释、不要 Markdown 围栏，第一个字符是 \`{\`：

{"score":85,"result":"普通","reason":"计算失误","got":"…","lost":"…","fix":"…","analysis":"…","weak":["…"]}

\`result\` 只能是「完美 / 普通 / 失败」之一，\`reason\` 只能是上面那 8 个词之一（完美就给空字符串）。`;
}

/** 把模型返回的单题判分收拾成规范结构（记录什么最终还是我自己在面板上定） */
export function normalizeQuestionGrade(raw) {
  // 用 num() 而不是 Number()：Number(null) 是 0，会把「模型没给分」当成「0 分」
  const n = num(raw?.score);
  // 没有分数就是没判成，不是 0 分 —— 见 badScore 的说明
  if (n === null) throw badScore('单题判分没成');
  const score = Math.max(0, Math.min(100, Math.round(n)));
  const want = str(raw?.result);
  const result = QUESTION_RESULTS.includes(want) ? want : resultFromScore(score);
  const reason = GRADE_REASONS.includes(str(raw?.reason)) ? str(raw.reason) : '';
  const weak = Array.isArray(raw?.weak) ? raw.weak.map(str).filter(Boolean).slice(0, 4) : [];
  return {
    score,
    result,
    // 完美就没错因可言（和我自己的错题本一个规矩）
    reason: result === '完美' ? '' : reason,
    got: str(raw?.got),
    lost: str(raw?.lost),
    fix: str(raw?.fix),
    analysis: String(raw?.analysis ?? '').trim().slice(0, 600),
    weak,
  };
}

/* ============================================================
   五、判分结果
   ============================================================ */

/**
 * 模型没给出可用的分数时抛这个。
 *
 * **为什么不静默按 0 分算**：一次「模型没回 score」的判分事故，
 * 会被当成「我这题考了 0 分」写进 打卡记录 / 成绩记录 —— 遗忘曲线、掌握度、错因统计
 * 全都跟着被带偏，而我还以为是自己做错了。宁可这次判分失败、什么都不写，也不能冤枉一次。
 */
function badScore(what) {
  return Object.assign(
    new Error(`${what}：模型没有给出分数（score 缺失或不是数字）。这次判分不算数，一个字节都没写盘 —— 重新判一次就行`),
    { code: 'bad_score' }
  );
}

/**
 * 把模型返回的东西收拾成规范结构。
 * **总分由程序自己加**（不信模型报的总分），而且每题得分会被夹在 [0, 满分] 里。
 * 一道题都没对上、或者整卷没有一处分数 → 直接报错（见 badScore）。
 */
export function normalizeGrade(raw, table) {
  const src = Array.isArray(raw) ? raw : raw?.items || [];
  const seen = new Map();
  let scored = 0;
  for (const it of src) {
    const n = num(it?.n);
    if (n == null || !(n in table.byN)) continue;
    const full = round2(table.byN[n]);
    let score = num(it.score);
    if (score == null) score = 0; // 个别题漏了分：先按 0 记，但下面会看「是不是整卷一个分都没有」
    else scored += 1;
    score = Math.max(0, Math.min(full, round2(score)));
    // 错因必须是固定词表里的那 8 个之一，模型自己造的词一律丢掉
    const reason = GRADE_REASONS.includes(str(it.reason)) ? str(it.reason) : '';
    seen.set(n, {
      n,
      score,
      full,
      verdict: str(it.verdict) || (score >= full ? '正确' : score > 0 ? '部分正确' : '错误'),
      reason: score >= full ? '' : reason,
      got: str(it.got),
      lost: str(it.lost),
      fix: str(it.fix),
    });
  }
  if (!seen.size) throw badScore('这次判分没写盘（模型给的题号一个都对不上这份卷子）');
  if (!scored) throw badScore('这次判分没写盘（每题都没有分数）');
  const items = Object.keys(table.byN)
    .map(Number)
    .sort((a, b) => a - b)
    .map((n) => seen.get(n) || { n, score: 0, full: round2(table.byN[n]), verdict: '未作答', reason: '', got: '', lost: '这一题模型没判到，按 0 分算', fix: '' });

  const total = round2(items.reduce((s, r) => s + r.score, 0));
  const list = (v, cap) => (Array.isArray(v) ? v.map(str).filter(Boolean).slice(0, cap) : []);
  return {
    items,
    total,
    full: round2(table.full),
    missing: Math.max(0, Object.keys(table.byN).length - seen.size),
    summary: str(raw?.summary),
    weak: list(raw?.weak, 6),
    next: list(raw?.next, 6),
  };
}

/* ============================================================
   六、成绩记录（写回试卷文件的那一节）
   ============================================================ */

/** 表格单元格：`|` 会把表格拆了，转义掉（读回来时再还原） */
function cell(v) {
  return str(v).replace(/\|/g, '\\|') || '—';
}

const VERDICT_ICON = { 正确: '✅', 部分正确: '🟡', 错误: '❌', 未作答: '⬜', 看不清: '🔍', 题号对不上: '❓' };
export const verdictIcon = (v) => VERDICT_ICON[str(v)] || '•';

/**
 * 一次成绩 → 一段 Markdown（写进 `## 成绩记录`）。
 * meta: `{ [n]: { type, topic } }`，用来把「考点」一列填上（没有就写 —）。
 * withReason: 要不要带「错因」一列 —— 数学 / 408 的错题要进错题本，错因有用；
 *   英语阅读是客观题，不进错题本，就不写这一列。
 */
export function formatGradeRecord(a) {
  const pct = a.full && a.full !== 100 ? `（折算 ${Math.round((a.total / a.full) * 100)}%）` : '';
  // 用时 / 参考用时：都记下来了才写成「用时 42:10（参考 40:00）」，只有一个就单写
  const time = a.seconds > 0 && a.refSeconds > 0
    ? ` · 用时 ${fmtClock(a.seconds)}（参考 ${fmtClock(a.refSeconds)}）`
    : a.seconds > 0
      ? ` · 用时 ${fmtClock(a.seconds)}`
      : '';
  const head = `### 第 ${a.index} 次 · ${a.date} · ${fmtScore(a.total)} / ${fmtScore(a.full)}${pct}${time}`;

  const meta = a.meta || {};
  const withReason = !!a.withReason;
  const cols = ['题号', '考点', '得分', '满分', '判定', ...(withReason ? ['错因'] : []), '丢分点'];
  const rows = (a.items || []).map((r) =>
    [
      r.n,
      cell(meta[r.n]?.topic || meta[r.n]?.type || '—'),
      fmtScore(r.score),
      fmtScore(r.full),
      `${VERDICT_ICON[str(r.verdict)] || ''}${str(r.verdict) || '—'}`,
      ...(withReason ? [cell(r.reason)] : []),
      // 丢分点和「该怎么改」写在一格里：判分最有用的就是这两句，别拆成两列把表撑太长
      cell([str(r.lost), str(r.fix) && str(r.fix) !== '保持' ? `改：${str(r.fix)}` : ''].filter(Boolean).join('；')),
    ].join(' | ')
  );

  const out = [
    head,
    '',
    `| ${cols.join(' | ')} |`,
    `| ${cols.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r} |`),
    '',
    `**总分** ${fmtScore(a.total)} / ${fmtScore(a.full)}${
      a.images ? `（判分图片 ${a.images} 张）` : ''
    }${a.source === 'local' ? '（本地判卷：自己点的选项）' : ''}`,
  ];
  if (a.summary) out.push('', `**总评** ${str(a.summary)}`);
  if ((a.weak || []).length) out.push('', `**薄弱点** ${a.weak.map(str).join('、')}`);
  if ((a.next || []).length) out.push('', `**下一步** ${a.next.map(str).join('、')}`);
  return out.join('\n');
}

/** unescape：`a \| b` → `a | b` */
function uncell(v) {
  return String(v ?? '').replace(/\\\|/g, '|').trim();
}

/** 按没被转义的 `|` 切一行表格 */
function splitRow(line) {
  return String(line)
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split(/(?<!\\)\|/)
    .map(uncell);
}

/**
 * 把 `## 成绩记录` 解析回结构化数据（最新的在前）。
 * **按表头认列**（题号 / 考点 / 得分 / 满分 / 判定 / 错因 / 丢分点 哪几列有就认哪几列），
 * 所以我手改了表格、加删了列也不会把整页弄崩 —— 认不出来的行跳过就是。
 */
export function readGradeRecords(content) {
  const sec = sectionOf(content, GRADE_SECTION);
  if (!sec) return [];
  const out = [];
  const hits = [...sec.matchAll(/^###\s*第\s*(\d+)\s*次\s*·\s*([^\n]*)$/gm)];
  hits.forEach((m, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].index : sec.length;
    const block = sec.slice(m.index + m[0].length, end);
    const tail = m[2];
    const [date = '', scorePart = ''] = tail.split('·').map((s) => s.trim());
    const sm = scorePart.match(/^([\d.]+)\s*\/\s*([\d.]+)/);
    const used = tail.match(/用时\s*(\d+):(\d+)(?::(\d+))?/);
    const refM = tail.match(/参考\s*(\d+):(\d+)(?::(\d+))?/);
    const clockSec = (x) => (x ? (x[3] ? Number(x[1]) * 3600 + Number(x[2]) * 60 + Number(x[3]) : Number(x[1]) * 60 + Number(x[2])) : 0);

    const items = [];
    let col = null;
    for (const line of block.split(/\r?\n/)) {
      if (!/^\s*\|/.test(line)) continue;
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue; // 分隔行
      const cols = splitRow(line);
      if (!col) {
        // 第一行是表头 → 认列
        const at = (name) => cols.findIndex((c) => c.replace(/\s/g, '') === name);
        const map = { n: at('题号'), topic: at('考点'), score: at('得分'), full: at('满分'), verdict: at('判定'), reason: at('错因'), lost: at('丢分点') };
        if (map.n === -1) continue; // 不是我们的表，跳过
        col = map;
        continue;
      }
      const pick = (k) => (col[k] >= 0 ? cols[col[k]] ?? '' : '');
      const n = Number(pick('n'));
      if (!Number.isFinite(n)) continue;
      items.push({
        n,
        topic: pick('topic') && pick('topic') !== '—' ? pick('topic') : '',
        score: Number(pick('score')) || 0,
        full: Number(pick('full')) || 0,
        // 判定列写的是「✅正确」，把前面的图标去掉
        verdict: String(pick('verdict') || '').replace(/^[^\p{L}\p{Script=Han}]+/u, '').trim(),
        reason: GRADE_REASONS.includes(pick('reason')) ? pick('reason') : '',
        lost: pick('lost'),
      });
    }
    const pickLine = (label) => {
      const mm = block.match(new RegExp(`\\*\\*${label}\\*\\*\\s*(.+)`));
      return mm ? mm[1].trim() : '';
    };
    const splitList = (label) => (pickLine(label) ? pickLine(label).split('、').map((x) => x.trim()).filter(Boolean) : []);
    out.push({
      index: Number(m[1]),
      date,
      total: sm ? Number(sm[1]) : round2(items.reduce((s, r) => s + r.score, 0)),
      full: sm ? Number(sm[2]) : 0,
      seconds: clockSec(used),
      refSeconds: clockSec(refM),
      images: Number((block.match(/判分图片\s*(\d+)\s*张/) || [])[1]) || 0,
      // 「判分图片 / 本地判卷」写在**总分那一行**，所以要在整块里找，不能只在标题里找
      source: /本地判卷/.test(block) ? 'local' : 'ai',
      // 有几题模型没判到 → 判分时按 0 记的，这里数回来，让列表能如实提醒
      // （认的是判分时写进去的那句话，笔记格式不用为此多一个字段）
      missing: items.filter((x) => x.verdict === '未作答' && /模型没判到/.test(x.lost || '')).length,
      items,
      summary: pickLine('总评'),
      weak: splitList('薄弱点'),
      next: splitList('下一步'),
    });
  });
  return out;
}

/** 最新的一次（成绩记录按「最新在上」写，所以是第一条） */
export function lastGrade(records) {
  return (records || [])[0] || null;
}

/** 连续两次同名判分之间至少隔这么久才算「新的一次」？不需要 —— 每次判分都记一次，和打卡一个规矩 */

/**
 * 把一次成绩写回试卷文件（**只动 `## 成绩记录` 这一节**）：
 *   - 已经有这一节 → 新的一次插在这一节**最前面**（最新在上），旧记录原样留在下面
 *   - 没有 → 在文件末尾新起一节
 * 其余正文一个字节都不动。
 */
export function writeGradeRecord(content, recordMarkdown) {
  const text = String(content ?? '');
  const head = String(recordMarkdown || '').trim();
  if (!head) return text;
  const m = /^##\s*成绩记录\s*$/m.exec(text);

  if (!m) {
    return `${text.replace(/\s*$/, '')}\n\n## ${GRADE_SECTION}\n\n${head}\n`;
  }
  const start = m.index;
  const rest = text.slice(start + m[0].length);
  const cut = rest.search(/^##\s/m);
  const end = cut === -1 ? text.length : start + m[0].length + cut;
  const before = text.slice(0, start).replace(/\s*$/, '');
  const body = text.slice(start + m[0].length, end).trim();
  const after = text.slice(end).replace(/^\s*/, '');
  const merged = `## ${GRADE_SECTION}\n\n${head}\n${body ? `\n${body}\n` : ''}`;
  return after ? `${before}\n\n${merged}\n${after}` : `${before}\n\n${merged}`;
}

/**
 * 模型重新生成试卷时，把旧的成绩记录接回去。
 * 不然「重新生成一次题」就把之前的成绩单抹了 —— 那是学习记录，不该丢。
 */
export function preserveGradeSection(oldContent, newContent) {
  const fresh = String(newContent ?? '');
  if (/^##\s*成绩记录\s*$/m.test(fresh)) return fresh; // 新的自己带了（不该发生），不动
  const old = sectionOf(oldContent, GRADE_SECTION);
  if (!old) return fresh;
  return writeGradeRecord(fresh, old);
}
