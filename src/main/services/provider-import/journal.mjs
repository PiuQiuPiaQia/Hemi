// 047 导入事务 journal：userData/provider-import/<operationId>.json。
//
// 外层明文只有 schema/id/时间戳；payload（站点/账号/intent/令牌事实/Key/
// 验证结果/计划）经 safeStorage 加密。派发创建前先落 may-have-been-sent，
// 崩溃后按保守事实恢复，不允许错误重建。加密不可用时写失败——preflight
// 据此拒绝创建远端 Key。删除只发生在成功/明确撤销之后；cleanup-pending 保留。
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const JOURNAL_SCHEMA = 1;

const MAX_FILE_BYTES = 1024 * 1024;

/**
 * @param {{ dirPath: string, readFile?, writeFile?, rename?, mkdir?, readdir?, unlink?, safeStorage: {isEncryptionAvailable: () => boolean, encryptString: (s: string) => Buffer, decryptString: (b: Buffer) => string}, log?: {warn: Function} }} deps
 */
export function createImportJournal({
  dirPath,
  readFile: readFileImpl = readFile,
  writeFile: writeFileImpl = writeFile,
  rename: renameImpl = rename,
  mkdir: mkdirImpl = mkdir,
  readdir: readdirImpl = readdir,
  unlink: unlinkImpl = unlink,
  safeStorage,
  log = null,
}) {
  const canEncrypt = () => Boolean(safeStorage?.isEncryptionAvailable?.());

  function fileOf(operationId) {
    if (!/^[a-zA-Z0-9-]{4,64}$/.test(String(operationId))) throw new Error('journal 文件名不合法');
    return path.join(dirPath, `${operationId}.json`);
  }

  function encryptPayload(payload) {
    const json = JSON.stringify(payload ?? {});
    const cipher = safeStorage.encryptString(json).toString('base64');
    return cipher;
  }

  function decryptPayload(cipher) {
    const plain = safeStorage.decryptString(Buffer.from(String(cipher ?? ''), 'base64'));
    return JSON.parse(plain);
  }

  return {
    /** durable 落盘（临时文件＋rename）。加密不可用/写失败如实抛错。 */
    async persist(operationId, payload) {
      if (!canEncrypt()) {
        throw new Error('本机暂时无法加密导入记录（本机存储不可用）');
      }
      const file = fileOf(operationId);
      const outer = {
        schema: JOURNAL_SCHEMA,
        operationId,
        updatedAt: Date.now(),
        encrypted: encryptPayload(payload),
      };
      const temp = `${file}.tmp`;
      await mkdirImpl(path.dirname(file), { recursive: true });
      await writeFileImpl(temp, `${JSON.stringify(outer)}\n`, { encoding: 'utf8', mode: 0o600 });
      await renameImpl(temp, file);
    },

    /** 读单条：缺失 null；解密/完整性失败 { ok:false, code:'corrupt' }（文件保留）。 */
    async read(operationId) {
      let raw;
      try {
        raw = await readFileImpl(fileOf(operationId), 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }
      if (raw.length > MAX_FILE_BYTES) return { ok: false, code: 'corrupt' };
      try {
        const outer = JSON.parse(raw);
        if (outer?.schema !== JOURNAL_SCHEMA || outer.operationId !== operationId) {
          return { ok: false, code: 'corrupt' };
        }
        return { ok: true, payload: decryptPayload(outer.encrypted) };
      } catch (error) {
        log?.warn(`导入 journal 解密失败（${operationId}，${error?.message ?? error}），保留现场`);
        return { ok: false, code: 'corrupt' };
      }
    },

    /** 待处理列表（外层摘要；不含秘密）。损坏文件如实标出，不静默抹掉。 */
    async list() {
      let names;
      try {
        names = await readdirImpl(dirPath);
      } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
      }
      const out = [];
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const operationId = name.slice(0, -'.json'.length);
        const read = await this.read(operationId);
        if (!read) continue;
        if (!read.ok) {
          out.push({ operationId, readable: false, phase: 'unknown' });
          continue;
        }
        const p = read.payload ?? {};
        out.push({
          operationId,
          readable: true,
          phase: p.phase ?? 'unknown',
          siteOrigin: p.siteOrigin ?? null,
          accountLabel: p.accountLabel ?? null,
          tokenName: p.intent?.tokenName ?? null,
          tokenId: p.tokenId ?? null,
          apiKeyHeld: Boolean(p.apiKey),
          committed: p.committed === true,
          updatedAt: p.updatedAt ?? null,
        });
      }
      out.sort((a, b) => String(a.operationId).localeCompare(String(b.operationId)));
      return out;
    },

    async remove(operationId) {
      try {
        await unlinkImpl(fileOf(operationId));
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    },
  };
}
