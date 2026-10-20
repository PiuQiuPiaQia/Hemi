import { mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

/** 不可变快照独立于原文件存在性；每次读取仍复核对话、派发范围和当前来源策略。 */
export function createContextStore({ dir }) {
  const fileOf = ref => {
    if (!/^ctx-[a-f0-9]{64}$/.test(String(ref))) throw new Error('无效上下文引用');
    return path.join(dir, `${ref}.json`);
  };
  return {
    async put({ owner, content, source = null, kind = 'tool-output' }) {
      if (!owner?.conversationId) throw new Error('上下文缺少对话归属');
      const payload = { version: 1, owner, content, source, kind };
      const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      const ref = `ctx-${hash}`;
      await mkdir(dir, { recursive: true });
      const tmp = `${fileOf(ref)}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify({ ...payload, ref, hash }), { mode: 0o600 });
      await rename(tmp, fileOf(ref)); return ref;
    },
    async read({ ref, owner, allowedRefs = null, validateSource = null, imageInput = false, offset = 0, limit = 8000 }) {
      const record = JSON.parse(await readFile(fileOf(ref), 'utf8').catch(error => { throw new Error(`上下文不可用：${error.code ?? error.message}`); }));
      if (record.owner.conversationId !== owner?.conversationId) throw new Error('上下文不属于当前对话');
      if (allowedRefs && !allowedRefs.includes(ref)) throw new Error('该引用不在本次派发范围');
      const hash = createHash('sha256').update(JSON.stringify({ version: record.version, owner: record.owner, content: record.content, source: record.source, kind: record.kind })).digest('hex');
      if (hash !== record.hash || ref !== `ctx-${hash}` || record.ref !== ref) throw new Error('上下文快照损坏');
      if (record.source && !validateSource) throw new Error('上下文来源策略不可用，不能读取');
      const validation = validateSource ? await validateSource(record.source) : true;
      if (validation === false || (validation && typeof validation === 'object' && validation.allowed !== true)) throw new Error('上下文来源权限已失效，不能读取');
      const sourceStatus = validation && typeof validation === 'object' ? validation : null;
      if (record.content.some(block => block.type === 'image') && !imageInput) throw new Error('unsupported-modality：当前模型不支持图像输入');
      const text = record.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      const start = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
      const count = Math.min(32000, Math.max(1, Number.isSafeInteger(limit) ? limit : 8000));
      const next = start + count < text.length ? start + count : null;
      return { ref, version: record.hash, sourceStatus, kind: record.kind, totalChars: text.length, offset: start, nextOffset: next,
        content: [{ type: 'text', text: JSON.stringify({ ref, version: record.hash, sourceStatus, offset: start, nextOffset: next, totalChars: text.length }) + '\n' + text.slice(start, start + count) }, ...record.content.filter(block => block.type === 'image')] };
    },
  };
}

export function projectToolText(content, ref, maxChars = 8000) {
  const text = content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  if (text.length <= maxChars) return content;
  const half = Math.floor(maxChars / 2);
  return [{ type: 'text', text: `${text.slice(0, half)}\n\n［省略 ${text.length - half * 2} 字；原始快照 ${ref}，可用 context_read 分段读取；未读部分尚未核对］\n\n${text.slice(-half)}` }, ...content.filter(block => block.type === 'image')];
}
