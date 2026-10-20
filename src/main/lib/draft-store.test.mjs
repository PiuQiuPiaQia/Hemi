import assert from 'node:assert/strict';
import test from 'node:test';

import { createDraftStore, DRAFT_TEXT_LIMIT, normalizeDraft } from './draft-store.mjs';

function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    readFile: async (p) => {
      if (!files.has(p)) {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(p);
    },
    writeFile: async (p, content) => {
      files.set(p, content);
    },
    rename: async (from, to) => {
      // 与真实 fs 对齐：源不存在（被并发 rename 消费）抛 ENOENT。
      if (!files.has(from)) {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
      files.set(to, files.get(from));
      files.delete(from);
    },
    unlink: async (p) => {
      if (!files.has(p)) throw new Error('ENOENT');
      files.delete(p);
    },
    mkdir: async () => {},
  };
}

function storeFor(fs) {
  return createDraftStore({
    dir: '/ud/drafts',
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    rename: fs.rename,
    unlink: fs.unlink,
    mkdir: fs.mkdir,
    log: null,
  });
}

test('normalizeDraft：身份/长度校验；空文本合法（＝无草稿语义）', () => {
  assert.equal(normalizeDraft({ conversationId: 'conv-1', revision: 3, text: 'hi' }).text, 'hi');
  assert.equal(normalizeDraft({ conversationId: '', text: 'x' }), null);
  assert.equal(normalizeDraft({ conversationId: 'bad id with space', text: 'x' }), null);
  assert.equal(normalizeDraft({ conversationId: 'c', text: 'x'.repeat(DRAFT_TEXT_LIMIT + 1) }), null);
});

test('保存与恢复：一份会话一份；切走再回来正文与换行不丢', async () => {
  const fs = memoryFs();
  const store = storeFor(fs);
  const text = '第一行\n第二行继续写\n\n第四行';
  await store.save({ conversationId: 'conv-a', revision: 4, text });
  await store.save({ conversationId: 'conv-b', revision: 1, text: 'B 的草稿' });
  const restored = await store.get('conv-a');
  assert.equal(restored.text, text);
  assert.equal(restored.revision, 4);
  assert.equal((await store.get('conv-b')).text, 'B 的草稿');
  assert.equal(await store.get('conv-c'), null);
});

test('revision 单调守卫：迟到的旧写入不回退；提交清空不吞等待期新内容', async () => {
  const fs = memoryFs();
  const store = storeFor(fs);
  // 用户写 v5 → 提交（清空写 v6）→ 等待期又写了 v7 → 迟到的 v5 防抖写入到达。
  await store.save({ conversationId: 'c', revision: 5, text: '旧防抖内容' });
  await store.save({ conversationId: 'c', revision: 6, text: '' }); // 提交清空
  assert.equal(await store.get('c'), null, '提交后无草稿');
  await store.save({ conversationId: 'c', revision: 7, text: '等待期新写的' });
  const stale = await store.save({ conversationId: 'c', revision: 5, text: '迟到旧写' });
  assert.equal(stale.ok, true);
  assert.equal(stale.stale, true, '旧版本被单调守卫拒绝');
  assert.equal((await store.get('c')).text, '等待期新写的');
});

test('损坏文件按无草稿处理；保存失败如实返回不中断', async () => {
  const fs = memoryFs({ '/ud/drafts/broken.json': '{oops' });
  const store = storeFor(fs);
  assert.equal(await store.get('broken'), null);
  const failing = createDraftStore({
    dir: '/ud/drafts',
    readFile: fs.readFile,
    writeFile: async () => {
      throw new Error('disk full');
    },
    rename: fs.rename,
    unlink: fs.unlink,
    mkdir: fs.mkdir,
  });
  const result = await failing.save({ conversationId: 'c', revision: 1, text: 'x' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'write-failed');
  assert.match(result.message, /重启后可能无法恢复/);
});

test('删除会话联动清草稿（幂等）；空草稿落盘即清文件', async () => {
  const fs = memoryFs();
  const store = storeFor(fs);
  await store.save({ conversationId: 'gone', revision: 1, text: '待删' });
  assert.equal(await store.remove('gone'), true);
  assert.equal(await store.get('gone'), null);
  assert.equal(await store.remove('gone'), false, '重复删除幂等');
  await store.save({ conversationId: 'empty', revision: 2, text: 'soon empty' });
  await store.save({ conversationId: 'empty', revision: 3, text: '' });
  assert.equal(fs.files.has('/ud/drafts/empty.json'), false, '空草稿清文件');
});

// 2026-10-01 会话审计回归：启动时同一会话两次保存并发（冲刷＋清空），
// 旧实现共享 tmp 被先到 rename 消费、第二个 ENOENT 且报 write-failed。
function deferredFs() {
  const base = memoryFs();
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const wrap = (impl) => async (...args) => {
    await tick(); // 每个 IO 都让步一拍，放大交错窗口
    return impl(...args);
  };
  return {
    files: base.files,
    readFile: wrap(base.readFile),
    writeFile: wrap(base.writeFile),
    rename: wrap(base.rename),
    unlink: wrap(base.unlink),
    mkdir: wrap(base.mkdir),
  };
}

test('并发保存同一会话：串行执行，不撞 tmp、单调守卫不被交错绕过', async () => {
  const fs = deferredFs();
  const store = storeFor(fs);
  const [high, stale] = await Promise.all([
    store.save({ conversationId: 'c', revision: 3, text: 'v3' }),
    store.save({ conversationId: 'c', revision: 1, text: '旧写入' }),
  ]);
  assert.equal(high.ok, true, '先入队的高版本正常落盘');
  assert.equal(high.code, undefined);
  assert.equal(stale.ok, true);
  assert.equal(stale.stale, true, '后入队的低版本被单调守卫拒绝，而非 ENOENT 失败');
  const final = await store.get('c');
  assert.equal(final.text, 'v3');
  assert.equal(final.revision, 3);
});

test('并发保存同一会话（乱序多次）：终态 revision＝最大值，无一失败', async () => {
  const fs = deferredFs();
  const store = storeFor(fs);
  const revisions = [5, 2, 9, 4, 7, 1, 8, 3, 6];
  const results = await Promise.all(
    revisions.map((revision) =>
      store.save({ conversationId: 'c', revision, text: `v${revision}` }),
    ),
  );
  for (const result of results) {
    assert.equal(result.ok, true, `revision 保存不应失败：${JSON.stringify(result)}`);
    assert.notEqual(result.code, 'write-failed');
  }
  const final = await store.get('c');
  assert.equal(final.revision, 9, '终态为最大 revision（单调不回退）');
  assert.equal(final.text, 'v9');
});

test('并发保存不同会话互不阻塞语义：各自正常落盘', async () => {
  const fs = deferredFs();
  const store = storeFor(fs);
  const results = await Promise.all([
    store.save({ conversationId: 'a', revision: 1, text: 'A' }),
    store.save({ conversationId: 'b', revision: 1, text: 'B' }),
  ]);
  assert.deepEqual(
    results.map((item) => item.ok),
    [true, true],
  );
  assert.equal((await store.get('a')).text, 'A');
  assert.equal((await store.get('b')).text, 'B');
});

// ---- 063：草稿 v2——标签身份（技能＋引用）与正文同批保存/恢复 ----

test('063：草稿随存技能与引用身份；只有文字的旧 v1 档照常读回', async () => {
  const fs = memoryFs();
  const store = storeFor(fs);
  const skills = [{ token: 'pdf', name: 'pdf', source: 'library', skillId: 'lib:pdf', description: 'x'.repeat(300) }];
  const references = [{ kind: 'file', key: 'file:a.md', name: 'a.md', subtitle: '文件 · a.md', refPath: 'a.md' }];
  const saved = await store.save({ conversationId: 'conv-a', revision: 1, text: '用 pdf 整理 @a.md', skills, references });
  assert.equal(saved.ok, true);
  const restored = await store.get('conv-a');
  assert.equal(restored.text, '用 pdf 整理 @a.md');
  assert.equal(restored.version, 2);
  assert.equal(restored.skills.length, 1);
  assert.equal(restored.skills[0].description.length <= 200, true, '超长说明截断');
  assert.equal(restored.references[0].refPath, 'a.md');
  // 旧 v1 档（无标签字段）：normalizeDraft 兼容读回。
  const legacy = normalizeDraft({ conversationId: 'conv-b', revision: 1, text: '旧草稿' });
  assert.equal(legacy.version, 2);
  assert.equal(legacy.text, '旧草稿');
  assert.equal(legacy.skills, undefined);
  // 非法 kind 的引用被清掉。
  const dirty = normalizeDraft({ conversationId: 'conv-c', revision: 1, text: 'x', references: [{ kind: 'evil', key: 'k', name: 'n', subtitle: '' }] });
  assert.equal(dirty.references, undefined);
});
