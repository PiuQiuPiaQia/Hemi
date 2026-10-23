import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  atomicJson,
  readJson,
  fail,
  BOT_PROTOCOL,
  syncModelConfig,
} from './storage.mjs';
import { createBotTransport } from './transport.mjs';
import { isValidSshTarget } from '../remote/ssh-runner.mjs';

const METHODS = new Set([
  'snapshot',
  'session.open',
  'session.create',
  'session.update',
  'session.rename',
  'session.remove',
  'session.order',
  'session.draft',
  'flow.command',
  'flow.snapshot',
  'permission.decide',
  'directory.list',
  'attachment.read',
  'attachment.document',
  'file.read',
  'file.resolve',
  'references',
  'skills',
  'operation.get',
  'diagnostics',
]);
const fingerprint = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function createBotDesktopService({
  userDataDir,
  runner,
  profiles,
  archivePath,
  onChanged = () => {},
  transport = createBotTransport({ runner, archivePath }),
  ensureArchive = async () => {},
}) {
  let storageError = '';
  function localJson(file, fallback) {
    try {
      return readJson(file, fallback);
    } catch {
      storageError = '本机 Bot 缓存损坏，已保留备份；请重新连接。';
      try {
        fs.copyFileSync(
          file,
          file + '.corrupt-' + Date.now(),
          fs.constants.COPYFILE_EXCL,
        );
      } catch {}
      return fallback;
    }
  }
  const dir = path.join(userDataDir, 'bot'),
    connectionFile = path.join(dir, 'connection.json'),
    cacheFile = path.join(dir, 'cache.json');
  const draftsFile = path.join(dir, 'drafts.json'),
    syncFile = path.join(dir, 'model-sync.json');
  const diagnosticsFile = path.join(dir, 'diagnostics.json');
  const diagnosticEvents = localJson(diagnosticsFile, []);
  const record = (stage, outcome, code = null) => {
    diagnosticEvents.push({ at: Date.now(), stage, outcome, code });
    diagnosticEvents.splice(0, Math.max(0, diagnosticEvents.length - 40));
    atomicJson(diagnosticsFile, diagnosticEvents);
  };
  let syncStatus = localJson(syncFile, null),
    syncInFlight = false;
  if (syncStatus?.phase === 'sending')
    syncStatus = { ...syncStatus, phase: 'unknown' };
  let localDrafts = localJson(draftsFile, { instanceId: null, items: {} });
  let retryCount = 0,
    retryAt = 0;
  let disconnected = false,
    stoppedConfirmed = false,
    initializationAbort = null;
  const uploads = new Map();
  let binding = localJson(connectionFile, null),
    cache = localJson(cacheFile, null),
    candidate = null,
    online = false,
    error = storageError,
    busy = '',
    lastConnectedAt = cache?.syncedAt ?? null,
    activeId = null,
    closed = false,
    polling = null;
  if (cache?.instanceId !== binding?.instanceId) cache = null;
  activeId = cache?.selectedId ?? null;
  if (syncStatus?.instanceId !== binding?.instanceId) syncStatus = null;
  if (localDrafts.instanceId !== binding?.instanceId)
    localDrafts = { instanceId: binding?.instanceId ?? null, items: {} };
  const publish = () => {
    const value = getState();
    onChanged(value);
    return value;
  };
  function getState() {
    return {
      binding: binding ? { ...binding } : null,
      online,
      error,
      busy,
      lastConnectedAt,
      stoppedConfirmed,
      syncStatus: syncStatus ? structuredClone(syncStatus) : null,
      cache: cache ? structuredClone(cache) : null,
      candidate: candidate
        ? { id: candidate.id, host: candidate.host, info: candidate.info }
        : null,
    };
  }
  async function direct(method, params = {}) {
    if (!binding) fail('请先创建 Bot 连接。', 'missing');
    return transport.rpc(binding.host, method, {
      ...params,
      instanceId: binding.instanceId,
      requestId: params.requestId ?? 'op-' + randomUUID(),
    });
  }
  async function refresh() {
    if (!binding || closed) return getState();
    if (polling) return polling;
    const identity = binding.instanceId,
      host = binding.host,
      target = activeId ?? cache?.sessions[0]?.id;
    polling = (async () => {
      try {
        if (!online) {
          const hello = await direct('handshake');
          if (hello.protocol !== BOT_PROTOCOL || hello.instanceId !== identity)
            fail('Bot 身份或协议不兼容，请核对后维护。', 'conflict');
        }
        const canReuse =
          !Object.keys(localDrafts.items).length &&
          syncStatus?.phase !== 'unknown';
        const snapshot = await direct('snapshot', {
          ...(target ? { id: target } : {}),
          revision: canReuse
            ? target
              ? cache?.detailRevisions?.[target]
              : cache?.revision
            : -1,
        });
        if (
          snapshot.notModified &&
          binding?.instanceId === identity &&
          binding?.host === host
        ) {
          const changed = !online;
          online = true;
          retryCount = 0;
          retryAt = 0;
          lastConnectedAt = Date.now();
          if (cache && lastConnectedAt - (cache.syncedAt ?? 0) > 30000) {
            cache.syncedAt = lastConnectedAt;
            atomicJson(cacheFile, cache);
          }
          return changed ? publish() : getState();
        }
        if (binding?.instanceId !== identity || binding?.host !== host)
          return getState();
        if (snapshot.instanceId !== identity)
          fail('Bot 身份不同，已停止连接。', 'conflict');
        let draftConflict = '';
        const details = Object.fromEntries(
          Object.entries(cache?.details ?? {}).filter(([id]) =>
            snapshot.sessions.some((s) => s.id === id),
          ),
        );
        if (snapshot.detail) details[snapshot.detail.id] = snapshot.detail;
        for (const [id, draft] of Object.entries(localDrafts.items)) {
          if (!snapshot.sessions.some((s) => s.id === id)) {
            delete localDrafts.items[id];
            continue;
          }
          const detail = details[id];
          if (!detail) continue;
          if (draft.conflict) {
            detail.draft = draft;
            draftConflict =
              '云端草稿已有其他更新，本机草稿已保留；继续编辑后可保存。';
            continue;
          }
          const ack = await direct('session.draft', { id, ...draft });
          if (ack.ok) {
            if (localDrafts.items[id] === draft) delete localDrafts.items[id];
            detail.draft = localDrafts.items[id] ?? ack.draft;
          } else {
            if (localDrafts.items[id] !== draft) {
              detail.draft = localDrafts.items[id];
              continue;
            }
            localDrafts.items[id] = {
              ...draft,
              conflict: true,
              revision: Math.max(draft.revision, ack.draft.revision),
            };
            detail.draft = localDrafts.items[id];
            draftConflict =
              '云端草稿已有其他更新，本机草稿已保留，请核对后再编辑。';
          }
        }
        atomicJson(draftsFile, localDrafts);
        if (activeId && !snapshot.sessions.some((s) => s.id === activeId))
          activeId = null;
        cache = {
          ...snapshot,
          details,
          detailRevisions: {
            ...cache?.detailRevisions,
            ...(snapshot.detail
              ? { [snapshot.detail.id]: snapshot.revision }
              : {}),
          },
          selectedId: activeId,
          syncedAt: Date.now(),
        };
        delete cache.detail;
        online = true;
        retryCount = 0;
        retryAt = 0;
        error = draftConflict;
        lastConnectedAt = Date.now();
        atomicJson(cacheFile, cache);
        if (syncStatus?.phase === 'unknown' && !syncInFlight) {
          const receipt = await direct('operation.get', {
            operationId: syncStatus.requestId,
          });
          if (receipt.status === 'interrupted') {
            syncStatus = { ...syncStatus, phase: 'interrupted' };
            atomicJson(syncFile, syncStatus);
          } else if (receipt.status === 'done') {
            syncStatus = {
              ...syncStatus,
              phase: 'confirmed',
              results: receipt.result.results,
            };
            atomicJson(syncFile, syncStatus);
          } else if (receipt.status === 'missing') {
            syncStatus = { ...syncStatus, phase: 'not-received' };
            atomicJson(syncFile, syncStatus);
          }
        }
        return publish();
      } catch (e) {
        if (binding?.instanceId === identity) {
          online = false;
          retryCount = ['permission', 'conflict', 'unsupported'].includes(
            e.code,
          )
            ? 4
            : retryCount + 1;
          retryAt =
            Date.now() +
            [1000, 5000, 15000, 60000][Math.min(3, retryCount - 1)];
          error = e.code ? e.message : '无法读取 Bot 状态，请重新连接。';
          publish();
        }
        return getState();
      } finally {
        polling = null;
      }
    })();
    return polling;
  }
  async function modelCandidates() {
    const list = await profiles.list();
    const out = [];
    for (const provider of list.providers) {
      for (const model of provider.models) {
        const resolved = provider.oauthProvider
          ? null
          : await profiles.resolveStrict(model.modelKey);
        const config = resolved?.ok ? resolved.config : null;
        const revision = config ? fingerprint(syncModelConfig(config)) : null;
        const remote = cache?.models?.find((v) => v.key === model.modelKey);
        let reason = provider.oauthProvider
          ? '暂不支持云端账号授权'
          : !config
            ? '缺少 API Key'
            : '';
        try {
          if (
            config &&
            /^(localhost|127\.|\[?::1\]?$|0\.0\.0\.0)/i.test(
              new URL(config.baseUrl).hostname,
            )
          )
            reason = '本机地址不可用';
        } catch {
          reason = '模型接口地址无效';
        }
        out.push({
          key: model.modelKey,
          name: model.model,
          provider: provider.name,
          auth: provider.oauthProvider ? '账号登录' : 'API Key',
          canSync: !reason,
          reason,
          revision,
          status: remote
            ? remote.revision === revision
              ? 'synced'
              : 'update'
            : 'new',
        });
      }
    }
    return out;
  }
  async function sync(host, instanceId, keys, requestId, signal) {
    if (!Array.isArray(keys) || !keys.length || new Set(keys).size > 50)
      fail('请选择要同步的模型。');
    const models = [];
    for (const key of [...new Set(keys)].slice(0, 50)) {
      const resolved = await profiles.resolveStrict(key);
      if (!resolved.ok || resolved.config.oauthProvider)
        fail('所选模型缺少独立 API Key，或使用暂不支持的账号授权。');
      models.push(resolved.config);
    }
    return transport.rpc(
      host,
      'model.sync',
      { instanceId, requestId: requestId ?? 'sync-' + randomUUID(), models },
      { signal },
    );
  }
  async function uploadRecord(item) {
    if (item.instanceId !== binding?.instanceId)
      fail('Bot 连接已更换。', 'conflict');
    if (!online) fail('恢复连接后才能上传附件。', 'offline');
    if (item.result) return item.result;
    item.cancelled = false;
    item.controller = new AbortController();
    const result = await transport.rpc(
      item.host,
      'attachment.add',
      {
        id: item.id,
        name: item.name,
        source: item.source,
        base64: item.bytes.toString('base64'),
        instanceId: item.instanceId,
        requestId: item.key,
      },
      { signal: item.controller.signal },
    );
    if (item.cancelled) fail('上传等待已取消，草稿保留。', 'needs-review');
    item.result = result;
    item.bytes = null;
    return result;
  }
  async function routeCommand(method, params = {}) {
    const controls = [
      'service.start',
      'service.stop',
      'connection.remove',
      'connection.forget',
      'connection.address',
      'component.update',
    ];
    if (!controls.includes(method)) return performCommand(method, params);
    if (busy) fail('正在处理 Bot 操作，请稍候。', 'busy');
    busy = method;
    publish();
    try {
      const result = await performCommand(method, params);
      record(method, 'confirmed');
      return result;
    } catch (error) {
      record(method, 'failed', error.code ?? 'failed');
      throw error;
    } finally {
      busy = '';
      publish();
    }
  }
  async function performCommand(method, params) {
    if (method === 'initialization.cancel') {
      initializationAbort?.abort();
      return { ok: true };
    }
    if (method === 'attachment.cancel') {
      for (const [key, item] of uploads)
        if (
          (typeof params.requestId === 'string' &&
            item.base === params.requestId) ||
          (typeof params.requestId === 'string' && key === params.requestId)
        ) {
          item.cancelled = true;
          item.controller?.abort();
        }
      return { ok: true };
    }
    if (method === 'attachment.retry') {
      const items = [...uploads.values()].filter(
        (item) =>
          item.base === params.requestId &&
          item.instanceId === binding?.instanceId,
      );
      if (!items.length) fail('上传暂存已过期，请重新选择文件。', 'missing');
      const attachments = [];
      for (const item of items)
        attachments.push((await uploadRecord(item)).attachment);
      return { attachments };
    }
    if (
      params.expectedInstanceId &&
      params.expectedInstanceId !== binding?.instanceId
    )
      fail('Bot 连接已更换，旧操作已取消。', 'conflict');
    if (method === 'models.sync') {
      if (!online) fail('恢复连接后才能同步模型。', 'offline');
      if (syncInFlight || syncStatus?.phase === 'unknown')
        fail('请先核对上次模型同步结果。', 'needs-review');
      const identity = binding.instanceId;
      syncStatus = {
        instanceId: identity,
        requestId: params.requestId ?? 'sync-' + randomUUID(),
        keys: params.keys,
        phase: 'sending',
        at: Date.now(),
      };
      syncInFlight = true;
      atomicJson(syncFile, syncStatus);
      publish();
      try {
        const result = await sync(
          binding.host,
          identity,
          params.keys,
          syncStatus.requestId,
        );
        if (binding?.instanceId === identity) {
          syncStatus = {
            ...syncStatus,
            phase: 'confirmed',
            results: result.results,
          };
          atomicJson(syncFile, syncStatus);
        }
        await refresh();
        record('models.sync', 'confirmed');
        return result;
      } catch (e) {
        record('models.sync', 'failed', e.code ?? 'failed');
        if (binding?.instanceId === identity) {
          syncStatus = {
            ...syncStatus,
            phase: ['offline', 'needs-review'].includes(e.code)
              ? 'unknown'
              : 'not-received',
          };
          atomicJson(syncFile, syncStatus);
          publish();
        }
        throw e;
      } finally {
        syncInFlight = false;
      }
    }
    if (method === 'models.reconcile') return refresh();
    if (method === 'models.dismiss') {
      if (syncInFlight || syncStatus?.phase === 'unknown')
        fail('请先核对同步结果。', 'needs-review');
      syncStatus = null;
      atomicJson(syncFile, null);
      return publish();
    }
    if (method === 'component.update') {
      if (!online) fail('恢复连接后才能维护组件。', 'offline');
      const info = await transport.probe(binding.host);
      if (info.bot?.instanceId !== binding.instanceId)
        fail('Bot 身份不同，已停止维护。', 'conflict');
      await direct('maintenance.begin');
      try {
        await ensureArchive();
        const updated = await transport.install(binding.host, info);
        if (updated.instanceId !== binding.instanceId)
          fail('维护后的实例身份不同，请保留数据并检查服务。', 'conflict');
        binding.version = updated.version;
        atomicJson(connectionFile, binding);
        return await refresh();
      } finally {
        try {
          await direct('maintenance.end');
        } catch {
          online = false;
          error = '维护结果待核对，请重新连接。';
          publish();
        }
      }
    }
    if (method === 'candidate.start') {
      if (!candidate) fail('连接信息已过期。', 'conflict');
      await transport.control(candidate.host, 'start');
      candidate.info = await transport.probe(candidate.host);
      return publish();
    }
    if (method === 'connection.reconnect') {
      disconnected = false;
      retryCount = 0;
      retryAt = 0;
      const result = await refresh();
      if (!online) fail(error, 'offline');
      return result;
    }
    if (method === 'connection.disconnect') {
      await transport.disconnect?.();
      disconnected = true;
      online = false;
      error = '连接已断开，云端可能仍在运行。';
      publish();
      return { ok: true };
    }
    if (method === 'service.start') {
      if (!binding) fail('没有 Bot 连接。');
      await transport.control(binding.host, 'start');
      await direct('service.start');
      disconnected = false;
      stoppedConfirmed = false;
      return refresh();
    }
    if (method === 'service.stop') {
      if (!online) fail('恢复连接后才能确认停止 Bot。', 'offline');
      await direct('service.stop');
      await refresh();
      await transport.control(binding.host, 'stop');
      stoppedConfirmed = true;
      online = false;
      error = 'Bot 已停止';
      return publish();
    }
    if (method === 'connection.forget') {
      await transport.disconnect?.();
      binding = null;
      cache = null;
      activeId = null;
      syncStatus = null;
      atomicJson(syncFile, null);
      for (const item of uploads.values()) item.controller?.abort();
      uploads.clear();
      localDrafts = { instanceId: null, items: {} };
      atomicJson(draftsFile, localDrafts);
      atomicJson(connectionFile, null);
      atomicJson(cacheFile, null);
      online = false;
      candidate = null;
      publish();
      return { ok: true };
    }
    if (method === 'connection.address') {
      const host = String(params.host ?? '').trim();
      if (!isValidSshTarget(host)) fail('请输入有效 SSH 地址。');
      const info = await transport.probe(host);
      if (info.bot?.instanceId !== binding?.instanceId)
        fail('新地址不是原来的 Bot，已保留原绑定。', 'conflict');
      binding = { ...binding, host };
      atomicJson(connectionFile, binding);
      return refresh();
    }
    if (method === 'connection.remove') {
      if (!binding) return { ok: true };
      if (!online && !stoppedConfirmed)
        fail('恢复连接并确认停止后才能移除绑定。', 'offline');
      if (!stoppedConfirmed) {
        await direct('service.stop');
        await transport.control(binding.host, 'stop');
      }
      binding = null;
      cache = null;
      activeId = null;
      syncStatus = null;
      atomicJson(syncFile, null);
      for (const item of uploads.values()) item.controller?.abort();
      uploads.clear();
      localDrafts = { instanceId: null, items: {} };
      atomicJson(draftsFile, localDrafts);
      online = false;
      candidate = null;
      atomicJson(connectionFile, null);
      atomicJson(cacheFile, null);
      publish();
      return { ok: true };
    }
    if (!METHODS.has(method)) fail('不支持的 Bot 操作。', 'unsupported');
    if (method === 'session.draft') {
      if (!binding) fail('没有 Bot 连接。');
      if (!cache?.sessions.some((s) => s.id === params.id))
        fail('会话不属于当前 Bot。', 'missing');
      const latest =
        localDrafts.items[params.id] ?? cache.details[params.id]?.draft;
      if (latest && params.revision < latest.revision)
        return { ok: false, code: 'conflict', draft: latest };
      localDrafts.instanceId = binding.instanceId;
      localDrafts.items[params.id] = {
        text: params.text,
        revision: params.revision,
        references: params.references ?? [],
        skills: params.skills ?? [],
        attachmentIds: params.attachmentIds ?? [],
      };
      atomicJson(draftsFile, localDrafts);
      if (cache?.details[params.id])
        cache.details[params.id].draft = localDrafts.items[params.id];
      publish();
      if (!online) return { ok: true, local: true };
    }

    if (!online) fail('连接已断开，草稿保留；请重新连接后操作。', 'offline');
    const identity = binding.instanceId;
    if (method === 'session.remove' && activeId === params.id) activeId = null;
    if (method === 'session.open' && params.activate !== false)
      activeId = params.id;
    const result = await direct(method, params);
    if (binding?.instanceId !== identity)
      fail('连接已更换，旧结果已丢弃。', 'conflict');
    if (method === 'session.open' && params.activate !== false && cache) {
      cache.selectedId = activeId;
      atomicJson(cacheFile, cache);
    }
    if (method === 'session.draft' && result.ok) {
      if (localDrafts.items[params.id]?.revision === params.revision)
        delete localDrafts.items[params.id];
      atomicJson(draftsFile, localDrafts);
    }
    if (
      ![
        'snapshot',
        'flow.snapshot',
        'directory.list',
        'attachment.read',
        'attachment.document',
        'file.read',
        'file.resolve',
        'references',
        'skills',
        'operation.get',
        'diagnostics',
      ].includes(method)
    )
      await refresh();
    return result;
  }
  let nextPollAt = 0;
  const timer = setInterval(() => {
    if (
      Date.now() >= nextPollAt &&
      binding &&
      !closed &&
      !disconnected &&
      !stoppedConfirmed &&
      (online || (retryCount < 4 && Date.now() >= retryAt))
    ) {
      nextPollAt =
        Date.now() +
        (online && !cache?.sessions.some((s) => s.status) ? 4000 : 1200);
      void refresh();
    }
  }, 1200);
  timer.unref?.();
  return {
    getState,
    diagnostics: () => ({
      events: structuredClone(diagnosticEvents),
      lastFailure:
        diagnosticEvents.findLast((e) => e.outcome === 'failed') ?? null,
    }),
    refresh,
    modelCandidates,
    async connect({ host, password, rememberPassword = false } = {}) {
      host = String(host ?? '').trim();
      if (!isValidSshTarget(host)) fail('请输入 SSH Host 或 user@host。');
      if (busy) fail('正在处理连接，请稍候。', 'busy');
      busy = 'probe';
      error = '';
      publish();
      try {
        if (password)
          runner.rememberPassword?.(host, password, {
            remember: rememberPassword,
          });
        const info = await transport.probe(host);
        candidate = { id: 'candidate-' + randomUUID(), host, info };
        return publish();
      } catch (e) {
        record('probe', 'failed', e.code ?? 'failed');
        error = e.message;
        throw e;
      } finally {
        busy = '';
        publish();
      }
    },
    async initialize({
      candidateId,
      modelKeys,
      existing = false,
      requestId,
    } = {}) {
      if (!candidate || candidate.id !== candidateId)
        fail('连接信息已过期，请重新探测。', 'conflict');
      if (busy) fail('正在初始化，请稍候。', 'busy');
      const selected = candidate;
      const cancellation = new AbortController();
      initializationAbort = cancellation;
      busy = 'initialize';
      error = '';
      publish();
      try {
        let info = selected.info.bot;
        if (existing) {
          if (!info?.configured) fail('原 Bot 尚未初始化完成。');
        } else {
          if (!info) {
            busy = 'deploy';
            publish();
            await ensureArchive();
            info = await transport.install(
              selected.host,
              selected.info,
              cancellation.signal,
            );
            selected.info.bot = info;
            selected.info.existing = true;
          }
          if (info.protocol !== BOT_PROTOCOL)
            fail('云端版本不兼容。', 'unsupported');
          busy = 'models';
          publish();
          const result = await sync(
            selected.host,
            info.instanceId,
            modelKeys,
            requestId,
            cancellation.signal,
          );
          if (!result.results?.some((item) => item.ok))
            fail('没有模型通过云端验证，请检查模型配置后重试。');
        }
        if (!existing)
          await transport.rpc(selected.host, 'initialize.verify', {
            instanceId: info.instanceId,
            requestId: 'verify-' + randomUUID(),
          });
        busy = 'verify-residency';
        publish();
        await transport.disconnect?.();
        if (cancellation.signal.aborted)
          fail('已停止等待，请重新连接核对云端初始化状态。', 'needs-review');
        const verify = await transport.rpc(selected.host, 'handshake');
        if (
          verify.instanceId !== info.instanceId ||
          verify.bootId !== info.bootId ||
          !verify.configured
        )
          fail('云端初始化结果尚未确认。', 'needs-review');
        disconnected = false;
        stoppedConfirmed = false;
        localDrafts = { instanceId: verify.instanceId, items: {} };
        atomicJson(draftsFile, localDrafts);
        binding = {
          host: selected.host,
          instanceId: verify.instanceId,
          protocol: verify.protocol,
          version: verify.version,
          home: verify.home,
          dataDir: verify.dataDir,
          boundAt: Date.now(),
        };
        cache = null;
        activeId = null;
        atomicJson(connectionFile, binding);
        candidate = null;
        await refresh();
        return publish();
      } catch (e) {
        record(busy || 'initialize', 'failed', e.code ?? 'failed');
        error = e.code ? e.message : '初始化未能确认，请重连检查原安装状态。';
        throw e;
      } finally {
        initializationAbort = null;
        busy = '';
        publish();
      }
    },
    async candidatesDirectory(candidateId, raw) {
      if (candidate?.id !== candidateId) fail('连接信息已过期。', 'conflict');
      const info = candidate.info;
      if (info.bot)
        return transport.rpc(candidate.host, 'directory.list', {
          instanceId: info.bot.instanceId,
          path: raw,
        });
      return transport.directory(candidate.host, raw ?? info.home);
    },
    command: routeCommand,
    async upload({
      id,
      name,
      bytes,
      source = 'picker',
      requestId,
      baseRequestId,
    }) {
      if (!online) fail('恢复连接后才能上传附件。', 'offline');
      if (!cache?.sessions.some((s) => s.id === id))
        fail('会话不属于当前 Bot。', 'missing');
      if (!Buffer.isBuffer(bytes) || bytes.length > 20 * 1024 * 1024)
        fail('附件超过大小限制。');
      for (const [key, item] of uploads)
        if (
          Date.now() - item.at > 600000 ||
          item.instanceId !== binding.instanceId
        )
          uploads.delete(key);
      if (
        [...uploads.values()].reduce(
          (sum, item) => sum + (item.bytes?.length ?? 0),
          0,
        ) +
          bytes.length >
        64 * 1024 * 1024
      )
        fail('请先完成或取消其他附件上传。', 'busy');
      const key = requestId ?? 'upload-' + randomUUID(),
        item = {
          key,
          base: baseRequestId ?? key,
          id,
          name,
          bytes,
          source,
          instanceId: binding.instanceId,
          host: binding.host,
          at: Date.now(),
          controller: new AbortController(),
        };
      uploads.set(key, item);
      return uploadRecord(item);
    },
    async download(id, artifactId) {
      if (!online) fail('恢复连接后才能下载云端文件。', 'offline');
      return direct('file.download', { id, artifactId });
    },
    async close() {
      closed = true;
      clearInterval(timer);
      initializationAbort?.abort();
      for (const item of uploads.values()) item.controller?.abort();
      uploads.clear();
      runner.close?.();
    },
  };
}
