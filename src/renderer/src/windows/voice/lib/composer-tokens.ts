/**
 * 063 · 输入框行内标签与触发 token 的纯逻辑（组件与单测共用；无 React 依赖）。
 *
 * 标签模型：标签身份（技能／行内引用）存在草稿结构里，正文中以「token 文字」
 * 出现——技能＝技能名，引用＝`@名称`。渲染/同步按「词边界内的完整 token 出现」
 * 匹配：token 被部分编辑（删半截）即视为标签已删（身份不残留）；正文中的
 * 同形普通文字不升格为标签（结构化身份不存在就不画标签）。
 */
import type { MessageReferenceView, SkillSelectionView } from '@/shared/types';

/** 词字符（中英文/数字/下划线/假名等）——token 边界判定用。 */
export function isWordChar(char: string | undefined): boolean {
  if (!char) return false;
  return /[\p{L}\p{N}_]/u.test(char);
}

/** 行内引用四类（063）；旧三类（attachment/artifact/context）走托盘芯片，不进正文标签。 */
export const INLINE_REFERENCE_KINDS = new Set(['workflow', 'file', 'folder', 'conversation']);

export function isInlineReference(reference: MessageReferenceView): boolean {
  return INLINE_REFERENCE_KINDS.has(reference.kind);
}

export function tokenOfSkill(skill: SkillSelectionView): string {
  return skill.token || skill.name;
}

export function tokenOfReference(reference: MessageReferenceView): string {
  return `@${reference.name}`;
}

// ---------------------------------------------------------------- 触发检测

export type ComposerTokenState = {
  trigger: '/' | '@';
  /** 查询词（不含触发符）。 */
  query: string;
  /** token 起点在正文中的下标（含触发符）。 */
  start: number;
  /** token 终点＝光标位置。 */
  end: number;
};

const SLASH_TOKEN_RE = /(?:^|[\n \t])(\/[^\s/]{0,32})$/;
const AT_TOKEN_RE = /@([\w\u00e0-\u024f\u0400-\u04ff\u3040-\u30ff\u4e00-\u9fff.-]{0,32})$/;

/**
 * 光标处正在输入的 `/词`／`@词`（不读整个草稿当查询）。
 *  - `/` 只在行首/空白后触发；URL、`foo/bar`、`//` 与路径内部的斜杠都不触发，
 *    绝对路径出现第二个斜杠后候选自然退出（token 不含 `/`）。
 *  - `@` 要求前一个字符不是词字符（邮箱 `foo@bar` 不触发）；行首/空白/中文
 *    标点后都可触发。
 */
export function detectComposerToken(text: string, caret: number): ComposerTokenState | null {
  const position = Math.max(0, Math.min(Math.floor(caret ?? 0), text.length));
  const before = text.slice(0, position);
  const slash = SLASH_TOKEN_RE.exec(before);
  if (slash) {
    const token = slash[1];
    return { trigger: '/', query: token.slice(1), start: position - token.length, end: position };
  }
  const at = AT_TOKEN_RE.exec(before);
  if (at) {
    const token = `@${at[1]}`;
    const atStart = position - token.length;
    // 词字符后紧跟的 @ 是邮箱/ID 形态，不触发。
    if (atStart > 0 && isWordChar(text[atStart - 1])) return null;
    return { trigger: '@', query: at[1], start: atStart, end: position };
  }
  return null;
}

// ---------------------------------------------------------------- token 匹配

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 技能 token 的出现位置（两侧都不是词字符才算完整出现；CJK 允许紧邻标点）。 */
export function findSkillTokenRange(text: string, token: string): [number, number] | null {
  if (!token) return null;
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(token)}(?![\\p{L}\\p{N}_])`, 'u');
  const match = re.exec(text);
  return match ? [match.index, match.index + token.length] : null;
}

/** 引用 token（@名称）的出现位置（@ 前不是词字符、名称后不是词字符）。 */
export function findReferenceTokenRange(text: string, token: string): [number, number] | null {
  if (!token.startsWith('@')) return null;
  const name = token.slice(1);
  if (!name) return null;
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])@${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`, 'u');
  const match = re.exec(text);
  return match ? [match.index, match.index + token.length] : null;
}

export function tokenRangeInText(text: string, tag: { kind: 'skill'; tag: SkillSelectionView } | { kind: 'reference'; tag: MessageReferenceView }): [number, number] | null {
  return tag.kind === 'skill'
    ? findSkillTokenRange(text, tokenOfSkill(tag.tag))
    : findReferenceTokenRange(text, tokenOfReference(tag.tag));
}

/** 正文里不再完整出现的标签要丢弃（文字删了身份不能残留）。 */
export function syncSkillsWithText(text: string, skills: SkillSelectionView[]): SkillSelectionView[] {
  return skills.filter((skill) => findSkillTokenRange(text, tokenOfSkill(skill)) != null);
}

export function syncReferencesWithText(text: string, references: MessageReferenceView[]): MessageReferenceView[] {
  return references.filter((reference) => !isInlineReference(reference) || findReferenceTokenRange(text, tokenOfReference(reference)) != null);
}

// ---------------------------------------------------------------- 插入与删除

/** 插入标签：token 两侧保必要间隔、不累积空格；光标落在 token（或既有
 *  空白）之后——紧贴标签继续输入不会破坏 token 边界。 */
export function insertTagToken(text: string, caret: number, token: string): { text: string; caret: number } {
  const position = Math.max(0, Math.min(Math.floor(caret ?? 0), text.length));
  const leading = position > 0 && !/\s/.test(text[position - 1]) ? ' ' : '';
  const inserted = `${leading}${token}`;
  const nextChar = text[position];
  if (nextChar == null) {
    return { text: text.slice(0, position) + inserted, caret: position + inserted.length };
  }
  if (/\s/.test(nextChar)) {
    // 后面已有空白：光标跨过它，继续输入不贴进 token。
    return { text: text.slice(0, position) + inserted + text.slice(position), caret: position + inserted.length + 1 };
  }
  return {
    text: text.slice(0, position) + inserted + ' ' + text.slice(position),
    caret: position + inserted.length + 1,
  };
}

export type TagDeletion =
  | { deleted: false }
  | { deleted: true; text: string; caret: number };

/** Backspace 原子删除：光标紧贴 token 末尾（或选区从 token 内外跨到其后）时整删。 */
export function deleteTagBackward(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  tags: Array<{ kind: 'skill'; tag: SkillSelectionView } | { kind: 'reference'; tag: MessageReferenceView }>,
): TagDeletion {
  for (const entry of tags) {
    const range = tokenRangeInText(text, entry);
    if (!range) continue;
    const [start, end] = range;
    if (selectionStart === selectionEnd) {
      if (selectionStart !== end) continue;
      // 光标在 token 末尾：删除 token；若后面紧跟空格且 token 前也有空白则连空格一起收走。
      const prevChar = text[start - 1];
      const nextChar = text[end];
      const eatSpace = /\s/.test(nextChar ?? '') && (start === 0 || /\s/.test(prevChar ?? '') || prevChar === undefined);
      const cutEnd = eatSpace ? end + 1 : end;
      return { deleted: true, text: text.slice(0, start) + text.slice(cutEnd), caret: start };
    }
    // 选区起点在 token 内部或末尾、终点在 token 之后：把删区扩展到 token 起点。
    if (selectionStart <= end && selectionStart > start && selectionEnd >= end) {
      return { deleted: true, text: text.slice(0, start) + text.slice(selectionEnd), caret: start };
    }
  }
  return { deleted: false };
}

/** Delete（前向删除）原子版：光标紧贴 token 起点时整删。 */
export function deleteTagForward(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  tags: Array<{ kind: 'skill'; tag: SkillSelectionView } | { kind: 'reference'; tag: MessageReferenceView }>,
): TagDeletion {
  for (const entry of tags) {
    const range = tokenRangeInText(text, entry);
    if (!range) continue;
    const [start, end] = range;
    if (selectionStart === selectionEnd && selectionStart === start) {
      const nextChar = text[end];
      const prevChar = text[start - 1];
      const eatSpace = /\s/.test(nextChar ?? '') && (start === 0 || /\s/.test(prevChar ?? ''));
      const cutEnd = eatSpace ? end + 1 : end;
      return { deleted: true, text: text.slice(0, start) + text.slice(cutEnd), caret: start };
    }
  }
  return { deleted: false };
}

/** 光标落进 token 内部时贴到较近的边界（textarea 无法禁止，用吸附近似原子性）。 */
export function snapCaretToTagBoundary(
  text: string,
  caret: number,
  tags: Array<{ kind: 'skill'; tag: SkillSelectionView } | { kind: 'reference'; tag: MessageReferenceView }>,
): number {
  for (const entry of tags) {
    const range = tokenRangeInText(text, entry);
    if (!range) continue;
    const [start, end] = range;
    if (caret > start && caret < end) {
      return caret - start <= end - caret ? start : end;
    }
  }
  return caret;
}

// ---------------------------------------------------------------- 渲染分段

export type TagSegment =
  | { type: 'text'; text: string }
  | { type: 'skill'; text: string; skill: SkillSelectionView }
  | { type: 'reference'; text: string; reference: MessageReferenceView };

/** 正文＋标签身份 → 依次分段（重叠时按先出现者；剩余按普通文字）。 */
export function segmentTaggedText(
  text: string,
  { skills = [], references = [] }: { skills?: SkillSelectionView[]; references?: MessageReferenceView[] },
): TagSegment[] {
  const hits: Array<{ start: number; end: number; segment: TagSegment }> = [];
  for (const skill of skills) {
    const range = findSkillTokenRange(text, tokenOfSkill(skill));
    if (range) hits.push({ start: range[0], end: range[1], segment: { type: 'skill', text: text.slice(range[0], range[1]), skill } });
  }
  for (const reference of references) {
    if (!isInlineReference(reference)) continue;
    const range = findReferenceTokenRange(text, tokenOfReference(reference));
    if (range) hits.push({ start: range[0], end: range[1], segment: { type: 'reference', text: text.slice(range[0], range[1]), reference } });
  }
  hits.sort((a, b) => a.start - b.start);
  const segments: TagSegment[] = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.start < cursor) continue; // 与前一段重叠（token 嵌套极少见）：跳过后者
    if (hit.start > cursor) segments.push({ type: 'text', text: text.slice(cursor, hit.start) });
    segments.push(hit.segment);
    cursor = hit.end;
  }
  if (cursor < text.length) segments.push({ type: 'text', text: text.slice(cursor) });
  return segments;
}

/** 复制到外部的可读纯文本：`[技能：名称]`／`[引用：名称]`（外部粘回只当文字）。 */
export function toExternalPlainText(
  text: string,
  { skills = [], references = [] }: { skills?: SkillSelectionView[]; references?: MessageReferenceView[] },
): string {
  return segmentTaggedText(text, { skills, references })
    .map((segment) =>
      segment.type === 'text' ? segment.text
      : segment.type === 'skill' ? `[技能：${segment.skill.name}]`
      : `[引用：${segment.reference.name}]`,
    )
    .join('');
}

/** 标签 token 唯一化：同名第二份带 ` 2` 起的序号（候选展示用相对路径区分，标签保短名）。 */
export function uniqueTokenLabel(base: string, taken: string[]): string {
  const clean = base.trim() || '未命名';
  if (!taken.includes(clean)) return clean;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${clean} ${index}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${clean} ${Date.now() % 1000}`;
}
