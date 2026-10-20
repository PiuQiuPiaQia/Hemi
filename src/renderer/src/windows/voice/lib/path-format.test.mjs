import assert from 'node:assert/strict';
import test from 'node:test';

import { displayPath } from './path-format.ts';

test('P1 displayPath：家目录收成 ~，短路径原样', () => {
  assert.equal(displayPath('/Users/demo/Projects/Studio'), '~/Projects/Studio');
  assert.equal(displayPath('/Users/demo'), '~');
  assert.equal(displayPath('/Volumes/Projects/Projects/Hemi'), '/Volumes/Projects/Projects/Hemi');
  assert.equal(displayPath('/home/bob/code'), '~/code');
});

test('P1 displayPath：过长时折叠中段、保住尾部', () => {
  assert.equal(
    displayPath('/Users/demo/Library/Application Support/hemi-dev/workspace/default'),
    '~/…/hemi-dev/workspace/default',
  );
  assert.equal(
    displayPath('/Volumes/Some Very Long Volume Name/And/Deep/Nested/ProjectFolderName'),
    '/…/And/Deep/Nested/ProjectFolderName',
  );
  assert.equal(displayPath('C:\\Users\\bob\\Documents\\Very Long Folder Name\\Another\\Project'), '~\\…\\Another\\Project');
});

test('P1 displayPath：单段超长也保留末段全名', () => {
  const name = 'ThisIsAnExtremelyLongSingleFolderNameThatExceedsTheBudget';
  assert.equal(displayPath(`/a/b/${name}`), `/…/${name}`);
});
