import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { checkCss, checkNative, checkTsx } from '../../../scripts/check-native.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

test('原生口径门：渲染层样式无网页式焦点环、手型控件与散落的选中/拖拽规则', () => {
  assert.deepEqual(checkNative(here), []);
});

test('门禁本身：抓得到各类违规，放得过合规写法', () => {
  assert.equal(checkCss('a.css', '.x:focus-visible { box-shadow: 0 0 0 2px red; }').length, 1);
  assert.equal(checkCss('a.css', '.x:hover, .x:focus-visible { outline: 2px solid; }').length, 1);
  assert.equal(checkCss('a.css', 'html.kb-nav .x:focus-visible { box-shadow: 0 0 0 2px red; }').length, 0);
  assert.equal(checkCss('a.css', '.x:hover, html.kb-nav .x:focus-visible { outline: 2px solid; }').length, 0);
  assert.equal(checkCss('a.css', '[data-hemi-conversation-flow][data-hcf-keyboard="true"] .x:focus-visible { outline: 2px solid; }').length, 0);
  assert.equal(checkCss('a.css', '.x-rename:focus-visible { box-shadow: 0 0 0 2px red; }').length, 0);
  assert.equal(checkCss('a.css', '.x:focus-within { box-shadow: 0 0 0 2px red; }').length, 0);
  assert.equal(checkCss('a.css', '.x:focus-visible { background: red; }').length, 0);

  assert.equal(checkCss('a.css', '.btn { cursor: pointer; }').length, 1);
  assert.equal(checkCss('a.css', '.h37-link { cursor: pointer; }').length, 0);
  assert.equal(checkCss('a.css', '.btn { cursor: default; }').length, 0);

  assert.equal(checkCss('a.css', '.x { user-select: none; }').length, 1);
  assert.equal(checkCss('a.css', '.x { -webkit-user-drag: none; }').length, 1);

  assert.equal(checkTsx('ui/button.tsx', `cn('focus-visible:ring-3')`).length, 1);
  assert.equal(checkTsx('ui/button.tsx', `cn('in-[.kb-nav]:focus-visible:ring-3')`).length, 0);
  assert.equal(checkTsx('ui/input.tsx', `cn('focus-visible:ring-3')`).length, 0);
  assert.equal(checkTsx('x.tsx', `<a className="cursor-pointer" />`).length, 1);
});
