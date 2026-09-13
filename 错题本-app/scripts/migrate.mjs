#!/usr/bin/env node
/**
 * migrate.mjs —— 把「高数错题本/」改造成「错题本/」三级结构
 *
 *   错题本/
 *   ├── 数学/{高数, 线代, 概率论}/{章节}/*.md
 *   └── 408/{数据结构, 计算机组成原理, 操作系统, 计算机网络}/{章节}/*.md
 *
 * 只做三件事：搬文件、改 tags、重写索引页。题目的正文一个字都不动。
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.argv[2] || '.');
const OLD = path.join(ROOT, '高数错题本');
const NEW = path.join(ROOT, '错题本');

export const TAXONOMY = {
  数学: {
    高数: [
      '极限', '连续', '函数', '导数', '微分',
      '一元函数积分学', '多元函数微分学', '多元函数积分学',
      '无穷级数', '微分方程', '向量代数与空间解析几何',
    ],
    线代: ['行列式', '矩阵', '向量', '线性方程组', '特征值与特征向量', '二次型'],
    概率论: [
      '随机事件与概率', '一维随机变量及其分布', '多维随机变量及其分布',
      '随机变量的数字特征', '大数定律与中心极限定理', '数理统计',
    ],
  },
  408: {
    数据结构: ['线性表', '栈队列和数组', '树与二叉树', '图', '查找', '排序'],
    计算机组成原理: ['计算机系统概述', '数据的表示和运算', '存储系统', '指令系统', '中央处理器', '总线', '输入输出系统'],
    操作系统: ['操作系统概述', '进程与线程', '内存管理', '文件管理', '输入输出管理'],
    计算机网络: ['计算机网络体系结构', '物理层', '数据链路层', '网络层', '传输层', '应用层'],
  },
};

const HEADER = (title, lines) => `${lines.join('\n')}\n`;

/** 单篇错题：改 tags，正文不动 */
function rewriteTags(text, subject) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return text;
  const fm = m[1];
  if (!fm.includes('高数错题本')) return text;

  const chapterTag = (fm.match(/^\s+-\s+(?!高数错题本)(.+?)\s*$/m) || [])[1];
  const typeLine = (fm.match(/^type\s*:\s*(.*)$/m) || [])[1] || '计算题';
  const diffLine = (fm.match(/^difficulty\s*:\s*(.*)$/m) || [])[1] || '⭐⭐⭐☆☆';
  const heatLine = (fm.match(/^heat\s*:\s*(.*)$/m) || [])[1] || '🔥🔥🔥☆☆';

  const tags = ['错题本', subject, chapterTag].filter(Boolean);
  const newFm = [
    'tags:',
    ...tags.map((t) => `  - ${t}`),
    `type: ${typeLine}`,
    `difficulty: ${diffLine}`,
    `heat: ${heatLine}`,
  ].join('\n');

  return text.replace(/^---\r?\n[\s\S]*?\r?\n---/, `---\n${newFm}\n---`);
}

/** 索引页里对「错题本」标签的统一写法 */
const q_table = (from, extraCols = '') => `\`\`\`dataview
TABLE WITHOUT ID
  file.link AS 题目,
  type AS 类型,
  difficulty AS 难度,
  heat AS 考研热度,
  length(filter(file.tasks, (t) => t.completed)) AS 打卡,
  choice(length(filter(file.tasks, (t) => t.completed and contains(t.text, "完美"))) > 0, "✅ 完成", "⏳ 待复习") AS 状态${extraCols}
FROM ${from}
WHERE type
SORT file.path ASC
\`\`\``;

function chapterIndex(chapter, subject) {
  return HEADER(chapter, [
    '---',
    'tags:',
    '  - 错题本',
    `  - ${subject}`,
    `  - ${chapter}`,
    '---',
    '',
    `# ${chapter} · 错题索引`,
    '',
    '> [!tip] 说明',
    '> 每题一篇；**答案、解析、考点难点、易错提醒全部折叠**。每篇底部有打卡区：做完一次勾一个结果，**勾到「完美」即复习完成**。',
    '> 本页由 Obsidian 的 dataview 自动汇总；用错题本程序打开会看到更完整的统计与刷题功能。',
    '',
    q_table(`#错题本 AND #${chapter}`, ''),
    '',
  ]);
}

function subjectIndex(subject, category, chapters) {
  const rows = chapters
    .map((c) => `| ${c} | | |`)
    .join('\n');
  return HEADER(subject, [
    '---',
    'tags:',
    '  - 错题本',
    `  - ${category}`,
    `  - ${subject}`,
    '---',
    '',
    `# ${subject} · 错题索引`,
    '',
    `> [!tip] 本页汇总「${category} / ${subject}」下的全部错题。`,
    '> 答案与解析默认折叠，点标题展开；勾到「完美」即为复习完成。',
    '',
    q_table(`#错题本 AND #${subject}`, ',\n  file.folder AS 位置'),
    '',
    '## 建议章节划分（没有的文件夹，加题时再建）',
    '',
    '| 章节 | 现有题数 | 备注 |',
    '| --- | --- | --- |',
    rows,
    '',
  ]);
}

function categoryIndex(category, subjects) {
  const rows = Object.keys(subjects).map((s) => `| [[00-${s}错题索引\\|${s}]] | | |`).join('\n');
  return HEADER(category, [
    '---',
    'tags:',
    '  - 错题本',
    `  - ${category}`,
    '---',
    '',
    `# ${category} · 错题总览`,
    '',
    `> [!tip] 本页汇总「${category}」下所有科目的错题。`,
    '',
    q_table(`#错题本 AND #${category}`, ',\n  file.folder AS 位置'),
    '',
    '## 科目分布',
    '',
    '```dataview',
    'TABLE WITHOUT ID',
    '  split(file.folder, "/")[2] AS 科目,',
    '  length(rows) AS 题数,',
    '  length(filter(rows.file.tasks, (t) => t.completed)) AS 打卡次数',
    'FROM #错题本',
    'WHERE type',
    'GROUP BY split(file.folder, "/")[2]',
    'SORT 题数 DESC',
    '```',
    '',
    '## 科目入口',
    '',
    '| 科目 | 题数 | 完成 |',
    '| --- | --- | --- |',
    rows,
    '',
  ]);
}

function rootIndex(taxonomy) {
  const rows = Object.entries(taxonomy)
    .map(([cat, subs]) => Object.keys(subs).map((s) => `| ${cat} | ${s} | | |`).join('\n'))
    .join('\n');
  return HEADER('错题本', [
    '---',
    'tags:',
    '  - 错题本',
    '---',
    '',
    '# 错题本 · 总览',
    '',
    '> [!tip] 结构',
    '> `错题本/<大类>/<科目>/<章节>/题目.md` —— 数学（高数 · 线代 · 概率论）与 408（数据结构 · 组成原理 · 操作系统 · 计算机网络）。',
    '> 每篇只显示「考的类型 · 难度 · 考研热度」三行，答案与解析默认折叠，底部有打卡区。',
    '',
    '## 全部错题',
    '',
    q_table('#错题本', ',\n  file.folder AS 位置'),
    '',
    '## 按大类 / 科目汇总',
    '',
    '```dataview',
    'TABLE WITHOUT ID',
    '  split(file.folder, "/")[1] AS 大类,',
    '  split(file.folder, "/")[2] AS 科目,',
    '  length(rows) AS 题数,',
    '  length(filter(rows.file.tasks, (t) => t.completed)) AS 打卡次数',
    'FROM #错题本',
    'WHERE type',
    'GROUP BY split(file.folder, "/")[1] + " / " + split(file.folder, "/")[2]',
    'SORT 题数 DESC',
    '```',
    '',
    '## 学科对照表',
    '',
    '| 大类 | 科目 | 题数 | 完成 |',
    '| --- | --- | --- | --- |',
    rows,
    '',
  ]);
}

function main() {
  if (!fs.existsSync(OLD)) {
    console.log(`没有找到 ${OLD}，可能已经迁移过。`);
    return;
  }
  if (fs.existsSync(NEW)) {
    console.error(`目标目录 ${NEW} 已存在，为避免覆盖，已中止。`);
    process.exit(1);
  }

  let moved = 0;
  let retagged = 0;

  // 1) 建骨架 + 搬题
  for (const [category, subjects] of Object.entries(TAXONOMY)) {
    for (const subject of Object.keys(subjects)) {
      const subjectDir = path.join(NEW, category, subject);
      fs.mkdirSync(subjectDir, { recursive: true });
    }
  }

  // 现有章节：高数下的 极限/函数/连续/导数/微分
  for (const entry of fs.readdirSync(OLD, { withFileTypes: true })) {
    if (entry.name.startsWith('00-') || entry.name.startsWith('_')) continue;
    if (!entry.isDirectory()) continue;

    const srcDir = path.join(OLD, entry.name);
    const dstDir = path.join(NEW, '数学', '高数', entry.name);
    fs.mkdirSync(dstDir, { recursive: true });

    for (const f of fs.readdirSync(srcDir)) {
      const src = path.join(srcDir, f);
      const dst = path.join(dstDir, f);
      let text = fs.readFileSync(src, 'utf8');
      if (!f.startsWith('00-')) {
        const before = text;
        text = rewriteTags(text, '高数');
        if (text !== before) retagged += 1;
      }
      fs.writeFileSync(dst, text, 'utf8');
      moved += 1;
    }
  }

  // 2) 章节索引（搬过来的 00- 文件统一重写成新格式）
  for (const [category, subjects] of Object.entries(TAXONOMY)) {
    for (const subject of Object.keys(subjects)) {
      const subjectDir = path.join(NEW, category, subject);
      if (!fs.existsSync(subjectDir)) continue;
      for (const ch of fs.readdirSync(subjectDir, { withFileTypes: true })) {
        if (!ch.isDirectory()) continue;
        const chDir = path.join(subjectDir, ch.name);
        for (const f of fs.readdirSync(chDir)) {
          if (f.startsWith('00-')) fs.rmSync(path.join(chDir, f));
        }
        fs.writeFileSync(path.join(chDir, `00-${ch.name}-错题索引.md`), chapterIndex(ch.name, subject), 'utf8');
      }
    }
  }

  // 408 各科目下先放一个索引
  for (const [category, subjects] of Object.entries(TAXONOMY)) {
    for (const [subject, chapters] of Object.entries(subjects)) {
      const dir = path.join(NEW, category, subject);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `00-${subject}-错题索引.md`), subjectIndex(subject, category, chapters), 'utf8');
    }
    fs.writeFileSync(path.join(NEW, category, `00-${category}-总览.md`), categoryIndex(category, subjects), 'utf8');
  }

  // 3) 顶层
  fs.writeFileSync(path.join(NEW, '00-错题本总览.md'), rootIndex(TAXONOMY), 'utf8');

  // 4) 模板
  const tpl = fs.readFileSync(path.join(OLD, '_错题模板.md'), 'utf8');
  fs.writeFileSync(
    path.join(NEW, '_错题模板.md'),
    tpl
      .replace(/  - 高数错题本/g, '  - 错题本\n  - <科目名：高数 / 线代 / 概率论 / 数据结构 / …>')
      .replace(/高数错题本\//g, '错题本/数学/高数/')
      .replace(/`高数错题本`/g, '`错题本`'),
    'utf8'
  );

  // 5) 移除旧目录
  fs.rmSync(OLD, { recursive: true, force: true });

  console.log(`搬移文件 ${moved} 个，改写 tags ${retagged} 篇`);
  console.log(`新结构：${NEW}`);
}

main();
