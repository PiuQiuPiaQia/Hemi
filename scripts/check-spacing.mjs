#!/usr/bin/env node
// 间距规范门：styles/ 下所有编号需求样式（037-*、047-*、以及未来 \d{3}-*）里
// 的 gap / margin / padding 只能用 tokens.css 的间距变量（--sp-* 与语义间距）。
// 放行的 px：0 / 1px / 3px（光学微调），以及行尾带 `sp-ok` 注释说明原因的声明。
//
// 块节奏规范（2026-10-08 用户裁决，页面块与标题间距一律照此）：
//   - 块 ↔ 块（section 卡之间、标题块与首卡）：--gap-section（32px），
//     靠 .h37-section 的 margin-top 折叠实现，首块不加；
//   - 卡内标题 ↔ 内容：--gap-head（8px）；卡片/行左右留白 --pad-card；
//   - 陷阱：给 .h37-section 再包一层 div 会让内部首个 section 命中
//     `:first-child` 兜底丢掉 margin-top，块间贴死——wrapper 必须自己补
//     margin-top: var(--gap-section)（见 047-provider-import.css 的 .h47n）。
//     布局审计（scripts/verify-047-layout-audit.mjs）对 32/8 有运行时断言。
// 用法：node scripts/check-spacing.mjs（有违规时退出码 1）。
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/renderer/src/styles');
const PROP = /^\s*(gap|row-gap|column-gap|margin(?:-[a-z]+)?|padding(?:-[a-z]+)?)\s*:\s*([^;]+);/;
const PX = /(?<![\w.])(\d+(?:\.\d+)?)px/g;
const ALLOWED = new Set([0, 1, 3]);

const violations = [];
for (const file of readdirSync(dir).filter((name) => /^\d{3}-.*\.css$/.test(name)).sort()) {
  const lines = readFileSync(path.join(dir, file), 'utf8').split('\n');
  lines.forEach((line, index) => {
    const match = PROP.exec(line);
    // sp-ok 可写在本行行尾，也可写在上一行的注释里。
    if (!match || line.includes('sp-ok') || (lines[index - 1] ?? '').includes('sp-ok')) return;
    const bad = [...match[2].matchAll(PX)].map((m) => Number(m[1])).filter((n) => !ALLOWED.has(n));
    if (bad.length) violations.push(`${file}:${index + 1}  ${line.trim()}`);
  });
}

if (violations.length) {
  console.error(`间距未用 token（${violations.length} 处）：\n${violations.join('\n')}`);
  process.exit(1);
}
console.log('spacing ok');
