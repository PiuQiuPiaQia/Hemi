import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

export const VIDEO_MIME = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' };

/** URL 只带随机令牌，不接受路径；每次范围请求都重新经过原交付的受控解析。 */
export function createMediaPreviewRegistry() {
  const sources = new Map();
  return {
    register(resolve) {
      const token = randomUUID();
      sources.set(token, resolve);
      if (sources.size > 128) sources.delete(sources.keys().next().value);
      return `hemi-media://preview/${token}`;
    },
    async respond(request) {
      try {
        const url = new URL(request.url);
        const resolve = url.protocol === 'hemi-media:' && url.host === 'preview' ? sources.get(url.pathname.slice(1)) : null;
        if (!resolve) return new Response('预览已失效，请重新读取', { status: 404 });
        if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
        const source = await resolve();
        if (!source?.path || !source.mime) return new Response('文件不可读', { status: 404 });
        const info = await stat(source.path);
        if (!info.isFile()) return new Response('文件不存在', { status: 404 });
        const headers = { 'Content-Type': source.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
        let start = 0, end = info.size - 1, status = 200;
        const range = request.headers.get('range');
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${info.size}` } });
          start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]));
          end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= info.size) {
            return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${info.size}` } });
          }
          status = 206;
          headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
        }
        headers['Content-Length'] = String(Math.max(0, end - start + 1));
        if (request.method === 'HEAD' || !info.size) return new Response(null, { status, headers });
        const stream = createReadStream(source.path, { start, end });
        if (request.signal) {
          const abort = () => stream.destroy();
          request.signal.addEventListener('abort', abort, { once: true });
          stream.once('close', () => request.signal.removeEventListener('abort', abort));
          if (request.signal.aborted) abort();
        }
        return new Response(Readable.toWeb(stream), { status, headers });
      } catch {
        return new Response('视频读取失败，请重新读取', { status: 404 });
      }
    },
  };
}

export const conversationMedia = createMediaPreviewRegistry();
