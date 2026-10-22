import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hasSupportedSecret } from '../lib/local-secrets.mjs';

/** App-owned CredentialStore. Tokens never enter Pi's plaintext auth.json. */
export function createOAuthCredentials({ filePath, safeStorage }) {
  let document;
  let chain = Promise.resolve();
  const queue = operation => {
    const result = chain.then(operation, operation);
    chain = result.catch(() => {});
    return result;
  };
  const secure = () => {
    if (!safeStorage?.isEncryptionAvailable()) throw new Error('本机存储不可用，暂时无法保存账号登录。');
  };
  async function load() {
    if (document) return document;
    try {
      const raw = JSON.parse(await readFile(filePath, 'utf8'));
      if (raw.version !== 1 || typeof raw.deviceId !== 'string' || !raw.entries || typeof raw.entries !== 'object' || Array.isArray(raw.entries)) throw new Error('invalid');
      document = { ...raw, entries: Object.fromEntries(Object.entries(raw.entries).filter(entry => hasSupportedSecret(safeStorage, entry[1]))) };
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('账号凭据文件无法读取，请恢复文件后重试。');
      document = { version: 1, deviceId: randomUUID(), entries: {} };
    }
    return document;
  }
  async function persist(next) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(`${filePath}.tmp`, `${JSON.stringify(next)}\n`, { mode: 0o600 });
    await rename(`${filePath}.tmp`, filePath);
    document = next;
  }
  function decrypt(raw) {
    if (!raw) return undefined;
    secure();
    try {
      const value = JSON.parse(safeStorage.decryptString(Buffer.from(raw, 'base64')));
      if (value.type !== 'oauth' || typeof value.access !== 'string' || !value.access || typeof value.refresh !== 'string' || !value.refresh || !Number.isFinite(value.expires)) throw new Error('invalid');
      return value;
    } catch { throw new Error('账号凭据无法解密，请重新登录。'); }
  }
  return {
    async deviceId() {
      return queue(async () => { secure(); const current = await load(); await persist(current); return current.deviceId; });
    },
    read(providerId, options) {
      return queue(async () => { options?.signal?.throwIfAborted(); return decrypt((await load()).entries[providerId]); });
    },
    list(options) {
      return queue(async () => { options?.signal?.throwIfAborted(); return Object.keys((await load()).entries).map(providerId => ({ providerId, type: 'oauth' })); });
    },
    modify(providerId, fn, options) {
      return queue(async () => {
        options?.signal?.throwIfAborted();
        secure();
        const current = await load();
        // Re-login may replace an unreadable credential. Refresh first calls read(),
        // and therefore cannot silently refresh a credential that failed decryption.
        let previous;
        try { previous = decrypt(current.entries[providerId]); } catch { /* replacement login */ }
        let next = await fn(previous);
        options?.signal?.throwIfAborted();
        if (!next) return previous;
        if (next.type !== 'oauth' || typeof next.access !== 'string' || !next.access || typeof next.refresh !== 'string' || !next.refresh || !Number.isFinite(next.expires)) throw new Error('服务商没有返回有效的账号凭据');
        // ChatGPT's token refresh returns only auth fields; its account catalog
        // belongs to the same issued client until an explicit reconnect refreshes it.
        if (previous?.clientId && next.clientId === previous.clientId && previous.availableModelIds && !next.availableModelIds) next = { ...next, availableModelIds: previous.availableModelIds };
        const encrypted = safeStorage.encryptString(JSON.stringify(next)).toString('base64');
        await persist({ ...current, entries: { ...current.entries, [providerId]: encrypted } });
        return structuredClone(next);
      });
    },
    delete(providerId, options) {
      return queue(async () => {
        options?.signal?.throwIfAborted();
        const current = await load();
        const entries = { ...current.entries };
        delete entries[providerId];
        await persist({ ...current, entries });
      });
    },
  };
}
