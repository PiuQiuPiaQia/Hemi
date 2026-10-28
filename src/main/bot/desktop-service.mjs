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
import { manualProviderModels } from './models.mjs';
import { modelSyncChanges, selectedModelChanges } from './model-sync.mjs';
import {conversationStatus,newSettledRuns} from '../../shared/conversation-status.mjs';
import { applyFlowChange } from '../../shared/conversation-flow.mjs';
import {readComponentVersion, componentUpdateNeeded} from './component-version.mjs';
import { createBotOAuthLogin } from './oauth-login.mjs';
import { deviceEndpoint } from './device-gateway.mjs';

const METHODS = new Set([
  'agent-environment.inspect',
  'agent-environment.read-file',
  'snapshot',
  'session.open',
  'session.control',
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
  'capabilities.inspect', 'capabilities.configure',
  'context.windows', 'context.capture',
  'skills.state', 'skills.refresh', 'skills.import', 'skills.install', 'skills.set-enabled', 'skills.remove', 'skills.read',
  'skills.search', 'skills.preview', 'skills.mp-install', 'skills.check-update',
  'operation.get',
  'diagnostics',
  'pairing.status',
  'pairing.operation',
  'pairing.configure',
  'pairing.disable',
  'pairing.create',
  'pairing.approve',
  'pairing.reject',
  'pairing.cancel',
  'devices.list',
  'devices.revoke',
]);
const fingerprint = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const COMPONENT_CHECK_INTERVAL = 6 * 60 * 60 * 1000;
const COMPONENT_IDLE_RETRY = 60 * 1000;
const COMPONENT_INITIAL_DELAY = 30 * 1000;
export function createBotDesktopService({
  userDataDir,
  runner,
  profiles,
  archivePath,
  onChanged = () => {},
  onConversationResult = () => {},
  transport = createBotTransport({ runner, archivePath }),
  ensureArchive = async () => {},
  autoComponentUpdates = true,
  openExternal = async () => {},
  modelPreviewTimeoutMs = 15000,
}) {
  let oauthLogin = null, oauthIdentity = null;
  function clearOAuthLogin() { oauthLogin?.dispose(); oauthLogin = null; oauthIdentity = null; }
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
  const clientFile=path.join(dir,'client.json');
  const clientId=localJson(clientFile,null)?.id ?? randomUUID();
  atomicJson(clientFile,{id:clientId});
  const diagnosticsFile = path.join(dir, 'diagnostics.json');
  const diagnosticEvents = localJson(diagnosticsFile, []);
  const record = (stage, outcome, code = null) => {
    diagnosticEvents.push({ at: Date.now(), stage, outcome, code });
    diagnosticEvents.splice(0, Math.max(0, diagnosticEvents.length - 40));
    atomicJson(diagnosticsFile, diagnosticEvents);
  };
  let syncStatus = localJson(syncFile, null),
    syncInFlight = false;
  const modelPreviews = new Map();
  let componentStatus = null, componentWork = null, componentTimer = null, componentScope = null, componentNextCheckAt = 0;
  if (syncStatus?.phase === 'sending')
    syncStatus = { ...syncStatus, phase: 'unknown' };
  let localDrafts = localJson(draftsFile, { instanceId: null, items: {} });
  let retryCount = 0,
    retryAt = 0,
    retryBlocked = false;
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
  if (binding?.platform) transport.setPlatform?.(binding.host, binding.platform);
  if (cache?.instanceId !== binding?.instanceId) cache = null;
  activeId = cache?.selectedId ?? null;
  if (syncStatus?.instanceId !== binding?.instanceId) syncStatus = null;
  if (localDrafts.instanceId !== binding?.instanceId)
    localDrafts = { instanceId: binding?.instanceId ?? null, items: {} };
  const publish = () => {
    ensureRealtime();
    scheduleComponentCheck();
    const value = getState();
    onChanged(value);
    return value;
  };
  function getState() {
    return {
      clientId,
      binding: binding ? { ...binding } : null,
      online,
      error,
      busy,
      componentStatus: componentStatus ? {...componentStatus} : null,
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
    }, {clientId});
  }
  async function installComponent(info, expected) {
    const identity = binding.instanceId;
    if (info.bot?.instanceId !== identity) fail('Bot 身份不同，已停止维护。', 'conflict');
    await direct('maintenance.begin');
    try {
      // Another PC may have completed the same update while this PC prepared it.
      const current = await direct('handshake');
      if (expected && !componentUpdateNeeded(expected, current.componentVersion)) return current;
      const updated = await transport.install(binding.host, {...info, bot: current});
      if (updated.instanceId !== identity || binding?.instanceId !== identity)
        fail('维护后的实例身份不同，请保留数据并检查服务。', 'conflict');
      if (expected && updated.componentVersion?.build !== expected.build)
        fail('云端组件版本未能核验，请重新连接后重试。', 'needs-review');
      binding.version = updated.version;
      binding.componentVersion = updated.componentVersion ?? undefined;
      atomicJson(connectionFile, binding);
      return updated;
    } finally {
      if (binding?.instanceId === identity) await direct('maintenance.end').catch(() => {
        online = false; error = '维护结果待核对，请重新连接。'; publish();
        fail(error, 'needs-review');
      });
    }
  }
  function scheduleComponentCheck() {
    const scope = binding ? JSON.stringify([binding.instanceId, binding.host]) : null;
    if (scope !== componentScope) {
      clearTimeout(componentTimer); componentTimer = null;
      componentScope = scope;
      componentStatus = null;
      componentNextCheckAt = Date.now() + COMPONENT_INITIAL_DELAY;
    }
    if (!autoComponentUpdates || !binding || !online || closed || disconnected || stoppedConfirmed) {
      clearTimeout(componentTimer); componentTimer = null;
      return;
    }
    if (componentTimer || componentWork || busy) return;
    componentTimer = setTimeout(() => {
      componentTimer = null;
      void ensureCurrentComponent({automatic: true});
    }, Math.max(0, componentNextCheckAt - Date.now()));
    componentTimer.unref?.();
  }
  async function ensureCurrentComponent({active = true, automatic = false} = {}) {
    // Page visibility no longer owns the background updater. Accept legacy
    // leave-page calls without cancelling the service's schedule.
    if (!active || closed || (automatic && !autoComponentUpdates)) return getState();
    if (componentWork) { await componentWork; return getState(); }
    // Page changes and failures share the same long backoff. A manual check
    // from settings can retry immediately.
    if (automatic && Date.now() < componentNextCheckAt) return getState();
    clearTimeout(componentTimer); componentTimer = null;
    componentNextCheckAt = Date.now() + COMPONENT_CHECK_INTERVAL;
    componentWork = Promise.resolve().then(async () => {
      if (!binding || !online || busy || disconnected || stoppedConfirmed) {
        componentNextCheckAt = Date.now() + COMPONENT_IDLE_RETRY;
        componentStatus = {phase: 'waiting', message: '连接恢复并空闲后自动更新云端组件'};
        return;
      }
      const identity = binding.instanceId, host = binding.host;
      componentStatus = {...componentStatus, phase: 'checking', message: undefined}; publish();
      try {
        await ensureArchive();
        const local = archivePath && readComponentVersion(archivePath + '.manifest.json');
        if (!local) fail('本机缺少云端组件版本清单，请更新 Hemi 后重试。', 'missing');
        const info = await transport.probe(host);
        if (closed || disconnected || stoppedConfirmed || binding?.instanceId !== identity || binding?.host !== host) return;
        if (info.bot?.instanceId !== identity) fail('Bot 身份不同，已停止自动更新。', 'conflict');
        binding.componentVersion = info.bot.componentVersion ?? undefined;
        atomicJson(connectionFile, binding);
        componentStatus = {phase: 'current', checkedAt: Date.now(), localVersion: local.version, remoteVersion: info.bot.componentVersion?.version};
        if (!componentUpdateNeeded(local, info.bot.componentVersion)) return;
        if (info.bot.activeJobs || busy) {
          componentNextCheckAt = Date.now() + COMPONENT_IDLE_RETRY;
          componentStatus = {...componentStatus, phase: 'waiting', message: '任务结束后自动更新云端组件'};
          return;
        }
        busy = 'component-update';
        componentStatus = {...componentStatus, phase: 'updating'}; publish();
        const updated = await installComponent(info, local);
        componentStatus = {...componentStatus, phase: 'current', checkedAt: Date.now(), remoteVersion: updated.componentVersion?.version};
        record('component-update', 'confirmed');
        await refresh();
      } catch (e) {
        if (closed || binding?.instanceId !== identity || binding?.host !== host) return;
        componentStatus = {...componentStatus, phase: e.code === 'busy' ? 'waiting' : 'failed', message: e.message};
        if (e.code === 'busy') componentNextCheckAt = Date.now() + COMPONENT_IDLE_RETRY;
        if (e.code !== 'busy') record('component-update', 'failed', e.code ?? 'failed');
      } finally {
        if (busy === 'component-update') busy = '';
      }
    }).finally(() => {
      componentWork = null; publish();
    });
    await componentWork;
    return getState();
  }
  let stream=null, streamCursor=null, streamScope='', streamRetryAt=0, streamFailures=0, refreshAgain=false, eventRefresh=null, streamReconnect=null;
  const olderCatalog = value => cache?.bootId && value.bootId === cache.bootId && value.revision < cache.revision;
  function applySessionReceipt(value, method, params, result) {
    if (!value || value.instanceId !== binding?.instanceId) return false;
    if (olderCatalog(value)) return true;
    const details = {};
    for (const session of value.sessions) {
      if (cache?.details[session.id]) details[session.id] = {...cache.details[session.id], ...session};
    }
    if (value.detail) details[value.detail.id] = value.detail;
    for (const [id, draft] of Object.entries(localDrafts.items)) {
      if (!value.sessions.some(session => session.id === id)) delete localDrafts.items[id];
      else if (details[id]) details[id].draft = draft;
    }
    if (method === 'session.create' && details[result.id]) activeId = result.id;
    if (method === 'session.remove' && activeId === params.id) activeId = null;
    cache = {...value, details, detailRevisions: {}, selectedId: activeId, syncedAt: Date.now()};
    delete cache.detail;
    atomicJson(cacheFile, cache);
    atomicJson(draftsFile, localDrafts);
    publish();
    return true;
  }
  function changedCatalog() {
    if(polling){refreshAgain=true;return;}
    if(!eventRefresh)eventRefresh=setTimeout(()=>{eventRefresh=null;void refresh();},60);
  }
  function ensureRealtime() {
    const id=activeId ?? cache?.sessions[0]?.id ?? null;
    const scope=binding ? `${binding.host}:${binding.instanceId}:${id}` : '';
    if(stream && (scope!==streamScope || closed || disconnected || stoppedConfirmed || !online)){stream.abort();stream=null;}
    if(scope!==streamScope){streamCursor=null;streamScope=scope;streamFailures=0;streamRetryAt=0;}
    if(!transport.watch || stream || !binding || !online || closed || disconnected || stoppedConfirmed || Date.now()<streamRetryAt)return;
    const controller=new AbortController(), identity=binding.instanceId;stream=controller;
    void transport.watch(binding.host,{instanceId:identity,id,cursor:streamCursor},{signal:controller.signal,clientId,onEvent(frame){
      if(controller.signal.aborted || binding?.instanceId!==identity)return;
      if(frame.type==='heartbeat')return;
      if(frame.version!==1 || frame.instanceId!==identity || !Number.isSafeInteger(frame.sequence))throw new Error('Invalid Bot event');
      if(frame.type==='reset'){
        const value=frame.snapshot;
        if(value?.instanceId!==identity)throw new Error('Invalid Bot reset');
        if (olderCatalog(value)) {changedCatalog(); return;}
        const details={...cache?.details};
        for(const key of Object.keys(details))if(!value.sessions.some(s=>s.id===key))delete details[key];
        if(value.detail){
          const previous=details[value.detail.id];
          if(cache?.bootId===frame.bootId && previous?.flow?.revision>value.detail.flow.revision)value.detail.flow=previous.flow;
          details[value.detail.id]=value.detail;
        }
        for(const [key,draft] of Object.entries(localDrafts.items))if(details[key])details[key].draft=draft;
        cache={...value,details,detailRevisions:{},selectedId:activeId,syncedAt:Date.now()};delete cache.detail;
      } else if(frame.type==='flow'){
        const detail=cache?.details?.[frame.id];
        if(!detail){changedCatalog();}
        else if(frame.change.revision>detail.flow.revision){
          const next=applyFlowChange(detail.flow,frame.change);
          if(!next.ok)changedCatalog();else{
            const fresh=newSettledRuns({flow:detail.flow},next.snapshot);
            detail.flow=next.snapshot;
            for(const run of fresh){const input=detail.flow.timeline.find(x=>x.kind==='user'&&run.inputIds?.includes(x.id));onConversationResult({conversationId:frame.id,conversationTitle:detail.title,outcome:run.outcome,preview:input?.text??''});}
            cache.sessions=cache.sessions.map(s=>s.id===frame.id?{...s,status:conversationStatus(detail.flow,{live:true}),waitingForUser:Boolean(detail.flow.awaitingUser),turnCount:detail.flow.timeline.length}:s);
          }
        }
      } else if(frame.type==='catalog')changedCatalog();
      streamCursor={bootId:frame.bootId,sequence:frame.sequence,id};
      streamFailures=0;lastConnectedAt=Date.now();
      if(frame.type==='reset' || frame.type==='flow')onChanged(getState());
    }}).catch(()=>{}).finally(()=>{
      if(stream!==controller)return;
      stream=null;
      if(!controller.signal.aborted){
        const delay=Math.min(30000,500*2**Math.min(streamFailures++,6));streamRetryAt=Date.now()+delay;
        clearTimeout(streamReconnect);streamReconnect=setTimeout(()=>{streamReconnect=null;ensureRealtime();void refresh();},delay);
        changedCatalog();
      }
    });
  }
  async function refresh() {
    if (!binding || closed || disconnected || stoppedConfirmed) return getState();
    if (polling) return polling;
    const identity = binding.instanceId,
      host = binding.host,
      target = activeId ?? cache?.sessions[0]?.id,
      initialBoot = cache?.bootId;
    const stale = () => closed || disconnected || stoppedConfirmed ||
      binding?.instanceId !== identity || binding?.host !== host;
    polling = (async () => {
      try {
        if (stale()) return getState();
        if (!online) {
          const hello = await direct('handshake');
          if (stale()) return getState();
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
        if (stale()) return getState();
        // A command receipt may overtake a poll already on the wire. It must
        // never resurrect a removed session or revert a confirmed model change.
        if (olderCatalog(snapshot)) return getState();
        if(cache?.bootId!==initialBoot && snapshot.bootId && snapshot.bootId!==cache?.bootId)return getState();
        if (
          snapshot.notModified &&
          binding?.instanceId === identity &&
          binding?.host === host
        ) {
          const changed = !online;
          const devicesChanged = JSON.stringify(cache?.deviceAccess) !== JSON.stringify(snapshot.deviceAccess);
          if (cache) cache.deviceAccess = snapshot.deviceAccess;
          online = true;
          retryCount = 0;
          retryAt = 0;
          retryBlocked = false;
          error = '';
          lastConnectedAt = Date.now();
          if (cache && lastConnectedAt - (cache.syncedAt ?? 0) > 30000) {
            cache.syncedAt = lastConnectedAt;
            atomicJson(cacheFile, cache);
          }
          ensureRealtime();
          return changed || devicesChanged ? publish() : getState();
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
        if (snapshot.detail) {
          const previous=details[snapshot.detail.id];
          if((!snapshot.bootId||snapshot.bootId===cache?.bootId)&&previous?.flow?.revision>snapshot.detail.flow.revision)snapshot.detail.flow=previous.flow;
          details[snapshot.detail.id] = snapshot.detail;
        }
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
          if (stale()) return getState();
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
        if (olderCatalog(snapshot)) return getState();
        if (activeId && !snapshot.sessions.some((s) => s.id === activeId))
          activeId = null;
        // Draft receipts above can await SSH while realtime advances the flow.
        // Recheck at the commit boundary so this refresh cannot restore an old
        // generation after the new one has already been shown to the renderer.
        if (!snapshot.bootId || snapshot.bootId === cache?.bootId) {
          for (const [id, detail] of Object.entries(details)) {
            const latest = cache?.details?.[id]?.flow;
            if (latest && latest.revision > detail.flow.revision) {
              details[id] = {...detail, flow: latest};
              snapshot.sessions = snapshot.sessions.map(session => session.id === id
                ? {...session, status: latest.phase === 'idle' ? null : 'running', turnCount: latest.timeline.length}
                : session);
            }
          }
        }
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
        retryBlocked = false;
        error = draftConflict;
        lastConnectedAt = Date.now();
        atomicJson(cacheFile, cache);
        if (syncStatus?.phase === 'unknown' && !syncInFlight) {
          const receipt = await direct('operation.get', {
            operationId: syncStatus.requestId,
          });
          if (stale()) return getState();
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
        if (!stale()) {
          online = false;
          retryBlocked = ['permission', 'conflict', 'unsupported'].includes(e.code);
          retryCount = Math.min(4, retryCount + 1);
          retryAt =
            Date.now() +
            [1000, 5000, 15000, 60000][Math.min(3, retryCount - 1)];
          error = e.code ? e.message : '无法读取 Bot 状态，请重新连接。';
          publish();
        }
        return getState();
      } finally {
        polling = null;
        if(refreshAgain){refreshAgain=false;changedCatalog();}
      }
    })();
    return polling;
  }
  async function localModelConfig() {
    const list = await profiles.list();
    if (list.corrupt) fail('本机模型配置无法读取，云端原配置已保留。', 'invalid');
    const candidates = [], models = [];
    for (const provider of list.providers) {
      for (const model of provider.models) {
        const resolved = provider.oauthProvider
          ? null
          : await profiles.resolveStrict(model.modelKey);
        const config = resolved?.ok ? { ...resolved.config, ...(/^mpi-/.test(provider.id) ? { configuration: 'newapi' } : {}) } : null;
        const revision = config ? fingerprint(syncModelConfig(config)) : null;
        const remote = cache?.models?.find((v) => v.key === model.modelKey);
        let reason = provider.oauthProvider
          ? '请在 Bot 模型设置中单独登录账号'
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
        if (!reason) models.push(config);
        candidates.push({
          key: model.modelKey,
          ...(provider.oauthProvider ? { oauthProvider: provider.oauthProvider } : {}),
          providerId: provider.id,
          baseUrl: provider.baseUrl,
          api: config?.api ?? provider.api ?? 'openai-completions',
          supportsVision: model.supportsVision ?? false,
          thinkingLevel: model.thinkingLevel ?? 'default',
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
    return { models, candidates };
  }
  async function modelCandidates() {
    return (await localModelConfig()).candidates;
  }
  async function sendModels(host, params, signal) {
    const method = params.expectedModelRevision !== undefined ? 'model.configure' : params.source === 'manual' ? 'model.sync' : 'model.sync-local';
    try {
      return await transport.rpc(host, method, params, { signal });
    } catch (error) {
      if (error.code === 'unsupported')
        error.message = '请先在 Bot 通用设置中维护云端组件，再修改或同步模型配置。';
      throw error;
    }
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
      'candidate.start',
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
      if (method !== 'candidate.start') record(method, 'confirmed');
      return result;
    } catch (error) {
      record(method, 'failed', error.code ?? 'failed');
      throw error;
    } finally {
      busy = '';
      publish();
    }
  }
  async function startCandidate(host, info) {
    try {
      await transport.control(host, 'start');
      const ready = await transport.probe(host);
      if (!ready.bot || ready.serviceError)
        fail('启动后仍未收到 Bot 响应，请稍后重试。', 'offline');
      record('candidate.start', 'confirmed');
      return ready;
    } catch (e) {
      record('candidate.start', 'failed', e.code ?? 'failed');
      return { ...info, serviceError: '自动启动 Bot 未成功：' + e.message };
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
    if (method === 'component.ensure-current') return ensureCurrentComponent(params);
    if (method.startsWith('oauth.')) {
      if (!['oauth.start', 'oauth.state', 'oauth.answer', 'oauth.cancel', 'oauth.logout'].includes(method)) fail('不支持的账号操作。', 'unsupported');
      if (oauthIdentity !== binding?.instanceId) clearOAuthLogin();
      if (method === 'oauth.state') return oauthLogin?.getState() ?? null;
      if (method === 'oauth.cancel') return await oauthLogin?.cancel(params.id) ?? null;
      if (!online || !binding) fail('恢复连接后才能登录 Bot 账号。', 'offline');
      if (method === 'oauth.logout') {
        if (oauthLogin?.getState()?.phase === 'login') fail('请先完成或取消当前登录。', 'busy');
        const result = await direct('oauth.logout', { provider: params.provider });
        clearOAuthLogin(); await refresh(); return result;
      }
      if (!oauthLogin) {
        const identity = binding.instanceId, host = binding.host;
        const check = () => { if (closed || !online || binding?.instanceId !== identity || binding?.host !== host) fail('Bot 连接已更换或断开，请重新登录。', 'conflict'); };
        oauthIdentity = identity;
        oauthLogin = createBotOAuthLogin({ openExternal,
          prepare: async () => {
            check(); const hello = await direct('handshake'); check();
            if (hello.capabilities?.botOAuth !== 1) fail('请先更新 Bot 运行组件，再登录订阅账号。', 'unsupported');
            const result = await direct('oauth.prepare'); check(); return result;
          },
          install: async (provider, credential) => {
            check(); const result = await direct('oauth.import', { provider, credential });
            check(); await refresh(); return result;
          },
        });
      }
      return method === 'oauth.start' ? oauthLogin.start(params.provider) : oauthLogin.answer(params);
    }
    if (method === 'models.test' || method === 'models.list') {
      if (!online) fail('恢复连接后才能验证模型。', 'offline');
      // Draft credentials go straight to the Host; never persist them in local
      // operation receipts, diagnostics, the model directory or Bot cache.
      try {
        return await direct(method === 'models.test' ? 'model.test' : 'model.list', { config: params.config, modelKey: params.modelKey });
      } catch (error) {
        if (error.code !== 'unsupported') throw error;
        return { ok: false, error: '请先在 Bot 设置中重新部署云端组件，再测试连接或拉取型号；也可手动填写型号后直接添加。' };
      }
    }
    if (method === 'models.roles') {
      if (!online) fail('恢复连接后才能配置模型路由。', 'offline');
      return direct('model.roles');
    }
    if (method === 'models.save' && cache?.models.some(model => model.providerId === params.provider?.id && model.oauthProvider)) {
      if (!online) fail('恢复连接后才能修改账号型号。', 'offline');
      const result = await direct('model.account-config', { providerId: params.provider.id, models: params.provider.models, expectedModelRevision: params.expectedModelRevision, requestId: params.requestId });
      await refresh(); return result;
    }
    if (method === 'models.remove') {
      if (!online) fail('恢复连接后才能删除模型配置。', 'offline');
      const removed = cache.models.filter(model => model.providerId === params.providerId), keys = new Set(removed.map(model => model.key));
      if (!keys.size) fail('供应商已不存在，请重新读取。', 'missing');
      const roleModels = Object.fromEntries(Object.entries(cache.roleModels ?? {}).flatMap(([slot, key]) => keys.has(key) ? params.replacementModelId ? [[slot, params.replacementModelId]] : [] : [[slot, key]]));
      const result = await direct('model.configure', { models: [], removeKeys: [...keys], roleModels, expectedModelRevision: params.expectedModelRevision, requestId: params.requestId });
      if (removed[0].oauthProvider) await direct('oauth.logout', { provider: removed[0].oauthProvider });
      await refresh(); return result;
    }
    if (method === 'models.diff') {
      if (!online) fail('恢复连接后才能对比模型配置。', 'offline');
      const identity = binding.instanceId, host = binding.host;
      // The live catalog already includes the Host's model version. A second
      // SSH snapshot only delays this read-only preview; configure validates
      // the captured version again before applying any selected changes.
      const remote = { models: structuredClone(cache?.models ?? []), roleModels: { ...cache?.roleModels },
        oauthAccounts: structuredClone(cache?.oauthAccounts ?? []), modelConfigRevision: cache?.modelConfigRevision };
      if (!remote.modelConfigRevision) fail('请先在 Bot 通用设置中维护云端组件，再对比模型配置。', 'unsupported');
      let timer;
      const local = await Promise.race([localModelConfig(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('本机模型配置读取超时，请重新对比。'), { code: 'timeout' })), modelPreviewTimeoutMs);
      })]).finally(() => clearTimeout(timer));
      if (binding?.instanceId !== identity || binding?.host !== host || !online || closed) fail('Bot 连接已更换。', 'conflict');
      const preview = { id: randomUUID(), identity, host, remote: { models: remote.models, roleModels: remote.roleModels, modelConfigRevision: remote.modelConfigRevision },
        localRevision: fingerprint(local.models), changes: modelSyncChanges(local, remote) };
      modelPreviews.set(preview.id, preview);
      while (modelPreviews.size > 8) modelPreviews.delete(modelPreviews.keys().next().value);
      return { id: preview.id, changes: preview.changes };
    }
    if (['models.sync', 'models.add', 'models.save', 'models.routing'].includes(method)) {
      if (!online) fail('恢复连接后才能配置模型。', 'offline');
      if (syncInFlight || syncStatus?.phase === 'unknown')
        fail('正在确认模型配置，请稍后重试。', 'needs-review');
      const identity = binding.instanceId, host = binding.host;
      const requestId = params.requestId ?? 'sync-' + randomUUID();
      let providerModels = null, payload;
      if (method === 'models.sync') {
        const preview = modelPreviews.get(params.previewId);
        if (!preview || params.previewId !== preview.id || preview.identity !== identity || preview.host !== host)
          fail('配置对比已过期，请重新对比。', 'conflict');
        const local = await localModelConfig();
        if (fingerprint(local.models) !== preview.localRevision) fail('本机配置已变化，请重新对比后再同步。', 'conflict');
        payload = { ...selectedModelChanges(preview.changes, params.selected, local),
          fromLocal: true, expectedModelRevision: preview.remote.modelConfigRevision };
      } else if (method === 'models.routing') {
        if (!params.roleModels || typeof params.roleModels !== 'object' || Array.isArray(params.roleModels)) fail('路由配置无效。');
        payload = { models: [], roleModels: { ...cache?.roleModels, ...params.roleModels }, expectedModelRevision: params.expectedModelRevision ?? '' };
      } else {
        const editing = method === 'models.save';
        if (editing && !cache?.models.some(model => model.providerId === params.provider?.id)) fail('Bot 供应商已不存在，请重新读取。', 'missing');
        providerModels = manualProviderModels(params.provider, requestId, { allowExisting: editing });
        payload = editing ? { models: providerModels, preserveCredentials: true,
          removeKeys: cache.models.filter(model => model.providerId === params.provider.id && !providerModels.some(next => next.modelKey === model.key)).map(model => model.key),
          expectedModelRevision: params.expectedModelRevision ?? '' } : { models: providerModels, source: 'manual' };
      }
      if (binding?.instanceId !== identity || binding?.host !== host || !online || closed)
        fail('Bot 连接已更换。', 'conflict');
      if (syncInFlight || syncStatus?.phase === 'unknown')
        fail('正在确认模型配置，请稍后重试。', 'needs-review');
      syncStatus = {
        instanceId: identity,
        requestId,
        keys: payload.models.map(model => model.modelKey),
        phase: 'sending',
        at: Date.now(),
      };
      syncInFlight = true;
      atomicJson(syncFile, syncStatus);
      publish();
      try {
        const result = await sendModels(host, {
          instanceId: identity, requestId,
          ...payload,
        });
        if (binding?.instanceId === identity) {
          syncStatus = {
            ...syncStatus,
            phase: 'confirmed',
            results: result.results,
          };
          atomicJson(syncFile, syncStatus);
          publish();
        }
        await refresh();
        record('models.sync', 'confirmed');
        return { ...result, ...(providerModels ? { providerId: providerModels[0].providerId, modelKeys: providerModels.map(model => model.modelKey) } : {}) };
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
      if (params.requestId && params.requestId !== syncStatus?.requestId) return { ok: true };
      if (syncInFlight || syncStatus?.phase === 'unknown')
        fail('请先核对同步结果。', 'needs-review');
      syncStatus = null;
      atomicJson(syncFile, null);
      return publish();
    }
    if (method === 'component.update') {
      if (!online) fail('恢复连接后才能维护组件。', 'offline');
      await ensureArchive();
      const info = await transport.probe(binding.host);
      await installComponent(info);
      return refresh();
    }
    if (method === 'candidate.start') {
      if (!candidate) fail('连接信息已过期。', 'conflict');
      candidate.info = await startCandidate(candidate.host, candidate.info);
      return publish();
    }
    if (method === 'connection.reconnect') {
      streamRetryAt=0;
      disconnected = false;
      retryCount = 0;
      retryAt = 0;
      retryBlocked = false;
      const result = await refresh();
      if (!online) fail(error, 'offline');
      return result;
    }
    if (method === 'connection.disconnect') {
      clearOAuthLogin();
      disconnected = true;
      online = false;
      error = '连接已断开，云端可能仍在运行。';
      publish();
      await transport.disconnect?.();
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
      clearOAuthLogin();
      await transport.disconnect?.();
      binding = null;
      modelPreviews.clear();
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
      clearOAuthLogin();
      binding = { ...binding, host };
      atomicJson(connectionFile, binding);
      return refresh();
    }
    if (method === 'connection.remove') {
      clearOAuthLogin();
      if (!binding) return { ok: true };
      if (!online && !stoppedConfirmed)
        fail('恢复连接并确认停止后才能移除绑定。', 'offline');
      if (!stoppedConfirmed) {
        await direct('service.stop');
        await transport.control(binding.host, 'stop');
      }
      binding = null;
      modelPreviews.clear();
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
    const identity = binding.instanceId, commandHost = binding.host, commandBoot = cache?.bootId;
    if (method === 'pairing.configure' && params.endpoint === undefined) {
      const access = await direct('pairing.status');
      const hostname = access.endpoint ? null : await runner.resolveHostname(commandHost);
      if (binding?.instanceId !== identity || binding?.host !== commandHost || !online || closed || disconnected || stoppedConfirmed)
        fail('连接已更换，旧操作已取消。', 'conflict');
      if (access.enabled) return access;
      const address = hostname?.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
      params = {...params, endpoint: access.endpoint || deviceEndpoint(`https://${address}:29421`)};
    }
    if (method === 'session.open' && params.activate !== false) {
      if (activeId && activeId !== params.id) void direct('session.control', {id: activeId, action: 'release', controlEpoch: cache?.sessions.find(item => item.id === activeId)?.control?.epoch}).catch(() => {});
      activeId = params.id;
      if (cache?.details[params.id]) {
        cache.selectedId = activeId;
        atomicJson(cacheFile, cache);
        publish();
        changedCatalog();
        return structuredClone(cache.details[params.id]);
      }
    }
    if (params.id && ['flow.command', 'session.draft', 'session.update', 'permission.decide', 'context.capture'].includes(method)) {
      const control = cache?.sessions.find(item => item.id === params.id)?.control;
      if (control?.ownerId === clientId && params.controlEpoch === undefined) params = {...params, controlEpoch: control.epoch};
    }
    if (method.startsWith('agent-environment.')) {
      const hello = await direct('handshake');
      if (hello.capabilities?.nativeMemory !== 1) fail('请更新 Bot 运行组件后使用共享记忆。', 'unsupported');
    }
    const fastSession = ['session.create', 'session.update', 'session.remove'].includes(method);
    const result = await direct(method, fastSession ? {...params, includeSnapshot: true} : params);
    if (method === 'session.control' && result.control && cache) {
      cache.sessions = cache.sessions.map(item => item.id === params.id ? {...item, control: result.control} : item);
      if (cache.details[params.id]) cache.details[params.id].control = result.control;
      publish();
    }
    if (binding?.instanceId !== identity || binding?.host !== commandHost || closed || disconnected || stoppedConfirmed)
      fail('连接已更换，旧结果已丢弃。', 'conflict');
    if (fastSession && result.snapshot && cache?.bootId !== commandBoot && result.snapshot.bootId !== cache?.bootId) {
      changedCatalog();
      return result;
    }
    if (fastSession && applySessionReceipt(result.snapshot, method, params, result)) {
      changedCatalog();
      return result;
    }
    if (method === 'session.remove' && activeId === params.id) activeId = null;
    if (method === 'session.open' && params.activate !== false && cache) {
      cache.selectedId = activeId;
      atomicJson(cacheFile, cache);
    }
    if (method === 'session.draft' && result.ok) {
      if (localDrafts.items[params.id]?.revision === params.revision)
        delete localDrafts.items[params.id];
      atomicJson(draftsFile, localDrafts);
    }
    if (method === 'flow.command') {
      // The command receipt already confirms durable acceptance. Let streaming
      // or a background refresh update presentation without another SSH wait.
      changedCatalog();
      return result;
    }
    if (!method.startsWith('pairing.') && !method.startsWith('devices.') &&
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
      (online || (!retryBlocked && Date.now() >= retryAt))
    ) {
      nextPollAt =
        Date.now() +
        (stream ? 30000 : online && !cache?.sessions.some((s) => s.status) ? 4000 : 1200);
      ensureRealtime();
      void refresh();
    }
  }, 1200);
  timer.unref?.();
  return {
    getState,
    importProfiles(expectedInstanceId) {
      const check = () => {
        if (!binding || binding.instanceId !== expectedInstanceId || closed) fail('Bot 连接已更换，导入已保留，请恢复原 Bot 连接。', 'conflict');
        if (!online) fail('恢复 Bot 连接后才能导入 New API 模型。', 'offline');
      };
      return {
        async list() {
          check(); const hello = await direct('handshake'); check();
          if (hello.capabilities?.newapiImport !== 1) fail('请先更新 Bot 运行组件，再导入 New API 模型。', 'unsupported');
          return { providers: [], corrupt: false, envOverride: false };
        },
        async findImportReceipt(operationId) { check(); return direct('model.import-receipt', { operationId }); },
        async importProvidersAtomic(input) {
          check(); const result = await direct('model.import-newapi', { ...input, requestId: input.operationId });
          check(); await refresh(); return result;
        },
      };
    },
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
        let info = await transport.probe(host);
        if (info.serviceError) {
          busy = 'start-service';
          publish();
          info = await startCandidate(host, info);
        }
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
      provider,
      existing = false,
      accountSetup = false,
      requestId,
    } = {}) {
      if (!candidate || candidate.id !== candidateId)
        fail('连接信息已过期，请重新探测。', 'conflict');
      if (busy) fail('正在初始化，请稍候。', 'busy');
      const operationId = requestId ?? 'initialize-' + randomUUID();
      const manual = !existing && provider ? manualProviderModels(provider, operationId) : null;
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
          if (accountSetup && info.capabilities?.botOAuth !== 1) fail('请先更新 Bot 运行组件，再登录订阅账号。', 'unsupported');
          if (!accountSetup) {
          const local = manual ? null : await localModelConfig();
          const result = await sendModels(selected.host, {
            instanceId: info.instanceId, requestId: operationId,
            ...(manual ? { models: manual, source: 'manual' } : { models: local.models }),
          }, cancellation.signal);
          if (!result.results?.length || result.results.some(item => !item.ok))
            fail('模型未通过云端验证，请检查本机配置或填写云端专用配置后重试。');
          }
        }
        if (!existing)
          await transport.rpc(selected.host, 'initialize.verify', {
            instanceId: info.instanceId,
            requestId: 'verify-' + randomUUID(),
            ...(accountSetup ? { accountSetup: true } : {}),
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
          platform: verify.platform,
          instanceId: verify.instanceId,
          protocol: verify.protocol,
          version: verify.version,
          home: verify.home,
          dataDir: verify.dataDir,
          boundAt: Date.now(),
        };
        syncStatus = null;
        atomicJson(syncFile, null);
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
      clearOAuthLogin();
      clearTimeout(componentTimer); componentTimer = null;
      closed = true;
      if (online && activeId) await direct('session.control', {id: activeId, action: 'release', controlEpoch: cache?.sessions.find(item => item.id === activeId)?.control?.epoch}).catch(() => {});
      stream?.abort();clearTimeout(eventRefresh);clearTimeout(streamReconnect);
      clearInterval(timer);
      initializationAbort?.abort();
      for (const item of uploads.values()) item.controller?.abort();
      uploads.clear();
      if (transport.disconnect) await transport.disconnect();
      else runner.close?.();
    },
  };
}
