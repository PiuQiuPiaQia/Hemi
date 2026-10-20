// 025 · 静态报告 HTML 导出（纯函数，无 IO）。
//
// 与应用内阅读视图消费同一份经校验的 delivery（technical-plan：正文和报告由
// 同一份经校验内容生成，卡片/网页/导出的数字不各生成一遍）。输出是可直接
// 离线打开的单文件 HTML：内联样式、无脚本、无远程字体/图片依赖；图片以
// data URL 内嵌（由调用方传入 readImage 闭包，本模块不做文件读取）。
//
// 安全：所有插值经 escapeHtml；URL 只接受 https（来源层已保证，这里再兜一道）；
// 不接受任何模型侧 HTML——模型只提供结构化块，排版全部由本模板负责。

const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif";
const MONO_STACK = "'SFMono-Regular', Consolas, 'Liberation Mono', monospace";

/** 设计 tokens（DESIGN.md 视觉参数的浅色导出版；导出固定浅色方便跨浏览器阅读）。 */
const CSS = `
  :root {
    --ink: #203e34; --body: #455e50; --muted: #586d60; --action: #286b55;
    --paper: #fffefa; --wash: #e4efe8; --line: #dbe7de;
    --warn-ink: #785716; --warn-wash: #fbf4df;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: #eef2ec; color: var(--body);
    font-family: ${FONT_STACK}; font-size: 15px; line-height: 1.85;
    font-variant-numeric: tabular-nums;
  }
  .page { max-width: 760px; margin: 0 auto; padding: 40px 24px 64px; }
  .kind-tag {
    display: inline-block; font-size: 12px; letter-spacing: .08em;
    color: var(--action); border: 1px solid var(--action); border-radius: 999px;
    padding: 1px 10px; margin-bottom: 12px;
  }
  h1 { color: var(--ink); font-size: 28px; line-height: 1.35; margin: 0 0 10px; }
  .summary { color: var(--ink); font-size: 17px; margin: 0 0 6px; }
  .meta { color: var(--muted); font-size: 12px; margin: 0 0 8px; }
  .warn {
    background: var(--warn-wash); color: var(--warn-ink); border-radius: 10px;
    padding: 10px 14px; font-size: 13px; margin: 14px 0;
  }
  h2 {
    color: var(--ink); font-size: 19px; margin: 34px 0 10px;
    padding-top: 18px; border-top: 1px solid var(--line);
  }
  h3 { color: var(--ink); font-size: 15px; margin: 20px 0 6px; }
  p { margin: 8px 0; }
  a { color: var(--action); }
  .metrics { display: flex; flex-wrap: wrap; gap: 10px; margin: 14px 0; }
  .metric {
    background: var(--wash); border-radius: 12px; padding: 10px 16px; min-width: 128px;
  }
  .metric-label { color: var(--muted); font-size: 12px; }
  .metric-value { color: var(--ink); font-size: 20px; font-weight: 600; }
  .metric-unit { font-size: 13px; font-weight: 400; color: var(--body); margin-left: 2px; }
  .metric-note { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .table-wrap { overflow-x: auto; margin: 14px 0; }
  table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--ink); white-space: nowrap; background: var(--wash); }
  td:first-child { color: var(--ink); }
  .caption { color: var(--muted); font-size: 12px; margin: 4px 0 0; }
  .check-group { margin: 12px 0 4px; }
  .check-list { list-style: none; padding: 0; margin: 6px 0; }
  .check-list li { padding: 6px 0 6px 20px; position: relative; }
  .check-list li::before {
    content: ''; position: absolute; left: 2px; top: 13px; width: 7px; height: 7px;
    border-radius: 2px; border: 1.5px solid var(--action);
  }
  .check-note { color: var(--muted); font-size: 12.5px; }
  figure { margin: 16px 0; }
  figure img { max-width: 100%; border-radius: 10px; border: 1px solid var(--line); }
  figcaption { color: var(--muted); font-size: 12px; margin-top: 6px; }
  .sources { margin-top: 34px; padding-top: 18px; border-top: 1px solid var(--line); }
  .sources h2 { border-top: none; padding-top: 0; margin-top: 0; }
  .sources ol { margin: 8px 0 0; padding-left: 20px; }
  .sources li { margin: 6px 0; font-size: 13.5px; }
  .source-note { color: var(--muted); font-size: 12.5px; }
  .toc {
    background: var(--wash); border-radius: 12px; padding: 12px 18px; margin: 18px 0;
  }
  .toc-title { color: var(--ink); font-size: 13px; font-weight: 600; margin: 0 0 6px; }
  .toc ol { margin: 0; padding-left: 18px; font-size: 13.5px; }
  .toc a { text-decoration: none; }
  .foot { color: var(--muted); font-size: 12px; margin-top: 40px; border-top: 1px solid var(--line); padding-top: 14px; }
`;

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeHref(url) {
  try {
    const parsed = new URL(String(url ?? ''));
    // 导出文件里只保留 https 链接（与来源校验同规）。
    return parsed.protocol === 'https:' ? escapeHtml(parsed.toString()) : null;
  } catch {
    return null;
  }
}

function renderBlock(block, { readImage }) {
  switch (block.type) {
    case 'p':
      return `<p>${escapeHtml(block.text).replaceAll('\n', '<br />')}</p>`;
    case 'metrics':
      return `<div class="metrics">${block.items
        .map(
          (item) => `<div class="metric">
            <div class="metric-label">${escapeHtml(item.label)}</div>
            <div class="metric-value">${escapeHtml(item.value)}${item.unit ? `<span class="metric-unit">${escapeHtml(item.unit)}</span>` : ''}</div>
            ${item.note ? `<div class="metric-note">${escapeHtml(item.note)}</div>` : ''}
          </div>`,
        )
        .join('')}</div>`;
    case 'table':
      return `<div class="table-wrap"><table>
        <thead><tr>${block.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('')}</tr></thead>
        <tbody>${block.rows
          .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
          .join('')}</tbody>
      </table>${block.caption ? `<p class="caption">${escapeHtml(block.caption)}</p>` : ''}</div>`;
    case 'checklist':
      return block.groups
        .map(
          (group) => `<div class="check-group">${group.title ? `<h3>${escapeHtml(group.title)}</h3>` : ''}
        <ul class="check-list">${group.items
          .map(
            (item) =>
              `<li>${escapeHtml(item.text)}${item.note ? ` <span class="check-note">${escapeHtml(item.note)}</span>` : ''}</li>`,
          )
          .join('')}</ul></div>`,
        )
        .join('');
    case 'image': {
      const dataUrl = readImage?.(block.artifactId) ?? null;
      if (!dataUrl) return '';
      return `<figure><img src="${dataUrl}" alt="${escapeHtml(block.caption || '报告配图')}" />${
        block.caption ? `<figcaption>${escapeHtml(block.caption)}</figcaption>` : ''
      }</figure>`;
    }
    case 'section':
      return `<h2>${escapeHtml(block.title)}</h2>${block.blocks
        .map((child) => renderBlock(child, { readImage }))
        .join('')}`;
    default:
      return '';
  }
}

const KIND_LABELS = { summary: '结果卡', comparison: '对比', checklist: '清单', receipt: '回执', report: '报告' };

function tocOf(blocks) {
  const sections = [];
  for (const block of blocks) {
    if (block.type === 'section') sections.push(block.title);
  }
  return sections;
}

/**
 * 渲染静态报告 HTML。
 * @param {object} params
 * @param {object} params.delivery 校验后的 TaskDelivery（宿主档案里的形状）
 * @param {object} params.task { taskText, outcome, resultText }
 * @param {Array} params.artifacts 产物视图（来源/附件与图片解析用）
 * @param {Function} [params.readImage] (artifactId) => dataURL | null
 * @param {number} params.generatedAt 导出时刻
 */
export function renderReportHtml({ delivery, task = {}, artifacts = [], readImage = null, generatedAt = Date.now() }) {
  const blocks = Array.isArray(delivery?.blocks) ? delivery.blocks : [];
  const sections = tocOf(blocks);
  const sources = Array.isArray(delivery?.sources) ? delivery.sources : [];
  const partial = delivery?.partial ?? null;
  const degraded = Array.isArray(delivery?.degraded) ? delivery.degraded : [];
  const toc = sections.length
    ? `<nav class="toc" aria-label="目录"><p class="toc-title">目录</p><ol>${sections
        .map((title, index) => `<li><a href="#section-${index + 1}">${escapeHtml(title)}</a></li>`)
        .join('')}</ol></nav>`
    : '';

  let sectionIndex = 0;
  const body = blocks
    .map((block) => {
      if (block.type === 'section') {
        sectionIndex += 1;
        return `<h2 id="section-${sectionIndex}">${escapeHtml(block.title)}</h2>${block.blocks
          .map((child) => renderBlock(child, { readImage }))
          .join('')}`;
      }
      return renderBlock(block, { readImage });
    })
    .join('');

  const sourceList = sources.length
    ? `<section class="sources"><h2>来源与依据</h2><ol>${sources
        .map((source) => {
          const href = safeHref(source.url);
          return `<li>${href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.title)}</a>` : escapeHtml(source.title)}${
            source.note ? ` <span class="source-note">${escapeHtml(source.note)}</span>` : ''
          }</li>`;
        })
        .join('')}</ol></section>`
    : '';

  const attachments = (Array.isArray(delivery?.attachmentArtifacts) ? delivery.attachmentArtifacts : [])
    .map((id) => artifacts.find((artifact) => artifact.id === id))
    .filter(Boolean);
  const attachmentList = attachments.length
    ? `<p class="meta">附件：${attachments.map((artifact) => escapeHtml(artifact.name || artifact.path || '')).join('、')}</p>`
    : '';

  const generated = new Date(generatedAt);
  const generatedLabel = `${generated.getFullYear()}-${String(generated.getMonth() + 1).padStart(2, '0')}-${String(
    generated.getDate(),
  ).padStart(2, '0')} ${String(generated.getHours()).padStart(2, '0')}:${String(generated.getMinutes()).padStart(2, '0')}`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(delivery?.title || task.taskText || '任务报告')}</title>
<style>${CSS}</style>
</head>
<body>
<div class="page">
  <span class="kind-tag">${escapeHtml(KIND_LABELS[delivery?.kind] ?? '报告')}</span>
  <h1>${escapeHtml(delivery?.title || task.taskText || '')}</h1>
  <p class="summary">${escapeHtml(delivery?.summary || '')}</p>
  <p class="meta">任务：${escapeHtml(task.taskText || '')} · 导出于 ${generatedLabel}</p>
  ${partial ? `<div class="warn">部分完成：${escapeHtml([...(partial.missing ?? []), partial.note].filter(Boolean).join('；'))}</div>` : ''}
  ${degraded.length ? `<div class="warn">展示降级：${escapeHtml(degraded.join('；'))}</div>` : ''}
  ${toc}
  ${body}
  ${sourceList}
  ${attachmentList}
  <p class="foot">由 Hemi 任务「${escapeHtml(task.taskText || '')}」的结果生成 · ${escapeHtml(
    task.outcome === 'complete' ? '任务已完成' : task.outcome === 'partial' ? '任务部分完成' : '结果状态以应用内为准',
  )}；排版导出不改变核验结论。</p>
</div>
</body>
</html>`;
}

/** 保存面板的默认文件名：成果标题 → 安全文件名（中文/空格保留，非法字符替换）。 */
export function reportFileName(title) {
  const base = String(title ?? '')
    .replace(/[\\/:*?"<>|\u0000]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return `${base || '任务报告'}.html`;
}

// ---- 050：正文 Markdown → HTML（确定性小渲染器，导出用） ----
// 不引第三方依赖（react-markdown 是渲染层 React 组件，主进程不可用；打包
// dependencies 也不想新增）。覆盖执行器正文的常用面：标题、段落、无序/有序
// 列表、GFM 表格、围栏代码、粗体/斜体/行内代码/链接/图片。不确定的构造
// 原样保留文本——导出不改变内容语义，排版保守即可。

/** 行内元素：先转义，再按安全白名单恢复受控标签。 */
function renderInline(text) {
  let out = escapeHtml(text);
  // 行内代码先保护（内部不再解析其它标记）。
  const codeSpans = [];
  out = out.replace(/`([^`]+)`/g, (_m, code) => {
    codeSpans.push(`<code>${code}</code>`);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });
  // 图片（本地路径不内嵌、留文字；https 原样保留）。
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, url) => {
    const href = safeHref(url);
    return href ? `<img src="${href}" alt="${alt}" />` : escapeHtml(alt || '图片');
  });
  // 链接：https 才可点，其余降级为纯文本。
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) => {
    const href = safeHref(url);
    return href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/\u0000(\d+)\u0000/g, (_m, index) => codeSpans[Number(index)] ?? '');
  return out;
}

function splitTableRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

/** 正文 Markdown → HTML 片段（块级结构；空输入返回空串）。 */
export function renderMarkdownHtml(markdown) {
  const lines = String(markdown ?? '').split('\n');
  const out = [];
  let listType = null; // 'ul' | 'ol'
  let paragraph = [];
  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }
    // 围栏代码块。
    if (/^```/.test(trimmed)) {
      flushParagraph();
      flushList();
      const code = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        code.push(lines[i]);
        i += 1;
      }
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    // 标题（# 到 ####）。
    const heading = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(heading[1].length + 1, 4); // 正文内从 h2 起，避免盖过页 h1
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }
    // 水平分隔线。
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      flushParagraph();
      flushList();
      out.push('<hr />');
      continue;
    }
    // GFM 表格：当前行有 | 且下一行是分隔行。
    if (trimmed.includes('|') && /^\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1] ?? '')) {
      flushParagraph();
      flushList();
      const columns = splitTableRow(trimmed);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim().includes('|') && lines[i].trim()) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      i -= 1;
      out.push(`<div class="table-wrap"><table><thead><tr>${columns.map((column) => `<th>${renderInline(column)}</th>`).join('')}</tr></thead><tbody>${rows
        .map((row) => `<tr>${columns.map((_column, index) => `<td>${renderInline(row[index] ?? '')}</td>`).join('')}</tr>`)
        .join('')}</tbody></table></div>`);
      continue;
    }
    // 引用块。
    if (trimmed.startsWith('>')) {
      flushParagraph();
      flushList();
      out.push(`<blockquote>${renderInline(trimmed.replace(/^>\s?/, ''))}</blockquote>`);
      continue;
    }
    // 列表（无序 -/*/+，有序 1.）。
    const bullet = trimmed.match(/^[-*+]\s+(.*)$/);
    const ordered = trimmed.match(/^\d+[.)]\s+(.*)$/);
    if (bullet || ordered) {
      flushParagraph();
      const type = bullet ? 'ul' : 'ol';
      if (listType !== type) {
        flushList();
        out.push(`<${type}>`);
        listType = type;
      }
      out.push(`<li>${renderInline((bullet ?? ordered)[1])}</li>`);
      continue;
    }
    flushList();
    paragraph.push(trimmed);
  }
  flushParagraph();
  flushList();
  return out.join('\n');
}

/**
 * 050：按正文契约渲染导出 HTML——正文 Markdown＋来源＋附带提醒。
 * 与 renderReportHtml（v1 delivery 旧档案）并存：新任务没有 delivery，
 * 导出吃正文；两者同一套 CSS 与安全纪律。
 * @param {object} params
 * @param {object} params.task { taskText, outcome, resultText, bodySource, notices }
 * @param {Array} params.sources [{ title, url, visited }]
 * @param {number} params.generatedAt 导出时刻
 */
export function renderBodyReportHtml({ task = {}, sources = [], generatedAt = Date.now() }) {
  const body = renderMarkdownHtml(task.resultText ?? '');
  const notices = Array.isArray(task.notices) ? task.notices.filter(Boolean) : [];
  const sourceList = sources.length
    ? `<section class="sources"><h2>来源与依据</h2><ol>${sources
        .map((source) => {
          const href = safeHref(source.url);
          const visited = source.visited === false ? ' <span class="source-note">（声明未访问）</span>' : '';
          return `<li>${href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.title)}</a>` : escapeHtml(source.title)}${visited}</li>`;
        })
        .join('')}</ol></section>`
    : '';
  const generated = new Date(generatedAt);
  const generatedLabel = `${generated.getFullYear()}-${String(generated.getMonth() + 1).padStart(2, '0')}-${String(
    generated.getDate(),
  ).padStart(2, '0')} ${String(generated.getHours()).padStart(2, '0')}:${String(generated.getMinutes()).padStart(2, '0')}`;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(task.taskText || '任务正文')}</title>
<style>${CSS}</style>
</head>
<body>
<div class="page">
  <span class="kind-tag">任务正文</span>
  <h1>${escapeHtml(task.taskText || '')}</h1>
  <p class="meta">导出于 ${generatedLabel}</p>
  ${notices.length ? `<div class="warn">附带提醒：${escapeHtml(notices.join('；'))}</div>` : ''}
  ${body}
  ${sourceList}
  <p class="foot">由 Hemi 任务「${escapeHtml(task.taskText || '')}」的交付正文导出；排版导出不改变核验结论。</p>
</div>
</body>
</html>`;
}
