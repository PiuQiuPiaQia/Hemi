import { createHash } from 'node:crypto';
import { resizeImage } from '@earendil-works/pi-coding-agent';

// token 压缩不限制 HTTP 字节数：视频帧可只计少量视觉 token，却携带数十 MiB Base64。
// 只投影本次请求，原图、工具执行事实和会话条目仍由原存储保留。
const POLICIES = {
  normal: { count: 8, bytes: 512 * 1024 },
  retry: { count: 4, bytes: 128 * 1024 },
};

export function isRequestMediaTooLarge({ status, message = '' }) {
  if (status != null && ![200, 400, 413, 422].includes(status)) return false;
  return status === 413 || /\b413\b|media_too_large|(?:request|payload|entity|image).{0,30}too (?:large|big)/i.test(message);
}

function omittedImage(message) {
  const ref = message.details?.hemiObservationRef;
  const source = ref ? `原始快照 ${ref}，需要时可用 context_read 重新读取` : '需要时请读取对应原图';
  return { type: 'text', text: `［历史图片已从本次请求省略，原始会话记录保留；${source}。本次没有重新看这张图。］` };
}

/** 每个会话独立且有界的压缩缓存；同一批历史帧不在每次工具调用后反复解码。 */
export function createRequestImageProjector() {
  const cache = new Map();
  return async function projectRequestImages(messages, { mode = 'normal', signal } = {}) {
    const policy = POLICIES[mode];
    if (!policy) throw new Error('未知图片请求策略');
    const images = messages.flatMap((message, index) => Array.isArray(message.content)
      ? message.content.flatMap((block, blockIndex) => block.type === 'image' ? [{ index, blockIndex, block }] : []) : []);
    const retained = new Set(images.slice(Math.max(0, images.length - policy.count)));
    const replacements = new Map();
    let resized = 0, bytesAfter = 0;
    for (const image of images) {
      signal?.throwIfAborted();
      const { block } = image;
      let content;
      if (!retained.has(image)) content = [omittedImage(messages[image.index])];
      else if (Buffer.byteLength(block.data, 'utf8') <= policy.bytes) {
        bytesAfter += Buffer.byteLength(block.data, 'utf8');
        continue;
      } else {
        const key = `${policy.bytes}:${block.mimeType}:${createHash('sha256').update(block.data).digest('hex')}`;
        let result = cache.get(key);
        if (!result) {
          result = await resizeImage(Buffer.from(block.data, 'base64'), block.mimeType,
            { maxWidth: 2000, maxHeight: 2000, maxBytes: policy.bytes });
          signal?.throwIfAborted();
          if (!result || Buffer.byteLength(result.data, 'utf8') > policy.bytes) throw new Error('图片无法压缩到模型请求预算；请先缩小图片后重试，原图已保留');
          cache.set(key, result);
          if (cache.size > 16) cache.delete(cache.keys().next().value);
        }
        resized++;
        bytesAfter += Buffer.byteLength(result.data, 'utf8');
        content = [
          { type: 'text', text: `［本次请求图片已压缩：原图 ${result.originalWidth}×${result.originalHeight}，当前 ${result.width}×${result.height}；像素坐标需按原图比例换算，原图保留。］` },
          { ...block, data: result.data, mimeType: result.mimeType },
        ];
      }
      if (!replacements.has(image.index)) replacements.set(image.index, new Map());
      replacements.get(image.index).set(image.blockIndex, content);
    }
    return {
      messages: replacements.size ? messages.map((message, index) => replacements.has(index)
        ? { ...message, content: message.content.flatMap((block, blockIndex) => replacements.get(index).get(blockIndex) ?? [block]) } : message) : messages,
      stats: { mode, imagesBefore: images.length, omitted: images.length - retained.size, resized,
        bytesBefore: images.reduce((sum, image) => sum + Buffer.byteLength(image.block.data, 'utf8'), 0), bytesAfter },
    };
  };
}
