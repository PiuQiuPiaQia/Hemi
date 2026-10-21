import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { unzipSync } from 'fflate';
import { pdfFixture, docxFixture, xlsxFixture, pptxFixture } from './document-fixtures.mjs';

export async function verifyAttachmentCards({ page, electron, attach, pick, send, evidence, check }) {
  const tray = page.locator('.h-attachment-tray');
  const card = (name) => tray.locator('.h-attachment-card').filter({ has: page.getByRole('button', { name: `预览文件附件 ${name}`, exact: true }) });
  const remove = async (name) => {
    await tray.getByRole('button', { name: `移除附件 ${name}`, exact: true }).focus();
    // Hemi's native input policy only activates buttons in keyboard navigation mode.
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.activeElement?.classList.contains('h24-attach-remove') && getComputedStyle(document.activeElement).opacity === '1');
    assert.equal(await tray.getByRole('button', { name: `移除附件 ${name}`, exact: true }).evaluate((node) => getComputedStyle(node).opacity), '1');
    await page.keyboard.press('Enter');
    await tray.getByRole('button', { name: `移除附件 ${name}`, exact: true }).waitFor({ state: 'detached' });
  };
  await page.locator('textarea.text-composer-input').fill('取消选择后保留草稿');
  await pick(null);
  assert.equal(await page.locator('textarea.text-composer-input').inputValue(), '取消选择后保留草稿');
  assert.equal(await tray.count(), 0);
  await page.locator('textarea.text-composer-input').fill('');
  check('＋ 文件选择取消保留草稿；过滤器覆盖图片与现代 Office；不创建工作对象');
  // Image fallback uses the same colored file pictogram as the supplied reference.
  await attach('缩略图不可用.png', Buffer.from('unavailable thumbnail fixture'));
  const imageCard = tray.locator('[data-kind="image"]');
  assert.equal((await imageCard.boundingBox()).width, 48);
  assert.equal(await imageCard.locator('.h-attachment-info').count(), 0);
  await pick('阿里云合同.pdf', pdfFixture());
  const pdfCard = card('阿里云合同.pdf');
  assert.equal((await pdfCard.boundingBox()).height, 48);
  assert.equal(await pdfCard.locator('.h24-attach-meta').innerText(), 'PDF');
  assert.equal(await pdfCard.locator('.h24-attach-remove').evaluate((node) => getComputedStyle(node).opacity), '0');
  await page.mouse.move(0, 0);
  await pdfCard.screenshot({ path: path.join(evidence, 'pdf-card.png'), animations: 'disabled' });
  await tray.screenshot({ path: path.join(evidence, 'reference-row.png'), animations: 'disabled' });
  await pdfCard.hover();
  assert.equal(await pdfCard.locator('.h24-attach-remove').evaluate((node) => getComputedStyle(node).opacity), '1');
  await page.waitForTimeout(100);
  await pdfCard.locator('.h24-attach-remove').focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(100);
  fs.writeFileSync(path.join(evidence, 'card-geometry.json'), JSON.stringify(await pdfCard.evaluate((node) => {
    const box = (element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { x, y, width, height, opacity: style.opacity, color: style.color, background: style.backgroundColor, font: style.font, display: style.display, visibility: style.visibility };
    };
    return { card: box(node), remove: box(node.querySelector('.h24-attach-remove')), name: box(node.querySelector('.h24-attach-name')) };
  }), null, 2));
  await pdfCard.screenshot({ path: path.join(evidence, 'pdf-card-hover.png'), animations: 'disabled' });
  check('截图同款 PDF 双行卡片和图片回退方块；48px 高，移除按钮随悬停和焦点显示');
  await remove('缩略图不可用.png');

  // Native thumbnail remains a genuine image, rather than a document glyph.
  const wordParts = unzipSync(fs.readFileSync(new URL('../fixtures/documents/chinese.docx', import.meta.url)));
  const imageBytes = Object.entries(wordParts).find(([name]) => /^word\/media\/.+\.png$/.test(name))?.[1];
  assert.ok(imageBytes, 'Word fixture has an embedded PNG');
  await attach('原图.png', imageBytes);
  const thumb = tray.locator('.h24-attach-thumb');
  await thumb.waitFor();
  assert.ok(await thumb.evaluate((node) => node.complete && node.naturalWidth > 0));
  assert.equal((await tray.locator('[data-kind="image"]').boundingBox()).height, 48);
  await remove('原图.png');
  check('实际图片保留缩略图，键盘可移除，移除不触发预览');

  await pick('这是一份需要保留完整文件名但在卡片中省略显示的年度总结报告.docx', docxFixture());
  await attach('预算表.xlsx', xlsxFixture());
  assert.equal(await tray.locator('.h24-attach-meta').allTextContents().then((labels) => labels.join(',')), 'PDF,DOCX,XLSX');
  for (const width of [1440, 768, 375]) {
    await electron.evaluate(({ BrowserWindow }, width) => {
      const win = BrowserWindow.getAllWindows().find((w) => !new URL(w.webContents.getURL()).searchParams.has('mode'));
      win.setMinimumSize(300, 400); win.setContentSize(width, 900);
    }, width);
    await page.waitForTimeout(150);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.ok(await tray.evaluate((node) => [...node.querySelectorAll('.h-attachment-card')].every((card) => {
      const r = card.getBoundingClientRect(), t = node.getBoundingClientRect();
      return r.width <= t.width && r.right <= t.right + 1;
    })));
    const boxes = await tray.locator('.h-attachment-card').evaluateAll((nodes) => nodes.map((node) => ({
      x: node.getBoundingClientRect().x, y: node.getBoundingClientRect().y, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height,
    })));
    if (width === 1440) assert.equal(boxes[0].y, boxes[1].y);
    if (width === 375) assert.ok(boxes[1].y > boxes[0].y);
    await page.mouse.move(0, 0);
    await tray.screenshot({ path: path.join(evidence, `draft-cards-${width}.png`) });
    await page.screenshot({ path: path.join(evidence, `draft-page-${width}.png`) });
  }
  check('1440／768／375：卡片按空间换行，长文件名省略，页面无横向溢出');
  await send('VERIFY_ATTACHMENT_CARDS', 'HEMI_PDF');
  assert.equal(await tray.count(), 0);
  const sent = page.locator('.h24-msg-attachment').filter({ hasText: '阿里云合同.pdf' }).last();
  assert.ok(Math.abs((await sent.locator('..').boundingBox()).height - 48) < 0.01);
  assert.equal(await sent.locator('.h24-attach-meta').innerText(), 'PDF');
  const message = sent.locator('xpath=ancestor::article');
  const rowBox = await message.locator('.h-attachment-sent-tray').boundingBox();
  const bubbleBox = await message.locator('.h24-user-bubble').boundingBox();
  assert.ok(rowBox.y + rowBox.height <= bubbleBox.y);
  assert.equal(await message.locator('.h24-attach-remove').count(), 0);
  assert.ok(await sent.locator('.h-attachment-file-icon').evaluate((node) => node.complete && node.naturalWidth > 0));
  await page.locator('.h24-msg-attachments', { has: sent }).screenshot({ path: path.join(evidence, 'sent-files.png') });
  await sent.click();
  await page.locator('.h-doc-surface[data-ready="true"]').waitFor();
  await page.getByRole('button', { name: '收起预览，返回对话' }).click();
  check('发送后复用双行缩略卡片，独立位于气泡上方，点击仍打开真实 PDF 原文');
  await pick('项目介绍.pptx', pptxFixture());
  assert.equal(await card('项目介绍.pptx').locator('.h24-attach-meta').innerText(), 'PPTX');
  assert.ok(await tray.locator('.h-attachment-file-icon').evaluateAll((nodes) => nodes.every((node) => node.complete && node.naturalWidth > 0)));
  await remove('项目介绍.pptx');
  check('PPTX 文件类型、图标与移除入口正确');
  await pick('原图.png', imageBytes);
  await pick('仅附件.pdf', pdfFixture(['HEMI_PDF_ONLY']));
  await tray.screenshot({ path: path.join(evidence, 'picked-photo-and-pdf.png') });
  await send('', 'HEMI_PDF_ONLY');
  const only = page.getByRole('button', { name: '预览文件附件 仅附件.pdf', exact: true }).locator('xpath=ancestor::article');
  assert.equal(await only.locator('.h24-user-bubble').count(), 0);
  assert.equal(await only.locator('.h24-attach-card[data-kind="image"] .h24-attach-thumb').count(), 1);
  assert.equal(await only.locator('.h24-attach-card').count(), 2);
  for (const element of await only.locator('.h24-attach-card').all()) assert.ok(Math.abs((await element.boundingBox()).height - 48) < 0.01);
  for (const width of [375, 768, 1440]) {
    await electron.evaluate(({ BrowserWindow }, width) => {
      const win = BrowserWindow.getAllWindows().find((w) => !new URL(w.webContents.getURL()).searchParams.has('mode'));
      win.setContentSize(width, 900);
    }, width);
    await page.waitForTimeout(150);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await only.screenshot({ path: path.join(evidence, `sent-photo-and-pdf-${width}.png`) });
    await page.screenshot({ path: path.join(evidence, `sent-photo-and-pdf-page-${width}.png`) });
  }
  check('照片与 PDF 从＋添加后并排展示；纯附件发送不产生空白气泡');
}
