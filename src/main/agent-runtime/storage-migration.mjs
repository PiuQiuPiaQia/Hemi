import { mkdir, readdir, lstat, readFile, writeFile, rename, cp, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const SCOPES = ['text-model-profiles.json','conversations','task-history','attachments','workflows'];
export const runtimeDataDir = userDataDir => path.join(userDataDir, 'runtime-v2');
const exists = async target => lstat(target).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
async function filesBelow(root, relative = '') {
  const result = [];
  for (const name of relative ? await readdir(path.join(root, relative)) : SCOPES) {
    if (name.startsWith('._')) continue;
    const rel = path.join(relative, name), target = path.join(root, rel);
    if (!await exists(target)) continue;
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) throw new Error(`旧运行数据含符号链接，未迁移：${rel}`);
    if (stat.isDirectory()) result.push(...await filesBelow(root, rel)); else if (stat.isFile()) result.push({ path: rel, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  return result.sort((a,b) => a.path.localeCompare(b.path));
}
async function fileHash(file) { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
function rewriteStagedPaths(value, from, to) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'stagedPath' && typeof item === 'string') {
      const relative = path.relative(from, item);
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) value[key] = path.join(to, relative);
    } else if (item && typeof item === 'object') rewriteStagedPaths(item, from, to);
  }
}
export function migrateConversation(record, predecessor) {
  const next = structuredClone(record), at = Date.now();
  if (next.agentSession) { next.predecessorAgentSession = next.agentSession; delete next.agentSession; }
  next.runtimeSchemaVersion = 2; next.predecessor = predecessor;
  const flow = next.flow;
  if (flow) {
    flow.phase = 'idle'; flow.activeRunId = null; flow.pendingReports = [];
    for (const run of Object.values(flow.runs ?? {})) if (run.closedAt == null) Object.assign(run, { outcome: 'interrupted', endedAt: at, closedAt: at, interruptionReason: '运行时升级，未自动重跑' });
    for (const task of Object.values(flow.tasks ?? {})) if (task.phase !== 'terminal') Object.assign(task, { phase: 'terminal', outcome: 'unknown', permission: null, outcomeReason: '运行时升级，旧执行已中断', endedAt: at });
    for (const item of flow.pending ?? []) Object.assign(item, { state: 'needs-review', reviewReason: 'runtime-upgrade' });
    if (flow.pending?.length) flow.queuePaused = true;
  }
  return next;
}

/** 一次性异步导入并原子激活。旧字节不改，之后所有写入走唯一新目录。 */
export async function initializeRuntimeStorage({ userDataDir }) {
  const target = runtimeDataDir(userDataDir), manifestPath = path.join(target, 'migration.json');
  await mkdir(userDataDir, { recursive: true });
  const current = await filesBelow(userDataDir);
  if (await exists(manifestPath)) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (manifest.version !== 2 || !Array.isArray(manifest.sourceStats)) throw new Error('运行时迁移清单损坏');
    const compare = value => JSON.stringify(value.map(({path,size,mtimeMs}) => ({path,size,mtimeMs})));
    return { dir: target, migrated: false, conflict: compare(current) !== compare(manifest.acknowledgedSourceStats ?? manifest.sourceStats), sourceStats: current };
  }
  if (await exists(target)) throw new Error('新版运行目录缺少迁移清单；已保留原数据，请先修复该目录后重试');
  const stage = path.join(userDataDir, `.runtime-v2-stage-${randomUUID()}`);
  await mkdir(stage);
  try {
    const sourceFiles = [];
    for (const item of current) {
      const source = path.join(userDataDir, item.path), destination = path.join(stage, item.path);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(source, destination, { preserveTimestamps: true });
      const sha256 = await fileHash(source);
      if (await fileHash(destination) !== sha256) throw new Error(`迁移复制校验失败：${item.path}`);
      sourceFiles.push({ ...item, sha256 });
      if (item.path.endsWith('.json')) {
        let record;
        try { record = JSON.parse(await readFile(destination, 'utf8')); }
        catch (error) { throw new Error(`旧运行数据损坏（旧会话损坏或配置损坏），迁移已停止且原字节保留：${item.path}（${error.message}）`); }
        const before = JSON.stringify(record);
        if (item.path.startsWith(`conversations${path.sep}`) && record?.id && (Array.isArray(record.turns) || record.flow)) {
          record = migrateConversation(record, { path: item.path, sha256 });
        }
        rewriteStagedPaths(record, path.join(userDataDir, 'attachments'), path.join(target, 'attachments'));
        if (JSON.stringify(record) !== before) await writeFile(destination, JSON.stringify(record), { mode: 0o600 });
      }
    }
    const after = await filesBelow(userDataDir);
    if (JSON.stringify(after) !== JSON.stringify(current)) throw new Error('迁移期间旧数据发生变化，未激活新版目录');
    await writeFile(path.join(stage, 'migration.json'), JSON.stringify({ version: 2, activatedAt: Date.now(), sourceStats: current, sourceFiles }), { mode: 0o600 });
    await rename(stage, target);
    return { dir: target, migrated: true, conflict: false, sourceStats: current };
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
}
export async function acknowledgeLegacyBranch({ userDataDir, sourceStats }) {
  const file = path.join(runtimeDataDir(userDataDir), 'migration.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.acknowledgedSourceStats = sourceStats; manifest.branchDecisions ??= [];
  manifest.branchDecisions.push({ at: Date.now(), choice: 'continue-v2', sourceStats });
  const tmp = `${file}.${randomUUID()}.tmp`; await writeFile(tmp, JSON.stringify(manifest), { mode: 0o600 }); await rename(tmp, file);
}
