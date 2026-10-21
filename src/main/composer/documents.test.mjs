import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, truncateSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { unzipSync } from 'fflate';
import { DOCUMENT_FILE_BYTE_LIMIT, readDocumentText } from './documents.mjs';
import { createAttachmentStore, guessAttachmentKind } from './attachments.mjs';
import { createWorkContext } from '../context/work-context.mjs';
import { docxFixture, xlsxFixture, pptxFixture, pdfFixture, officeZip, wordNamespace } from '../../../scripts/lib/document-fixtures.mjs';

function workspace(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hemi-documents-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return (name, data) => {
    const file = path.join(root, name);
    writeFileSync(file, data);
    return file;
  };
}

for (const [format, bytes, expected] of [
  ['pdf', pdfFixture(), /HEMI_PDF first page[\s\S]*第 2 页[\s\S]*Second page/],
  ['docx', docxFixture(), /HEMI_DOCX 项目说明 & 预算[\s\S]*表格内容/],
  ['xlsx', xlsxFixture(), /工作表：预算[\s\S]*A1: HEMI_XLSX 收入\tC1: 1200[\s\S]*SUM\(C1\)[\s\S]*工作表：人员[\s\S]*张三/],
  ['pptx', pptxFixture(), /第 1 张幻灯片[\s\S]*HEMI_PPTX 第一张[\s\S]*第 2 张幻灯片[\s\S]*第二张/],
]) {
  test(`${format}: real worker extraction, controlled preview, turn and reference-compatible text`, async (t) => {
    const file = workspace(t)(`document.${format.toUpperCase()}`, bytes);
    assert.equal(guessAttachmentKind(file), 'text');
    const store = createAttachmentStore();
    const { attachment } = store.attachFile({ conversationId: 'c1', filePath: file, source: 'drop' });
    assert.equal(attachment.kind, 'text');
    assert.equal((await store.readDocumentSource({ conversationId: 'c2', attachmentId: attachment.attachmentId })).code, 'cross-conversation');
    const visual = await store.readDocumentSource({ conversationId: 'c1', attachmentId: attachment.attachmentId });
    assert.equal(visual.ok, true, visual.message);
    assert.equal(visual.format, format);
    if (format === 'xlsx') assert.equal(visual.sheets[0].name, '预算');
    else assert.deepEqual(visual.bytes, new Uint8Array(bytes));
    assert.equal(await store.readPreview({ conversationId: 'c2', attachmentId: attachment.attachmentId }).code, 'cross-conversation');
    const preview = await store.readPreview({ conversationId: 'c1', attachmentId: attachment.attachmentId });
    assert.equal(preview.ok, true, preview.message);
    assert.equal(preview.markdown, false);
    assert.match(preview.text, expected);
    if (format === 'xlsx') assert.match(preview.text, /A3: 2026-10-21\tC3: 25%/);
    const envelope = await store.resolveEnvelopeForTurn({ conversationId: 'c1', attachmentIds: [attachment.attachmentId], question: '总结' });
    assert.match(envelope, expected);
    assert.match(envelope, /来源：消息附件/);
    assert.match(envelope, /内嵌图片/);
    rmSync(file);
    assert.equal((await store.readPreview({ conversationId: 'c1', attachmentId: attachment.attachmentId })).code, 'source-missing');
  });
}

test('document budgets are enforced at registration and again at extraction', async (t) => {
  const file = workspace(t)('large.docx', docxFixture());
  const store = createAttachmentStore();
  const { attachment } = store.attachFile({ conversationId: 'c1', filePath: file, source: 'picker' });
  truncateSync(file, DOCUMENT_FILE_BYTE_LIMIT + 1);
  assert.throws(() => store.attachFile({ conversationId: 'c2', filePath: file, source: 'drop' }), /20MB/);
  const preview = await store.readPreview({ conversationId: 'c1', attachmentId: attachment.attachmentId });
  assert.equal(preview.ok, false);
  assert.match(preview.message, /20MB/);
  assert.equal((await store.readDocumentSource({ conversationId: 'c1', attachmentId: attachment.attachmentId })).ok, false);
});

test('independently generated Chinese PDF and Office documents extract real text', async (t) => {
  const file = workspace(t);
  for (const ext of ['pdf', 'docx', 'xlsx', 'pptx']) {
    const bytes = readFileSync(new URL(`../../../scripts/fixtures/documents/chinese.${ext}`, import.meta.url));
    const result = await readDocumentText(file(`chinese.${ext}`, bytes));
    assert.match(result.text, /1500/);
    assert.match(result.text, ext === 'xlsx' ? /项目[\s\S]*软件/ : /真实.*中文测试/);
    if (ext === 'docx') assert.match(result.text, /项目\t金额\n软件\t1500/);
  }
});

test('bundled PDF CMaps retain upstream bytes and license provenance', () => {
  const base = new URL('../../../third-party/pdfjs/', import.meta.url);
  const provenance = JSON.parse(readFileSync(new URL('sources.json', base), 'utf8'));
  const bytes = readFileSync(new URL('cmaps.zip', base));
  const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
  assert.equal(hash(bytes), provenance.archiveSha256);
  const files = unzipSync(bytes);
  for (const item of provenance.files) assert.equal(hash(files[item.name]), item.sha256, item.name);
  for (const item of provenance.licenseFiles) assert.equal(hash(readFileSync(new URL(item.name, base))), item.sha256);
});

test('file picker and Finder context routes attach, refresh and send documents using the same parser', async (t) => {
  const file = workspace(t);
  for (const viaFinder of [true, false]) {
    const filePath = file('context.docx', docxFixture('原始文档'));
    const context = createWorkContext({
      readFinderSelection: () => viaFinder ? [filePath] : [],
      showOpenDialog: async () => ({ canceled: false, filePaths: [filePath] }),
    });
    const attached = await context.attach('file');
    assert.match(attached.object.text, /原始文档/);
    writeFileSync(filePath, docxFixture('更新后的文档'));
    await context.refresh(attached.object.id);
    assert.match(await context.resolveEnvelope('总结'), /更新后的文档/);
    assert.doesNotMatch(await context.resolveEnvelope('总结'), /原始文档/);
  }
});

test('scan-only PDF, corrupt and encrypted Office files fail visibly without binary text', async (t) => {
  const file = workspace(t);
  await assert.rejects(readDocumentText(file('scan.pdf', pdfFixture(['']))), /扫描件.*OCR/);
  await assert.rejects(readDocumentText(file('broken.docx', 'not a zip')), /格式不正确或已加密/);
  await assert.rejects(readDocumentText(file('broken.pdf', 'not a pdf')), /无法读取文档/);
  const encrypted = readFileSync(new URL('../../../scripts/fixtures/documents/encrypted.pdf', import.meta.url));
  await assert.rejects(readDocumentText(file('encrypted.pdf', encrypted)), { code: 'document-encrypted', message: '文档已加密，请移除密码后重新添加' });
  const store = createAttachmentStore();
  const { attachment } = store.attachFile({ conversationId: 'c1', filePath: file('bad.pptx', 'binary garbage'), source: 'drop' });
  const envelope = await store.resolveEnvelopeForTurn({ conversationId: 'c1', attachmentIds: [attachment.attachmentId] });
  assert.match(envelope, /无法读取文档/);
  assert.doesNotMatch(envelope, /binary garbage/);
});

test('long text is explicitly truncated, XML entities and ZIP expansion are bounded', async (t) => {
  const file = workspace(t);
  const store = createAttachmentStore();
  const { attachment } = store.attachFile({ conversationId: 'c1', filePath: file('long.docx', docxFixture('长'.repeat(9000))), source: 'drop' });
  const preview = await store.readPreview({ conversationId: 'c1', attachmentId: attachment.attachmentId });
  assert.match(preview.text, /仅保留前 6000 字/);
  await assert.rejects(readDocumentText(file('entity.docx', officeZip({ 'word/document.xml': `<!DOCTYPE w:document [<!ENTITY x SYSTEM "file:///etc/passwd">]><w:document xmlns:w="${wordNamespace}">&x;</w:document>` }))), /XML 声明/);
  await assert.rejects(readDocumentText(file('bomb.docx', officeZip({ 'word/document.xml': ' '.repeat(8 * 1024 * 1024 + 1) }))), /解压内容过大/);
});
