// Real Electron renderer -> IPC -> worker -> provider payload regression.
// VITE_DEV_SERVER_URL selects the development renderer; otherwise use npm run build.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { docxFixture, xlsxFixture, pptxFixture, pdfFixture } from './lib/document-fixtures.mjs';

const runtime = process.env.HEMI_PLAYWRIGHT_MODULE ?? path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const { _electron } = await import(pathToFileURL(runtime).href);
const mode = process.env.VITE_DEV_SERVER_URL ? 'dev' : 'built';
const cardsOnly = process.argv.includes('--cards');
const evidence = path.resolve(`.visual/${cardsOnly ? 'attachment-cards' : 'document-attachments'}/${mode}`);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-document-attachments-'));
fs.mkdirSync(evidence, { recursive: true });
fs.writeFileSync(path.join(userData, 'onboarding.json'), JSON.stringify({ version: 1, phase: 'complete', step: 'done', completedAt: Date.now() }));
const requests = [], checks = [], errors = [], consoleErrors = [];
const check = (name) => { checks.push(name); console.log(`PASS ${name}`); };
const wait = async (predicate, label) => {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`等待超时：${label}`);
};
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push(body);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [delta, finish_reason] of [[{ role: 'assistant', content: '已收到文档文字。' }, null], [{}, 'stop']]) {
    res.write(`data: ${JSON.stringify({ id: 'document-test', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  }
  res.end('data: [DONE]\n\n');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
fs.writeFileSync(path.join(userData, 'text-model-profiles.json'), JSON.stringify({
  version: 3, defaultModelId: 'audit/main', lastConversationModelKey: 'audit/main',
  providers: [{ id: 'audit', name: '文档附件验证', api: 'openai-completions', baseUrl,
    models: [{ id: 'main', model: 'document-test', supportsVision: cardsOnly, thinkingLevel: 'off' }] }],
}));

let electron, page, rendererUrl;
try {
  electron = await _electron.launch({
    executablePath: path.resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: ['.'],
    env: { ...process.env, HEMI_USER_DATA_DIR: userData, HEMI_TEST_MIC_GRANT: '1', HEMI_LLM_API_KEY: 'TEST_ONLY', HEMI_LLM_BASE_URL: baseUrl, HEMI_LLM_MODEL: 'document-test' },
  });
  electron.process().stderr.on('data', (data) => fs.appendFileSync(path.join(evidence, 'stderr.log'), data));
  await wait(() => { page = electron.windows().find((p) => /^(?:http|file):/.test(p.url()) && !new URL(p.url()).searchParams.has('mode')); return !!page; }, '主窗口');
  rendererUrl = page.url();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  const input = page.locator('textarea.text-composer-input');
  await input.waitFor();
  await page.evaluate(async ({ baseUrl, vision }) => {
    await window.hemiVoice.saveModelProfile({ id: 'audit', name: '文档附件验证', api: 'openai-completions', baseUrl, apiKey: 'TEST_ONLY',
      models: [{ id: 'main', model: 'document-test', supportsVision: vision, thinkingLevel: 'off' }], makeDefault: true });
  }, { baseUrl, vision: cardsOnly });
  await page.reload(); await input.waitFor();
  await electron.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => !new URL(w.webContents.getURL()).searchParams.has('mode'));
    win.setContentSize(1440, 900); win.show();
  });
  const attach = async (filename, bytes) => {
    const filePath = path.join(userData, filename);
    fs.writeFileSync(filePath, bytes);
    // A genuine disk-backed File exercises preload's webUtils.getPathForFile.
    await page.evaluate(() => {
      const fileInput = document.createElement('input'); fileInput.type = 'file'; fileInput.id = 'document-test-file'; fileInput.hidden = true; document.body.append(fileInput);
    });
    await page.locator('#document-test-file').setInputFiles(filePath);
    await input.evaluate((textarea) => {
      const fileInput = document.getElementById('document-test-file');
      const dataTransfer = new DataTransfer(); dataTransfer.items.add(fileInput.files[0]);
      textarea.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }));
      fileInput.remove();
    });
    await wait(() => page.locator('.h24-attach-tray .h24-attach-open').evaluateAll(
      (buttons, name) => buttons.some((button) => button.getAttribute('aria-label')?.endsWith(name)), filename,
    ), `${filename} 草稿登记`);
  };
  const pick = async (filename, bytes) => {
    const filePath = filename ? path.join(userData, filename) : null;
    if (filePath) fs.writeFileSync(filePath, bytes);
    // Stub only the OS chooser; UI -> preload -> real composer IPC/store is exercised.
    await electron.evaluate(({ dialog }, filePath) => {
      dialog.showOpenDialog = async (_window, options) => {
        globalThis.__hemiPickerOptions = options;
        return { canceled: !filePath, filePaths: filePath ? [filePath] : [] };
      };
    }, filePath);
    await page.getByRole('button', { name: '添加附件', exact: true }).click();
    await page.getByRole('menuitem', { name: /选中文件/ }).click();
    await page.getByRole('button', { name: '添加附件', exact: true }).waitFor();
    const options = await electron.evaluate(() => globalThis.__hemiPickerOptions);
    assert.equal(options.title, '添加附件');
    for (const extension of ['png', 'pdf', 'docx', 'xlsx', 'pptx']) assert.ok(options.filters[0].extensions.includes(extension));
    if (filename) await wait(() => page.locator('.h24-attach-tray .h24-attach-open').evaluateAll(
      (buttons, name) => buttons.some((button) => button.getAttribute('aria-label')?.endsWith(name)), filename,
    ), `${filename} 选择后登记`);
    assert.equal(await page.evaluate(async () => (await window.hemiVoice.getContextState()).objects.length), 0);
  };
  const send = async (marker, expected) => {
    await input.fill(marker);
    await input.press('Enter');
    await wait(() => requests.some((request) => {
      const user = request.messages.findLast((message) => message.role === 'user');
      const content = JSON.stringify(user?.content ?? '');
      return content.includes(marker) && content.includes(expected);
    }), `${marker} 的文档文字到达 provider`);
    await wait(async () => await input.inputValue() === '' && await page.getByRole('button', { name: '停止当前任务', exact: true }).count() === 0, '回合结束');
  };
  const visual = async (format, expected) => {
    if (format === 'xlsx') {
      await wait(async () => (await page.locator('.h-doc-sheet').textContent())?.includes(expected), '工作表网格');
    } else {
      await page.locator('.h-doc-surface[data-ready="true"]').waitFor();
      if (format === 'pdf') assert.ok(await page.locator('.h-doc-surface canvas').evaluate((canvas) => canvas.width > 100 && canvas.height > 100));
      else await wait(async () => {
        try { return (await page.frameLocator('.h-doc-frame').locator('body').innerText({ timeout: 500 })).includes(expected); } catch { return false; }
      }, '原文文档内容');
    }
  };
  if (cardsOnly) {
    const { verifyAttachmentCards } = await import('./lib/verify-attachment-cards.mjs');
    await verifyAttachmentCards({ page, electron, attach, pick, send, evidence, check });
  } else {
  for (const [format, bytes, expected] of [
    ['pdf', pdfFixture(), 'HEMI_PDF'], ['docx', fs.readFileSync(new URL('./fixtures/documents/chinese.docx', import.meta.url)), '真实 Word 中文测试'],
    ['xlsx', xlsxFixture(), 'HEMI_XLSX'], ['pptx', fs.readFileSync(new URL('./fixtures/documents/chinese.pptx', import.meta.url)), '真实 PPT 中文测试'],
  ]) {
    await attach(`document.${format}`, bytes);
    await page.locator('.h24-attach-tray .h24-attach-open').click();
    await visual(format, expected);
    if (format === 'docx' || format === 'pptx') {
      await wait(() => page.frameLocator('.h-doc-frame').locator('img').evaluateAll((images) => images.length > 0 && images.every((image) => image.complete && image.naturalWidth > 0)), '文档内嵌图片');
      assert.equal(await page.locator('.h-doc-frame').getAttribute('sandbox'), 'allow-same-origin');
    }
    if (format === 'docx') {
      const link = page.frameLocator('.h-doc-frame').getByText('链接安全检查', { exact: true });
      await link.click();
      assert.equal(await page.evaluate(() => window.__HEMI_DOC_LINK_EXECUTED__), undefined);
      assert.equal(await page.frameLocator('.h-doc-frame').locator('a[href]').count(), 0);
      assert.equal(await page.locator('.h-doc-frame').evaluate((frame) => frame.contentWindow.hemiVoice), undefined);
      check('Word 原文中的脚本链接不可导航，预览 iframe 没有 preload API');
    }
    await page.screenshot({ path: path.join(evidence, `preview-${format}.png`) });
    if (format === 'pdf') {
      const initialWidth = await page.locator('.h-doc-surface canvas').evaluate((canvas) => canvas.width);
      await page.getByRole('button', { name: '放大文档', exact: true }).click();
      await wait(() => page.locator('.h-doc-surface canvas').evaluate((canvas) => canvas.width).then((width) => width > initialWidth), 'PDF 放大');
      await page.getByTitle('适应宽度', { exact: true }).click();
      await page.getByRole('button', { name: '下一页', exact: true }).click();
      await page.getByText('2 / 2', { exact: true }).waitFor();
      await visual(format, expected);
      await page.getByRole('button', { name: '上一页', exact: true }).click();
    }
    if (format === 'pptx') {
      await page.getByRole('button', { name: '下一页', exact: true }).click();
      await visual(format, '第二张：结论');
      await page.getByRole('button', { name: '上一页', exact: true }).click();
      await visual(format, expected);
    }
    if (format === 'xlsx') {
      await page.getByRole('tab', { name: '人员', exact: true }).click();
      assert.ok((await page.locator('.h-doc-sheet').innerText()).includes('张三'));
      await page.getByRole('tab', { name: '预算', exact: true }).click();
    }
    for (const width of [768, 375, 1440]) {
      await electron.evaluate(({ BrowserWindow }, width) => {
        const win = BrowserWindow.getAllWindows().find((w) => !new URL(w.webContents.getURL()).searchParams.has('mode'));
        win.setMinimumSize(300, 400); win.setContentSize(width, 900);
      }, width);
      await visual(format, expected);
      await page.waitForTimeout(200);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: path.join(evidence, `preview-${format}-${width}.png`) });
    }
    await page.getByRole('button', { name: '提取文字', exact: true }).click();
    await wait(async () => (await page.locator('.h24-preview-plain').textContent())?.includes(expected), '提取文字切换');
    await page.getByRole('button', { name: '收起预览，返回对话' }).click();
    await send(`VERIFY_${format.toUpperCase()}`, expected);
    assert.equal(await page.locator('.h24-attach-tray .h24-attach-card').count(), 0);
    await page.locator('.h24-msg-attachment', { hasText: `document.${format}` }).last().click();
    await visual(format, expected);
    if (format === 'docx') {
      await page.getByRole('button', { name: '重新读取当前文件', exact: true }).click();
      await page.locator('.h24-msg-attachment', { hasText: 'document.pdf' }).last().click();
      await visual('pdf', '');
      assert.equal(await page.locator('.h-doc-frame').count(), 0);
      await page.locator('.h24-msg-attachment', { hasText: 'document.docx' }).last().click();
      await visual('docx', expected);
      check('重读 Word 时立即切换 PDF，旧异步渲染不会覆盖当前文档');
      await page.getByRole('button', { name: '关闭 document.docx', exact: true }).click();
      const filePath = path.join(userData, 'document.docx');
      const original = fs.readFileSync(filePath);
      const parts = unzipSync(original);
      parts['word/document.xml'] = strToU8(strFromU8(parts['word/document.xml']).replace(expected, '重新读取后的 Word'));
      fs.writeFileSync(filePath, zipSync(parts));
      await page.locator('.h24-msg-attachment', { hasText: 'document.docx' }).last().click();
      await visual('docx', '重新读取后的 Word');
      fs.writeFileSync(filePath, original);
      check('关闭文档 Tab 后再次打开会重读原文件，不保留已关闭的二进制缓存');
    }
    await page.getByRole('button', { name: '收起预览，返回对话' }).click();
    check(`${format} 真实拖入、预览、发送内容、草稿清理、历史预览`);
  }
  await attach('chinese.pdf', fs.readFileSync(new URL('./fixtures/documents/chinese.pdf', import.meta.url)));
  await page.locator('.h24-attach-tray .h24-attach-open').click();
  await visual('pdf', '');
  await page.screenshot({ path: path.join(evidence, 'chinese-pdf-original.png') });
  await page.getByRole('button', { name: '收起预览，返回对话' }).click();
  await send('VERIFY_CHINESE_PDF', '真实 PDF 中文测试');
  check('中文 PDF 的本地 CMap 经真实 Electron worker 解析并发送');
  await input.fill('@document.xlsx');
  await page.locator('[data-group="attachment"] .h63-panel-item', { hasText: 'document.xlsx' }).click();
  await send('VERIFY_REFERENCE', 'HEMI_XLSX');
  check('@ 引用已发送 Excel 后，异步提取文字仍进入真实 provider 请求');

  await attach('scan.pdf', fs.readFileSync(new URL('./fixtures/documents/scan.pdf', import.meta.url)));
  await page.locator('.h24-attach-tray .h24-attach-open').click();
  await visual('pdf', '');
  await page.getByRole('button', { name: '提取文字', exact: true }).click();
  await page.getByText(/PDF 没有可提取的文字/).waitFor();
  await page.screenshot({ path: path.join(evidence, 'scan-only-error.png') });
  check('扫描件无文字时，预览明确提示 OCR 限制');
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(consoleErrors.filter((message) => !message.includes("Blocked script execution in 'about:srcdoc'")), []);
} finally {
  if (electron) await electron.close();
  await new Promise((resolve) => server.close(resolve));
  fs.writeFileSync(path.join(evidence, 'checks.json'), JSON.stringify({
    mode, rendererUrl, testedCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirtyFiles: execFileSync('git', ['status', '--short'], { encoding: 'utf8' }).trim().split('\n'),
    environment: { platform: process.platform, arch: process.arch, node: process.version }, checks, errors, consoleErrors,
    requestCount: requests.length,
  }, null, 2));
  fs.rmSync(userData, { recursive: true, force: true });
}
