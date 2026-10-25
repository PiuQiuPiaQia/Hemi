import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { createAgentRuntime } from '../agent-runtime/core.mjs';
import { isNativeSessionReference } from '../agent-runtime/session-reference.mjs';
import { resolveModelPlan, hydrateModelPlan } from '../agent-runtime/model-policy.mjs';
import { createHemiSession } from '../agent/hemi-session.mjs';
import { createRunPartProjector } from '../services/flow-parts-projection.mjs';
import { createTaskFactPublisher } from '../services/task-fact-publisher.mjs';
import { createPermissionService } from '../services/permission-service.mjs';

const TOOLS = ['context_read', 'task_read', 'read', 'write', 'edit', 'ls', 'grep', 'glob', 'bash', 'register_delivery'];
const CLOUD_SYSTEM = '你是 Hemi，运行在用户的 Linux 云服务器上。所有文件和命令都在这台服务器执行。用用户的语言完成已授权的工作。没有本机桌面、麦克风、录屏、语音或浏览器能力；不能宣称已操作用户电脑。敏感操作遵守宿主确认，不绕过门控。生成交付文件时使用 register_delivery 登记真实路径。';

export async function validateCloudModel(config) {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), 'hemi-bot-validation-'),
  );
  const access = createPermissionService({dir: path.join(temporary, 'access-store')});
  let session;
  let timer;
  try {
    // Validation may finish before the default session's asynchronous store load.
    // Own and await initialization so cleanup cannot race its pending writes.
    await access.load();
    session = createHemiSession({
      cwd: temporary,
      agentDir: temporary,
      accessService: access,
      model: config,
      tools: [],
      appendSystem: ['你是 Hemi。仅验证模型连接，回复 OK。'],
      features: {},
      maxRunRequests: 1,
      initTimeoutMs: 20000,
      stallTimeoutMs: 30000,
    });
    const result = await Promise.race([
      (async () => {
        await session.ready();
        return session.prompt('Reply OK.');
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('模型验证超时')), 45000);
        timer.unref?.();
      }),
    ]);
    if (result.modelError || result.aborted || !result.texts.length)
      throw new Error('模型验证失败', {cause:result.modelError || {aborted:result.aborted,textCount:result.texts.length}});
  } finally {
    clearTimeout(timer);
    session?.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Cloud host bindings only. Desktop and Bot share the same execution runtime. */
export function createBotExecutor({dataDir, readEntries, saveEntries, onPermission, onDelivery, recordUsage, getModel, attachmentPrompt, flowService}) {
  const active = new Map(), generations = new Map(), cancelledBeforeStart = new Set();
  const access = createPermissionService({dir: dataDir}), ready = access.load();
  const taskFacts = flowService ? createTaskFactPublisher({flowService}) : null;
  const profilesFor = ctx => ({
    async list() { return {roleModels: {}, defaultModelId: ctx?.policySnapshot?.fixedKey}; },
    async resolveStrict(key) {
      const revision = ctx?.policySnapshot?.revisions?.[key];
      if (!revision) return {ok: false, message: '任务缺少受理时的模型版本。'};
      return {ok: true, config: getModel(key, revision)};
    },
  });
  const deliver = (owner, files) => {
    const pending = Promise.resolve(onDelivery(owner.spec, files));
    void pending.catch(() => {});owner.deliveries.push(pending);
  };
  const runtime = createAgentRuntime({
    userDataDir: dataDir, getProfiles: profilesFor,
    resolveCapabilities: async () => ({visionOn: false, browserOn: false, features: {vision: false, browser: false, web: false}}),
    getAccessService: () => access,
    sessionOptions: {tools: [...TOOLS, 'task', 'task_status', 'task_message', 'task_cancel'], permissionTimeoutMs: 0, controlRoots: [dataDir, path.join(os.homedir(), '.local/share/hemi-bot'), path.join(os.homedir(), '.config/systemd/user/hemi-bot.service'), path.resolve(import.meta.dirname, '../../..')]},
    appendSystem: [CLOUD_SYSTEM], permissionTimeoutMs: 0,
    loadArchiveAgent(id) {
      const owner = active.get(id);if (!owner) return null;
      const entries = readEntries(id, owner.spec.generation, owner.spec.envelope.inputId);
      if (isNativeSessionReference(entries)) return entries;
      return entries?.length ? {header: entries[0], entries: entries.slice(1)} : null;
    },
    loadArchiveTurns: () => [],
    saveArchiveAgent(id, payload) {
      const generation = generations.get(id);return generation === undefined ? false : saveEntries(id, generation, payload);
    },
    onPermissionRequest({conversationId, request, decide}) {
      const owner = active.get(conversationId);if (!owner || owner.ctx.cancelled) return;
      owner.permissions.set(request.id, {request, decide});
      let card = {};try {card = JSON.parse(request.title);} catch {}
      onPermission(owner.spec, {...request, title: typeof card.summary === 'string' ? card.summary : request.title,
        kind: card.kind === 'grant' ? 'grant' : 'action', tool: card.tool ?? '', args: card.args ?? {}, note: card.note ?? ''});
    },
    onTaskState: snapshot => taskFacts?.publish(snapshot),
    onDeliveryDeclared({conversationId, rootRunId, file}) {
      const owner = active.get(conversationId);
      if (owner && owner.spec.runId === rootRunId && !owner.ctx.cancelled) deliver(owner, [file]);
    },
    onSession({conversationId, role, session, modelPlan}) {
      session.on('model-call', call => {
        const owner = active.get(conversationId);if (!owner) return;
        const candidates = [modelPlan.primary, ...modelPlan.allowedFallbacks];
        const config = candidates.find(candidate => candidate.modelKey === call.modelKey) ?? modelPlan.primary;
        recordUsage(conversationId, {...call, role, modelKey: config.modelKey, modelName: config.model, at: Date.now()});
      });
    },
  });
  return {
    async run(spec, apply) {
      await ready;
      const {conversationId, generation, runId, envelope} = spec;
      if (cancelledBeforeStart.delete(conversationId)) return {stopped: true};
      if (generations.has(conversationId) && generations.get(conversationId) !== generation) runtime.invalidate(conversationId);
      generations.set(conversationId, generation);
      const ctx = {conversationId, generation, runId, policySnapshot: envelope.modelPolicySnapshot, workspace: envelope.workspaceSnapshot, inputSource: 'text', cancelled: false};
      const owner = {spec, ctx, stopped: false, permissions: new Map(), deliveries: [], settled: Promise.withResolvers()};active.set(conversationId, owner);
      const projector = createRunPartProjector({runId, generation, inputId: envelope.inputId});
      const fact = event => {for (const value of projector.handle(event)) apply(value);};
      let session, outcome = 'failed';
      const onStream = event => {
        if (event.type === 'text_delta') fact({kind: 'text', text: event.delta});
        else if (event.type === 'thinking_delta') fact({kind: 'thinking', text: event.delta});
        else if (event.type === 'thinking_end') fact({kind: 'thinking_end'});
        else if (event.type === 'hemi_request_start') fact({kind: 'request-start'});
        else if (event.type === 'hemi_request_reset') fact({kind: 'request-reset'});
      };
      const onActivity = activity => fact({kind: 'activity', activity});
      const onRecovery = recovery => fact({kind: 'recovery', recovery});
      const onProgress = event => {
        fact({...event, kind: event.kind === 'tool-start' ? 'tool_start' : 'tool_end'});
        if (event.kind === 'tool-end' && event.tool === 'register_delivery' && !event.isError) deliver(owner, event.args?.files ?? []);
      };
      try {
        const modelPlan = await hydrateModelPlan(resolveModelPlan(ctx.policySnapshot, {requirements: envelope.attachmentViews?.some(file => file.kind === 'image') ? {imageInput: true} : {}}), profilesFor(ctx));
        Object.assign(ctx, {modelPlan, config: modelPlan.primary, fallback: modelPlan.allowedFallbacks[0] ?? null, routed: ctx.policySnapshot.mode === 'routed'});
        await runtime.prepareExecution(ctx);
        if (ctx.cancelled) return {stopped: true};
        session = await runtime.obtain(ctx);
        if (ctx.cancelled) return {stopped: true};
        session.on('stream', onStream);session.on('activity', onActivity);session.on('recovery', onRecovery);session.on('progress', onProgress);
        apply({type: 'run-started', runId, generation, at: Date.now(), modelUsed: modelPlan.primary.modelKey});
        const input = await attachmentPrompt({...envelope, conversationId}, modelPlan.primary);
        if (ctx.cancelled) return {stopped: true};
        const result = await runtime.runRootTurn(conversationId, {userText: input.text, inputId: envelope.inputId, imageBlocks: input.images ?? []});
        await Promise.all(owner.deliveries);await runtime.persist(conversationId);
        outcome = result.aborted || ctx.cancelled ? 'stopped' : 'completed';
        for (const value of projector.finish({stopped: result.aborted || ctx.cancelled})) apply(value);
        return {stopped: result.aborted || ctx.cancelled};
      } catch (error) {
        for (const value of projector.finish({error: owner.stopped ? null : error, stopped: owner.stopped})) apply(value);
        if (!owner.stopped) throw error;
        return {stopped: true};
      } finally {
        session?.off('stream', onStream);session?.off('activity', onActivity);session?.off('recovery', onRecovery);session?.off('progress', onProgress);
        try {await runtime.completeConversation(conversationId, owner.stopped ? 'stopped' : outcome, null, runId);}
        finally {if (active.get(conversationId) === owner) active.delete(conversationId);owner.settled.resolve();}
      }
    },
    async stop(id) {
      const owner = active.get(id);
      if (!owner) {cancelledBeforeStart.add(id);return;}
      owner.stopped = true;owner.ctx.cancelled = true;
      await runtime.stopRoot(id, owner.spec.runId, {inputs: [owner.spec.envelope.text]});
    },
    decide(id, permissionId, value) {
      const owner = active.get(id), pending = owner?.permissions.get(permissionId);
      if (!pending || !pending.request.options.includes(value)) return false;
      const result = pending.decide(value);if (result) owner.permissions.delete(permissionId);return result;
    },
    async close() {
      await ready;
      const running = [...active.values()];
      await Promise.all(running.map(owner => this.stop(owner.spec.conversationId)));
      await Promise.all(running.map(owner => owner.settled.promise));
      taskFacts?.dispose();await runtime.close();
    },
  };
}
