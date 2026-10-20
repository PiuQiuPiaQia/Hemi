// 012 产物纯函数单测。
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  artifactViews,
  expandTildePath,
  extractHttpsLinks,
  isExecutablePath,
  resolveForOpen,
} from './artifacts.mjs';

test('expandTildePath：波浪线与家目录', () => {
  // join 结果按平台构造：win 上 path.join 用反斜杠（产品语义正确）。
  assert.equal(expandTildePath('~/Documents/a.md', '/home/u'), path.join('/home/u', 'Documents/a.md'));
  assert.equal(expandTildePath('~', '/home/u'), '/home/u');
  assert.equal(expandTildePath('/abs/b.txt', '/home/u'), '/abs/b.txt');
  assert.equal(expandTildePath('  ', '/home/u'), '');
});

test('isExecutablePath：可执行扩展名', () => {
  assert.equal(isExecutablePath('/a/b.app'), true);
  assert.equal(isExecutablePath('/a/b.SH'), true);
  assert.equal(isExecutablePath('/a/b.md'), false);
});

test('extractHttpsLinks：去重/限数/非 https 忽略/尾标点剥离', () => {
  const report = [
    '来源见 https://example.com/a。',
    '重复 https://example.com/a',
    'ftp://example.com/x 与 custom:proto 不收',
    'https://example.com/b?q=1，以及 https://example.com/c',
  ].join('\n');
  const urls = extractHttpsLinks(report);
  assert.deepEqual(urls, ['https://example.com/a', 'https://example.com/b?q=1', 'https://example.com/c']);
  assert.equal(extractHttpsLinks('没有链接').length, 0);
  assert.equal(extractHttpsLinks('https://u1 https://u2 https://u3 https://u4 https://u5 https://u6').length, 5);
});

test('extractHttpsLinks：反引号/中文粘连截断（真机档案回归）', () => {
  // 报告常见写法：反引号包裹 + 全角冒号说明（2026-09-20 task-4 档案实录）。
  assert.deepEqual(
    extractHttpsLinks('已保存 `https://en.wikipedia.org/api/rest_v1/page/summary/Pablo_Picasso`：description'),
    ['https://en.wikipedia.org/api/rest_v1/page/summary/Pablo_Picasso'],
  );
  // 链接后直接接中文，中间无空格。
  assert.deepEqual(
    extractHttpsLinks('见 https://example.com/x 的说明'),
    ['https://example.com/x'],
  );
  // 引号与尖括号截断保持原有行为。
  assert.deepEqual(extractHttpsLinks('"https://q.com/a"'), ['https://q.com/a']);
  assert.deepEqual(extractHttpsLinks('<https://q.com/b>'), ['https://q.com/b']);
});

const fileArtifact = { id: 'art-1', kind: 'file', path: '/tmp/a.md', name: 'a.md', registeredAt: 123 };

test('artifactViews：可用性实时查证（stat 注入）', () => {
  const views = artifactViews([
    fileArtifact,
    { id: 'art-2', kind: 'link', url: 'https://example.com', name: 'example.com', registeredAt: 124 },
  ], {
    statNow: (p) => {
      if (p === '/tmp/a.md') return { isFile: () => true, size: 456 };
      throw new Error('ENOENT');
    },
  });
  assert.equal(views[0].available, true);
  assert.equal(views[0].size, 456);
  assert.equal(views[0].executable, false);
  assert.equal(views[1].kind, 'link');
  assert.equal(views[1].available, true);
  // 不可用文件（AC-03）。
  const missing = artifactViews([fileArtifact], { statNow: () => { throw new Error('ENOENT'); } });
  assert.equal(missing[0].available, false);
});

test('artifactViews：旧档案截坏链接展示前清洗（真机回归）', () => {
  const views = artifactViews([
    { id: 'art-9', kind: 'link', url: 'https://a.b/c`：description', name: 'x', registeredAt: 9 },
  ]);
  assert.equal(views[0].url, 'https://a.b/c');
  assert.equal(views[0].available, true);
  // 截不出可链接的按失效显示。
  const dead = artifactViews([{ id: 'art-10', kind: 'link', url: 'https://', name: 'y', registeredAt: 10 }]);
  assert.equal(dead[0].available, false);
});

test('resolveForOpen：寻址、协议边界、可执行只定位（AC-05）', () => {
  const record = {
    deliverables: [
      fileArtifact,
      { id: 'art-2', kind: 'link', url: 'https://example.com', name: 'e' },
      { id: 'art-3', kind: 'link', url: 'ftp://example.com', name: 'f' },
      { id: 'art-4', kind: 'file', path: '/tmp/tool.app', name: 'tool.app', registeredAt: 125 },
    ],
  };
  const statOk = () => ({ isFile: () => true, size: 1 });
  assert.deepEqual(resolveForOpen(record, 'art-1', { statNow: statOk }), { ok: true, kind: 'open', path: '/tmp/a.md' });
  assert.deepEqual(resolveForOpen(record, 'art-1', { intent: 'reveal', statNow: statOk }), { ok: true, kind: 'reveal', path: '/tmp/a.md' });
  assert.deepEqual(resolveForOpen(record, 'art-2', { statNow: statOk }), { ok: true, kind: 'link', url: 'https://example.com' });
  assert.equal(resolveForOpen(record, 'art-3', { statNow: statOk }).ok, false);
  assert.equal(resolveForOpen(record, 'art-9', { statNow: statOk }).ok, false);
  const exec = resolveForOpen(record, 'art-4', { statNow: statOk });
  assert.equal(exec.kind, 'reveal'); // 可执行产物不自动运行
  assert.equal(resolveForOpen(record, 'art-1', { statNow: () => { throw new Error('ENOENT'); } }).ok, false);
});

test('resolveForOpen：旧档案截坏链接打开前清洗（真机回归）', () => {
  const record = {
    deliverables: [
      { id: 'dirty', kind: 'link', url: 'https://a.b/c`：description', name: 'x' },
      { id: 'junk', kind: 'link', url: 'https://', name: 'y' },
    ],
  };
  assert.deepEqual(resolveForOpen(record, 'dirty'), { ok: true, kind: 'link', url: 'https://a.b/c' });
  assert.equal(resolveForOpen(record, 'junk').ok, false);
});

// ---- 043：Windows 可执行/间接执行形态同样只定位不运行（R-15） ----
test('043 isExecutablePath：Windows 安装包/脚本/快捷方式/URL 捷径全部命中', () => {
  for (const p of [
    'C:\\Users\\d\\Downloads\\setup.exe',
    'D:\\工具\\hacktool.com',
    'C:\\安装包\\installer.msi',
    'C:\\store\\app.msix',
    'C:\\store\\app.appx',
    'C:\\脚本\\run.bat',
    'C:\\脚本\\run.cmd',
    'C:\\脚本\\deploy.ps1',
    'C:\\脚本\\calc.vbs',
    'C:\\脚本\\main.js',
    'C:\\脚本\\po.hta',
    'C:\\Windows\\scr.scr',
    'C:\\Users\\d\\Desktop\\shortcut.lnk',
    'C:\\Users\\d\\Desktop\\某站点.url',
  ]) {
    assert.equal(isExecutablePath(p), true, `${p} 应判定为可执行（只定位）`);
  }
});

test('043 isExecutablePath：大小写不敏感；普通文档不受连坐', () => {
  assert.equal(isExecutablePath('C:\\a\\SETUP.EXE'), true);
  assert.equal(isExecutablePath('C:\\a\\report.EXE.txt'), false);
  assert.equal(isExecutablePath('C:\\a\\笔记.md'), false);
  assert.equal(isExecutablePath('C:\\a\\表格.xlsx'), false);
  assert.equal(isExecutablePath('/tmp/report.pdf'), false);
});

test('043 resolveForOpen：exe 产物 open 意图降级为 reveal，不启动程序', () => {
  const record = {
    deliverables: [{ id: 'exe', kind: 'file', path: 'C:\\dist\\tool.exe', name: 'tool.exe', registeredAt: 1 }],
  };
  const statOk = () => ({ isFile: () => true, size: 1 });
  assert.deepEqual(resolveForOpen(record, 'exe', { statNow: statOk }), {
    ok: true, kind: 'reveal', path: 'C:\\dist\\tool.exe',
  });
  assert.equal(resolveForOpen(record, 'exe', { intent: 'open', statNow: statOk }).kind, 'reveal');
});
