import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { createHemiSession } from '../agent/hemi-session.mjs';
import { createRunPartProjector } from '../services/flow-parts-projection.mjs';
import { discoverProjectSkills } from '../skills/project-skills.mjs';
import { createPermissionService } from '../services/permission-service.mjs';

const TOOLS = [
  'read',
  'write',
  'edit',
  'ls',
  'grep',
  'glob',
  'bash',
  'register_delivery',
];
export async function validateCloudModel(config) {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), 'hemi-bot-validation-'),
  );
  const session = createHemiSession({
    cwd: temporary,
    agentDir: temporary,
    model: config,
    tools: [],
    appendSystem: ['你是 Hemi。仅验证模型连接，回复 OK。'],
    features: {},
    maxRunRequests: 1,
    initTimeoutMs: 20000,
    stallTimeoutMs: 30000,
  });
  let timer;
  try {
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
    session.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Runs the same Hemi session/tools/gates as desktop, entirely on the Host. No Electron or desktop tools. */
export function createBotExecutor({
  dataDir,
  readEntries,
  saveEntries,
  onPermission,
  onDelivery,
  recordUsage,
  getModel,
  attachmentPrompt,
}) {
  const active = new Map();
  const cancelledBeforeStart = new Set();
  const access = createPermissionService({ dir: dataDir });
  const ready = access.load();
  return {
    async run(spec, apply) {
      await ready;
      const { conversationId, generation, runId, envelope } = spec;
      if (cancelledBeforeStart.delete(conversationId)) return { stopped: true };
      const model = getModel(
        envelope.modelPolicySnapshot.modelKey,
        envelope.modelPolicySnapshot.revision,
      );
      const projector = createRunPartProjector({
        runId,
        generation,
        inputId: envelope.inputId,
      });
      const fact = (event) => {
        for (const f of projector.handle(event)) apply(f);
      };
      const pendingDeliveries = [];
      const session = createHemiSession({
        cwd: envelope.workspaceSnapshot.dir,
        agentDir: dataDir,
        model,
        thinking: {
          level: envelope.modelPolicySnapshot.thinkingLevel ?? 'default',
          format: model.thinkingFormat,
        },
        tools: TOOLS,
        delivery: true,
        skills: discoverProjectSkills(envelope.workspaceSnapshot.dir),
        features: { vision: false, browser: false, web: false },
        accessService: access,
        accessId: runId,
        grantScopeId: `bot-${conversationId}`,
        accessWorkspaceDir: envelope.workspaceSnapshot.dir,
        loadContextFiles: true,
        controlRoots: [
          dataDir,
          path.join(os.homedir(), '.local/share/hemi-bot'),
          path.join(os.homedir(), '.config/systemd/user/hemi-bot.service'),
          path.resolve(import.meta.dirname, '../../..'),
        ],
        permissionTimeoutMs: 0,
        entries: readEntries(conversationId, generation, envelope.inputId),
        maxRunRequests: 60,
        appendSystem: [
          '你是 Hemi，运行在用户的 Linux 云服务器上。所有文件和命令都在这台服务器执行。用用户的语言完成已授权的工作。没有本机桌面、麦克风、录屏、语音或浏览器能力；不能宣称已操作用户电脑。敏感操作遵守宿主确认，不绕过门控。生成交付文件时使用 register_delivery 登记真实路径。',
        ],
      });
      const owner = {
        session,
        generation,
        runId,
        cancelled: false,
        pending: new Map(),
      };
      active.set(conversationId, owner);
      session.on('stream', (e) => {
        if (e.type === 'text_delta') fact({ kind: 'text', text: e.delta });
        if (e.type === 'thinking_delta')
          fact({ kind: 'thinking', text: e.delta });
        if (e.type === 'thinking_end') fact({ kind: 'thinking_end' });
      });
      session.on('activity', (activity) =>
        fact({ kind: 'activity', activity }),
      );
      session.on('progress', (e) => {
        fact({
          ...e,
          kind: e.kind === 'tool-start' ? 'tool_start' : 'tool_end',
        });
        if (
          e.kind === 'tool-end' &&
          e.tool === 'register_delivery' &&
          !e.isError
        )
          pendingDeliveries.push(
            Promise.resolve(onDelivery(spec, e.args?.files ?? [])),
          );
      });
      session.on('model-call', (call) =>
        recordUsage(conversationId, {
          ...call,
          modelKey: model.modelKey,
          modelName: model.model,
          at: Date.now(),
        }),
      );
      session.on('permission', (permission) => {
        owner.pending.set(permission.id, permission);
        let card = {};
        try {
          const value = JSON.parse(permission.title);
          if (value && typeof value === 'object') card = value;
        } catch {}
        onPermission(spec, {
          ...permission,
          title:
            typeof card.summary === 'string' ? card.summary : permission.title,
          kind: card.kind === 'grant' ? 'grant' : 'action',
          tool: typeof card.tool === 'string' ? card.tool : '',
          args: card.args && typeof card.args === 'object' ? card.args : {},
          note: typeof card.note === 'string' ? card.note : '',
        });
      });
      try {
        await session.ready();
        if (owner.cancelled) return { stopped: true };
        apply({
          type: 'run-started',
          runId,
          generation,
          at: Date.now(),
          modelUsed: model.modelKey,
        });
        const input = await attachmentPrompt(
          { ...envelope, conversationId },
          model,
        );
        const result = await session.prompt(
          input.text,
          input.images?.length ? { images: input.images } : {},
        );
        await Promise.allSettled(pendingDeliveries);
        if (!owner.cancelled)
          await saveEntries(
            conversationId,
            generation,
            await session.exportEntries(),
          );
        if (result.modelError && !owner.cancelled)
          throw Object.assign(
            new Error('云端模型请求失败，请检查模型配置后重试。'),
            { code: 'failed' },
          );
        for (const f of projector.finish({
          stopped: result.aborted || owner.cancelled,
        }))
          apply(f);
        return { stopped: result.aborted || owner.cancelled };
      } catch (error) {
        for (const f of projector.finish({
          error: owner.cancelled ? null : error,
          stopped: owner.cancelled,
        }))
          apply(f);
        if (!owner.cancelled) throw error;
        return { stopped: true };
      } finally {
        session.dispose();
        if (active.get(conversationId) === owner) active.delete(conversationId);
      }
    },
    async stop(id) {
      const owner = active.get(id);
      if (owner) {
        owner.cancelled = true;
        await owner.session.abort();
      } else cancelledBeforeStart.add(id);
    },
    decide(id, permissionId, value) {
      const owner = active.get(id);
      const permission = owner?.pending.get(permissionId);
      if (!permission || !permission.options.includes(value)) return false;
      owner.pending.delete(permissionId);
      return owner.session.respondPermission(permissionId, { value });
    },
    async close() {
      await ready;
      await Promise.all([...active.keys()].map((id) => this.stop(id)));
    },
  };
}
