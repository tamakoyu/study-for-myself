/**
 * test/units.mjs —— 纯函数的单元测试（不起服务、不联外网）
 *
 * 只测「不依赖墨墨、也不依赖浏览器」的那部分：
 * 题型解析、随机不重复、词分配、文件名、以及阅读题的解析/存取。
 *
 *   node test/units.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

import {
  PAPER_TYPES, PAPER_TYPE_LABEL, paperTypeOf, recommendedWords, resolveTypes,
  distributeWords, paperRelOf, listStories, readStory, saveStory, saveStoryGrade, paperPrompt,
  sortVocabByArticleOrder,
} from '../lib/maimemo.mjs';
import {
  testRelOf, readTest, saveTest, saveTestGrade, listTests, splitAnswer, dailyTestPrompt,
} from '../lib/dailytest.mjs';
import {
  ENGLISH_FULL, ENGLISH_MIN_PER_POINT, GRADE_REASONS, QUESTION_RESULTS,
  scoreFromHead, scoreTable, referenceTime, gradePaper, gradePrompt,
  normalizeGrade, formatGradeRecord, writeGradeRecord, readGradeRecords, preserveGradeSection,
  questionGradePrompt, normalizeQuestionGrade,
} from '../lib/grade.mjs';
import { setReasonAnalysis } from '../lib/write.mjs';
import { QUOTES, quoteOfTheDay, parseExtraQuotes } from '../lib/quotes.mjs';
import {
  parseItemsEnvelopeEx, parseFilesEnvelope, parseFilesEnvelopeEx, parseJsonEnvelope, snippet,
  filesFooter, patternFooter,
} from '../lib/ai.mjs';
import { writePatternNote } from '../lib/patterns.mjs';
import { parsePlan, toggleTask } from '../lib/plans.mjs';
import { buildToday, plansCached } from '../lib/today.mjs';

const results = [];
const check = (label, fn) => {
  try {
    fn();
    results.push({ label, ok: true });
    console.log(`✅ ${label}`);
  } catch (err) {
    results.push({ label, ok: false });
    console.log(`❌ ${label}\n   ${err.message}`);
  }
};

console.log('\n=== 单元测试 ===\n');

/* ---------- 题型目录 ---------- */
check('题型一共 8 个，覆盖完形 / 传统阅读六种 / 新题型', () => {
  assert.equal(PAPER_TYPES.length, 8);
  const groups = [...new Set(PAPER_TYPES.map((t) => t.group))];
  assert.deepEqual(groups, ['完形填空', '传统阅读', '新题型']);
  const reads = PAPER_TYPES.filter((t) => t.group === '传统阅读').map((t) => t.label);
  assert.deepEqual(reads, ['主旨题', '细节题', '推理判断题', '猜测题', '例证题', '态度题']);
});

check('每个题型都写清了考研英语一的规格（含篇幅和题量）', () => {
  for (const t of PAPER_TYPES) {
    assert.ok(t.spec.length > 120, `${t.label} 的 spec 太短`);
    assert.ok(/\d+\s*[–-]\s*\d+\s*词/.test(t.spec), `${t.label} 没写篇幅`);
    assert.ok(t.words >= 10 && t.words <= 20, `${t.label} 的推荐词数不合理：${t.words}`);
  }
});

check('题型的显示名不重复，完形不写成「完形填空 · 完形填空」', () => {
  const labels = PAPER_TYPES.map((t) => PAPER_TYPE_LABEL[t.id]);
  assert.equal(new Set(labels).size, 8);
  assert.equal(PAPER_TYPE_LABEL.cloze, '完形填空');
  assert.equal(PAPER_TYPE_LABEL['read-main'], '传统阅读 · 主旨题');
});

/* ---------- 随机选题型 ---------- */
check('自选：按勾选的题型出，顺序稳定', () => {
  const got = resolveTypes(['read-main', 'cloze'], 2, false);
  assert.deepEqual(got.slice().sort(), ['cloze', 'read-main']);
});

check('自选：出几篇就取几个题型，不会超', () => {
  assert.equal(resolveTypes(['read-main', 'cloze', 'newtype'], 2, false).length, 2);
});

check('自选：一个题型都没勾时报错', () => {
  assert.throws(() => resolveTypes([], 1, false), /先勾一个题型/);
});

check('随机：多篇之间题型不重复（跑 200 次都成立）', () => {
  for (let i = 0; i < 200; i += 1) {
    const got = resolveTypes([], 6, true);
    assert.equal(got.length, 6);
    assert.equal(new Set(got).size, 6, `出现重复：${got.join(',')}`);
  }
});

check('随机：6 ≤ 8，永远抽得出来；抽 8 篇也刚好用完', () => {
  assert.equal(resolveTypes([], 6, true).length, 6);
  assert.equal(new Set(resolveTypes([], 6, true)).size, 6);
});

check('随机：候选池不够时报错而不是硬凑', () => {
  assert.throws(() => resolveTypes(['read-main'], 3, true), /出不了 3 篇/);
});

/* ---------- 词的分配 ---------- */
check('多篇时单词按轮转分配：不重不漏、每篇数量最多差 1', () => {
  const words = Array.from({ length: 13 }, (_, i) => ({ voc_id: `v${i}`, spelling: `w${i}` }));
  const buckets = distributeWords(words, 4);
  assert.equal(buckets.length, 4);
  const flat = buckets.flat();
  assert.equal(flat.length, 13);
  assert.equal(new Set(flat.map((w) => w.voc_id)).size, 13, '有词被分给了两篇');
  const sizes = buckets.map((b) => b.length);
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `分布不均：${sizes.join(',')}`);
});

check('轮转分配会把顺序打散（不是把前一半给第 1 篇）', () => {
  const words = Array.from({ length: 10 }, (_, i) => ({ voc_id: `v${i}`, spelling: `w${i}` }));
  const buckets = distributeWords(words, 2);
  assert.deepEqual(buckets[0].map((w) => w.voc_id), ['v0', 'v2', 'v4', 'v6', 'v8']);
  assert.deepEqual(buckets[1].map((w) => w.voc_id), ['v1', 'v3', 'v5', 'v7', 'v9']);
});

check('推荐词数 = 各题型之和', () => {
  assert.equal(recommendedWords(['read-detail']), 15);
  assert.equal(recommendedWords(['cloze', 'newtype']), 24);
  assert.equal(recommendedWords([]), 0);
});

/* ---------- 文件名 ---------- */
check('文件名带日期 + 序号 + 题型，一天多篇不会撞名', () => {
  const cfg = { vaultDir: '/tmp/vault', storyDir: '/tmp/vault/单词故事' };
  assert.equal(paperRelOf(cfg, '2026-09-14', 1, 'read-main'), '单词故事/2026-09-14-01-传统阅读·主旨题.md');
  assert.equal(paperRelOf(cfg, '2026-09-14', 12, 'cloze'), '单词故事/2026-09-14-12-完形填空.md');
  const set = new Set(PAPER_TYPES.map((t, i) => paperRelOf(cfg, '2026-09-14', i + 1, t.id)));
  assert.equal(set.size, 8);
});

/* ---------- 提示词：词是程序分配的 ---------- */
check('提示词把词明确分到每一篇，且逐篇写明题型与输出路径', () => {
  const cfg = { vaultDir: '/tmp/vault', storyDir: '/tmp/vault/单词故事' };
  const words = Array.from({ length: 30 }, (_, i) => ({ voc_id: `v${i}`, spelling: `word${i}` }));
  const out = paperPrompt(cfg, words, { date: '2026-09-14', types: ['read-detail', 'cloze'] });
  assert.equal(out.papers.length, 2);
  assert.equal(out.words.length, 30);
  const ids = out.papers.flatMap((p) => p.words.map((w) => w.voc_id));
  assert.equal(new Set(ids).size, 30, '有词被分到两篇');
  assert.ok(out.prompt.includes('word0'), '提示词里没有具体的词');
  assert.ok(out.prompt.includes('2026-09-14-01-'), '提示词里没有输出路径');
  assert.ok(out.prompt.includes('考研英语（一）'), '提示词没强调考研规格');
  assert.ok(out.prompt.includes('答案速查'), '提示词没写答案格式');
});

check('提示词要求格式严格（选项各占一行 / 答案一行）', () => {
  const cfg = { vaultDir: '/tmp/vault', storyDir: '/tmp/vault/单词故事' };
  const words = [{ voc_id: 'v1', spelling: 'alpha' }];
  const { prompt } = paperPrompt(cfg, words, { date: '2026-09-14', types: ['read-main'] });
  assert.ok(/A\.\s*选项/.test(prompt), '没写明选项格式');
  assert.ok(/1\.A 2\.C/.test(prompt), '没写明答案速查格式');
  assert.ok(prompt.includes('出现多次'), '没说明词可以重复出现');
});

check('提示词：解析要够细 —— 有逐题精讲、定位句、长难句拆解，且没有 NaN/undefined', () => {
  const cfg = { vaultDir: '/tmp/vault', storyDir: '/tmp/vault/单词故事' };
  const words = Array.from({ length: 20 }, (_, i) => ({ voc_id: `v${i}`, spelling: `word${i}` }));
  const { prompt } = paperPrompt(cfg, words, { date: '2026-09-14', types: ['read-detail', 'cloze'] });
  assert.ok(prompt.includes('## 长难句拆解'), '缺长难句拆解这一节');
  assert.ok(prompt.includes('定位句（原文照抄）'), '答案解析里缺定位句列');
  assert.ok(prompt.includes('逐题精讲'), '缺逐题精讲');
  assert.ok(prompt.includes('断句'), '长难句拆解里没要求断句');
  assert.ok(prompt.includes('主干'), '长难句拆解里没要求主干');
  assert.ok(prompt.includes('挂在谁身上'), '长难句拆解里没要求说清修饰挂在哪');
  // 模板字符串里混进未转义的反引号时，会静默产出 NaN/undefined —— 这里兜住
  const bad = prompt.match(/NaN|undefined|\[object Object\]/);
  assert.equal(bad, null, `提示词里出现了 ${bad && bad[0]}`);
});

check('提示词：逐句分析 —— 全文每句都要，不许漏句 / 不许合并', () => {
  const cfg = { vaultDir: '/tmp/vault', storyDir: '/tmp/vault/单词故事' };
  const words = [{ voc_id: 'v1', spelling: 'alpha' }];
  const { prompt } = paperPrompt(cfg, words, { date: '2026-09-14', types: ['read-detail'] });
  assert.ok(prompt.includes('## 逐句分析'), '模板里没有「逐句分析」这一节');
  assert.ok(prompt.includes('**S1.**'), '没给可照抄的 S1 格式');
  assert.ok(prompt.includes('全文每一句'), '没要求覆盖全文每一句');
  assert.ok(prompt.includes('不许漏句'), '没禁止漏句');
  assert.ok(prompt.includes('不许把两三句并成一句'), '没禁止合并句子');
  assert.ok(/标题原文照抄[\s\S]{0,400}## 逐句分析/.test(prompt), '没把「逐句分析」列进标题照抄清单');
  assert.ok(prompt.includes('- **结构**') && prompt.includes('- **翻译**'), '没写清每句要给结构和翻译');
});

check('提示词：用词限定考研大纲内；超纲词必须就地注释，且不许注释目标词', () => {
  const cfg = { vaultDir: '/tmp/vault', storyDir: '/tmp/vault/单词故事' };
  const { prompt } = paperPrompt(cfg, [{ voc_id: 'v1', spelling: 'obtain' }], { types: ['read-main'] });
  assert.ok(prompt.includes('严格控制在考研英语（一）大纲词汇范围内'), '没说清用词范围');
  assert.ok(prompt.includes('万一必须出现大纲外的词'), '没交代超纲词怎么办');
  assert.ok(prompt.includes('在文中就地注释'), '没说要在文里注释');
  assert.ok(/superconductor（超导体）/.test(prompt), '没给注释的写法示例');
  assert.ok(prompt.includes('第一次'), '没说只在首次出现时注释');
  assert.ok(prompt.includes('不要给目标词加注释'), '没排除目标词');
});

check('提示词：生词回收表按文中出现顺序排', () => {
  const cfg = { vaultDir: '/tmp/vault', storyDir: '/tmp/vault/单词故事' };
  const { prompt } = paperPrompt(cfg, [{ voc_id: 'v1', spelling: 'obtain' }], { types: ['read-main'] });
  assert.ok(prompt.includes('按在文中出现的先后顺序排'), '没要求按出现顺序');
  assert.ok(prompt.includes('按词在文中**出现的先后**排'), '模板里没写在表下面');
});

check('生词回收：读出来时按词在文中出现的先后重排（文件一个字节都不动）', () => {
  const prose =
    'The statute was passed last year. Researchers **obtain** data from it, and the statute still matters. Limping along, they obtain more.';
  const body = [
    '# 假文章',
    '',
    prose,
    '',
    '## 生词回收',
    '',
    '| 单词 | 词性 · 释义 | 文中原句 |',
    '| --- | --- | --- |',
    '| limping | v. 跛行 | Limping along |',
    '| obtain | v. 获得 | they obtain more |',
    '| statute | n. 法令 | The statute was passed |',
    '| nowhere | adv. 哪都没有 | （正文里压根没有这个词）',
    '',
    '## 中文大意',
    '',
    '大意。',
  ].join('\n');
  const out = sortVocabByArticleOrder(body, prose);
  const rows = out
    .split('\n')
    .filter((l) => l.startsWith('| ') && !l.includes('---') && !l.includes('单词'))
    .map((l) => l.split('|')[1].trim());
  // statute 最先出现 → obtain 其次 → limping 最后；正文里找不到的排在最末，且保持原相对顺序
  assert.deepEqual(rows, ['statute', 'obtain', 'limping', 'nowhere'], rows.join(' → '));
  // 只改这一节的表格行：正文、前后小节、表头都要原样
  assert.ok(out.includes(prose), '正文被动了');
  assert.ok(out.includes('| 单词 | 词性 · 释义 | 文中原句 |'), '表头被动了');
  assert.ok(out.endsWith('## 中文大意\n\n大意。'), '后面那节被动了');
  // 没有这张表 / 只有一行时不折腾
  assert.equal(sortVocabByArticleOrder('# 只有正文\n\nhello', 'hello'), '# 只有正文\n\nhello');
  assert.equal(
    sortVocabByArticleOrder('## 生词回收\n\n只有一句话，不是表', 'x'),
    '## 生词回收\n\n只有一句话，不是表'
  );
});

check('提示词：没词 / 没题型都要报错', () => {
  const cfg = { vaultDir: '/tmp/vault', storyDir: '/tmp/vault/单词故事' };
  assert.throws(() => paperPrompt(cfg, [], { types: ['read-main'] }), /先选几个单词/);  assert.throws(() => paperPrompt(cfg, [{ voc_id: 'v', spelling: 'a' }], { types: [] }), /先勾一个题型/);
});

/* ---------- 存取与解析 ---------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-units-'));
const cfg = {
  vaultDir: tmp,
  storyDir: path.join(tmp, '单词故事'),
  backupDir: path.join(tmp, 'backups'),
};

check('存进去再读回来：题目 / 选项 / 答案速查都能解析', () => {
  const md = `---
date: 2026-09-14
type: 传统阅读 · 细节题
title: T
words:
  - alpha
  - beta
---

# T

Alpha and **beta**.

## 题目

1. First question?
A. one
B. two

2. Second question?
A. one
B. two

## 答案速查

1.B 2.A

## 生词回收

| 单词 | 释义 |
| --- | --- |
| **alpha** | n. 甲 |
`;
  saveStory(cfg, '单词故事/2026-09-14-01-传统阅读·细节题.md', md);
  const back = readStory(cfg, '单词故事/2026-09-14-01-传统阅读·细节题.md');
  assert.equal(back.exists, true);
  assert.equal(back.title, 'T');
  assert.equal(back.questions.length, 2);
  assert.deepEqual(back.questions[0].options.map((o) => o.key), ['A', 'B']);
  assert.deepEqual(back.key, { 1: 'B', 2: 'A' });
  assert.deepEqual(back.words, ['alpha', 'beta']);
  assert.ok(back.body.startsWith('# T'), 'frontmatter 没被剥掉');
  assert.equal(back.length, 3, `正文词数应为 3，实际 ${back.length}`);
});

check('没有 frontmatter 的故事会被自动补一份（带 words，才能高亮）', () => {
  saveStory(cfg, '单词故事/2026-09-14-02-传统阅读·主旨题.md', '# 光秃秃\n\n只有正文。', {
    words: ['alpha', 'beta'],
  });
  const back = readStory(cfg, '单词故事/2026-09-14-02-传统阅读·主旨题.md');
  assert.equal(back.title, '光秃秃');
  assert.deepEqual(back.words, ['alpha', 'beta']);
});

check('完形填空式：20 题、每题 4 个选项，原文里的 (1)…(20) 空不影响解析', () => {
  const lines = ['---', 'date: 2026-09-14', 'title: Cloze', '---', '', '# Cloze', ''];
  lines.push('The city (1)____ its carts for fifty years, and the clerks (2)____ nothing.');
  lines.push('', '## 题目');
  for (let i = 1; i <= 20; i += 1) {
    lines.push('', `${i}. Choose the best word for blank (${i}).`);
    for (const k of ['A', 'B', 'C', 'D']) lines.push(`${k}. option ${k} of ${i}`);
  }
  lines.push('', '## 答案速查', '', Array.from({ length: 20 }, (_, i) => `${i + 1}.A`).join(' '));
  saveStory(cfg, '单词故事/2026-09-14-03-完形填空.md', lines.join('\n'));
  const back = readStory(cfg, '单词故事/2026-09-14-03-完形填空.md');
  assert.equal(back.questions.length, 20);
  assert.ok(back.questions.every((q) => q.options.length === 4), '有题不是 4 个选项');
  assert.equal(Object.keys(back.key).length, 20);
  assert.equal(back.key['20'], 'A');
});

check('新题型式：5 题、每题 A–G 七个选项也能解析（不写死四个）', () => {
  const md = `---
date: 2026-09-14
title: NewType
---

# NewType

Body text.

## 题目

1. Which paragraph fits gap (1)?
A. first
B. second
C. third
D. fourth
E. fifth
F. sixth
G. seventh

## 答案速查

1.G
`;
  saveStory(cfg, '单词故事/2026-09-14-04-新题型.md', md);
  const back = readStory(cfg, '单词故事/2026-09-14-04-新题型.md');
  assert.equal(back.questions.length, 1);
  assert.deepEqual(back.questions[0].options.map((o) => o.key), ['A', 'B', 'C', 'D', 'E', 'F', 'G']);
  assert.equal(back.key['1'], 'G');
});

check('题目格式写崩了也不炸：解析不出来就返回空，交给前端退回普通渲染', () => {
  saveStory(cfg, '单词故事/2026-09-14-05-传统阅读·态度题.md', '# 乱写的\n\n## 题目\n\n这道题没有选项也没有编号。\n');
  const back = readStory(cfg, '单词故事/2026-09-14-05-传统阅读·态度题.md');
  assert.deepEqual(back.questions, []);
  assert.deepEqual(back.key, {});
  assert.ok(back.body.includes('这道题没有选项'), '正文应该还在');
});

check('故事列表：新日期在前，同一天按序号升序，旧的「-故事.md」排最后', () => {
  // 同一天再放一份没有序号的旧格式文件，它应该排在所有编号篇目后面
  saveStory(cfg, '单词故事/2026-09-14-故事.md', '# 旧格式\n\n正文。');
  saveStory(cfg, '单词故事/2026-09-13-故事.md', '# 更早的一天\n\n正文。');
  const list = listStories(cfg);
  assert.equal(list[0].date, '2026-09-14', `最新日期没排在最前：${list.map((s) => s.date).join(',')}`);
  const sameDay = list.filter((s) => s.date === '2026-09-14').map((s) => s.seq);
  const numbered = sameDay.filter((n) => n > 0);
  assert.deepEqual(numbered, [...numbered].sort((a, b) => a - b), `编号没升序：${numbered.join(',')}`);
  assert.equal(sameDay[sameDay.length - 1], 0, `旧格式没排最后：${sameDay.join(',')}`);
});

check('故事目录外的路径一律拒绝（不能借接口读写别的文件）', () => {
  assert.throws(() => readStory(cfg, '../../etc/passwd.md'), /只能读写故事目录|非法路径/);
  assert.throws(() => saveStory(cfg, '../乱写.md', '# x'), /只能读写故事目录|非法路径/);
  assert.throws(() => readStory(cfg, '错题本/某题.md'), /只能读写故事目录/);
  assert.throws(() => saveStory(cfg, '单词故事/不是markdown.txt', '# x'), /只能操作 .md/);
});

check('空内容不给存', () => {
  assert.throws(() => saveStory(cfg, '单词故事/2026-09-14-03-完形填空.md', '   '), /空的/);
});

/* ---------- 今日测试 ---------- */
const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-test-'));
const tcfg = {
  vaultDir: tdir,
  testDir: path.join(tdir, '今日测试'),
  backupDir: path.join(tdir, 'backups'),
  notebookDir: path.join(tdir, '错题本'),
  planDir: path.join(tdir, '考研'),
  reviewDir: path.join(tdir, '复盘'),
  noteDirs: [],
};

const TEST_MD = `---
date: 2026-09-14
title: 9/14 今日测试
scope: 数学 · 连续性 ｜ 408 · C 语言
minutes: 30
---

# 9/14 今日测试

## 题目

### 1. 填空 ｜ 左右极限

设 $f(x)=…$，则 $a=$ ______。

### 2. 大题 ｜ 编译过程

一段 C 程序要经过哪些步骤？

## 答案与解析

### 1. 填空 ｜ 左右极限

**标准答案**

$a=2$

**解析**

- 先算左极限……
- 易错点：忘了分母的 $x$。

### 2. 大题 ｜ 编译过程

**标准答案**

解：依次经过预处理、编译、汇编、链接四步。

**解析**

- 为什么这样切分……
`;

check('今日测试：题号与答案一一对上，答案里带解析', () => {
  saveTest(tcfg, '今日测试/2026-09-14-今日测试.md', TEST_MD);
  const back = readTest(tcfg, '今日测试/2026-09-14-今日测试.md');
  assert.equal(back.exists, true);
  assert.equal(back.title, '9/14 今日测试');
  assert.equal(back.minutes, 30);
  assert.equal(back.items.length, 2);
  assert.deepEqual(back.items.map((q) => q.type), ['填空', '大题']);
  assert.deepEqual(back.items.map((q) => q.topic), ['左右极限', '编译过程']);
  assert.ok(back.items[0].answer.includes('a=2'), '第 1 题答案没对上');
  assert.ok(back.items[1].answer.includes('预处理'), '第 2 题答案没对上');
  assert.deepEqual(back.answerMissing, []);
});

check('今日测试：答案拆成「标准答案」和「解析」两段', () => {
  const { answer, analysis } = splitAnswer(readTest(tcfg, '今日测试/2026-09-14-今日测试.md').items[0].answer);
  assert.ok(answer.includes('a=2'), `标准答案不对：${answer.slice(0, 40)}`);
  assert.ok(!answer.includes('易错点'), '标准答案里混进了解析');
  assert.ok(analysis.includes('易错点'), '解析没拆出来');
});

check('今日测试：有题没答案时如实标出来，而不是静默丢掉', () => {
  saveTest(
    tcfg,
    '今日测试/2026-09-13-今日测试.md',
    '# 缺答案\n\n## 题目\n\n### 1. 填空 ｜ A\n\n题干\n\n### 2. 填空 ｜ B\n\n题干\n\n## 答案与解析\n\n### 2. 填空 ｜ B\n\n**标准答案**\n\n42\n'
  );
  const back = readTest(tcfg, '今日测试/2026-09-13-今日测试.md');
  assert.equal(back.items.length, 2);
  assert.deepEqual(back.answerMissing, [1]);
  assert.equal(back.items[1].answer.includes('42'), true);
});

check('今日测试：列表按日期倒序', () => {
  const list = listTests(tcfg);
  assert.equal(list[0].date, '2026-09-14');
  assert.equal(list[0].count, 2);
  assert.equal(list[0].minutes, 30);
});

check('今日测试：文件名与路径防护', () => {
  assert.equal(testRelOf(tcfg, '2026-09-14'), '今日测试/2026-09-14-今日测试.md');
  assert.throws(() => readTest(tcfg, '../../etc/passwd.md'), /只能读写测试目录|非法路径/);
  assert.throws(() => saveTest(tcfg, '../../乱写.md', '# x'), /只能读写测试目录|非法路径/);
  assert.throws(() => saveTest(tcfg, '单词故事/x.md', '# x'), /只能读写测试目录/);
});

check('今日测试：题量按「今天学了多少」动态定，不写死题数', () => {
  const base = {
    date: '2026-09-14', weekday: '周一', week: null, other: [], review: null,
    weakPoints: [], troubled: [], mistakes: null,
  };
  const 少 = dailyTestPrompt(tcfg, {
    ...base,
    math: [{ group: '数学', text: '极限 (11)', done: false }],
    cs: [], notes: [], recentNotes: [],
    learned: { tasks: 1, mathTasks: 1, csTasks: 0, notes: 0, noteChars: 0, hasReview: false, volume: '少' },
  }).prompt;
  const 多 = dailyTestPrompt(tcfg, {
    ...base,
    math: [{ group: '数学', text: '第 3 章', done: false }],
    cs: [{ group: '408', text: '第 4 章', done: false }],
    notes: [{ rel: 'a.md', body: '笔记' }], recentNotes: [],
    learned: { tasks: 5, mathTasks: 3, csTasks: 2, notes: 3, noteChars: 2400, hasReview: true, volume: '多' },
  }).prompt;
  assert.ok(少.includes('3–5 道') && 少.includes('20–30 分钟'), '学得少时没给出对应题量');
  assert.ok(多.includes('10–14 道') && 多.includes('45–60 分钟'), '学得多时没给出对应题量');
  assert.ok(多.includes('最多 60 分钟'), '没写时长上限');
  assert.ok(少.includes('别漏知识点'), '没写「别漏知识点」');
  assert.ok(!/总题量控制在 \*\*25[–-]30 分钟\*\*/.test(少), '还在写死 25–30 分钟');
});

check('今日测试：题型跟着内容走 —— 概念填空 / 公式默写 / 选择题 / 填空 / 大题', () => {
  const ctx = {
    date: '2026-09-14', weekday: '周一', week: null, other: [], review: { rel: 'r.md', body: '今天学了洛必达' },
    math: [{ group: '数学', text: '极限 (11)', done: false }], cs: [], notes: [], recentNotes: [],
    weakPoints: ['等价无穷小（3 题）'], troubled: [], mistakes: null,
    learned: { tasks: 1, mathTasks: 1, csTasks: 0, notes: 0, noteChars: 0, hasReview: true, volume: '一般' },
  };
  const { prompt } = dailyTestPrompt(tcfg, ctx);
  for (const t of ['概念填空', '公式默写', '选择题', '大题']) {
    assert.ok(prompt.includes(t), `没提到「${t}」`);
  }
  assert.ok(prompt.includes('每个重要知识点至少出一道题'), '没要求覆盖知识点');
  assert.ok(prompt.includes('一道题可以有多个小问'), '没给「一题多小问」这个扩容手段');
  assert.ok(prompt.includes('考点') && prompt.includes('不要写 LaTeX'), '没要求考点名别写 LaTeX');
  assert.ok(prompt.includes('内容实在撑不起'), '没允许内容不够时少出');
  assert.ok(prompt.includes('今天的复盘'), '没把今日复盘列为出题依据');
  assert.ok(prompt.includes('今天记的笔记') || prompt.includes('今天刚记录的笔记'), '没把今日笔记列为出题依据');
  assert.ok(prompt.includes('基础阶段'), '没写基础阶段该多出概念填空/公式默写');
  assert.ok(!prompt.includes('不要出选择题'), '还禁止着选择题');
});

check('今日测试：提示词卡死「只考今天」', () => {
  const ctx = {
    date: '2026-09-14', weekday: '周一', week: null,
    math: [{ group: '数学', text: '极限 (11)', done: false }],
    cs: [{ group: '408', text: '第一章 配置 C 语言开发环境', done: false }],
    other: [], notes: [], recentNotes: [], review: null,
    weakPoints: ['等价无穷小（3 题，失败 0 次）'], troubled: [], mistakes: null,
  };
  const { prompt, rel } = dailyTestPrompt(tcfg, ctx);
  assert.equal(rel, '今日测试/2026-09-14-今日测试.md');
  assert.ok(prompt.includes('极限 (11)'), '没带上今天的数学任务');
  assert.ok(prompt.includes('第一章 配置 C 语言开发环境'), '没带上今天的 408 任务');
  assert.ok(/分钟/.test(prompt), '没写时长');
  assert.ok(prompt.includes('只考今天出现过的内容'), '没卡死「只考今天」');
  assert.ok(prompt.includes('一步一依据'), '没要求考试标准答案');
  assert.ok(prompt.includes('等价无穷小'), '没带上薄弱考点');
});

check('今日测试：今天没记笔记时，提示词会说明「最近笔记不是今天的」', () => {
  const ctx = {
    date: '2026-09-14', weekday: '周一', week: null,
    math: [], cs: [], other: [], notes: [],
    recentNotes: [{ rel: '公式本/极限/x.md', body: '正文' }],
    review: null, weakPoints: [], troubled: [], mistakes: null,
  };
  const { prompt } = dailyTestPrompt(tcfg, ctx);
  assert.ok(prompt.includes('不是今天的'), '没标明最近笔记的日期属性');
  assert.ok(prompt.includes('今天还没记笔记'), '没说明今天没记笔记');
});

/* ---------- 每日一句 ---------- */
check('每日一句：正好内置 460 句，且没有重复', () => {
  assert.equal(QUOTES.length, 460, `应该有 460 句，现在是 ${QUOTES.length}`);
  assert.equal(new Set(QUOTES.map((q) => q.text)).size, 460, '有重复的句子');
  for (const q of QUOTES) {
    assert.ok(q.text && q.text.trim(), '有空句子');
    assert.ok(q.from && q.from.trim(), `「${q.text}」没写出处`);
  }
});

check('每日一句：用户给的那几十句全在，且被彻底打散（不按原顺序连着出）', () => {
  const guren = QUOTES.filter((q) => q.from === '《蛊真人》');
  assert.equal(guren.length, 37, `蛊真人的句子应该有 37 条，现在是 ${guren.length}`);
  const pos = QUOTES.map((q, i) => (q.from === '《蛊真人》' ? i : -1)).filter((i) => i >= 0);
  // 全部打散：不能出现两连号（原顺序连着出来的话必然是连续 index）
  const consecutive = pos.filter((p, i) => i > 0 && p - pos[i - 1] === 1);
  assert.equal(consecutive.length, 0, '还有连着排的，没打散干净');
  // 也别全挤在一头：散布范围要覆盖整个池子
  assert.ok(Math.min(...pos) < 60, '开头太长时间没有');
  assert.ok(Math.max(...pos) > QUOTES.length - 60, '结尾太长时间没有');
});

check('每日一句：同一天永远同一句，跨天会换，一天天走能走满一整轮不重复', () => {
  const d = (n) => {
    const t = new Date(2026, 8, 14 + n);
    const p = (x) => String(x).padStart(2, '0');
    return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
  };
  assert.deepEqual(quoteOfTheDay(d(0)), quoteOfTheDay(d(0)), '同一天两次取到的不是同一句');
  assert.notEqual(quoteOfTheDay(d(0)).text, quoteOfTheDay(d(1)).text, '第二天没换句子');
  // 连续 460 天：每一句都出现过，且各出现一次
  const seen = new Map();
  for (let i = 0; i < 460; i += 1) {
    const q = quoteOfTheDay(d(i));
    seen.set(q.text, (seen.get(q.text) || 0) + 1);
  }
  assert.equal(seen.size, 460, `一轮只出现了 ${seen.size} 句`);
  assert.ok([...seen.values()].every((n) => n === 1), '一轮里有句子重复出现');
});

check('每日一句：超过 460 天会从头循环，也不会崩', () => {
  const d = (n) => {
    const t = new Date(2026, 8, 14 + n);
    const p = (x) => String(x).padStart(2, '0');
    return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
  };
  assert.equal(quoteOfTheDay(d(460)).text, quoteOfTheDay(d(0)).text, '第 461 天没回到第 1 天');
  for (let i = 0; i < 1500; i += 1) assert.ok(quoteOfTheDay(d(i)).text, '取到空句子');
});

check('每日一句：自己在 quotes.txt 里加的句子排在最后，不挤掉内置的', () => {
  const extra = parseExtraQuotes('# 注释\n自己写的一句 | 我自己\n只有句子\n\n');
  assert.equal(extra.length, 2);
  assert.equal(extra[0].text, '自己写的一句');
  assert.equal(extra[0].from, '我自己');
  assert.equal(extra[1].text, '只有句子');
  assert.equal(extra[1].from, '自己加的');
  const q = quoteOfTheDay('2026-09-14', extra);
  assert.ok(q.total === 462, `总数应该是 460+2，现在是 ${q.total}`);
});

/* ---------- 分值 · 参考用时 · 判分（grade.mjs） ---------- */

check('分值：从题目行里抠出来，「考点」里的数字不会被误当成分值', () => {
  assert.equal(scoreFromHead('大题 ｜ 中值定理 ｜ 20 分'), 20);
  assert.equal(scoreFromHead('选择题 ｜ 极限 ｜ 4分'), 4);
  assert.equal(scoreFromHead('大题 ｜ 中值定理（12 分）'), 12);
  assert.equal(scoreFromHead('概念填空 ｜ 第 2 类间断点'), null, '考点里的「2」被当成分值了');
  assert.equal(scoreFromHead('大题 ｜ 1 的无穷大型'), null);
  assert.equal(scoreFromHead('大题 ｜ 洛必达法则'), null);
});

check('分值：全标了就用标好的，满分是它们的和（程序不替模型改口径）', () => {
  const t = scoreTable([{ n: 1, score: 40 }, { n: 2, score: 60 }]);
  assert.equal(t.full, 100);
  assert.deepEqual(t.byN, { 1: 40, 2: 60 });
  assert.equal(t.assumed, false);
  // 模型标了 97 分（没凑够 100）也如实显示，不偷偷补成 100
  assert.equal(scoreTable([{ n: 1, score: 52 }, { n: 2, score: 45 }]).full, 97);
});

check('分值：没标就按满分平均分，加起来正好等于满分（不因为四舍五入丢分）', () => {
  const t = scoreTable([{ n: 1 }, { n: 2 }, { n: 3 }], { full: 100 });
  assert.equal(t.assumed, true);
  assert.equal(t.full, 100);
  const sum = Object.values(t.byN).reduce((a, b) => a + b, 0);
  assert.equal(Math.round(sum * 100) / 100, 100, `加起来是 ${sum}，不是 100`);
  assert.equal(t.byN[3], 33.34, '最后一名没吃掉舍入余数');
});

check('参考用时：今日测试按出题时估的 minutes 分摊，分值高的题分到更多时间', () => {
  const t = scoreTable([{ n: 1, score: 25 }, { n: 2, score: 75 }]);
  const ref = referenceTime({ full: 100, byN: t.byN, minutes: 40 });
  assert.equal(ref.seconds, 2400);
  assert.equal(ref.minutes, 40);
  assert.equal(ref.byN[1], 600);
  assert.equal(ref.byN[2], 1800);
});

check('参考用时：英语按考研真题的分值时间比 —— 一篇 10 分的阅读正好 18 分钟', () => {
  const t = scoreTable([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }], { full: ENGLISH_FULL });
  const ref = referenceTime({ full: t.full, byN: t.byN, perPoint: ENGLISH_MIN_PER_POINT });
  assert.equal(ref.minutes, 18);
  assert.equal(ref.byN[1], 216); // 2 分 × 1.8 分钟 = 3 分 36 秒
});

check('英语：完形 20 空每空 0.5 分、传统阅读 5 题每题 2 分，单篇都是 10 分', () => {
  const cloze = gradePaper({ kind: 'story', rel: 'x', questions: Array.from({ length: 20 }, (_, i) => ({ n: i + 1 })) });
  assert.equal(cloze.table.full, 10);
  assert.equal(cloze.table.byN[1], 0.5);
  const read = gradePaper({ kind: 'story', rel: 'x', questions: Array.from({ length: 5 }, (_, i) => ({ n: i + 1 })) });
  assert.equal(read.table.full, 10);
  assert.equal(read.table.byN[5], 2);
  // 8 个题型在考研里都是 10 分
  for (const t of PAPER_TYPES) assert.equal(t.full, 10, `${t.label} 的满分不是 10`);
});

check('判分提示词：带上每题分值、考研按步给分、固定错因词表，且不许猜看不清的答案', () => {
  const paper = {
    kind: 'test',
    rel: '今日测试/2026-09-14-今日测试.md',
    title: '9/14 今日测试',
    minutes: 40,
    full: 100,
    items: [
      { n: 1, type: '选择题', topic: '极限', score: 6, body: '题干一', answerText: '解：答案一', analysisText: '解析一' },
      { n: 2, type: '大题', topic: '中值定理', score: 94, body: '题干二', answerText: '解：答案二', analysisText: '解析二' },
    ],
  };
  const { prompt } = gradePrompt(paper, { images: 2, seconds: 2530, date: '2026-09-14' });
  assert.ok(prompt.includes('满分 100 分'), '没写满分');
  assert.ok(prompt.includes('第 1 题 ｜ 选择题 ｜ 极限 ｜ 满分 6 分'), '每题的分值没带上');
  assert.ok(prompt.includes('按步给分'), '没要求按步给分（考研就是这么给的）');
  assert.ok(prompt.includes('结果算错但方法对'), '没写「方法对只扣结果分」');
  assert.ok(prompt.includes('方法错但结论碰巧对'), '没写「碰巧对不给分」');
  assert.ok(prompt.includes('看不清') && prompt.includes('绝不许猜'), '没禁止瞎猜看不清的答案');
  for (const r of GRADE_REASONS) assert.ok(prompt.includes(r), `错因词表漏了「${r}」`);
  assert.ok(prompt.includes('42:10') && prompt.includes('40:00'), '没把用时和参考用时告诉模型');
  assert.ok(prompt.includes('2 张照片'), '没告诉模型有几张图');
  assert.ok(!/undefined|NaN/.test(prompt), '提示词里有 undefined / NaN');
});

check('判分提示词：只给数学 / 408 用，不会把英语那份也塞进去（英语本地判就够了）', () => {
  const { prompt } = gradePrompt(
    {
      kind: 'test',
      rel: '今日测试/2026-09-14-今日测试.md',
      title: '9/14 今日测试',
      minutes: 30,
      full: 100,
      items: [{ n: 1, type: '大题', topic: '中值定理', score: 100, body: '题干', answerText: '解：…', analysisText: '解析' }],
    },
    { images: 1, seconds: 600 }
  );
  assert.ok(prompt.includes('今日测试（数学 / 408）'), '没写清这是哪一类卷子');
  assert.ok(!prompt.includes('只看选项字母'), '英语那套判分说明混进来了');
});

check('判分结果：总分由程序自己加，单题得分被夹在 [0, 满分] 里', () => {
  const table = scoreTable([{ n: 1, score: 40 }, { n: 2, score: 60 }]);
  const r = normalizeGrade({ items: [{ n: 1, score: 999 }, { n: 2, score: -5 }], summary: 's' }, table);
  assert.equal(r.items[0].score, 40, '超过满分的得分没被夹住');
  assert.equal(r.items[1].score, 0, '负分没被夹住');
  assert.equal(r.total, 40, '总分不是各项之和');
  assert.equal(r.full, 100);
});

check('判分结果：模型漏判的题按 0 分补上，一道都不能少；错因只认固定词表', () => {
  const table = scoreTable([{ n: 1 }, { n: 2 }, { n: 3 }], { full: 100 });
  const r = normalizeGrade(
    { items: [{ n: 1, score: 20, verdict: '部分正确', reason: '粗心大意' }, { n: 2, score: 0, reason: '我编的错因' }] },
    table
  );
  assert.equal(r.items.length, 3, '漏判的题没补上');
  assert.equal(r.items[2].verdict, '未作答');
  assert.equal(r.items[2].score, 0);
  assert.equal(r.items[0].reason, '粗心大意');
  assert.equal(r.items[1].reason, '', '自己造的错因没被丢掉');
  assert.equal(r.missing, 1);
});

check('判分结果：满分的题不给错因（它没错）', () => {
  const table = scoreTable([{ n: 1, score: 100 }]);
  const r = normalizeGrade({ items: [{ n: 1, score: 100, reason: '粗心大意' }] }, table);
  assert.equal(r.items[0].reason, '');
  assert.equal(r.items[0].verdict, '正确');
});

const GRADE_META = { 1: { type: '选择题', topic: '极限' }, 2: { type: '大题', topic: '中值定理' } };
const ATTEMPT = {
  index: 1,
  date: '2026-09-14',
  total: 76,
  full: 100,
  seconds: 2530,
  refSeconds: 2400,
  images: 2,
  source: 'ai',
  withReason: true,
  meta: GRADE_META,
  items: [
    { n: 1, score: 6, full: 6, verdict: '正确', reason: '', lost: '无', fix: '保持' },
    { n: 2, score: 70, full: 94, verdict: '部分正确', reason: '计算失误', lost: '漏了 |x| 的符号', fix: '先讨论 x=0' },
  ],
  summary: '中值定理那一步跳了',
  weak: ['中值定理', '分类讨论'],
  next: ['重做第 2 题'],
};

check('成绩记录：写进去再读回来，分数 / 用时 / 判定 / 错因 / 丢分点都对得上', () => {
  const md = formatGradeRecord(ATTEMPT);
  const back = readGradeRecords(writeGradeRecord('# 卷子\n', md));
  assert.equal(back.length, 1);
  const g = back[0];
  assert.equal(g.index, 1);
  assert.equal(g.date, '2026-09-14');
  assert.equal(g.total, 76);
  assert.equal(g.full, 100);
  assert.equal(g.seconds, 2530);
  assert.equal(g.refSeconds, 2400);
  assert.equal(g.images, 2);
  assert.equal(g.source, 'ai');
  assert.equal(g.items.length, 2);
  assert.equal(g.items[0].verdict, '正确');
  assert.equal(g.items[0].topic, '极限');
  assert.equal(g.items[1].score, 70);
  assert.equal(g.items[1].reason, '计算失误');
  assert.equal(g.items[1].lost, '漏了 |x| 的符号；改：先讨论 x=0', '单元格里的竖线没转义回来');
  assert.deepEqual(g.weak, ['中值定理', '分类讨论']);
  assert.equal(g.summary, '中值定理那一步跳了');
  assert.equal(g.missing, 0, '这次每题都判到了，不该报「模型没判到」');
});

check('成绩记录：模型漏判的题数能数回来（列表上要如实提醒，别让总分看着像考砸了）', () => {
  // normalizeGrade 遇到模型没判到的题会补一行「未作答 + 模型没判到」，这条要能被数出来
  const table = { full: 10, byN: { 1: 5, 2: 5 } };
  const result = normalizeGrade({ items: [{ n: 1, score: 5 }] }, table);
  const md = formatGradeRecord({ ...ATTEMPT, index: 1, total: result.total, full: result.full, items: result.items });
  const g = readGradeRecords(writeGradeRecord('# 卷子\n', md))[0];
  assert.equal(g.items.length, 2);
  assert.equal(g.items[1].verdict, '未作答');
  assert.equal(g.missing, 1, '漏判的题没数出来');
  assert.equal(g.total, 5);
});

check('成绩记录：英语客观题那份不带错因列，读回来也不串列', () => {
  const md = formatGradeRecord({
    ...ATTEMPT,
    withReason: false,
    source: 'local',
    images: 0,
    items: ATTEMPT.items.map((x) => ({ ...x, reason: '计算失误' })),
  });
  const g = readGradeRecords(writeGradeRecord('# 卷子\n', md))[0];
  assert.equal(g.source, 'local');
  assert.equal(g.items[1].reason, '');
  assert.equal(g.items[1].lost, '漏了 |x| 的符号；改：先讨论 x=0');
});

check('成绩记录：只动那一节，试卷正文一个字节都不改', () => {
  const body = '# 9/14 今日测试\n\n## 题目\n\n### 1. 选择题 ｜ 极限 ｜ 6 分\n\n题干一\n\n## 答案与解析\n\n解：答案一\n';
  const prev = formatGradeRecord({ ...ATTEMPT, index: 1, date: '2026-09-13' });
  const next = formatGradeRecord({ ...ATTEMPT, index: 2, date: '2026-09-14' });
  const c1 = writeGradeRecord(body, prev);
  const c2 = writeGradeRecord(c1, next);
  const strip = (t) => t.replace(/## 成绩记录[\s\S]*$/, '').trimEnd();
  assert.equal(strip(c1), body.trimEnd(), '第一次写成绩就把正文改了');
  assert.equal(strip(c2), body.trimEnd(), '第二次写成绩把正文改了');
  assert.ok(c2.indexOf('第 2 次') < c2.indexOf('第 1 次'), '最新的成绩没排在最前面');
  assert.equal((c2.match(/### 第 \d 次/g) || []).length, 2, '旧成绩被覆盖了');
  assert.deepEqual(readGradeRecords(c2).map((x) => x.index), [2, 1]);
});

check('成绩记录：重新生成试卷时把旧成绩接回去，不会被一次重出题抹掉', () => {
  const body = '# 9/14 今日测试\n\n## 题目\n\n### 1. 选择题 ｜ 极限 ｜ 6 分\n\n题干一\n';
  const withGrade = writeGradeRecord(body, formatGradeRecord(ATTEMPT));
  const fresh = '# 9/14 今日测试\n\n## 题目\n\n### 1. 大题 ｜ 新考点 ｜ 100 分\n\n新题干\n';
  const merged = preserveGradeSection(withGrade, fresh);
  assert.ok(merged.includes('新题干'), '新题没写进去');
  assert.ok(merged.includes('### 第 1 次'), '旧成绩丢了');
  assert.equal(readGradeRecords(merged)[0].total, 76);
  assert.equal(preserveGradeSection(withGrade, withGrade), withGrade);
});

/* ---------- 单题判分（错题本的做题模式） ---------- */

check('单题判分：提示词带上题干 / 标准答案 / 解析 / 我的历史，并要求按采分点给分', () => {
  const prompt = questionGradePrompt(
    {
      num: '极限-01', title: '左右极限', category: '数学', subject: '高数', chapter: '极限',
      type: '计算题', difficulty: 3, heat: 4, points: ['左右极限', '分段点'],
      stem: '设 $f(x)=…$，求 $\\lim_{x\\to 0}f(x)$。',
      answer: '解：左极限 1，右极限 2，故极限不存在。',
      solution: '分别求左右极限再比较。',
      pitfalls: '别忘了先看分段点。',
      keypoints: '分段函数在分段点处必须分左右。',
      firstReason: '概念不清',
      stats: { total: 3, last: { result: '普通' } },
    },
    { images: 2, seconds: 245, date: '2026-09-14' }
  );
  assert.ok(prompt.includes('批我**一道题**'), '没说清是单题');
  assert.ok(prompt.includes('左极限 1，右极限 2'), '没带标准答案');
  assert.ok(prompt.includes('分别求左右极限再比较'), '没带解析');
  assert.ok(prompt.includes('这道题我已经练过 3 次'), '没带练习历史');
  assert.ok(prompt.includes('上一次是「普通」'), '没带上一次结果');
  assert.ok(prompt.includes('我第一次做错的原因记的是「概念不清」'), '没带首次错因');
  assert.ok(prompt.includes('按步给分'), '没要求按步给分');
  assert.ok(prompt.includes('方法错但结论碰巧对'), '没写「碰巧对不给分」');
  assert.ok(prompt.includes('绝不许猜'), '没禁止瞎猜看不清的答案');
  assert.ok(prompt.includes('4:05'), '没把这次用时告诉模型');
  for (const r of GRADE_REASONS) assert.ok(prompt.includes(r), `错因词表漏了「${r}」`);
  for (const r of QUESTION_RESULTS) assert.ok(prompt.includes(r), `结果词表漏了「${r}」`);
  assert.ok(!/undefined|NaN/.test(prompt), '提示词里有 undefined / NaN');
});

check('单题判分：结果只认「完美 / 普通 / 失败」，模型乱给的词按得分换算', () => {
  assert.equal(normalizeQuestionGrade({ score: 95, result: '完美' }).result, '完美');
  assert.equal(normalizeQuestionGrade({ score: 70, result: '普通' }).result, '普通');
  assert.equal(normalizeQuestionGrade({ score: 30, result: '失败' }).result, '失败');
  // 模型给了个不认识的词 → 用得分兜底
  assert.equal(normalizeQuestionGrade({ score: 92, result: '做得不错' }).result, '完美');
  assert.equal(normalizeQuestionGrade({ score: 61, result: '' }).result, '普通');
  assert.equal(normalizeQuestionGrade({ score: 0 }).result, '失败');
});

check('单题判分：得分夹在 0–100；完美不给错因；错因只认固定词表', () => {
  const hi = normalizeQuestionGrade({ score: 999, result: '完美', reason: '计算失误' });
  assert.equal(hi.score, 100);
  assert.equal(hi.reason, '', '完美的题不该带错因');
  const lo = normalizeQuestionGrade({ score: -20, result: '失败', reason: '我编的错因' });
  assert.equal(lo.score, 0);
  assert.equal(lo.reason, '', '自己造的错因没被丢掉');
  assert.equal(normalizeQuestionGrade({ score: 50, result: '失败', reason: '计算失误' }).reason, '计算失误');
  assert.equal(normalizeQuestionGrade({ score: 50, result: '失败' }).result, '失败');
});

check('单题判分：错因分析原样带回来（那一整段要写进笔记），空的也给空串', () => {
  const v = normalizeQuestionGrade({ score: 80, result: '普通', analysis: '这一步没讨论 x=0。\n下次先看分段点。' });
  assert.equal(v.analysis, '这一步没讨论 x=0。\n下次先看分段点。');
  assert.equal(normalizeQuestionGrade({ score: 80 }).analysis, '');
});

check('单题判分：模型没给分数时报错，不静默判 0 分', () => {
  // 一次「模型没回 score」的事故要是按 0 分落盘，就成了「我考了 0 分」，
  // 打卡记录 / 遗忘曲线 / 错因统计全被带偏 —— 宁可这次判分失败
  for (const bad of [{}, { result: '失败' }, { score: null }, { score: '不知道' }, null]) {
    assert.throws(() => normalizeQuestionGrade(bad), /没有给出分数/, `没拦住：${JSON.stringify(bad)}`);
  }
  // 0 分本身是合法结果（真没做出来 / 没作答），照收
  assert.equal(normalizeQuestionGrade({ score: 0, result: '失败' }).score, 0);
  assert.equal(normalizeQuestionGrade({ score: 0 }).result, '失败');
  // 看不清 / 没作答也是这个口径（宁可严，别白送分）
  assert.equal(normalizeQuestionGrade({ score: 0, result: '失败' }).result, '失败');
});

check('整卷判分：一道题都没对上、或整卷一个分都没有时报错，不静默判 0 分', () => {
  const table = { full: 10, byN: { 1: 5, 2: 5 } };
  assert.throws(() => normalizeGrade({ items: [] }, table), /没写盘/, '空 items 没拦住');
  assert.throws(
    () => normalizeGrade({ items: [{ n: 9, score: 5 }, { n: 8, score: 5 }] }, table),
    /题号一个都对不上/,
    '题号全错没拦住'
  );
  assert.throws(
    () => normalizeGrade({ items: [{ n: 1 }, { n: 2, score: null }] }, table),
    /每题都没有分数/,
    '整卷没分没拦住'
  );
  // 正常的一份照旧：总分程序自己加、每题夹在满分内
  const ok = normalizeGrade({ items: [{ n: 1, score: 5 }, { n: 2, score: 99 }] }, table);
  assert.equal(ok.total, 10);
  assert.equal(ok.items[1].score, 5);
  // 只漏了一题的分：按 0 记，但 missing 要让界面说得出来
  const partial = normalizeGrade({ items: [{ n: 1, score: 5 }] }, table);
  assert.equal(partial.total, 5);
  assert.equal(partial.missing, 1);
});

check('写盘：AI 的错因分析写进 ## 错因分析，而且只留最近一次（不堆流水账）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-ana-'));
  const file = path.join(dir, 'x.md');
  fs.writeFileSync(
    file,
    '# 极限-01　左右极限\n\n## 题干\n\n题干\n\n## 错因分析\n\n> [!question]- 展开 · 错因（做题时别看）\n> **首次错因**　概念不清\n\n## 打卡记录\n\n- [ ] 第 1 次 · 完美\n',
    'utf8'
  );
  setReasonAnalysis(file, '第一行\n第二行', '2026-09-14');
  const once = fs.readFileSync(file, 'utf8');
  assert.ok(once.includes('> [!note]- 展开 · 最近一次判分（2026-09-14）'), '没写进去');
  assert.ok(once.includes('> 第一行\n> 第二行'), '多行没逐行加 > 前缀（Obsidian 会截断）');
  assert.ok(once.includes('> **首次错因**　概念不清'), '首次错因被动了');
  assert.ok(once.indexOf('## 错因分析') < once.indexOf('## 打卡记录'), '插错地方了');

  setReasonAnalysis(file, '第二次的分析', '2026-09-15');
  const twice = fs.readFileSync(file, 'utf8');
  assert.equal((twice.match(/最近一次判分/g) || []).length, 1, '旧的判分块没被替换掉');
  assert.ok(twice.includes('第二次的分析') && !twice.includes('第一行'), '还留着上一次的');
  assert.ok(twice.includes('## 打卡记录'), '打卡记录被弄丢了');

  // 没有这一节的笔记：整段插到打卡记录之前
  const file2 = path.join(dir, 'y.md');
  fs.writeFileSync(file2, '# t\n\n## 打卡记录\n\n- [ ] 第 1 次 · 完美\n', 'utf8');
  setReasonAnalysis(file2, '分析', '2026-09-14');
  const made = fs.readFileSync(file2, 'utf8');
  assert.ok(made.includes('## 错因分析') && made.indexOf('## 错因分析') < made.indexOf('## 打卡记录'));
  fs.rmSync(dir, { recursive: true, force: true });
});

check('今日测试：一次读出分值、参考用时和历次成绩（页面上的计时器与判分都用它）', () => {
  const md = `---
date: 2026-09-14
title: 9/14 今日测试
minutes: 40
full: 100
---

# 9/14 今日测试

## 题目

### 1. 选择题 ｜ 极限 ｜ 40 分

题干一

### 2. 大题 ｜ 中值定理 ｜ 60 分

题干二

## 答案与解析

### 1. 选择题 ｜ 极限 ｜ 40 分

**标准答案**

A

**解析**

- 易错点……

### 2. 大题 ｜ 中值定理 ｜ 60 分

**标准答案**

解：完整过程

**解析**

- 为什么……
`;
  saveTest(tcfg, '今日测试/2026-09-20-今日测试.md', md);
  const back = readTest(tcfg, '今日测试/2026-09-20-今日测试.md');
  assert.deepEqual(back.items.map((q) => q.score), [40, 60]);
  assert.equal(back.plan.table.full, 100);
  assert.equal(back.plan.table.assumed, false);
  assert.equal(back.plan.ref.minutes, 40);
  assert.equal(back.plan.ref.byN[1], 960);
  assert.equal(back.items[1].answerText, '解：完整过程');
  assert.equal(back.items[1].analysisText, '- 为什么……');
  const row = listTests(tcfg).find((x) => x.rel.endsWith('2026-09-20-今日测试.md'));
  assert.equal(row.full, 100);
  assert.equal(row.refMinutes, 40);
  assert.equal(row.last, null);
});

check('今日测试：存了成绩之后，列表和详情都能看到最近一次的分数，题干不受影响', () => {
  const rel = '今日测试/2026-09-20-今日测试.md';
  const gradeMd = formatGradeRecord(ATTEMPT);
  assert.equal(saveTestGrade(tcfg, rel, gradeMd).ok, true);
  const after = readTest(tcfg, rel);
  assert.equal(after.grades.length, 1);
  assert.equal(after.last.total, 76);
  assert.equal(after.items.length, 2, '写成绩把题目弄丢了');
  assert.ok(after.content.includes('### 1. 选择题 ｜ 极限 ｜ 40 分'), '题干被改了');
  const row = listTests(tcfg).find((x) => x.rel.endsWith('2026-09-20-今日测试.md'));
  assert.equal(row.last.total, 76);
});

check('英语题目：判分要用的答案与解析能读出来，成绩也能写回同一篇', () => {
  const srel = '单词故事/2026-09-14-09-传统阅读·细节题.md';
  const STORY_MD = `---
date: 2026-09-14
type: 传统阅读 · 细节题
title: The Quiet Death of a Paper Rule
words:
  - statute
---

# The Quiet Death of a Paper Rule

The statute was **monotonous** and nobody read it.

## 题目

1. What does the author suggest about the rule?
A. It was widely read
B. It quietly lost its force
C. It was repealed loudly
D. It was never written

2. The word "monotonous" most probably means
A. boring
B. strict
C. brief
D. fair

## 答案速查

1.B 2.A

## 答案解析

| 题号 | 题型 | 答案 |
| --- | --- | --- |
| 1 | 细节题 | B |

第 1 段定位句：nobody read it。同义替换……

## 中文大意

讲的是……`;
  saveStory(cfg, srel, STORY_MD);
  const s = readStory(cfg, srel);
  assert.ok(s.analysis.includes('定位句'), '答案解析没读出来');
  assert.equal(s.plan.table.full, 10);
  // 这篇只有 2 道题 → 10 ÷ 2 = 每题 5 分（标准的一篇阅读是 5 题 × 2 分）
  assert.equal(s.plan.table.byN[1], 5);
  assert.equal(s.plan.ref.minutes, 18);
  const md = formatGradeRecord({ ...ATTEMPT, index: 1, total: 8, full: 10, withReason: false, source: 'local' });
  assert.equal(saveStoryGrade(cfg, srel, md).ok, true);
  const after = readStory(cfg, srel);
  assert.equal(after.grades.length, 1);
  assert.equal(after.last.total, 8);
  assert.equal(after.last.full, 10);
  assert.equal(after.questions.length, s.questions.length, '写成绩把题目弄丢了');
  // 重新生成这一篇，成绩还在
  saveStory(
    cfg,
    srel,
    `---\ntitle: 新的一篇\n---\n\n# 新的一篇\n\nText here.\n\n## 题目\n\n1. Q?\nA. a\nB. b\n\n## 答案速查\n\n1.A\n\n## 答案解析\n\n第 1 段定位句……\n`
  );
  const regen = readStory(cfg, srel);
  assert.equal(regen.grades.length, 1, '重新生成把成绩记录抹了');
  assert.ok(regen.content.includes('新的一篇'));
});

/* ---------- 模型输出的 JSON 容错（增题「格式不对、一道都没写进去」的真正原因就在这儿） ---------- */
// 数学题的答案全是 LaTeX。模型只要把 `\lim` 写成单个反斜杠，整份 JSON 就是坏的：
// 以前会一道都写不进去，界面上只留一句「模型没有按 JSON 格式返回」。
// 这几条盯着它别再退回去。

check('模型漏转义 LaTeX 反斜杠时，JSON 要能修回来（而且内容一个字符都不许变）', () => {
  const raw = String.raw`{"items":[{"n":1,"title":"求极限","answer":"解：$\lim_{x\to 0}\frac{\sin x}{x}=1$","keyPoints":"等价无穷小"}]}`;
  assert.throws(() => JSON.parse(raw), '原生 JSON.parse 竟然过了 —— 这条测试就没意义了');
  const got = parseItemsEnvelopeEx(raw);
  assert.equal(got.repaired, 'repaired');
  assert.equal(got.items.length, 1);
  assert.equal(got.items[0].answer, String.raw`解：$\lim_{x\to 0}\frac{\sin x}{x}=1$`, '修完把内容改坏了');
});

check('尾逗号 / ``` 围栏 / 前后有解释文字，都还认得出', () => {
  assert.equal(parseItemsEnvelopeEx('{"items":[{"n":1,"title":"a","answer":"b",},]}').items.length, 1);
  const fenced = '好的：\n```json\n{"items":[{"n":1,"title":"围栏题","answer":"a"}]}\n```\n以上。';
  const got = parseItemsEnvelopeEx(fenced);
  assert.equal(got.items.length, 1);
  assert.equal(got.items[0].title, '围栏题');
});

check('整份 JSON 坏了（最后一道被截断）时，前面完整的题要救回来，并如实标「只救回一部分」', () => {
  const partial = String.raw`{"items":[{"n":1,"title":"第一题","answer":"ok"},{"n":2,"title":"第二题","answer":"被截`;
  const got = parseItemsEnvelopeEx(partial);
  assert.equal(got.repaired, 'partial', '没标出这是「救回来的」，界面上就会瞒着用户');
  assert.deepEqual(got.items.map((x) => x.n), [1], '没救回第一道');
});

check('彻底不是 JSON 就老实返回 null（别硬编出一道假题写进笔记）', () => {
  assert.equal(parseItemsEnvelopeEx('这是一段中文，不是 JSON。').items, null);
  assert.equal(parseItemsEnvelopeEx('').items, null);
  assert.equal(parseItemsEnvelopeEx('{"items":[]}').items, null);
  // 只有别的对象、没有题：不能把无关的 {} 当成一道题
  assert.equal(parseItemsEnvelopeEx('{"foo":{"bar":1}}').items, null);
});

// 判分时总评 / 薄弱点 / 下一步是**和 items 平级**的。以前 server 只把 items 数组交出去，
// 这三项当场就没了 —— 成绩单上永远没有总评，模型写得再好也看不见。
check('整卷判分：总评 / 薄弱点 / 下一步要和 items 一起交出来（不能只给 items）', () => {
  const got = parseItemsEnvelopeEx(
    String.raw`{"items":[{"n":1,"score":10,"lost":"漏了 $x\to 0^+$"}],"summary":"总评：$\frac{1}{2}$ 别再丢","weak":["等价无穷小"],"next":["重做第 1 题"]}`
  );
  assert.equal(got.items.length, 1);
  assert.ok(got.envelope, '没把整份信封交出来');
  assert.equal(got.envelope.summary, String.raw`总评：$\frac{1}{2}$ 别再丢`);
  assert.deepEqual(got.envelope.weak, ['等价无穷小']);
  assert.deepEqual(got.envelope.next, ['重做第 1 题']);
  // 判分那一步真正用的就是它
  const g = normalizeGrade(got.envelope, scoreTable([{ n: 1, score: 10 }]));
  assert.equal(g.summary, String.raw`总评：$\frac{1}{2}$ 别再丢`);
  assert.deepEqual(g.weak, ['等价无穷小']);
});

check('整卷判分：整份 JSON 坏了、只救回几道题时，不假装有总评', () => {
  const got = parseItemsEnvelopeEx('{"items":[{"n":1,"score":10,"lost":"ok"}],"summary":"这段被截');
  assert.equal(got.repaired, 'partial');
  assert.deepEqual(Object.keys(got.envelope), ['items']);
  assert.equal(got.envelope.summary, undefined);
});

check('files 信封与判分对象走同一套容错（看图写题、拍照判分同样会踩这个坑）', () => {
  const files = parseFilesEnvelope(String.raw`{"files":[{"rel":"错题本/a.md","content":"$\lim_{x\to 0}$"}]}`);
  assert.equal(files.length, 1);
  assert.equal(files[0].content, String.raw`$\lim_{x\to 0}$`);
  const grade = parseJsonEnvelope(String.raw`{"score":72,"analysis":"用 \frac{1}{2} 算"}`);
  assert.equal(grade.score, 72);
  assert.equal(grade.analysis, String.raw`用 \frac{1}{2} 算`);
});

check('模型把 rel 写成 path / file / name 时也要认（真实翻车：整批题因为一个字段名全丢）', () => {
  const body = String.raw`"content":"---\ntags:\n  - 错题本\n---\n\n# 标题\n\n$\frac{1}{2}$"`;
  for (const key of ['path', 'file', 'filename', 'filepath', 'name']) {
    const got = parseFilesEnvelope(`{"files":[{"${key}":"错题本/数学/高数/连续/连续-01-x.md",${body}}]}`);
    assert.ok(got, `字段名 ${key} 没认出来`);
    assert.equal(got[0].rel, '错题本/数学/高数/连续/连续-01-x.md');
    assert.ok(got[0].content.includes(String.raw`\frac{1}{2}`), `${key} 的正文坏了`);
  }
  // 正文字段名同理：text / body / markdown 都收
  const t = parseFilesEnvelope('{"files":[{"path":"错题本/a.md","text":"# a"}]}');
  assert.equal(t[0].content, '# a');
});

check('一个文件都收不下时，要说清是哪个字段名对不上（别只说「格式不对」）', () => {
  const got = parseFilesEnvelopeEx('{"files":[{"标题":"错题本/a.md","正文":"x"}]}');
  assert.equal(got.files, null);
  assert.ok(got.hint.includes('标题'), `hint 没点出模型用的字段名：${got.hint}`);
  assert.ok(got.hint.includes('rel'), `hint 没说要的是什么：${got.hint}`);
});

check('看图写题的提示词必须写清 JSON 结构与字段名（漏了它模型就会自己起 path）', () => {
  const footer = filesFooter({ dir: '错题本', label: '错题本' });
  assert.ok(footer.includes('"rel"') && footer.includes('"content"'), '没给 JSON 结构');
  assert.ok(footer.includes('path') && footer.includes('file'), '没点名禁止用 path / file 这些字段名');
  assert.ok(footer.includes('错题本/'), '没写清楚 rel 从哪儿算起');
});

check('失败提示里要带上模型原文摘要，不能只说一句「格式不对」', () => {
  const s = snippet(`  第一行\n第二行\n${'x'.repeat(500)}`, 60);
  assert.ok(!s.includes('\n'), '摘要里不该有换行');
  assert.ok(s.length <= 61 && s.endsWith('…'), `摘要没截断：${s.length}`);
  assert.equal(snippet(''), '');
});

/* ---------- 自动归类：通解落盘的两道护栏 ---------- */
// 归类这一步会**整份替换**已有的通解文件（模型返回全文），所以越界和写瘦都得拦住

check('自动归类：通解只许写进题型本，越界（错题本 / 好题本）一律拒收', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pat-'));
  const cfg = {
    vaultDir: root,
    patternDir: path.join(root, '题型本'),
    notebookDir: path.join(root, '错题本'),
    backupDir: path.join(root, 'backups'),
  };
  const pattern = '---\ntags:\n  - 题型本\nrelated:\n  - mistakes:x\n---\n\n# 通解\n\n## 通解步骤\n\n1. 先配方。\n';
  const wrote = writePatternNote(cfg, '题型本/数学/高数/极限/配方.md', pattern);
  assert.equal(wrote.rel, '题型本/数学/高数/极限/配方.md');
  assert.ok(fs.existsSync(path.join(root, '题型本', '数学', '高数', '极限', '配方.md')), '该写的没写');
  // 错题本里的题不该被这一步碰
  assert.throws(() => writePatternNote(cfg, '错题本/数学/高数/极限/别动.md', pattern), /只能写进题型本/);
  assert.throws(() => writePatternNote(cfg, '题型本/../../etc/passwd.md', pattern), /路径不合法/);
  assert.throws(() => writePatternNote(cfg, '题型本/数学/图.svg', pattern), /只能是 \.md/);
  assert.throws(() => writePatternNote(cfg, '题型本/数学/没frontmatter.md', '# 光有正文'), /frontmatter/);
  fs.rmSync(root, { recursive: true, force: true });
});

check('自动归类：不许把已有通解写瘦（模型只回半截时拒收，原文一个字不动）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pat2-'));
  const cfg = {
    vaultDir: root,
    patternDir: path.join(root, '题型本'),
    notebookDir: path.join(root, '错题本'),
    backupDir: path.join(root, 'backups'),
  };
  const rel = '题型本/数学/高数/极限/配方.md';
  const full = `---\ntags:\n  - 题型本\nrelated:\n  - mistakes:a\n---\n\n# 配方法\n\n## 通解步骤\n\n${'1. 一步一步来。\n'.repeat(40)}`;
  writePatternNote(cfg, rel, full);
  const abs = path.join(root, '题型本', '数学', '高数', '极限', '配方.md');
  // 归类时正常会变长（多一个 related id）：照收，并留备份
  const grown = full.replace('  - mistakes:a', '  - mistakes:a\n  - mistakes:b');
  writePatternNote(cfg, rel, grown);
  assert.ok(fs.readFileSync(abs, 'utf8').includes('mistakes:b'), '加 related 没写进去');
  assert.ok(fs.existsSync(cfg.backupDir), '替换前没备份');
  // 只回半截：直接拒收，盘上还是那份完整的
  assert.throws(() => writePatternNote(cfg, rel, '---\ntags:\n  - 题型本\n---\n\n# 配方法\n'), /短了一半/);
  assert.equal(fs.readFileSync(abs, 'utf8'), grown, '被写瘦了');
  fs.rmSync(root, { recursive: true, force: true });
});

check('自动归类：收尾指令说清了结构、字段名和「只改题型本」', () => {
  const f = patternFooter('题型本');
  assert.ok(f.includes('"rel"') && f.includes('"content"'), '没给 JSON 结构');
  assert.ok(f.includes('path') && f.includes('name'), '没点名禁止别的字段名');
  assert.ok(f.includes('只返回 `题型本/`'), '没划清只改题型本');
  assert.ok(f.includes('完整内容一起返回'), '没说清要返回整份全文');
});

/* ---------- 🔁 每日任务：勾选按天算 ----------
 * 症状：🔁 那一行只有一个勾，第二天还显示昨天勾了。
 * 现在勾选状态存在模板行下面的打卡子行里，一天一行。
 */
const dailyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-daily-'));
const dailyVault = path.join(dailyRoot, 'vault');
const dailyPlanDir = path.join(dailyVault, '考研', '2026-09');
fs.mkdirSync(dailyPlanDir, { recursive: true });
const dailyBackup = path.join(dailyRoot, 'backups');
const dailyRel = '考研/2026-09/2026-09-第3周-周计划.md';
const dailyAbs = path.join(dailyVault, dailyRel);
/** 一份最小周计划：H1 里带 9/14–9/20 的范围（每周 7 个打卡位） */
const writeDailyPlan = (taskLines) =>
  fs.writeFileSync(
    dailyAbs,
    `# 📅 2026-09 第 3 周（9/14–9/20）｜测试用\n\n## 📋 本周任务\n\n### 📐 数学\n${taskLines}\n`
  );
const readDailyPlan = () => fs.readFileSync(dailyAbs, 'utf8');
const dailyTaskOf = (today) => parsePlan(dailyAbs, dailyVault, today).taskGroups[0].tasks[0];

check('每日任务：昨天勾过的，今天不算完成（原来就错在这）', () => {
  writeDailyPlan('- [x] 🔁 每日单词 130 个 ✅ 2026-09-14');
  const t = dailyTaskOf('2026-09-15');
  assert.equal(t.daily, true, '没认出这是每日任务');
  assert.equal(t.done, false, '第二天不该算完成');
  assert.deepEqual(t.checkins, ['2026-09-14'], '昨天的打卡记录要留着');
  assert.equal(dailyTaskOf('2026-09-14').done, true, '当天看应该是完成');
});

check('每日任务：打卡子行按天算，不会被当成两条任务', () => {
  writeDailyPlan('- [ ] 🔁 每日单词 130 个\n  - [x] 2026-09-14\n  - [x] 2026-09-15');
  const tasks = parsePlan(dailyAbs, dailyVault, '2026-09-15').taskGroups[0].tasks;
  assert.equal(tasks.length, 1, '子行不该变成第二条任务');
  assert.deepEqual(tasks[0].checkins, ['2026-09-14', '2026-09-15']);
  assert.equal(tasks[0].done, true, '今天打过卡');
  assert.equal(tasks[0].weekDone, 2, '本周打了 2 次');
  assert.equal(tasks[0].slots, 7, '一周 7 个打卡位');
});

check('每日任务：勾今天 → 模板行保持 - [ ]，下面追加今天的打卡行', () => {
  writeDailyPlan('- [ ] 🔁 每日单词 130 个');
  const r = toggleTask(dailyVault, dailyBackup, dailyRel, {
    expect: '🔁 每日单词 130 个', done: true, date: '2026-09-15',
  });
  assert.equal(r.daily, true, '没走每日任务那条路');
  const text = readDailyPlan();
  assert.ok(text.includes('- [ ] 🔁 每日单词 130 个\n  - [x] 2026-09-15'), text);
  assert.ok(!/- \[x\] 🔁/.test(text), '模板行不该被勾上，否则第二天又带着勾');
});

check('每日任务：取消勾选只删当天那行，昨天的留着', () => {
  writeDailyPlan('- [ ] 🔁 每日单词 130 个\n  - [x] 2026-09-14\n  - [x] 2026-09-15');
  toggleTask(dailyVault, dailyBackup, dailyRel, {
    expect: '🔁 每日单词 130 个', done: false, date: '2026-09-15',
  });
  const text = readDailyPlan();
  assert.ok(text.includes('  - [x] 2026-09-14'), '昨天的不该被删');
  assert.ok(!text.includes('2026-09-15'), '今天那行该删掉');
  assert.equal(dailyTaskOf('2026-09-15').done, false);
});

check('每日任务：旧格式第一次写回时迁成子行，历史不丢', () => {
  writeDailyPlan('- [x] 🔁 每日单词 130 个 ✅ 2026-09-14');
  toggleTask(dailyVault, dailyBackup, dailyRel, {
    expect: '🔁 每日单词 130 个', done: true, date: '2026-09-15',
  });
  const text = readDailyPlan();
  assert.ok(text.includes('- [ ] 🔁 每日单词 130 个'), text);
  assert.ok(text.includes('  - [x] 2026-09-14') && text.includes('  - [x] 2026-09-15'), text);
  assert.ok(!text.includes('✅ 2026-09-14'), '旧日期该挪进子行');
});

check('每日任务：同一行文字重复出现时，@occ 还能定位到对的那条', () => {
  writeDailyPlan('- [ ] 🔁 每日单词 130 个\n- [ ] 极限 (11)');
  toggleTask(dailyVault, dailyBackup, dailyRel, {
    expect: '🔁 每日单词 130 个', occurrence: 0, done: true, date: '2026-09-15',
  });
  assert.ok(readDailyPlan().includes('  - [x] 2026-09-15'), readDailyPlan());
});

check('普通任务：写回还是老样子（行尾补 ✅ 日期）', () => {
  writeDailyPlan('- [ ] 9/15 极限 (11)');
  toggleTask(dailyVault, dailyBackup, dailyRel, {
    expect: '9/15 极限 (11)', done: true, date: '2026-09-15',
  });
  assert.ok(readDailyPlan().includes('- [x] 9/15 极限 (11) ✅ 2026-09-15'), readDailyPlan());
});

check('今日页：第二天的每日任务不再带着昨天的勾', () => {
  writeDailyPlan('- [ ] 9/15 今天的一次性任务\n- [x] 🔁 每日单词 130 个 ✅ 2026-09-14');
  const cfg = { vaultDir: dailyVault, planDir: path.join(dailyVault, '考研'), examDate: '2027-12-18' };
  plansCached(cfg, true); // 首页的计划扫描带 3 秒缓存，测试里手动失效
  const ctx = buildToday(cfg, null, new Date(2026, 8, 15));
  const daily = ctx.todayTasks.find((t) => t.daily);
  assert.ok(daily, '每日任务要出现在今日列表里');
  assert.equal(daily.done, false, '第二天不该显示勾上');
  assert.equal(daily.doneDate, null, '不该显示昨天的日期');
  assert.equal(ctx.todayTasks.find((t) => !t.daily).done, false);
});

check('今日页：当天勾过的每日任务算完成，本周打卡进度一起给出来', () => {
  writeDailyPlan('- [ ] 🔁 每日单词 130 个\n  - [x] 2026-09-15');
  const cfg = { vaultDir: dailyVault, planDir: path.join(dailyVault, '考研'), examDate: '2027-12-18' };
  plansCached(cfg, true);
  const ctx = buildToday(cfg, null, new Date(2026, 8, 15));
  assert.equal(ctx.todayTasks.find((t) => t.daily).done, true);
  assert.equal(ctx.week.daily.done, 1, '本周打卡数');
  assert.equal(ctx.week.daily.slots, 7, '本周应打卡数');
});

check('完成率：每日任务按天占位（4 项 × 7 天，不是 4 条）', () => {
  writeDailyPlan(
    '- [x] 9/14（周一）极限 (11) ✅ 2026-09-14\n- [ ] 🔁 每日单词 130 个\n  - [x] 2026-09-14\n  - [x] 2026-09-15'
  );
  const p = parsePlan(dailyAbs, dailyVault, '2026-09-15');
  assert.equal(p.total, 8, '1 条普通任务 + 7 个打卡位');
  assert.equal(p.done, 3, '1 条任务 + 2 次打卡');
  assert.equal(p.rate, 38, '3/8 = 38%');
  assert.equal(p.daily.done, 2, '本周打卡数');
  assert.equal(p.daily.slots, 7, '本周应打卡数');
});

check('七天进度条：每一格都算上当天该做的每日任务', () => {
  writeDailyPlan('- [x] 9/14（周一）极限 (11) ✅ 2026-09-14\n- [ ] 🔁 每日单词 130 个\n  - [x] 2026-09-14');
  const cfg = { vaultDir: dailyVault, planDir: path.join(dailyVault, '考研'), examDate: '2027-12-18' };
  plansCached(cfg, true);
  const days = buildToday(cfg, null, new Date(2026, 8, 15)).week.days;
  const mon = days.find((d) => d.date === '2026-09-14');
  const tue = days.find((d) => d.date === '2026-09-15');
  assert.equal(mon.total, 2, '周一：1 条任务 + 每日任务那格');
  assert.equal(mon.done, 2, '周一都完成了');
  assert.equal(tue.total, 1, '周二只剩每日任务那格');
  assert.equal(tue.done, 0, '今天还没打卡');
});

check('每日任务：翻回昨天能把漏掉的卡补上（记在那一天）', () => {
  writeDailyPlan('- [ ] 🔁 每日单词 130 个\n  - [x] 2026-09-14');
  toggleTask(dailyVault, dailyBackup, dailyRel, {
    expect: '🔁 每日单词 130 个', done: true, date: '2026-09-13',
  });
  const text = readDailyPlan();
  assert.ok(text.includes('  - [x] 2026-09-13') && text.includes('  - [x] 2026-09-14'), text);
  assert.ok(text.indexOf('2026-09-13') < text.indexOf('2026-09-14'), '补的那天要按日期排在前面');
});

check('首页看别的日子：任务换成那天的，每日任务按那天算', () => {
  writeDailyPlan(
    '- [ ] 9/14（周一）极限 (11)\n- [ ] 9/15（周二）极限 (12)\n- [ ] 🔁 每日单词 130 个\n  - [x] 2026-09-14'
  );
  const cfg = { vaultDir: dailyVault, planDir: path.join(dailyVault, '考研'), examDate: '2027-12-18' };
  plansCached(cfg, true);

  const today = buildToday(cfg, null, new Date(2026, 8, 15));
  assert.equal(today.viewing.isToday, true, '缺省就是今天');
  assert.ok(!today.todayTasks.some((t) => t.text.includes('极限 (11)')), '今天不该出现昨天的任务');
  assert.equal(today.todayTasks.find((t) => t.daily).done, false, '今天还没打卡');

  const past = buildToday(cfg, null, new Date(2026, 8, 15), '2026-09-14');
  const texts = past.todayTasks.map((t) => t.text).join('|');
  assert.equal(past.date, '2026-09-14');
  assert.equal(past.weekday, '周一');
  assert.equal(past.viewing.isToday, false);
  assert.equal(past.viewing.isFuture, false);
  assert.ok(texts.includes('极限 (11)'), '该出现 14 号的任务');
  assert.ok(!texts.includes('极限 (12)'), '不该出现 15 号的任务');
  assert.equal(past.todayTasks.find((t) => t.daily).done, true, '14 号那天打过卡');
  assert.ok(past.week.days.find((d) => d.date === '2026-09-14').isViewing, '七天条要标出正在看哪天');

  const future = buildToday(cfg, null, new Date(2026, 8, 15), '2026-09-16');
  assert.equal(future.viewing.isFuture, true, '还没到的那天要认出来（界面上不让勾）');
  assert.equal(future.countdown.days, today.countdown.days, '看别的日子，倒计时还是按今天算');
  assert.deepEqual(future.quote, today.quote, '每日一句也不跟着换');
});

fs.rmSync(dailyRoot, { recursive: true, force: true });


fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(tdir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n=== 单元测试：${results.length - failed.length}/${results.length} 通过 ===`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log('  ❌', f.label);
  process.exitCode = 1;
}
