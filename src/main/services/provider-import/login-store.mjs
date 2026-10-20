// 047：每站点一个加密登录档案。密码与会话 Cookie 均不进入导入 journal/DTO/日志。
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function loginSiteKey(origin) {
  const url = new URL(origin);
  if (!['https:', 'http:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) {
    throw new Error('登录站点归属不合法');
  }
  return createHash('sha256').update(origin).digest('hex');
}

export function createLoginStore({ dirPath, safeStorage, fs = {} }) {
  const io = { mkdir, readFile, rename, unlink, writeFile, ...fs };
  let writes = Promise.resolve();
  const available = () => Boolean(safeStorage?.isEncryptionAvailable?.())
    && safeStorage?.getSelectedStorageBackend?.() !== 'basic_text';
  const fileOf = (origin) => path.join(dirPath, `${loginSiteKey(origin)}.json`);

  async function read(origin) {
    const file = fileOf(origin);
    if (!available()) throw new Error('LOGIN_ENCRYPTION_UNAVAILABLE');
    let raw;
    try { raw = await io.readFile(file, 'utf8'); }
    catch (error) { if (error?.code === 'ENOENT') return { origin }; throw error; }
    if (raw.length > 1024 * 1024) throw new Error('LOGIN_STORE_CORRUPT');
    const outer = JSON.parse(raw);
    if (outer.schema !== 1 || typeof outer.encrypted !== 'string') throw new Error('LOGIN_STORE_CORRUPT');
    const payload = JSON.parse(safeStorage.decryptString(Buffer.from(outer.encrypted, 'base64')));
    if (payload.origin !== origin) throw new Error('LOGIN_ORIGIN_MISMATCH');
    return payload;
  }

  return {
    available,
    async read(origin) { await writes; return read(origin); },
    update(origin, patch) {
      const result = writes.then(async () => {
        const payload = { ...await read(origin), ...patch, origin };
        const encrypted = safeStorage.encryptString(JSON.stringify(payload)).toString('base64');
        const file = fileOf(origin);
        const temp = `${file}.${randomUUID()}.tmp`;
        await io.mkdir(dirPath, { recursive: true, mode: 0o700 });
        try {
          await io.writeFile(temp, JSON.stringify({ schema: 1, encrypted }) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
          await io.rename(temp, file);
        } finally {
          await io.unlink(temp).catch(() => undefined);
        }
      });
      writes = result.catch(() => undefined);
      return result;
    },
    async flush() { await writes; },
  };
}
