/**
 * 042 · 主进程权限服务（P1）：授权事实源的数据层与持久化协议。
 * 契约来源：requirements/042-app-scoped-permissions/technical-plan/contracts.md（§1/§2）。
 * 纯 Node、不依赖 Electron；IPC 与任务客户端（contracts §3/§4）在 P2/P3 接入。
 *
 * 职责与边界：
 * - 持久化 userData 侧 store 文件＋journal（准备记录→新快照→提交完成）；
 *   单写队列串行；崩溃恢复按「未完成的撤销取更严格、未完成的新增不授予」。
 * - 资源：AppResource（uiEnabled、identity、ownedRoots 由宿主解析后传入）/ DirectoryResource
 *   （selectedPath 与 canonicalRoot 分开记，比较只用后者）。
 * - 能力二值 access/edit（编辑含访问）；应用只取 access；同资源多来源 grant 做并集。
 * - 任务临时 grant、请求、令牌只驻内存（contracts §1）。
 * - write_failed 语义：新增持久授权失败→仅本任务范围继续＋保存失败上报；撤销失败→内存保持
 *   已撤销（不恢复权限）＋锁定相关资源等待重试。
 * - 本层不做身份解析（P0-2 的 lsof/plist/驱动核对在 target-resolver）、不做 Seatbelt 执行（P2）。
 */

import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const SCHEMA_VERSION = 1;
export const POLICY_VERSION = 'app-scoped-v1';

export const STORE_FILENAME = 'access-grants.json';
const INIT_MARKER = 'access-grants.init';
const JOURNAL_FILENAME = 'access-grants.json.journal';

/** 资源标识（应用的唯一键；gate/access-context 共用）。 */
export function appResourceId(identityKey) { return `app:${identityKey}`; }

/** 健康态（contracts §1）：运行态不自报，由本服务判定。 */
export const HEALTH = {
  initializing: 'initializing',
  ready: 'ready',
  corrupt: 'corrupt',
  writeFailed: 'write_failed',
  /** load 本身抛错（目录不可建/读盘异常）：终态受限，与 corrupt 一样拒绝变更与检查。 */
  unavailable: 'unavailable',
};

/** 可接受变更的健康态（其余一律 STORE_UNAVAILABLE）。 */
const WRITABLE_HEALTH = new Set([HEALTH.ready, HEALTH.writeFailed]);
/** 拒绝一切检查的受限态。 */
const RESTRICTED_HEALTH = new Set([HEALTH.corrupt, HEALTH.unavailable]);

function emptyStore() {
  return {
    schemaVersion: SCHEMA_VERSION,
    policyVersion: POLICY_VERSION,
    revision: 0,
    resources: {},            // resourceId → { type:'app', ... }（2026-10-15 起只有应用）
    persistentGrants: [],     // 持续授权列表
  };
}

function cloneStore(store) {
  return JSON.parse(JSON.stringify(store));
}

/**
 * 2026-10-15 文件夹授权退役（只保留应用级授权）：读库时丢掉 `dir:` 资源与它们的授权。
 * 只改内存，下一次写入时随快照落盘（未发布不留兼容，不做启动期迁移写）。
 */
export function withoutDirectoryGrants(store) {
  const resources = Object.fromEntries(
    Object.entries(store.resources ?? {}).filter(([id, r]) => r?.type !== 'dir' && !String(id).startsWith('dir:')),
  );
  const persistentGrants = (store.persistentGrants ?? []).filter((g) => !String(g?.resourceId ?? '').startsWith('dir:'));
  return { ...store, resources, persistentGrants };
}

/** 撤销/收紧类 op（失败时内存保持更严格结果、崩溃恢复按更严格应用）。 */
function isRevokeOp(op) {
  return op?.kind === 'revoke-resource' || op?.kind === 'remove-grant'
    || (op?.kind === 'set-ui' && op.enabled === false);
}

/**
 * 把撤销/收紧类 op 落到快照（崩溃恢复与失败后重放共用）。新增类返回 false 不动快照。
 * @returns {boolean} 是否改动了快照
 */
function applyRevokeOp(target, op) {
  if (!isRevokeOp(op)) return false;
  const bump = (id) => { if (target.resources[id]) target.resources[id].epoch = (target.resources[id].epoch ?? 0) + 1; };
  if (op.kind === 'revoke-resource') {
    const ids = Array.isArray(op.resourceIds) && op.resourceIds.length ? op.resourceIds : [op.resourceId];
    target.persistentGrants = target.persistentGrants.filter((g) => !ids.includes(g.resourceId));
    ids.forEach(bump);
  } else if (op.kind === 'remove-grant') {
    target.persistentGrants = target.persistentGrants.filter((g) => g.grantId !== op.grantId);
    bump(op.resourceId);
  } else if (op.kind === 'set-ui') {
    if (target.resources[op.resourceId]) target.resources[op.resourceId].uiEnabled = false;
    bump(op.resourceId);
  }
  return true;
}

/**
 * @param {object} opts
 * @param {string} opts.dir          store 所在目录（userData）
 * @param {() => number} opts.nowFn  假时钟（单测）
 * @param {object} [opts.fsHooks]    单测注入：{ persistFailure?: (op)=>boolean }
 */
export function createPermissionService({ dir, nowFn = Date.now, fsHooks = {} } = {}) {
  const storePath = path.join(dir, STORE_FILENAME);
  const journalPath = path.join(dir, JOURNAL_FILENAME);
  const initPath = path.join(dir, INIT_MARKER);

  let health = HEALTH.initializing;
  let store = emptyStore();
  /**
   * 盘上已提交快照的 revision（journal baseRevision 用它）。内存 store.revision 在撤销
   * 持久化失败时会先行（内存已撤销、盘上未落），两者分开记，恢复判定才不错位。
   */
  let diskRevision = 0;
  /** 持久化失败但内存已生效的撤销 op：随下一次成功提交（或 retrySave）一并落盘。 */
  let pendingRevokes = [];
  /** 任务临时授权：grantId → grant（lifetime=task，不持久化）。 */
  const taskGrants = new Map();
  /** 发现态资源（无任何授权）：requestId 引用它们；只在内存，重启即无（无 grant 也无需保留）。 */
  const discoveredResources = new Map();
  /** 待确认请求：requestId → request（含 kind=resource|action）。 */
  const pendingRequests = new Map();
  /** write_failed 详情：{ operation, affectedResourceIds, committedStateKnown }。 */
  let writeFailure = null;
  /** 撤销持久化失败后锁定的资源：resourceId → true（重试成功前拒绝该资源新授权）。 */
  const lockedResources = new Map();
  const listeners = new Set();
  let writeQueue = Promise.resolve();
  /** load() 的记忆化 promise：写队列先等它（加载完成前的写不能从空表起草覆盖盘上数据）。 */
  let loadPromise = null;
  let loadError = null;
  const persistFailures = fsHooks.persistFailure ?? null;

  // -------------------------------------------------------------- 加载与恢复
  function load() {
    if (!loadPromise) {
      loadPromise = doLoad().catch((error) => {
        health = HEALTH.unavailable;
        loadError = String(error?.message ?? error).slice(0, 200);
        throw error;
      });
    }
    return loadPromise;
  }

  async function doLoad() {
    await mkdir(dir, { recursive: true });
    const [snapshotRaw, journalRaw, initRaw] = await Promise.all([
      readFile(storePath, 'utf-8').then((t) => t, () => null),
      readFile(journalPath, 'utf-8').then((t) => t, () => null),
      readFile(initPath, 'utf-8').then((t) => t, () => null),
    ]);

    // 首次初始化：三缺（无初始化标识、无库、无 journal）才建空库（contracts §2.1）。
    if (snapshotRaw === null && journalRaw === null && initRaw === null) {
      await atomicWrite(initPath, `${SCHEMA_VERSION}\n`);
      await atomicWrite(storePath, serializeStore(emptyStore()));
      diskRevision = 0;
      health = HEALTH.ready;
      return;
    }

    if (snapshotRaw === null) {
      // 已初始化但库丢了／只剩 journal：受限态（不是首次启动）。
      health = HEALTH.corrupt;
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(snapshotRaw);
      validateStore(parsed);
    } catch {
      // 损坏：保留原文件为备份，进入受限态；不回退旧三档、不静默重建。
      await backupCorrupt(snapshotRaw).catch(() => {});
      health = HEALTH.corrupt;
      return;
    }
    store = withoutDirectoryGrants(parsed);
    diskRevision = parsed.revision;

    // journal 恢复（contracts §2.4）：未完成的撤销按更严格结果恢复，未完成的新增不授予。
    if (journalRaw !== null) {
      let journal;
      try {
        journal = JSON.parse(journalRaw);
      } catch {
        // journal 解析失败：不确定是否有未完成撤销 → 受限
        health = HEALTH.corrupt;
        return;
      }
      if (journal?.baseRevision === store.revision) {
        const recovered = cloneStore(store);
        let changed = false;
        for (const op of journalRevokeOps(journal)) changed = applyRevokeOp(recovered, op) || changed;
        if (changed) {
          recovered.revision = store.revision + 1;
          try {
            // 先把恢复结果原子落盘，再删 journal（否则删了 journal 又没落快照＝撤销丢失）。
            await atomicWrite(storePath, serializeStore(recovered));
          } catch {
            // 恢复快照写不下：内存按更严格生效，journal 留盘（下次启动再恢复），锁定相关资源。
            store = recovered;
            const affected = journalAffectedIds(journal);
            for (const id of affected) lockedResources.set(id, true);
            pendingRevokes = journalRevokeOps(journal);
            health = HEALTH.writeFailed;
            writeFailure = { operation: 'recovery', affectedResourceIds: affected, committedStateKnown: false };
            return;
          }
          store = recovered;
          diskRevision = recovered.revision;
        }
      } // baseRevision 不等 → 那次已提交（或无关残留），快照为准
      await rm(journalPath, { force: true }).catch(() => {});
    }
    health = HEALTH.ready;
  }

  /** journal 内需按更严格恢复的 op：本次 op ＋ 随附的未落盘撤销（retry-save 只带后者）。 */
  function journalRevokeOps(journal) {
    const ops = [];
    if (Array.isArray(journal?.pendingRevokes)) ops.push(...journal.pendingRevokes);
    if (journal?.op) ops.push(journal.op);
    return ops.filter(isRevokeOp);
  }

  function journalAffectedIds(journal) {
    const ids = new Set();
    for (const op of journalRevokeOps(journal)) {
      if (Array.isArray(op.resourceIds)) op.resourceIds.forEach((id) => ids.add(id));
      if (op.resourceId) ids.add(op.resourceId);
    }
    return [...ids];
  }

  function validateStore(parsed) {
    if (parsed?.schemaVersion !== SCHEMA_VERSION || parsed?.policyVersion !== POLICY_VERSION) {
      throw new Error('unknown schema');
    }
    if (typeof parsed?.revision !== 'number' || !Array.isArray(parsed?.persistentGrants)
      || !parsed?.resources || typeof parsed.resources !== 'object') {
      throw new Error('bad shape');
    }
  }

  async function backupCorrupt(raw) {
    const backup = path.join(dir, `${STORE_FILENAME}.corrupt-${Math.floor(nowFn() / 1000)}`);
    await writeFile(backup, raw, { mode: 0o600 });
  }

  // -------------------------------------------------------------- 持久化协议
  function serializeStore(s) {
    return `${JSON.stringify(s, null, 2)}\n`;
  }

  /** 同目录 tmp 写入＋fsync＋rename（contracts §2）；目录 fsync 在 exFAT/APFS 上不保证，未做。 */
  async function atomicWrite(file, text) {
    const tmp = path.join(dir, `.${path.basename(file)}.tmp-${randomUUID().slice(0, 8)}`);
    const fh = await open(tmp, 'w', 0o600);
    try {
      await fh.writeFile(text, 'utf-8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, file);
  }

  /** 成功落盘：内存切到新快照、未落盘撤销随之耐久、锁与故障清零。 */
  function commitSuccess(draft) {
    store = draft;
    diskRevision = draft.revision;
    pendingRevokes = [];
    lockedResources.clear();
    health = HEALTH.ready;
    writeFailure = null;
  }

  /**
   * 单写队列执行一次持久化变更（contracts §2：准备记录→新快照→提交完成）。
   * @param {object} op            { kind, ...payload }，journal 与恢复规则按 kind 判定
   * @param {(draft)=>void} mutate 在 draft（下一版快照）上落内存等价变更；失败不进入内存
   *                               （撤销类例外：失败时直接作用于内存，保持更严格）
   */
  function enqueuePersist(op, mutate, { affectedResourceIds = [] } = {}) {
    let attempted = false;
    const run = async () => {
      if (!WRITABLE_HEALTH.has(health)) {
        return { ok: false, errorCode: 'STORE_UNAVAILABLE', revision: store.revision };
      }
      if (affectedResourceIds.some((id) => lockedResources.get(id))) {
        return { ok: false, errorCode: 'PERSIST_FAILED', revision: store.revision };
      }
      if (op.expectedRevision !== undefined && op.expectedRevision !== store.revision) {
        return { ok: false, errorCode: 'REVISION_CONFLICT', revision: store.revision };
      }
      attempted = true;
      // 1) 准备记录（随附未落盘撤销：崩溃恢复时按更严格一并应用）
      await atomicWrite(journalPath, `${JSON.stringify({
        id: randomUUID(), baseRevision: diskRevision, op, pendingRevokes,
      })}\n`);
      // 2) 新快照（从内存起草：内存里已生效的失败撤销随本次一并落盘）
      const draft = cloneStore(store);
      mutate(draft);
      draft.revision = store.revision + 1;
      if (persistFailures?.(op)) throw new Error('injected persist failure');
      await atomicWrite(storePath, serializeStore(draft));
      // 3) 提交完成
      await rm(journalPath, { force: true });
      commitSuccess(draft);
      notify({ revision: store.revision, health, op });
      return { ok: true, revision: store.revision };
    };
    // 串行关键：run() 等队列前一个完成、且 load 完成（未调用 load 时 health=initializing → 拒绝）。
    const guarded = writeQueue
      .then(() => loadPromise ?? undefined)
      .then(run, run)
      .catch((err) => {
        void err;
        // 写失败语义（contracts §2.2/2.3）
        const revoke = isRevokeOp(op);
        if (revoke) {
          // 撤销失败：内存保持撤销结果（更安全态），锁定相关资源等待重试；
          // 盘上 revision 不动（diskRevision 单独记）。
          mutate(store);
          store.revision += 1;
          pendingRevokes.push(op);
          for (const id of affectedResourceIds) lockedResources.set(id, true);
        }
        if (attempted || revoke) {
          health = HEALTH.writeFailed;
          writeFailure = {
            operation: op.kind,
            affectedResourceIds,
            committedStateKnown: !revoke, // 新增失败：旧已提交状态明确；撤销失败：盘上仍是旧授权
          };
        }
        notify({ revision: store.revision, health, op, failure: writeFailure });
        return { ok: false, errorCode: 'PERSIST_FAILED', revision: store.revision };
      });
    writeQueue = guarded.then(() => {}, () => {});
    return guarded;
  }

  /**
   * 保存重试（access:retry-save）：把内存现状（含失败撤销）整体重新落盘；成功即解锁。
   * 不改变任何范围，也不重跑任何工具。
   */
  function retrySave() {
    const run = async () => {
      if (!WRITABLE_HEALTH.has(health)) {
        return { ok: false, errorCode: 'STORE_UNAVAILABLE', revision: store.revision };
      }
      if (health === HEALTH.ready && !pendingRevokes.length) {
        return { ok: true, revision: store.revision, unchanged: true };
      }
      const op = { kind: 'retry-save' };
      try {
        await atomicWrite(journalPath, `${JSON.stringify({
          id: randomUUID(), baseRevision: diskRevision, op, pendingRevokes,
        })}\n`);
        const draft = cloneStore(store);
        draft.revision = store.revision + 1;
        if (persistFailures?.(op)) throw new Error('injected persist failure');
        await atomicWrite(storePath, serializeStore(draft));
        await rm(journalPath, { force: true });
        commitSuccess(draft);
        notify({ revision: store.revision, health, op });
        return { ok: true, revision: store.revision };
      } catch {
        health = HEALTH.writeFailed;
        notify({ revision: store.revision, health, op, failure: writeFailure });
        return { ok: false, errorCode: 'PERSIST_FAILED', revision: store.revision };
      }
    };
    const guarded = writeQueue.then(() => loadPromise ?? undefined).then(run, run);
    writeQueue = guarded.then(() => {}, () => {});
    return guarded;
  }

  function notify(evt) {
    for (const fn of listeners) {
      try { fn(evt); } catch { /* 订阅方异常不影响提交结果 */ }
    }
  }

  // -------------------------------------------------------------- 资源与授权
  // 资源标识构造走模块级导出（gate/access-context 共用同一份规则）。

  function resourceById(resourceId) {
    return store.resources[resourceId] ?? discoveredResources.get(resourceId) ?? null;
  }

  /**
   * 发现态登记（host-only，来自 P0-2 的归属解析或访达选择）：只建资源不产生 grant。
   * 卡片流程：noteResource → createRequest → decide(task|persistent|deny)。
   */
  function noteResource({ type, identityKey, displayName, ownedRoots }) {
    if (type !== 'app') return { ok: false, errorCode: 'INVALID_INPUT' }; // 2026-10-15 只剩应用资源
    const resourceId = appResourceId(identityKey);
    const def = { type: 'app', resourceId, identity: { key: identityKey }, displayName: displayName ?? identityKey,
      uiEnabled: true, ownedRoots: ownedRoots ?? [], epoch: 0 };
    const existing = resourceById(resourceId);
    discoveredResources.set(resourceId, existing ? { ...existing, ...def, epoch: existing.epoch } : def);
    return { ok: true, resourceId };
  }

  /** 添加应用＝持续 access（零配置裁决）；identity/ownedRoots 由宿主解析后传入。 */
  function addApplication({ identityKey, displayName, ownedRoots = [], expectedRevision }) {
    if (typeof identityKey !== 'string' || !identityKey.trim()) {
      return Promise.resolve({ ok: false, errorCode: 'INVALID_INPUT', revision: store.revision });
    }
    const resourceId = appResourceId(identityKey);
    const grantId = `g-${randomUUID()}`;
    return enqueuePersist(
      { kind: 'add-app', resourceId, expectedRevision },
      (draft) => {
        const existing = draft.resources[resourceId] ?? discoveredResources.get(resourceId) ?? null;
        draft.resources[resourceId] = {
          type: 'app',
          resourceId,
          identity: { key: identityKey },
          displayName: displayName || existing?.displayName || identityKey,
          uiEnabled: existing?.uiEnabled ?? true,
          ownedRoots: ownedRoots.length ? ownedRoots : (existing?.ownedRoots ?? []),
          epoch: existing?.epoch ?? 0,
        };
        draft.persistentGrants.push({
          grantId, resourceId, capability: 'access', lifetime: 'persistent',
          source: 'settings', createdAt: nowFn(),
        });
      },
      { affectedResourceIds: [resourceId] },
    ).then((result) => ({ ...result, grantId, resourceId }));
  }

  /**
   * 授权卡「持续允许」（access-context 调用）：资源缺失则落库，已有则保留原记录
   * （epoch/ownerAppId 不动）；该资源已有 card 来源持续 grant 则能力取 max(既有, 请求)，
   * 否则新增一份 card grant。其他来源（如设置页 access）不受影响。单次 journal 变更。
   * @returns {Promise<{ ok: true, grantId: string } | { ok: false, errorCode: string }>}
   */
  async function upsertCardGrant({ type, identityKey, displayName, capability } = {}) {
    if (capability !== 'access' && capability !== 'edit') return { ok: false, errorCode: 'INVALID_INPUT' };
    let resourceId;
    let fresh;
    if (type === 'app') {
      if (typeof identityKey !== 'string' || !identityKey.trim()) return { ok: false, errorCode: 'INVALID_INPUT' };
      if (capability !== 'access') return { ok: false, errorCode: 'UNSUPPORTED_CAPABILITY' };
      resourceId = appResourceId(identityKey);
      fresh = () => {
        const disc = discoveredResources.get(resourceId);
        return {
          type: 'app', resourceId, identity: { key: identityKey },
          displayName: displayName || disc?.displayName || identityKey,
          uiEnabled: disc?.uiEnabled ?? true, ownedRoots: disc?.ownedRoots ?? [], epoch: disc?.epoch ?? 0,
        };
      };
    } else {
      return { ok: false, errorCode: 'INVALID_INPUT' };
    }
    let grantId = null;
    const result = await enqueuePersist(
      { kind: 'upsert-card-grant', resourceId, capability },
      (draft) => {
        if (!draft.resources[resourceId]) draft.resources[resourceId] = fresh();
        const existing = draft.persistentGrants.find((g) => g.resourceId === resourceId && g.source === 'card');
        if (existing) {
          if (capability === 'edit') existing.capability = 'edit'; // max(既有, 请求)：只升不降
          grantId = existing.grantId;
        } else {
          grantId = `g-${randomUUID()}`;
          draft.persistentGrants.push({
            grantId, resourceId, capability, lifetime: 'persistent', source: 'card', createdAt: nowFn(),
          });
        }
      },
      { affectedResourceIds: [resourceId] },
    );
    if (!result.ok) return { ok: false, errorCode: result.errorCode };
    return { ok: true, grantId, resourceId, revision: result.revision };
  }

  /** 应用界面开关：关闭即 epoch+1（令牌失效），不是授权本身。仅已落库的应用资源。 */
  function setUiEnabled({ resourceId, enabled, expectedRevision }) {
    const r = store.resources[resourceId];
    if (!r) return Promise.resolve({ ok: false, errorCode: 'UNKNOWN_RESOURCE', revision: store.revision });
    if (r.type !== 'app') return Promise.resolve({ ok: false, errorCode: 'NOT_APPLICATION', revision: store.revision });
    return enqueuePersist(
      { kind: 'set-ui', resourceId, enabled: Boolean(enabled), expectedRevision },
      (draft) => {
        if (!draft.resources[resourceId]) return;
        draft.resources[resourceId].uiEnabled = Boolean(enabled);
        draft.resources[resourceId].epoch += 1;
      },
      { affectedResourceIds: [resourceId] },
    );
  }

  function bumpEpochInMemory(resourceId) {
    const r = store.resources[resourceId] ?? discoveredResources.get(resourceId);
    if (r) r.epoch = (r.epoch ?? 0) + 1;
  }

  /** 来源级移除：只移除该份 grant；剩余范围返回给 UI 解释。任务临时 grant 直接删内存。 */
  function removeGrant({ grantId, expectedRevision }) {
    const taskGrant = taskGrants.get(grantId);
    if (taskGrant) {
      taskGrants.delete(grantId);
      bumpEpochInMemory(taskGrant.resourceId);
      notify({ revision: store.revision, health, op: { kind: 'remove-task-grant', grantId } });
      return Promise.resolve({
        ok: true, revision: store.revision, remaining: grantsForResource(taskGrant.resourceId),
      });
    }
    const g = store.persistentGrants.find((x) => x.grantId === grantId);
    if (!g) return Promise.resolve({ ok: false, errorCode: 'UNKNOWN_GRANT', revision: store.revision });
    return enqueuePersist(
      { kind: 'remove-grant', grantId, resourceId: g.resourceId, expectedRevision },
      (draft) => {
        draft.persistentGrants = draft.persistentGrants.filter((x) => x.grantId !== grantId);
        const res = draft.resources[g.resourceId];
        if (res) res.epoch += 1;
      },
      { affectedResourceIds: [g.resourceId] },
    ).then((result) => ({ ...result, remaining: grantsForResource(g.resourceId) }));
  }

  /** 整资源撤销：app 撤销连带其名下目录 grant；同时取消相关待确认请求与任务临时授权。 */
  function revokeResource({ resourceId, expectedRevision }) {
    const resourceIds = relatedResourceIds(resourceId);
    cancelPendingRequestsFor(resourceIds);
    let removedTask = false;
    for (const [gid, g] of taskGrants) {
      if (resourceIds.includes(g.resourceId)) { taskGrants.delete(gid); removedTask = true; }
    }
    if (removedTask) {
      for (const id of resourceIds) if (!store.resources[id]) bumpEpochInMemory(id);
      notify({ revision: store.revision, health, op: { kind: 'revoke-task-grants', resourceIds } });
    }
    return enqueuePersist(
      { kind: 'revoke-resource', resourceId, resourceIds, expectedRevision },
      (draft) => {
        for (const id of resourceIds) {
          draft.persistentGrants = draft.persistentGrants.filter((x) => x.resourceId !== id);
          const res = draft.resources[id];
          if (res) res.epoch += 1;
        }
      },
      { affectedResourceIds: resourceIds },
    );
  }

  function relatedResourceIds(resourceId) {
    return [resourceId]; // 2026-10-15 文件夹资源退役，应用撤销不再连带目录
  }

  function grantsForResource(resourceId) {
    return [
      ...store.persistentGrants.filter((g) => g.resourceId === resourceId),
      ...[...taskGrants.values()].filter((g) => g.resourceId === resourceId),
    ];
  }

  // -------------------------------------------------------------- 任务临时授权与请求
  /** 授权卡「本任务允许」：内存 grant，绑定活跃 taskId，子 agent 终态由 subagents 调 cleanupTask。 */
  function grantTaskScope({ taskId, resourceId, capability = 'access' }) {
    if (!resourceById(resourceId)) return { ok: false, errorCode: 'UNKNOWN_RESOURCE' };
    const grantId = `t-${randomUUID()}`;
    taskGrants.set(grantId, {
      grantId, resourceId, capability, lifetime: 'task', taskId,
      source: 'card', createdAt: nowFn(),
    });
    notify({ revision: store.revision, health, op: { kind: 'grant-task-scope', taskId, resourceId } });
    return { ok: true, grantId };
  }

  /** 任务终态/停止：清掉该任务全部临时授权与待确认请求。 */
  function cleanupTask(taskId) {
    let changed = false;
    for (const [gid, g] of taskGrants) if (g.taskId === taskId) { taskGrants.delete(gid); changed = true; }
    for (const [rid, r] of pendingRequests) if (r.taskId === taskId) { pendingRequests.delete(rid); changed = true; }
    if (changed) notify({ revision: store.revision, health, op: { kind: 'cleanup-task', taskId } });
  }

  function createRequest({ taskId, kind = 'resource', requirements, ttlMs = 30_000 }) {
    const requestId = `r-${randomUUID()}`;
    const request = {
      requestId, taskId, kind, requirements,
      issuedAt: nowFn(), deadline: nowFn() + ttlMs,
      resourceEpochs: Object.fromEntries(
        [...new Set(requirements.map((x) => x.resourceId))].map((id) => [id, resourceById(id)?.epoch ?? 0]),
      ),
      state: 'pending',
    };
    pendingRequests.set(requestId, request);
    return { ok: true, requestId };
  }

  function cancelPendingRequestsFor(resourceIds) {
    for (const [rid, r] of pendingRequests) {
      if (r.requirements.some((x) => resourceIds.includes(x.resourceId))) {
        r.state = 'cancelled';
        pendingRequests.delete(rid);
      }
    }
  }

  /** 授权卡应答（host-only）。决议后请求不可复用；kind 与 decision 匹配校验。 */
  function decide(requestId, decision) {
    const r = pendingRequests.get(requestId);
    if (!r) return { ok: false, errorCode: 'REQUEST_EXPIRED' };
    pendingRequests.delete(requestId);
    if (r.deadline < nowFn()) return { ok: false, errorCode: 'REQUEST_EXPIRED' };
    if (r.kind === 'action') {
      if (decision !== 'action-once') return { ok: false, errorCode: 'KIND_MISMATCH' };
      return { ok: true, effect: 'action-once' }; // 风险确认不产生任何 grant
    }
    if (!['task', 'persistent', 'deny'].includes(decision)) {
      return { ok: false, errorCode: 'KIND_MISMATCH' };
    }
    if (decision === 'deny') return { ok: true, effect: 'denied' };
    if (decision === 'task') {
      const granted = [];
      for (const req of r.requirements) {
        const res = grantTaskScope({ taskId: r.taskId, resourceId: req.resourceId, capability: req.capability });
        if (res.ok) granted.push(res.grantId);
      }
      return { ok: true, effect: 'task', granted };
    }
    // persistent：写持久层（card 来源 upsert）；写失败时保底本任务范围（contracts §2.2）
    return (async () => {
      const results = [];
      let persistFailed = false;
      for (const req of r.requirements) {
        const res = resourceById(req.resourceId) ?? {};
        const outcome = await upsertCardGrant({
          type: 'app', identityKey: res.identity?.key ?? String(req.resourceId).slice(4),
          displayName: res.displayName, capability: 'access',
        });
        if (outcome.ok) {
          results.push({ ...outcome, capability: req.capability });
        } else {
          persistFailed = true;
          grantTaskScope({ taskId: r.taskId, resourceId: req.resourceId, capability: req.capability });
        }
      }
      if (persistFailed) {
        return { ok: true, effect: 'persistent-save-failed', savedScope: results, taskFallback: true };
      }
      return { ok: true, effect: 'persistent', savedScope: results };
    })();
  }

  // -------------------------------------------------------------- 查询与检查
  /**
   * 状态 DTO：无 taskId＝设置页视图（只含持续授权）；带 taskId＝该任务可见（持续＋本任务临时）。
   * resources 含已落库资源＋被所含 grant 引用的发现态资源（渲染层据此显示名称）。
   */
  function getState(taskId = null) {
    const grants = taskId ? grantsVisibleTo(taskId) : [...store.persistentGrants];
    const resources = Object.values(store.resources);
    const referenced = new Set(grants.map((g) => g.resourceId));
    for (const id of referenced) {
      if (!store.resources[id] && discoveredResources.has(id)) resources.push(discoveredResources.get(id));
    }
    return {
      health,
      revision: store.revision,
      writeFailure,
      ...(loadError ? { loadError } : {}),
      lockedResourceIds: [...lockedResources.keys()],
      resources,
      grants,
      pendingRequests: [...pendingRequests.values()]
        .filter((r) => !taskId || (Array.isArray(taskId) ? taskId.includes(r.taskId) : r.taskId === taskId))
        .map((r) => ({ requestId: r.requestId, taskId: r.taskId, kind: r.kind, state: r.state })),
    };
  }

  /** taskId 可为数组：056 子 agent 同时看本任务与所属对话范围的临时授权。 */
  function grantsVisibleTo(taskId) {
    const ids = new Set(Array.isArray(taskId) ? taskId : [taskId]);
    return [...store.persistentGrants, ...[...taskGrants.values()].filter((g) => ids.has(g.taskId))];
  }

  /**
   * 能力检查：多来源并集；task grant 仅本任务；编辑含访问；write_failed 锁定资源拒绝。
   * 返回 { ok, viaGrant } 或 { ok:false, errorCode }。
   */
  function checkAccess({ taskId, resourceId, capability = 'access' }) {
    if (RESTRICTED_HEALTH.has(health)) return { ok: false, errorCode: 'STORE_UNAVAILABLE' };
    if (lockedResources.get(resourceId)) return { ok: false, errorCode: 'PERSIST_FAILED' };
    const resource = resourceById(resourceId);
    if (!resource) return { ok: false, errorCode: 'UNKNOWN_RESOURCE' };
    if (resource.type === 'app' && capability === 'edit') {
      return { ok: false, errorCode: 'UNSUPPORTED_CAPABILITY' }; // 应用只有 access
    }
    if (resource.type === 'app' && !resource.uiEnabled) {
      return { ok: false, errorCode: 'FEATURE_DISABLED' };
    }
    for (const g of grantsVisibleTo(taskId)) {
      if (g.resourceId !== resourceId) continue;
      if (g.capability === 'edit' || g.capability === capability) {
        return { ok: true, viaGrant: g.grantId };
      }
    }
    return { ok: false, errorCode: 'UNAUTHORIZED' };
  }

  /** 资源当前 epoch（供令牌/请求校验 staleness）。 */
  function resourceEpoch(resourceId) {
    return resourceById(resourceId)?.epoch ?? null;
  }

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return {
    load,
    /** store 所在目录（userData）：gate 侧据此划控制面根，模型工具一律硬拒。 */
    storeDir: dir,
    // 管理（设置页/授权卡经 IPC，host-only）
    noteResource,
    addApplication, setUiEnabled,
    upsertCardGrant,
    removeGrant, revokeResource, retrySave,
    createRequest, decide, grantTaskScope, cleanupTask,
    // 查询
    getState, checkAccess, resourceEpoch, grantsForResource,
    listDiscoveredResources: () => [...discoveredResources.values()],
    appResourceId,
    onChange,
    get health() { return health; },
  };
}
