import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectComposerToken,
  deleteTagBackward,
  deleteTagForward,
  findReferenceTokenRange,
  findSkillTokenRange,
  insertTagToken,
  isInlineReference,
  segmentTaggedText,
  snapCaretToTagBoundary,
  syncReferencesWithText,
  syncSkillsWithText,
  toExternalPlainText,
  uniqueTokenLabel,
} from './composer-tokens.ts';

const skill = (name) => ({ token: name, name, source: 'library', skillId: `lib:${name}` });
const reference = (name, kind = 'file') => ({
  kind, key: `${kind}:${name}`, name, subtitle: `${kind} · ${name}`, refPath: name,
});

// ---------------------------------------------------------------- 触发检测

test('063 R-01：`/` 只在行首/空白后的光标 token 触发；URL、路径、`//` 不触发', () => {
  assert.deepEqual(detectComposerToken('/', 1), { trigger: '/', query: '', start: 0, end: 1 });
  assert.deepEqual(detectComposerToken('看看 /mo', 6), { trigger: '/', query: 'mo', start: 3, end: 6 });
  assert.deepEqual(detectComposerToken('第一行\n/t', 6), { trigger: '/', query: 't', start: 4, end: 6 });
  // URL / foo/bar / 注释斜杠：前置字符不是行首或空白，不触发。
  assert.equal(detectComposerToken('https://a.com/x', 16), null);
  assert.equal(detectComposerToken('foo/bar', 7), null);
  assert.equal(detectComposerToken('// 注意', 2), null);
  // 绝对路径出现第二个斜杠后退出候选（token 不含 `/`）。
  assert.equal(detectComposerToken('/usr/local', 11), null);
  assert.deepEqual(detectComposerToken('/usr', 4), { trigger: '/', query: 'usr', start: 0, end: 4 });
});

test('063 R-08：`@` 词字符后不触发（邮箱）；行首/空白/中文标点后触发', () => {
  assert.deepEqual(detectComposerToken('@资料', 3), { trigger: '@', query: '资料', start: 0, end: 3 });
  assert.deepEqual(detectComposerToken('看看 @资料', 6), { trigger: '@', query: '资料', start: 3, end: 6 });
  assert.equal(detectComposerToken('foo@bar.com', 11), null, '邮箱不触发');
  assert.deepEqual(detectComposerToken('总结一下，@报告', 8), { trigger: '@', query: '报告', start: 5, end: 8 });
});

// ---------------------------------------------------------------- token 匹配与同步

test('063 R-05：token 匹配带词边界——正文同形子串不升格，部分编辑即丢身份', () => {
  assert.deepEqual(findSkillTokenRange('用 pdf 总结', 'pdf'), [2, 5]);
  assert.equal(findSkillTokenRange('用 pdfs 总结', 'pdf'), null, '后缀词字符不算完整出现');
  assert.equal(findSkillTokenRange('用 xpdf 总结', 'pdf'), null, '前缀词字符不算完整出现');
  assert.deepEqual(findReferenceTokenRange('看 @资料，说', '@资料'), [2, 5]);
  assert.equal(findReferenceTokenRange('看 @资料库', '@资料'), null, '后缀词字符不算边界');
  // 同步：删半截 token → 标签身份不残留。
  assert.deepEqual(syncSkillsWithText('用 pd 总结', [skill('pdf')]), []);
  assert.deepEqual(syncSkillsWithText('用 pdf 总结', [skill('pdf')]), [skill('pdf')]);
  assert.deepEqual(syncReferencesWithText('看 @资 了', [reference('资料')]), []);
  // 旧三类引用不参与行内同步（托盘芯片仍持有）。
  assert.deepEqual(syncReferencesWithText('正文', [{ kind: 'artifact', key: 'a:1', name: '成果', subtitle: '' }]),
    [{ kind: 'artifact', key: 'a:1', name: '成果', subtitle: '' }]);
});

// ---------------------------------------------------------------- 插入与删除

test('063：插入标签补必要空格且光标不贴 token；结尾不累积空格', () => {
  assert.deepEqual(insertTagToken('总结', 0, 'pdf'), { text: 'pdf 总结', caret: 4 });
  // 前面无空白、后面已有空白：两侧都保间隔，光标跨过后置空白。
  assert.deepEqual(insertTagToken('说 好的', 1, 'pdf'), { text: '说 pdf 好的', caret: 6 });
  // 前后都有空白（面板选择的常见位形）：不新增空格，光标跨过既有空白。
  assert.deepEqual(insertTagToken('看看  说', 3, 'pdf'), { text: '看看 pdf 说', caret: 7 });
  assert.deepEqual(insertTagToken('开头', 0, '@资料'), { text: '@资料 开头', caret: 4 });
});

test('063 R-05：Backspace/Delete 原子删除整标签；普通文字按字符删除', () => {
  const tags = [{ kind: 'skill', tag: skill('pdf') }];
  const text = '用 pdf 总结';
  const result = deleteTagBackward(text, 5, 5, tags);
  assert.equal(result.deleted, true);
  assert.equal(result.text, '用 总结', '前后空白各留一个，不累积');
  // 不在边界：不拦截。
  assert.equal(deleteTagBackward(text, 4, 4, tags).deleted, false);
  assert.equal(deleteTagBackward(text, 5, 5, [{ kind: 'skill', tag: skill('别的') }]).deleted, false);
  // Delete 前向：光标在 token 起点整删。
  const forward = deleteTagForward('用 pdf 总结', 2, 2, tags);
  assert.equal(forward.deleted, true);
  assert.equal(forward.text, '用 总结');
  assert.equal(deleteTagForward('用 pdf 总结', 3, 3, tags).deleted, false);
});

test('063 R-05：光标落进标签内部贴到较近边界', () => {
  const tags = [{ kind: 'skill', tag: skill('pdf') }];
  assert.equal(snapCaretToTagBoundary('用 pdf 总结', 3, tags), 2);
  assert.equal(snapCaretToTagBoundary('用 pdf 总结', 4, tags), 5);
  assert.equal(snapCaretToTagBoundary('用 pdf 总结', 6, tags), 6, '标签外不动');
});

// ---------------------------------------------------------------- 分段与复制

test('063 R-05：分段保留原位置；复制对外可读为 [技能：x]/[引用：y]', () => {
  const skills = [skill('pdf')];
  const references = [reference('资料'), { kind: 'artifact', key: 'a:1', name: '成果', subtitle: '任务成果' }];
  const text = '用 pdf 整理 @资料 的内容';
  const segments = segmentTaggedText(text, { skills, references });
  assert.deepEqual(segments.map((s) => s.type), ['text', 'skill', 'text', 'reference', 'text']);
  assert.equal(segments[1].text, 'pdf');
  assert.equal(segments[3].text, '@资料');
  // 旧三类引用不进正文分段（托盘芯片自己渲染）。
  assert.equal(isInlineReference(references[1]), false);
  assert.equal(toExternalPlainText(text, { skills, references }), '用 [技能：pdf] 整理 [引用：资料] 的内容');
});

test('063：同名标签唯一化（第二份带序号）；空名兜底', () => {
  assert.equal(uniqueTokenLabel('pdf', ['pdf']), 'pdf 2');
  assert.equal(uniqueTokenLabel('pdf', []), 'pdf');
  assert.equal(uniqueTokenLabel('  ', []).length > 0, true);
});
