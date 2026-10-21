import path from 'node:path';
import { readFileSync } from 'node:fs';
import { parentPort } from 'node:worker_threads';
import { DOMParser } from '@xmldom/xmldom';
import { unzipSync, strFromU8 } from 'fflate';
import { DOCUMENT_TEXT_LIMIT } from './documents.mjs';

const XML_BYTE_LIMIT = 8 * 1024 * 1024;
const TOTAL_XML_BYTE_LIMIT = 32 * 1024 * 1024;
const WORD_NS = /\/wordprocessingml\//;
const DRAWING_NS = /\/drawingml\//;
const REL_NS = /\/relationships$/;
const elements = (node, name) => Array.from(node.getElementsByTagNameNS('*', name));
const local = (node, name) => node.nodeType === 1 && node.localName === name;

function parseXml(bytes) {
  const source = strFromU8(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('文档包含不支持的 XML 声明');
  return new DOMParser({ onError: (_level, message) => {
    throw new Error(`文档 XML 损坏：${message}`);
  } }).parseFromString(source, 'application/xml');
}

function officeArchive(bytes) {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('文档格式不正确或已加密，请另存为未加密的 Office 文件');
  let total = 0;
  let expanded = 0;
  let entries = 0;
  const files = unzipSync(bytes, { filter: ({ name, originalSize }) => {
    expanded += originalSize;
    entries += 1;
    if (entries > 4000 || expanded > 128 * 1024 * 1024 || originalSize > 32 * 1024 * 1024) throw new Error('文档解压内容过大，请拆分文件后重试');
    if (!/^(word|xl|ppt)\/.*\.(xml|rels)$/.test(name)) return false;
    total += originalSize;
    if (originalSize > XML_BYTE_LIMIT || total > TOTAL_XML_BYTE_LIMIT) throw new Error('文档解压内容过大，请拆分文件后重试');
    return true;
  } });
  return (name, optional = false) => {
    if (!files[name]) {
      if (optional) return null;
      throw new Error('文档缺少必要内容，文件可能已损坏');
    }
    return parseXml(files[name]);
  };
}

function relationshipId(node) {
  return Array.from(node.attributes).find((attr) => attr.localName === 'id' && REL_NS.test(attr.namespaceURI ?? ''))?.value;
}

function relationships(xml, base) {
  return new Map(elements(xml, 'Relationship').filter((rel) => rel.getAttribute('TargetMode') !== 'External').map((rel) => {
    const target = rel.getAttribute('Target');
    const resolved = target.startsWith('/') ? target.slice(1) : path.posix.normalize(path.posix.join(base, target));
    if (!resolved.startsWith(`${base}/`) || resolved.includes('..')) throw new Error('文档内部引用无效');
    return [rel.getAttribute('Id'), resolved];
  }));
}

// Text only: hyperlinks keep their displayed text, and no external target is read.
function paragraphText(paragraph, namespace) {
  const parts = [];
  function visit(node) {
    if (node.nodeType !== 1) return;
    if (namespace.test(node.namespaceURI ?? '')) {
      if (local(node, 't')) { parts.push(node.textContent); return; }
      if (local(node, 'tab')) parts.push('\t');
      if (local(node, 'br') || local(node, 'cr')) parts.push('\n');
      if (local(node, 'del')) return;
    }
    for (const child of Array.from(node.childNodes)) visit(child);
  }
  visit(paragraph);
  return parts.join('');
}

function paragraphs(xml, namespace) {
  return elements(xml, 'p').filter((p) => namespace.test(p.namespaceURI ?? ''))
    .map((p) => paragraphText(p, namespace)).filter((text) => text.trim()).join('\n');
}

function wordText(xml) {
  const document = xml('word/document.xml');
  const body = elements(document, 'body')[0];
  if (!body) throw new Error('Word 文档缺少正文');
  const blocks = [];
  function visit(node) {
    if (local(node, 'p') && WORD_NS.test(node.namespaceURI ?? '')) {
      blocks.push(paragraphText(node, WORD_NS));
      return;
    }
    if (local(node, 'tbl') && WORD_NS.test(node.namespaceURI ?? '')) {
      const rows = Array.from(node.childNodes).filter((child) => local(child, 'tr'));
      for (const row of rows) {
        blocks.push(Array.from(row.childNodes).filter((child) => local(child, 'tc')).map((cell) => paragraphs(cell, WORD_NS).replaceAll('\n', ' / ')).join('\t'));
      }
      return;
    }
    for (const child of Array.from(node.childNodes ?? [])) visit(child);
  }
  visit(body);
  return blocks.filter((text) => text.trim()).join('\n');
}

function spreadsheetValue(value, format, date1904) {
  const number = Number(value);
  if (!value || !Number.isFinite(number) || !format) return value;
  if (/\[[hms]+\]/i.test(format)) return `${value}（Excel 时长，单位：天）`;
  const clean = format.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
  if (/[ymdhs]/i.test(clean)) {
    const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, number < 60 ? 31 : 30);
    const date = new Date(epoch + Math.round(number * 86400_000));
    if (!Number.isFinite(date.getTime())) return value;
    const timeOnly = !/[yd]/i.test(clean) && /[hs]/i.test(clean);
    const iso = date.toISOString();
    return timeOnly ? iso.slice(11, 19) : /[hs]/i.test(clean) ? iso.slice(0, 19).replace('T', ' ') : iso.slice(0, 10);
  }
  return clean.includes('%') ? `${Number((number * 100).toFixed(10))}%` : value;
}

function spreadsheetText(xml) {
  const workbook = xml('xl/workbook.xml');
  const rels = relationships(xml('xl/_rels/workbook.xml.rels'), 'xl');
  const styles = xml('xl/styles.xml', true);
  const builtinFormats = new Map([[9, '0%'], [10, '0.00%'], [14, 'yyyy-mm-dd'], [15, 'd-mmm-yy'], [16, 'd-mmm'], [17, 'mmm-yy'], [18, 'h:mm AM/PM'], [19, 'h:mm:ss AM/PM'], [20, 'h:mm'], [21, 'h:mm:ss'], [22, 'yyyy-mm-dd h:mm'], [45, 'mm:ss'], [46, '[h]:mm:ss'], [47, 'mm:ss']]);
  for (const id of [27, 28, 29, 30, 31, 36, 50, 51, 52, 53, 54, 57, 58]) builtinFormats.set(id, 'yyyy-mm-dd');
  for (const id of [32, 33, 34, 35, 55, 56]) builtinFormats.set(id, 'h:mm:ss');
  const formats = new Map([...builtinFormats, ...(styles ? elements(styles, 'numFmt').map((node) => [Number(node.getAttribute('numFmtId')), node.getAttribute('formatCode')]) : [])]);
  const cellFormats = styles ? elements(styles, 'cellXfs').flatMap((node) => elements(node, 'xf').map((xf) => formats.get(Number(xf.getAttribute('numFmtId'))))) : [];
  const date1904 = ['1', 'true'].includes(elements(workbook, 'workbookPr')[0]?.getAttribute('date1904'));
  const shared = xml('xl/sharedStrings.xml', true);
  const strings = shared ? elements(shared, 'si').map((si) => elements(si, 't').map((t) => t.textContent).join('')) : [];
  const sheets = [];
  let previewTextLength = 0;
  const text = elements(workbook, 'sheet').map((sheet) => {
    const target = rels.get(relationshipId(sheet));
    if (!target) throw new Error('工作表引用缺失，文件可能已损坏');
    const previewRows = [];
    let previewTruncated = false;
    const rows = elements(xml(target), 'row').map((row) => {
      const previewCells = [];
      const cells = elements(row, 'c').map((cell) => {
        const type = cell.getAttribute('t');
        const value = elements(cell, 'v')[0]?.textContent ?? '';
        const formula = elements(cell, 'f')[0]?.textContent;
        let text = type === 's' ? strings[Number(value)] ?? ''
          : type === 'inlineStr' ? elements(cell, 't').map((t) => t.textContent).join('')
            : type === 'b' ? value === '1' ? 'TRUE' : 'FALSE'
              : !type || type === 'n' ? spreadsheetValue(value, cellFormats[Number(cell.getAttribute('s') || 0)], date1904) : value;
        const displayValue = text || (formula ? `=${formula}` : '');
        if (formula) text = text ? `${text}（公式：=${formula}；缓存值）` : `=${formula}（无缓存值）`;
        if (text && previewCells.length < 64 && previewTextLength < DOCUMENT_TEXT_LIMIT) {
          previewCells.push({ address: cell.getAttribute('r') || '', value: displayValue.slice(0, 2000) + (displayValue.length > 2000 ? '…' : ''), ...(formula ? { formula } : {}) });
          previewTextLength += Math.min(displayValue.length, 2000);
        } else if (text) previewTruncated = true;
        return text ? `${cell.getAttribute('r') || '?'}: ${text}` : '';
      }).filter(Boolean);
      if (previewRows.length < 500 && previewCells.length) previewRows.push(previewCells);
      return cells.join('\t');
    }).filter(Boolean);
    if (sheets.length < 50 && sheet.getAttribute('state') !== 'hidden' && sheet.getAttribute('state') !== 'veryHidden') {
      sheets.push({ name: sheet.getAttribute('name'), rows: previewRows, truncated: rows.length > 500 || previewTruncated });
    }
    return rows.length ? `［工作表：${sheet.getAttribute('name')}］\n${rows.join('\n')}` : '';
  }).filter(Boolean).join('\n\n');
  return { text, sheets };
}

function presentationText(xml) {
  const presentation = xml('ppt/presentation.xml');
  const rels = relationships(xml('ppt/_rels/presentation.xml.rels'), 'ppt');
  return elements(presentation, 'sldId').map((slide, index) => {
    const target = rels.get(relationshipId(slide));
    if (!target) throw new Error('幻灯片引用缺失，文件可能已损坏');
    const text = paragraphs(xml(target), DRAWING_NS);
    return text ? `［第 ${index + 1} 张幻灯片］\n${text}` : '';
  }).filter(Boolean).join('\n\n');
}

async function pdfText(bytes) {
  const { getDocumentProxy } = await import('unpdf');
  // PDF.js needs Adobe CMaps for many Chinese/Japanese/Korean PDFs. Serve the
  // pinned byte tables locally rather than relying on a CDN or canvas addon.
  let cmaps;
  class LocalPdfDataReader {
    async fetch({ kind, filename }) {
      if (kind !== 'cMapUrl') throw new Error('PDF 文字提取不加载字体或图像解码器');
      cmaps ??= unzipSync(readFileSync(new URL('../../../third-party/pdfjs/cmaps.zip', import.meta.url)));
      const cMapData = cmaps[filename];
      if (!cMapData) throw new Error('PDF 使用了不支持的字符映射');
      return cMapData;
    }
  }
  const pdf = await getDocumentProxy(bytes, {
    isEvalSupported: false, useSystemFonts: true, disableFontFace: true,
    BinaryDataFactory: LocalPdfDataReader, useWorkerFetch: false, useWasm: false,
  });
  try {
    const pages = [];
    let length = 0;
    let hasText = false;
    for (let index = 1; index <= pdf.numPages; index += 1) {
      const page = await pdf.getPage(index);
      const { items } = await page.getTextContent();
      let text = '';
      for (const item of items) {
        if (typeof item.str !== 'string') continue;
        text += item.str + (item.hasEOL ? '\n' : ' ');
      }
      if (text.trim()) hasText = true;
      pages.push(`［第 ${index} 页］\n${text.trim() || '（本页没有可提取的文字，可能包含图片）'}`);
      length += text.length;
      page.cleanup();
      if (length > DOCUMENT_TEXT_LIMIT) break;
    }
    if (!hasText) throw new Error('PDF 没有可提取的文字，可能是扫描件；当前暂不支持文档 OCR，请上传截图或带文字层的 PDF');
    if (pages.length < pdf.numPages) pages.push('（文档过长，仅提取前段页面）');
    return pages.join('\n\n');
  } finally {
    await pdf.loadingTask.destroy();
  }
}

parentPort.once('message', async ({ bytes, format, allowEmpty }) => {
  try {
    const parsed = format === 'pdf' ? await pdfText(bytes)
      : { docx: wordText, xlsx: spreadsheetText, pptx: presentationText }[format](officeArchive(bytes));
    const text = typeof parsed === 'string' ? parsed : parsed.text;
    if (!text.trim() && !allowEmpty) throw new Error('文档没有可提取的文字；当前仅提取文字与表格单元格，不识别内嵌图片');
    const truncated = text.length > DOCUMENT_TEXT_LIMIT;
    parentPort.postMessage({ text: text.slice(0, DOCUMENT_TEXT_LIMIT) + (truncated ? '\n（文档过长，仅提取前段内容）' : ''), truncated,
      ...(typeof parsed === 'object' ? { sheets: parsed.sheets } : {}),
    });
  } catch (error) {
    parentPort.postMessage({ error: {
      code: error.name === 'PasswordException' ? 'document-encrypted' : 'document-unreadable',
      message: error.name === 'PasswordException' ? '文档已加密，请移除密码后重新添加' : `无法读取文档：${error.message}`,
    } });
  }
});
