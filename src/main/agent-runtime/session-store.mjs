import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function createSessionStore({ dir }) {
  const pointer = ref => {
    if (!/^(session|main)-[A-Za-z0-9_-]{1,100}$/.test(ref)) throw new Error('会话引用无效');
    return path.join(dir, `${ref}.json`);
  };
  return {
    async save(ref, record) {
      const content = { version: 2, ...record }, revision = hash(content);
      await mkdir(dir, { recursive: true });
      const versionPath = path.join(dir, `entries-${revision}.json`);
      await writeFile(versionPath, JSON.stringify(content), { mode: 0o600, flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const tmp = `${pointer(ref)}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify({ revision }), { mode: 0o600 }); await rename(tmp, pointer(ref));
      return revision;
    },
    async load(ref, conversationId) {
      const { revision } = JSON.parse(await readFile(pointer(ref), 'utf8'));
      if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error('会话版本损坏');
      const record = JSON.parse(await readFile(path.join(dir, `entries-${revision}.json`), 'utf8'));
      if (hash(record) !== revision) throw new Error('会话条目损坏');
      if (record.owner.conversationId !== conversationId) throw new Error('会话引用不属于当前对话');
      return record;
    },
  };
}
