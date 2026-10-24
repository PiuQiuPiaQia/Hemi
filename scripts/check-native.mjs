#!/usr/bin/env node
// 原生桌面口径门：packages/ui/src/styles/native.css 是焦点环门控、文字选中、拖拽、
// 光标规则的唯一来源，组件样式不得另起炉灶——
//   1. 焦点环：选择器项含 :focus-visible 且声明 outline / box-shadow 的，该项必须挂
//      `html.kb-nav` 前缀（只在键盘巡航时画环）；文本输入（input/rename/textarea）
//      的落点提示除外。Tailwind 的 focus-visible:ring/outline 类同理须带 in-[.kb-nav]:。
//   2. 光标：cursor: pointer 只许文字链接（LINK_SELECTOR），控件一律箭头。
//   3. 选中/拖拽：user-select、-webkit-user-drag、-webkit-tap-highlight-color 只许
//      写在 native.css（内容区可选用 .selectable 类）。
// 用法：node scripts/check-native.mjs（有违规时退出码 1）；
// src/renderer/src/native-gate.test.mjs 让 npm test 同样把关。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RING_PROPS = /^(outline(-[a-z]+)?|box-shadow)$/;
const TEXT_TARGET = /(input|rename|textarea)\b[^ ]*:focus-visible/i;
const LINK_SELECTOR = /\.h37-link\b|\.text-composer-hint-link\b|\.inline-link\b/;
const NATIVE_ONLY_PROPS = /^(-webkit-)?user-select$|^-webkit-user-drag$|^-webkit-tap-highlight-color$/;
/** 文本输入组件：焦点描边是落点提示，不受门控。 */
const TEXT_FIELD_COMPONENTS = new Set(['input.tsx', 'textarea.tsx']);

function splitTopLevel(selector) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of selector) {
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

export function checkCss(file, source) {
  const violations = [];
  for (const match of source.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const prelude = match[1];
    const selector = prelude.includes('*/') ? prelude.slice(prelude.lastIndexOf('*/') + 2) : prelude;
    const declarations = match[2]
      .split(';')
      .map((decl) => decl.trim())
      .filter((decl) => decl.includes(':') && !decl.startsWith('--'));
    const props = declarations.map((decl) => decl.slice(0, decl.indexOf(':')).trim().toLowerCase());
    const line = lineOf(source, match.index + prelude.length);
    const where = `${file}:${line}  ${selector.trim().split(/\s+/).join(' ').slice(0, 100)}`;

    if (props.some((prop) => RING_PROPS.test(prop))) {
      const ungated = splitTopLevel(selector).filter(
        (item) => item.includes(':focus-visible') && !item.includes('kb-nav') && !item.includes('data-hcf-keyboard') && !TEXT_TARGET.test(item),
      );
      if (ungated.length) violations.push(`焦点环未挂 html.kb-nav：${where}`);
    }
    if (declarations.some((decl) => /^cursor\s*:\s*pointer/i.test(decl)) && !LINK_SELECTOR.test(selector)) {
      violations.push(`控件用了手型光标（只许文字链接）：${where}`);
    }
    const nativeOnly = props.filter((prop) => NATIVE_ONLY_PROPS.test(prop));
    if (nativeOnly.length) violations.push(`${nativeOnly.join('/')} 只许写在 native.css：${where}`);
  }
  return violations;
}

export function checkTsx(file, source) {
  if (TEXT_FIELD_COMPONENTS.has(path.basename(file))) return [];
  const violations = [];
  source.split('\n').forEach((text, index) => {
    for (const match of text.matchAll(/(\S*)focus-visible:(ring|outline|shadow)[\w/-]*/g)) {
      if (!match[1].includes('in-[.kb-nav]:')) {
        violations.push(`焦点环类未带 in-[.kb-nav]:：${file}:${index + 1}  ${match[0]}`);
      }
    }
    if (/\bcursor-pointer\b/.test(text)) violations.push(`控件用了手型光标类：${file}:${index + 1}`);
  });
  return violations;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

export function checkNative(rendererSrc) {
  const violations = [];
  const project = path.resolve(rendererSrc, '../../..');
  const shared = ['packages/ui/src', 'packages/conversation-flow/src'].map(root => path.join(project, root)).filter(existsSync);
  for (const full of [rendererSrc, ...shared].flatMap(root => walk(root))) {
    const file = full.startsWith(rendererSrc + path.sep) ? path.relative(rendererSrc, full) : path.relative(project, full);
    if (full === path.join(project, 'packages/ui/src/styles/native.css')) continue;
    if (file === 'native.css' || file === 'fixtures-main.tsx') continue;
    if (file.endsWith('.css')) violations.push(...checkCss(file, readFileSync(full, 'utf8')));
    else if (file.endsWith('.tsx')) violations.push(...checkTsx(file, readFileSync(full, 'utf8')));
  }
  return violations;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rendererSrc = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/renderer/src');
  const violations = checkNative(rendererSrc);
  if (violations.length) {
    console.error(`原生口径违规（${violations.length} 处，规则见 native.css 头注）：\n${violations.join('\n')}`);
    process.exit(1);
  }
  console.log('native ok');
}
