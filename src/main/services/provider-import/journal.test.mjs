import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';

import { createImportJournal } from './journal.mjs';

function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const error = (code) => Object.assign(new Error(code), { code });
  // journal.mjs 的 fileOf 走 path.join——Windows 出反斜杠；桩内键一律归一成正斜杠，
  // readdir 前缀过滤才有结果（否则 list() 恒空、直设的坏文件读不到）。
  const norm = (p) => String(p).split(path.sep).join('/');
  return {
    files,
    readFile: async (p) => (files.has(norm(p)) ? files.get(norm(p)) : Promise.reject(error('ENOENT'))),
    writeFile: async (p, c) => files.set(norm(p), c),
    rename: async (from, to) => {
      const fromKey = norm(from);
      if (!files.has(fromKey)) return Promise.reject(error('ENOENT'));
      files.set(norm(to), files.get(fromKey));
      files.delete(fromKey);
    },
    mkdir: async () => {},
    readdir: async (p) => [...files.keys()].filter((key) => key.startsWith(`${norm(p)}/`)).map((key) => key.slice(norm(p).length + 1)),
    unlink: async (p) => (files.has(norm(p)) ? files.delete(norm(p)) : Promise.reject(error('ENOENT'))),
  };
}

const safeStub = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain}`).toString('base64'),
  decryptString: (buf) => {
    const text = Buffer.from(buf).toString('utf8');
    if (!text.startsWith('enc:')) throw new Error('bad cipher');
    return text.slice(4);
  },
};

function journalFor(fs, safeStorage = safeStub) {
  return createImportJournal({
    dirPath: '/ud/provider-import',
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    rename: fs.rename,
    mkdir: fs.mkdir,
    readdir: fs.readdir,
    unlink: fs.unlink,
    safeStorage,
    log: null,
  });
}

test('persist/read 加密往返；list 摘要不含秘密正文', async () => {
  const fs = memoryFs();
  const journal = journalFor(fs);
  await journal.persist('pi-test-0001', { siteOrigin: 'https://vvcode.top', apiKey: 'sk-secret', intent: { tokenName: 'Hemi-1' }, phase: 'reading-key' });

  const read = await journal.read('pi-test-0001');
  assert.equal(read.ok, true);
  assert.equal(read.payload.apiKey, 'sk-secret');

  const listed = await journal.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].apiKeyHeld, true);
  assert.equal(listed[0].tokenName, 'Hemi-1');
  assert.equal(JSON.stringify(listed[0]).includes('sk-secret'), false, '列表摘要不出现明文 Key');

  // 外层文件本身也不含明文
  const raw = fs.files.get('/ud/provider-import/pi-test-0001.json');
  assert.equal(raw.includes('sk-secret'), false);
});

test('损坏/异源密文 → corrupt（文件保留）；缺失 → null', async () => {
  const fs = memoryFs();
  const journal = journalFor(fs);
  assert.equal(await journal.read('pi-missing-0000'), null);

  fs.files.set('/ud/provider-import/pi-bad-00002.json', JSON.stringify({ schema: 1, operationId: 'pi-bad-00002', encrypted: 'bm90LWVuYw==' }));
  const read = await journal.read('pi-bad-00002');
  assert.deepEqual(read, { ok: false, code: 'corrupt' });
  const listed = await journal.list();
  assert.equal(listed[0].readable, false);
  assert.equal(fs.files.has('/ud/provider-import/pi-bad-00002.json'), true, '现场保留');
});

test('remove 幂等；safeStorage 不可用 → persist 如实抛错', async () => {
  const fs = memoryFs();
  const journal = journalFor(fs);
  await journal.persist('pi-gone-000003', { phase: 'login' });
  await journal.remove('pi-gone-000003');
  await journal.remove('pi-gone-000003');
  assert.equal((await journal.list()).length, 0);

  const broken = journalFor(memoryFs(), { isEncryptionAvailable: () => false, encryptString: () => Buffer.of(), decryptString: () => '' });
  await assert.rejects(() => broken.persist('pi-noenc-0004', { phase: 'login' }), /无法加密/);
});

test('journal 文件名只认合法 operationId', async () => {
  const journal = journalFor(memoryFs());
  await assert.rejects(() => journal.persist('../escape', {}));
});
