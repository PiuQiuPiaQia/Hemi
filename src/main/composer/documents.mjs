// Local text extraction for document attachments. The worker keeps ZIP/XML/PDF
// parsing off Electron's main thread and can be terminated even on malformed input.
import { open } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

export const DOCUMENT_FILE_BYTE_LIMIT = 20 * 1024 * 1024;
export const DOCUMENT_TEXT_LIMIT = 512 * 1024;
export const DOCUMENT_PARSE_TIMEOUT_MS = 20_000;
const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.docx', '.xlsx', '.pptx']);

export function isDocumentFile(filename) {
  return DOCUMENT_EXTENSIONS.has(path.extname(String(filename ?? '')).toLowerCase());
}

export async function readDocumentBytes(filePath) {
  const format = path.extname(filePath).slice(1).toLowerCase();
  if (!DOCUMENT_EXTENSIONS.has(`.${format}`)) throw new Error('不支持的文档格式');
  const file = await open(filePath, 'r');
  let bytes;
  try {
    const stats = await file.stat();
    if (!stats.isFile()) throw new Error('文档来源不是普通文件');
    if (stats.size > DOCUMENT_FILE_BYTE_LIMIT) throw new Error('文档附件支持 20MB 内');
    // Bounded reread: changing a registered file cannot bypass the byte budget.
    bytes = Buffer.alloc(Math.min(stats.size + 1, DOCUMENT_FILE_BYTE_LIMIT + 1));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > stats.size) throw new Error('文档在读取时发生变化，请重新添加附件');
    bytes = new Uint8Array(bytes.subarray(0, offset));
  } finally {
    await file.close();
  }
  return { bytes, format };
}

export async function readDocumentText(filePath) {
  const { bytes, format } = await readDocumentBytes(filePath);
  return parseDocumentBytes(bytes, format);
}

export function parseDocumentBytes(bytes, format, { allowEmpty = false } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./document-worker.mjs', import.meta.url), {
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('文档解析超时，请拆分文件后重试')), DOCUMENT_PARSE_TIMEOUT_MS);
    worker.once('message', (result) => {
      if (result.error) {
        const error = new Error(result.error.message);
        error.code = result.error.code;
        finish(error);
      } else finish(null, result);
    });
    worker.once('error', () => finish(new Error('文档解析失败，文件可能过大或已损坏')));
    worker.once('exit', (code) => {
      if (code !== 0) finish(new Error('文档解析中断，请拆分文件后重试'));
    });
    worker.postMessage({ bytes, format, allowEmpty }, [bytes.buffer]);
  });
}
