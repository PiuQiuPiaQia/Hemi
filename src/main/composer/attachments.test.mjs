import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createAttachmentStore,
  formatBytes,
  guessAttachmentKind,
  parseDataUrl,
  MAX_ATTACHMENTS_PER_TURN,
} from './attachments.mjs';

function tempWorkspace() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hemi-attachments-test-'));
  return {
    dir,
    file(name, content) {
      const target = path.join(dir, name);
      writeFileSync(target, content);
      return target;
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function storeFor(workspace, overrides = {}) {
  return createAttachmentStore({
    stagingDir: path.join(workspace.dir, 'staging'),
    resolveImageAnswer: async ({ question }) => `看到了：${question}`,
    log: null,
    ...overrides,
  });
}

test('guessAttachmentKind/formatBytes/parseDataUrl：纯函数口径', () => {
  assert.equal(guessAttachmentKind('笔记.md'), 'text');
  assert.equal(guessAttachmentKind('照片.JPG'), 'image');
  assert.equal(guessAttachmentKind('表格.csv'), null);
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
  const parsed = parseDataUrl('data:image/png;base64,aGVsbG8=');
  assert.equal(parsed?.mime, 'image/png');
  assert.equal(parsed?.bytes.toString('utf8'), 'hello');
  assert.equal(parseDataUrl('not-a-data-url'), null);
  // 通用解析器不挑 mime；非图片的拒收发生在登记层（IMAGE_MIME 白名单）。
  assert.equal(parseDataUrl('data:text/plain;base64,aGVsbG8=')?.mime, 'text/plain');
});

test('attachFile：登记文本附件（realpath 解析、视图不带原始内容）', () => {
  const ws = tempWorkspace();
  try {
    const store = storeFor(ws);
    const file = ws.file('notes.md', '# 标题\n正文');
    const result = store.attachFile({ conversationId: 'c1', filePath: file, source: 'picker' });
    assert.equal(result.ok, true);
    assert.equal(result.attachment.kind, 'text');
    assert.equal(result.attachment.name, 'notes.md');
    assert.equal(result.attachment.conversationId, 'c1');
    assert.ok((result.attachment.originPath ?? '').length > 0, '文件附件带来源路径');
    assert.equal(JSON.stringify(result.attachment).includes('# 标题'), false, '视图不携带文件内容');
    assert.equal(store.list('c1').length, 1);
    assert.equal(store.list('c2').length, 0, '会话隔离');
  } finally {
    ws.cleanup();
  }
});

test('attachFile：不支持的格式／目录／超限数量都有可读拒绝', () => {
  const ws = tempWorkspace();
  try {
    const store = storeFor(ws);
    assert.throws(
      () => store.attachFile({ conversationId: 'c1', filePath: ws.file('a.csv', 'x'), source: 'picker' }),
      /暂不支持这种格式/,
    );
    assert.throws(
      () => store.attachFile({ conversationId: 'c1', filePath: ws.dir, source: 'drop' }),
      /文件夹/,
    );
    assert.throws(
      () => store.attachFile({ conversationId: '', filePath: ws.file('b.txt', 'x'), source: 'picker' }),
      /会话身份/,
    );
    store.attachFile({ conversationId: 'c1', filePath: ws.file('1.txt', 'x'), source: 'picker' });
    store.attachFile({ conversationId: 'c1', filePath: ws.file('2.md', 'x'), source: 'drop' });
    store.attachFile({ conversationId: 'c1', filePath: ws.file('3.txt', 'x'), source: 'picker' });
    assert.throws(
      () => store.attachFile({ conversationId: 'c1', filePath: ws.file('4.txt', 'x'), source: 'picker' }),
      new RegExp(`最多.*${MAX_ATTACHMENTS_PER_TURN}`),
    );
  } finally {
    ws.cleanup();
  }
});

test('readPreview：受控寻址（跨会话拒、失效给 ENOENT 专属文案、markdown 标记）', () => {
  const ws = tempWorkspace();
  try {
    const store = storeFor(ws);
    const file = ws.file('doc.md', '正文内容');
    const { attachment } = store.attachFile({ conversationId: 'c1', filePath: file, source: 'picker' });

    const preview = store.readPreview({ conversationId: 'c1', attachmentId: attachment.attachmentId });
    assert.equal(preview.ok, true);
    assert.equal(preview.kind, 'text');
    assert.equal(preview.markdown, true);
    assert.equal(preview.text, '正文内容');

    assert.equal(store.readPreview({ conversationId: 'c2', attachmentId: attachment.attachmentId }).code, 'cross-conversation');
    assert.equal(store.readPreview({ conversationId: 'c1', attachmentId: 'att-999' }).code, 'unknown');

    rmSync(file);
    const missing = store.readPreview({ conversationId: 'c1', attachmentId: attachment.attachmentId });
    assert.equal(missing.ok, false);
    assert.match(missing.message, /不在登记时的位置|已被移动/);
  } finally {
    ws.cleanup();
  }
});

test('attachPasteImage：字节落受控暂存区，缩略图随视图，移除时清理（2026-10-18 起不设视觉门槛）', async () => {
  const ws = tempWorkspace();
  const staging = path.join(ws.dir, 'staging');
  try {
    const store = storeFor(ws, {
      makeThumbnail: ({ buffer, mime }) => `data:${mime};base64,${buffer.toString('base64').slice(0, 8)}`,
    });
    const dataUrl = `data:image/png;base64,${Buffer.from('pngbytes').toString('base64')}`;
    const result = await store.attachPasteImage({ conversationId: 'c1', dataUrl });
    assert.equal(result.ok, true);
    assert.equal(result.attachment.kind, 'image');
    assert.equal(result.attachment.source, 'paste');
    assert.equal(result.attachment.originPath, '', '粘贴图片不暴露路径');
    assert.match(result.attachment.thumbnailUrl ?? '', /^data:image\/png;base64/, '缩略图随视图下发');
    const staged = path.join(staging, `${result.attachment.attachmentId}.png`);
    assert.equal(result.attachment.stagedPath, staged, '视图带暂存路径供重启回退');
    assert.equal(readFileSync(staged).toString(), 'pngbytes');
    const preview = store.readPreview({ conversationId: 'c1', attachmentId: result.attachment.attachmentId });
    assert.equal(preview.ok, true);
    assert.equal(preview.kind, 'image');
    assert.match(preview.dataUrl, /^data:image\/png;base64,/);

    store.remove({ conversationId: 'c1', attachmentId: result.attachment.attachmentId });
    assert.throws(() => statSync(staged), '暂存字节随移除清理');

    // 缩略图生成缺席（未注入／解码失败）时登记照常，视图不带缩略图——渲染层回退图标 chip。
    const bare = storeFor(ws);
    const bareResult = await bare.attachPasteImage({ conversationId: 'c1', dataUrl });
    assert.equal(bareResult.ok, true);
    assert.equal(bareResult.attachment.thumbnailUrl, undefined);
  } finally {
    ws.cleanup();
  }
});

test('attachFile：图片附件生成缩略图（文件类不走暂存回退）', () => {
  const ws = tempWorkspace();
  try {
    const store = storeFor(ws, {
      makeThumbnail: ({ mime }) => `data:${mime};base64,thumb`,
    });
    const png = ws.file('photo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const { attachment } = store.attachFile({ conversationId: 'c1', filePath: png, source: 'drop' });
    assert.equal(attachment.kind, 'image');
    assert.match(attachment.thumbnailUrl ?? '', /^data:image\/png;base64/);
    assert.equal(attachment.stagedPath, undefined, '文件附件不走暂存回退');
  } finally {
    ws.cleanup();
  }
});

test('readPreview：重启后登记表为空，按档案冻结的暂存路径受控回退（只认暂存区内图片）', async () => {
  const ws = tempWorkspace();
  const staging = path.join(ws.dir, 'staging');
  try {
    const store = storeFor(ws);
    const dataUrl = `data:image/png;base64,${Buffer.from('restartpng').toString('base64')}`;
    const { attachment } = await store.attachPasteImage({ conversationId: 'c1', dataUrl });
    const staged = path.join(staging, `${attachment.attachmentId}.png`);

    // 模拟重启：新实例登记表为空，暂存字节仍在盘上。
    const restarted = storeFor(ws);
    const fallback = restarted.readPreview({
      conversationId: 'c1',
      attachmentId: attachment.attachmentId,
      stagedPath: staged,
    });
    assert.equal(fallback.ok, true);
    assert.equal(fallback.kind, 'image');
    assert.match(fallback.dataUrl, /^data:image\/png;base64,/);

    // 回退边界：暂存区外的路径、暂存区内的非图片，都不当作附件读，按 unknown 如实返回。
    assert.equal(
      restarted.readPreview({ conversationId: 'c1', attachmentId: 'att-1', stagedPath: ws.file('evil.txt', 'x') }).code,
      'unknown',
    );
    const txtInStaging = path.join(staging, 'note.txt');
    writeFileSync(txtInStaging, 'x');
    assert.equal(
      restarted.readPreview({ conversationId: 'c1', attachmentId: 'att-1', stagedPath: txtInStaging }).code,
      'unknown',
    );
  } finally {
    ws.cleanup();
  }
});

test('markSent：受理后撤出草稿列表，预览与重试仍按身份可读', async () => {
  const ws = tempWorkspace();
  try {
    const store = storeFor(ws);
    const file = ws.file('notes.txt', '内容甲');
    const { attachment } = store.attachFile({ conversationId: 'c1', filePath: file, source: 'picker' });
    assert.equal(store.list('c1').length, 1);

    const envelope = await store.resolveEnvelopeForTurn({
      conversationId: 'c1',
      attachmentIds: [attachment.attachmentId],
      question: '看看写了什么',
    });
    assert.match(envelope, /消息附件「notes.txt」/);
    assert.match(envelope, /内容甲/);

    assert.equal(store.markSent({ conversationId: 'c1', attachmentIds: [attachment.attachmentId] }), 1);
    assert.equal(store.list('c1').length, 0, '已发送不再出现在准备区');
    assert.equal(store.markSent({ conversationId: 'c2', attachmentIds: [attachment.attachmentId] }), 0, '跨会话不可冻结');

    const preview = store.readPreview({ conversationId: 'c1', attachmentId: attachment.attachmentId });
    assert.equal(preview.ok, true, '冻结后预览仍可读');
    const again = await store.resolveEnvelopeForTurn({
      conversationId: 'c1',
      attachmentIds: [attachment.attachmentId],
      question: '再读一次',
    });
    assert.match(again, /内容甲/, '重试按原身份重读');
  } finally {
    ws.cleanup();
  }
});

test('resolveEnvelopeForTurn：图片走视觉解读、失效附件降级为说明块（不吞回合）', async () => {
  const ws = tempWorkspace();
  try {
    const store = storeFor(ws);
    const png = ws.file('photo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const { attachment } = store.attachFile({ conversationId: 'c1', filePath: png, source: 'picker' });
    const envelope = await store.resolveEnvelopeForTurn({
      conversationId: 'c1',
      attachmentIds: [attachment.attachmentId],
      question: '图里有什么',
    });
    assert.match(envelope, /看到了：图里有什么/);

    const ghost = await store.resolveEnvelopeForTurn({
      conversationId: 'c1',
      attachmentIds: ['att-404'],
      question: 'q',
    });
    assert.match(ghost, /附件不存在或已被移除/);
  } finally {
    ws.cleanup();
  }
});

test('remove：只清自己的登记；重复移除幂等', () => {
  const ws = tempWorkspace();
  try {
    const store = storeFor(ws);
    const a = store.attachFile({ conversationId: 'c1', filePath: ws.file('a.txt', 'x'), source: 'picker' });
    store.attachFile({ conversationId: 'c1', filePath: ws.file('b.txt', 'y'), source: 'picker' });
    assert.equal(store.remove({ conversationId: 'c2', attachmentId: a.attachment.attachmentId }).ok, false);
    assert.equal(store.remove({ conversationId: 'c1', attachmentId: a.attachment.attachmentId }).ok, true);
    assert.equal(store.list('c1').length, 1);
    assert.equal(store.remove({ conversationId: 'c1', attachmentId: a.attachment.attachmentId }).ok, false);
  } finally {
    ws.cleanup();
  }
});
