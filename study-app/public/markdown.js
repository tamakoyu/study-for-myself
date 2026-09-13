/**
 * markdown.js —— 极简 Markdown + LaTeX 渲染器
 *
 * 只覆盖错题笔记里真实用到的语法：标题、粗体、行内代码、列表、分割线、
 * 引用/标注、表格，以及 $行内公式$ 与 $$行间公式$$。
 * 先抽出公式（避免被当成 Markdown 处理），最后再用 KaTeX 渲染回去。
 */

let katexReady = false;
export function initMath() {
  katexReady = typeof window !== 'undefined' && !!window.katex;
  return katexReady;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderMath(tex, displayMode) {
  const src = String(tex).trim();
  if (katexReady) {
    try {
      return window.katex.renderToString(src, {
        displayMode,
        throwOnError: false,
        strict: 'ignore',
        output: 'html',
      });
    } catch {
      /* 落到下面显示原文 */
    }
  }
  return `<code class="math-fallback">${escapeHtml(src)}</code>`;
}

/** 行内语法：代码 → 粗体 → 斜体 → 链接 → 删除线 */
function inline(text) {
  let t = escapeHtml(text);
  t = t.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  t = t.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return t;
}

const CALLOUT_ICON = {
  note: '🔎', info: 'ℹ️', tip: '💡', success: '✅', question: '❓',
  warning: '⚠️', error: '⛔', example: '📝', abstract: '📋', quote: '❝',
};

/** 引用块 —— 识别 Obsidian 的 `> [!type]- 标题` 标注语法 */
function renderQuote(lines) {
  const head = lines[0] && lines[0].match(/^\[!(\w+)\]([+-]?)\s*(.*)$/);
  if (head) {
    const kind = head[1].toLowerCase();
    const title = head[3].trim();
    const body = blocks(lines.slice(1));
    return `<div class="callout callout-${kind}">
      <div class="callout-head">${CALLOUT_ICON[kind] || '📌'}${title ? `<span>${inline(title)}</span>` : ''}</div>
      <div class="callout-body">${body}</div>
    </div>`;
  }
  return `<blockquote>${blocks(lines)}</blockquote>`;
}

function renderTable(rows) {
  const cells = (line) =>
    line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const head = cells(rows[0]);
  const body = rows.slice(2).map(cells);
  return `<div class="table-wrap"><table>
    <thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>
    <tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>`;
}

function isBlockStart(line) {
  return /^(#{1,6}\s|>|\s*[-*+]\s|\s*\d+[.、)]\s|\||\u0000|\s*$|-{3,}\s*$)/.test(line);
}

/** 块级解析 */
function blocks(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*$/.test(line)) { i++; continue; }

    // 已被抽出的公式
    if (/^\u0000\$\d+\u0000$/.test(line.trim())) {
      out.push(`<div class="math-display">${line.trim()}</div>`);
      i++;
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lv = Math.min(6, h[1].length + 1);
      out.push(`<h${lv} class="md-h">${inline(h[2])}</h${lv}>`);
      i++;
      continue;
    }

    if (/^-{3,}\s*$/.test(line) || /^\*{3,}\s*$/.test(line)) {
      out.push('<hr class="md-hr">');
      i++;
      continue;
    }

    // 引用 / 标注
    if (/^>/.test(line)) {
      const buf = [];
      while (
        i < lines.length &&
        (/^>/.test(lines[i]) || (/^\s*$/.test(lines[i]) && /^>/.test(lines[i + 1] || '')))
      ) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      while (buf.length && /^\s*$/.test(buf[buf.length - 1])) buf.pop();
      out.push(renderQuote(buf));
      continue;
    }

    // 表格
    if (/^\|.*\|/.test(line) && /^\|[\s:|-]+\|$/.test((lines[i + 1] || '').trim())) {
      const rows = [];
      while (i < lines.length && /^\|.*\|/.test(lines[i])) {
        rows.push(lines[i].trim());
        i++;
      }
      out.push(renderTable(rows));
      continue;
    }

    // 无序列表（其中 - [ ] / - [x] 渲染成可点击的复选框）
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i]);
        i++;
      }
      out.push(
        `<ul class="md-list">${items
          .map((raw) => {
            const t = raw.replace(/^\s*[-*+]\s+/, '');
            const task = t.match(/^\[([ xX])\]\s*(.*)$/);
            if (!task) return `<li>${inline(t)}</li>`;
            const done = task[1].toLowerCase() === 'x';
            const text = task[2].replace(/\s*✅\s*\d{4}-\d{2}-\d{2}\s*$/, '').trim();
            return `<li class="md-task${done ? ' is-done' : ''}">
              <input type="checkbox" data-task="1" data-text="${escapeHtml(text)}"${
                done ? ' checked' : ''
              } />
              <span>${inline(text)}</span>
            </li>`;
          })
          .join('')}</ul>`
      );
      continue;
    }

    // 有序列表
    if (/^\s*\d+[.、)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.、)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.、)]\s+/, ''));
        i++;
      }
      out.push(`<ol class="md-list">${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ol>`);
      continue;
    }

    // 段落
    const buf = [line];
    i++;
    while (i < lines.length && !isBlockStart(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p class="md-p">${buf.map(inline).join('<br>')}</p>`);
  }
  return out.join('\n');
}

/** 主入口 */
export function mdToHtml(src) {
  const store = [];
  const stash = (html) => {
    store.push(html);
    return `\u0000$${store.length - 1}\u0000`;
  };

  let text = String(src ?? '');

  // 代码块
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) =>
    stash(`<pre class="code-block" data-lang="${lang}"><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`)
  );

  // 先把转义的 \$ 藏起来，免得写正则时要用 lookbehind（Safari 老版本不支持）
  text = text.replace(/\\\$/g, '\u0001DOLLAR\u0001');

  // 行间公式
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex) => stash(renderMath(tex, true)));
  // 行内公式（不跨行）
  text = text.replace(/\$([^\n$]+?)\$/g, (_m, tex) => stash(renderMath(tex, false)));

  let html = blocks(text.split('\n'));

  // 还原公式占位符与转义美元
  html = html.replace(/\u0000\$(\d+)\u0000/g, (_m, n) => store[Number(n)] ?? '');
  html = html.replace(/\u0001DOLLAR\u0001/g, '$');
  return html;
}

/** 纯文本摘要（给列表卡片用） */
export function plainText(src, limit = 120) {
  const t = String(src ?? '')
    .replace(/\$\$[\s\S]+?\$\$/g, ' [公式] ')
    .replace(/\$[^\n$]+?\$/g, ' [公式] ')
    .replace(/\\[a-zA-Z]+/g, '')
    .replace(/[#>*`|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > limit ? `${t.slice(0, limit)}…` : t;
}
