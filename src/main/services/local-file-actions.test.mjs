import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalFileActions } from './local-file-actions.mjs';

test('选择应用用独立参数打开文件；取消不启动，定位调用原生文件管理器', async () => {
  const invocations = [];
  let canceled = false;
  const actions = createLocalFileActions({ platform: 'darwin',
    revealPath: target => invocations.push(['reveal', target]),
    chooseApplication: async () => ({ canceled, filePaths: ['/Applications/My App.app'] }),
    execFileFn: (command, args, options, done) => { invocations.push([command, args]); done(null); },
  });
  const target = '/workspace/中文 $(literal).md';
  assert.equal((await actions.perform('choose-app', target)).ok, true);
  assert.deepEqual(invocations[0], ['/usr/bin/open', ['-a', '/Applications/My App.app', '--', target]]);
  canceled = true;
  assert.equal((await actions.perform('choose-app', target)).canceled, true);
  assert.equal(invocations.length, 1);
  assert.equal((await actions.perform('reveal', target)).ok, true);
  assert.deepEqual(invocations[1], ['reveal', target]);
});

test('菜单只给展示字段；打开具体程序时重新查证，目录操作使用真实父目录', async () => {
  const invocations = [];
  let installed = true;
  const actions = createLocalFileActions({ platform: 'darwin',
    discoverApplications: async filePath => installed ? [{ id: 'host-issued', name: 'Editor', path: '/Applications/Editor.app', isDefault: true }] : [],
    getApplicationIcon: async () => 'data:image/png;base64,icon',
    openDirectory: async directory => { invocations.push(['directory', directory]); return ''; },
    execFileFn: (command, args, options, done) => { invocations.push([command, args]); done(null); },
  });
  const target = '/workspace/中文 $(literal).md';
  const list = await actions.listApplications(target);
  assert.deepEqual(list.applications, [{ id: 'host-issued', name: 'Editor', isDefault: true, icon: 'data:image/png;base64,icon' }]);
  assert.equal((await actions.perform('application', target, 'forged')).ok, false);
  assert.equal(invocations.length, 0);
  assert.equal((await actions.perform('application', target, 'host-issued')).ok, true);
  assert.deepEqual(invocations[0], ['/usr/bin/open', ['-a', '/Applications/Editor.app', '--', target]]);
  installed = false;
  assert.equal((await actions.perform('application', target, 'host-issued')).ok, false);
  assert.equal(invocations.length, 1);
  assert.equal((await actions.perform('directory', target)).ok, true);
  assert.deepEqual(invocations[1], ['directory', '/workspace']);
});
