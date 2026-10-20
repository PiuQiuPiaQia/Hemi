// 033 · 工作区上下文块（对话层注入）：会话绑定项目后，主脑模型也要知道
// 「我们现在在哪个项目里、里面有什么」——否则用户问「我们的项目」对话层
// 一无所知，任务简报也只能凭空写。
//
// 口径对齐 ZCode：ZCode 的对话就跑在工作目录里（agent cwd＝workspace，
// AGENTS.md 等项目说明随 Pi 会话进系统提示词）。Hemi 的主脑模型没有文件
// 工具，所以在回合系统提示词里注入等价信息：项目身份＋根目录一层概览＋
// AGENTS.md／README.md 摘录（有界，全部 try 容错——目录读不出时如实留空，
// 不阻断对话）。
//
// 默认空间（userData/workspace/default，通常是空目录）不注入——没有可
// 感知的项目内容，注入只是噪音；旧会话（家目录语义）同样不注入。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const CONTEXT_FILES = ['AGENTS.override.md', 'AGENTS.md', 'README.md'];
/** 单文件摘录上限（字符）：说明文件通常头几百字就够对话层定位项目。 */
const FILE_EXCERPT_CHARS = 1200;
/** 根目录概览上限（条目）：再长对对话层没有增量信息。 */
const DIR_ENTRIES_LIMIT = 40;
/** 排除的目录条目：系统/编辑器垃圾与巨型依赖目录。 */
const DIR_ENTRY_EXCLUDE = new Set(['.DS_Store', 'node_modules', '.git']);

const defaultFs = { readdirSync, readFileSync, statSync };

function head(text, limit) {
  const clean = String(text ?? '').trim();
  if (!clean) return '';
  const chars = Array.from(clean);
  return chars.length <= limit ? clean : `${chars.slice(0, limit).join('')}…（截断）`;
}

function readExcerpt(fs, dir, name) {
  try {
    const target = path.join(dir, name);
    if (!fs.statSync(target).isFile()) return '';
    return head(fs.readFileSync(target, 'utf8'), FILE_EXCERPT_CHARS);
  } catch {
    return '';
  }
}

/**
 * 项目工作区的对话上下文块（空串＝不注入）。
 * @param {object} view 工作区登记视图（type 须为 'project'；调用方过滤）
 * @param {object} [deps] deps.fs 注入（离线单测；缺省用 node:fs）
 */
export function buildWorkspaceContextBlock(view, { fs = null } = {}) {
  const io = fs ?? defaultFs;
  if (!view || view.type !== 'project' || !view.dir || view.status !== 'ok') return '';
  const lines = ['［工作区 · 当前项目］', `项目「${view.name}」：${view.dir}`];
  // 根目录一层概览（目录带 / 标记；读不出就跳过，不猜）。
  try {
    const names = io
      .readdirSync(view.dir)
      .filter((name) => !DIR_ENTRY_EXCLUDE.has(name) && !name.startsWith('._'));
    const marked = [];
    for (const name of names) {
      let isDir = false;
      try {
        isDir = io.statSync(path.join(view.dir, name)).isDirectory();
      } catch {
        /* 条目消失就不标记 */
      }
      marked.push(isDir ? `${name}/` : name);
    }
    const shown = marked.slice(0, DIR_ENTRIES_LIMIT).join(' · ');
    if (shown) {
      lines.push(`根目录：${shown}${marked.length > DIR_ENTRIES_LIMIT ? ` …（共 ${marked.length}+ 项）` : ''}`);
    }
  } catch {
    /* 目录不可读：只报身份，不列内容 */
  }
  for (const name of CONTEXT_FILES) {
    const excerpt = readExcerpt(io, view.dir, name);
    if (excerpt) lines.push(`${name}（摘录）：\n${excerpt}`);
  }
  return lines.length > 2 ? lines.join('\n') : '';
}
