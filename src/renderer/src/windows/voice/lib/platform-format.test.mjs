import assert from 'node:assert/strict';
import test from 'node:test';

import {
  displayPath,
  fileManagerName,
  newConversationShortcut,
  platformBasename,
} from './platform-format.ts';

test('新建对话快捷键：mac ⌘N / Windows Ctrl+N（aria 同步）', () => {
  assert.deepEqual(newConversationShortcut('darwin'), { label: '⌘N', ariaKeyshortcuts: 'Meta+N' });
  assert.deepEqual(newConversationShortcut('win32'), { label: 'Ctrl+N', ariaKeyshortcuts: 'Control+N' });
});

test('文件管理器名称：访达 / 资源管理器（R-17）', () => {
  assert.equal(fileManagerName('darwin'), '访达');
  assert.equal(fileManagerName('win32'), '资源管理器');
});

test('displayPath：mac home 缩写与空白清理', () => {
  assert.equal(displayPath('/Users/zhang/下载/图 片', { home: '/Users/zhang' }), '~/下载/图 片');
  assert.equal(displayPath('/Users/zhang', { home: '/Users/zhang' }), '~');
  assert.equal(displayPath('/Volumes/Projects/Projects/', {}), '/Volumes/Projects/Projects');
  assert.equal(displayPath('', {}), '');
});

test('displayPath：Windows 盘符与 UNC（保持大小写，不误转 ~）', () => {
  assert.equal(
    displayPath('C:\\Users\\Zhang\\文档\\报 告', { platform: 'win32', home: 'C:\\Users\\Zhang' }),
    '~\\文档\\报 告',
  );
  assert.equal(displayPath('D:\\项目\\2026\\', { platform: 'win32' }), 'D:\\项目\\2026');
  assert.equal(displayPath('\\\\NAS\\共享\\目录', { platform: 'win32' }), '\\\\NAS\\共享\\目录');
  // 大小写不敏感匹配 home，但展示保留原样
  assert.equal(
    displayPath('c:\\users\\zhang\\下载', { platform: 'win32', home: 'C:\\Users\\Zhang' }),
    '~\\下载',
  );
});

test('displayPath：home 缩写不命中相邻前缀目录（/Users/zhang2 不是 ~2）', () => {
  assert.equal(displayPath('/Users/zhang2/文档', { home: '/Users/zhang' }), '/Users/zhang2/文档');
  assert.equal(
    displayPath('C:\\Users\\Zhang2\\x', { platform: 'win32', home: 'C:\\Users\\Zhang' }),
    'C:\\Users\\Zhang2\\x',
  );
});

test('platformBasename：两种分隔符、盘符根、UNC 共享根、尾分隔符', () => {
  assert.equal(platformBasename('/Users/zhang/下载/图片.png'), '图片.png');
  assert.equal(platformBasename('C:\\Users\\zhang\\文档\\报 告.md'), '报 告.md');
  assert.equal(platformBasename('D:\\'), 'D:');
  assert.equal(platformBasename('\\\\NAS\\share'), '\\\\NAS\\share');
  assert.equal(platformBasename('/tmp/mixed/slash\\back.txt'), 'back.txt');
  assert.equal(platformBasename(''), '');
});
