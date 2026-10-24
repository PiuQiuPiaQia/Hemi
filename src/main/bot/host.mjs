import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { entriesFromTurns } from '../agent/main-agent.mjs';
import { createConversationController } from '../services/conversation-controller.mjs';
import { restoreFlowSnapshot } from '../services/flow-bootstrap.mjs';
import { recoverConversationFlow } from '../services/conversation-recovery.mjs';
import { hitsDenyPath } from '../agent/gate/pi-gate.mjs';
import { guessAttachmentKind } from '../composer/attachments.mjs';
import {
  isDocumentFile,
  readDocumentText,
  readDocumentBytes,
} from '../composer/documents.mjs';
import { buildSkillDirectiveBlock } from '../../shared/skill-directives.mjs';
import { discoverProjectSkills } from '../skills/project-skills.mjs';
import {
  BOT_PROTOCOL,
  BOT_VERSION,
  validId,
  privateDirectory,
  atomicJson,
  readJson,
  publicModel,
  fail,
  syncModelConfig,
} from './storage.mjs';
import { cloudDirectory, listCloudDirectories } from './directories.mjs';
import { createBotExecutor, validateCloudModel } from './runtime.mjs';
import { modelEndpoint } from './models.mjs';
import { listRemoteModels } from '../services/text-model.mjs';
import { createDeviceGateway } from './device-gateway.mjs';
import { createResourceFiles } from './resource-files.mjs';
import { createAttachmentUploads } from './attachment-uploads.mjs';

const clone = structuredClone;
const hash = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const inside = (root, file) =>
  file === root || file.startsWith(root + path.sep);
const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};
const COMMANDS = new Set([
  'send',
  'stop',
  'resumeQueue',
  'promoteInput',
  'reorderInput',
  'beginEditInput',
  'finishEditInput',
  'updateInput',
  'saveInputEditDraft',
  'withdrawInput',
  'resendInput',
  'rewind',
]);

export async function createBotHost({
  dataDir,
  defaultDir = path.join(os.homedir(), 'hemi-workspace'),
  executorFactory = createBotExecutor,
  validateModel = validateCloudModel,
  allowLoopbackModels = false,
} = {}) {
  privateDirectory(dataDir);
  dataDir = await fsp.realpath(dataDir);
  const bootId = randomUUID();
  const controlDir =
    dataDir === path.join(os.homedir(), '.local/share/hemi-bot/data')
      ? path.dirname(dataDir)
      : dataDir;
  const stateFile = path.join(dataDir, 'state.json');
  const state = readJson(stateFile, {
    instanceId: randomUUID(),
    protocol: BOT_PROTOCOL,
    revision: 0,
    enabled: true,
    defaultDir,
    defaultModel: null,
    lastConversationModelKey: null,
    models: {},
    versions: {},
    sessions: {},
    order: [],
    operations: {},
    recentDirs: [],
  });
  if (state.protocol !== BOT_PROTOCOL)
    fail(
      'Bot 数据版本不兼容，请使用对应版本维护，原数据已保留。',
      'unsupported',
    );
  await fsp.mkdir(state.defaultDir, { recursive: true });
  state.defaultDir = await fsp.realpath(state.defaultDir);
  const controllers = new Map(),
    jobs = new Map(),
    listeners = new Set();
  let activeJob = null,
    closed = false,
    flushTimer = null,
    maintenanceUntil = 0;
  let modelSyncActive = false;
  const maintenanceActive = () => maintenanceUntil > Date.now();
  for (const operation of Object.values(state.operations))
    if (operation.status === 'pending') operation.status = 'interrupted';
  const save = () => {
    state.revision++;
    atomicJson(stateFile, state);
    for (const fn of listeners) fn(state.revision);
  };
  const laterSave = () => {
    if (!flushTimer)
      flushTimer = setTimeout(() => {
        flushTimer = null;
        save();
      }, 120);
  };
  const requireSession = (id) => {
    if (!validId(id) || !Object.hasOwn(state.sessions, id))
      fail('会话不存在或已删除。', 'missing');
    return state.sessions[id];
  };
  const requireOnlineModel = (key) => {
    const revision = Object.hasOwn(state.models, key)
      ? state.models[key]
      : null;
    if (!revision)
      fail('当前模型不可用，请手动同步或选择可用模型。', 'missing');
    return state.versions[revision];
  };
  const view = (session) => ({
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    dir: session.dir,
    modelKey: session.modelKey,
    thinking: session.thinking,
    status:
      jobs.has(session.id) && activeJob?.id !== session.id
        ? 'queued'
        : session.flow?.activeRunId && session.flow.phase !== 'idle'
          ? 'running'
          : null,
    waitingPermission: Object.values(session.permissions ?? {}).some(
      (p) => p.status === 'pending',
    ),
    turnCount: session.flow?.timeline?.length ?? 0,
  });
  const privatePath = (target) =>
    inside(controlDir, target) || hitsDenyPath(target, os.homedir());
  function fileLinkPath(session, value) {
    let raw = String(value ?? '').trim();
    if (!raw || /[\x00-\x1f]/.test(raw)) fail('文件链接无效。');
    if (/^file:/i.test(raw)) {
      try {
        const url = new URL(raw);
        if (url.hostname && url.hostname !== 'localhost')
          fail('文件链接主机不匹配。', 'permission');
        raw = decodeURIComponent(url.pathname);
      } catch (error) {
        if (error.code === 'permission') throw error;
        fail('文件链接无效。');
      }
    } else if (/^[a-z][a-z\d+.-]*:/i.test(raw)) fail('文件链接无效。');
    if (raw === '~') raw = os.homedir();
    else if (raw.startsWith('~/')) raw = path.join(os.homedir(), raw.slice(2));
    else if (raw.startsWith('~')) fail('文件链接无效。');
    return { raw, absolute: path.resolve(session.dir, raw) };
  }
  async function readLinkedFile(session, absolute) {
    if (privatePath(absolute)) fail('链接指向的位置不能打开。', 'permission');
    let real;
    try { real = await fsp.realpath(absolute); }
    catch { fail('云端文件不存在，可能已被移动或删除。', 'missing'); }
    const home = await fsp.realpath(os.homedir());
    const root = await fsp.realpath(session.dir);
    if (privatePath(real) || !(inside(home, real) || inside(root, real)))
      fail('链接不在家目录与当前工作目录的允许范围内。', 'permission');
    const stat = await fsp.stat(real);
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024)
      fail('文件不可读或超过 20 MB 预览限制。');
    // 链接身份按会话隔离，仅供受控预览，不写入交付登记或持久化状态。
    return { id: 'link-' + hash([session.id, real]).slice(0, 40), path: real, real, name: path.basename(real), stat };
  }
  const readOwnedFile = async (session, id) => {
    const file = session.files?.[id];
    if (
      !file ||
      !session.flow?.artifacts?.[id] ||
      !(session.flow.timeline ?? []).some((item) => item.runId === file.runId)
    )
      fail('文件未登记或不属于当前会话。', 'missing');
    let real;
    try {
      real = await fsp.realpath(file.path);
    } catch {
      fail('云端文件已被移动或删除。', 'missing');
    }
    if (privatePath(real) || !inside(file.root, real))
      fail('文件不在该次交付的允许范围内。', 'permission');
    const stat = await fsp.stat(real);
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024)
      fail('文件不可读或超过 20 MB 预览／下载限制。');
    return { ...file, real, stat };
  };
  function persistSession(id) {
    const s = requireSession(id),
      c = controllers.get(id);
    if (c) s.flow = c.getSnapshot();
    save();
    return Promise.resolve();
  }
  async function drain() {
    if (activeJob || !state.enabled || closed) return;
    const job = [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!job) return;
    activeJob = job;
    job.running = true;
    laterSave();
    try {
      const result = await executor.run(job.spec, (fact) =>
        controllers.get(job.id)?.applyFact(fact),
      );
      job.controller.applyFact({
        type: 'run-settled',
        runId: job.spec.runId,
        generation: job.spec.generation,
        at: Date.now(),
      });
      job.controller.applyFact({
        type: 'run-closed',
        runId: job.spec.runId,
        generation: job.spec.generation,
        outcome: result?.stopped ? 'stopped' : 'completed',
        at: Date.now(),
      });
    } catch (error) {
      job.controller.applyFact({
        type: 'part-appended',
        runId: job.spec.runId,
        generation: job.spec.generation,
        part: {
          partId: job.spec.runId + '-error',
          kind: 'notice',
          level: 'error',
          text: error.code
            ? error.message
            : '云端运行失败，请检查模型或服务器环境后重试。',
        },
      });
      job.controller.applyFact({
        type: 'run-closed',
        runId: job.spec.runId,
        generation: job.spec.generation,
        outcome: 'failed',
        at: Date.now(),
      });
    } finally {
      if (state.sessions[job.id]) {
        for (const p of Object.values(state.sessions[job.id].permissions ?? {}))
          if (p.runId === job.spec.runId && p.status === 'pending')
            p.status = 'expired';
        await persistSession(job.id);
      }
      if (jobs.get(job.id) === job) jobs.delete(job.id);
      activeJob = null;
      job.settled.resolve();
      pruneVersions();
      save();
      void drain();
    }
  }
  async function freeze(id, input) {
    const s = requireSession(id),
      key = input.profileId ?? s.modelKey;
    requireOnlineModel(key);
    const dir = await cloudDirectory(s.dir, { writable: true, controlDir });
    const ids = Array.isArray(input.attachmentIds)
      ? input.attachmentIds.slice(0, 3)
      : [];
    for (const attachmentId of ids)
      if (!s.attachments[attachmentId])
        fail('附件尚未上传完成或不属于本会话。');
    const available = discoverProjectSkills(dir),
      skills = [];
    for (const selection of (input.skills ?? []).slice(0, 10)) {
      const resolved = available.find(
        (skill) =>
          skill.id === selection.skillId && selection.source === 'project',
      );
      if (!resolved)
        fail('所选技能在当前云端目录不可用，请重新选择。', 'missing');
      skills.push({
        skillId: resolved.id,
        name: resolved.name,
        source: 'project',
        description: resolved.description,
        token: selection.token ?? resolved.name,
      });
    }
    return {
      skills,
      modelPolicySnapshot: {
        modelKey: key,
        revision: state.models[key],
        thinkingLevel: s.thinking,
      },
      workspaceSnapshot: { dir },
      thinkingLevel: s.thinking,
      attachmentViews: ids.map((attachmentId) =>
        attachmentView(s.attachments[attachmentId]),
      ),
    };
  }
  function controller(id) {
    const s = requireSession(id);
    if (controllers.has(id)) return controllers.get(id);
    const c = createConversationController({
      conversationId: id,
      effects: {
        store: {
          update: () => persistSession(id),
          flush: () => persistSession(id),
        },
        runtime: {
          freezeInput: (input) => freeze(id, input),
          async start(spec) {
            if (!state.enabled) fail('Bot 已停止。', 'busy');
            if (!spec.envelope?.modelPolicySnapshot)
              fail('任务缺少受理时的模型版本。');
            jobs.set(id, {
              id,
              spec,
              controller: c,
              running: false,
              createdAt: Date.now(),
              settled: Promise.withResolvers(),
            });
            // Acceptance is durable before starting. The job is owned by Host, never the SSH request.
            await persistSession(id);
            setImmediate(() => {
              void drain();
            });
            return { modelUsed: spec.envelope.modelPolicySnapshot.modelKey };
          },
          async stop() {
            const job = jobs.get(id);
            if (!job) return;
            if (job.running) await executor.stop(id);
            else {
              jobs.delete(id);
              job.settled.resolve();
              c.applyFact({
                type: 'run-closed',
                runId: job.spec.runId,
                generation: job.spec.generation,
                outcome: 'stopped',
                at: Date.now(),
              });
            }
          },
        },
      },
    });
    if (s.flow) {
      const recovered = recoverConversationFlow(restoreFlowSnapshot(s.flow));
      c.restore(recovered.snapshot);
      for (const p of Object.values(s.permissions ?? {}))
        if (p.status === 'pending') p.status = 'expired';
    }
    controllers.set(id, c);
    c.subscribe(() => {
      s.flow = c.getSnapshot();
      s.updatedAt = Date.now();
      laterSave();
    });
    return c;
  }
  const executor = executorFactory({
    dataDir,
    readEntries: (id, generation, inputId) => {
      const s = requireSession(id),
        saved = s.agent;
      if (saved?.generation === generation)
        return [
          saved.payload.header,
          ...saved.payload.entries.filter((e) => e.type !== 'session'),
        ];
      const turns = (s.flow?.timeline ?? [])
        .filter((item) => item.kind !== 'user' || item.id !== inputId)
        .map((item) => ({
          id: item.id ?? item.itemId,
          createdAt: item.deliveredAt ?? 0,
          author: item.kind === 'user' ? 'user' : 'hemi',
          text:
            item.kind === 'user'
              ? item.text
              : item.parts
                  .filter((p) => p.kind === 'text')
                  .map((p) => p.content)
                  .join('\n'),
        }));
      return turns.length ? entriesFromTurns(turns, { cwd: s.dir }) : null;
    },
    saveEntries: async (id, generation, payload) => {
      const s = requireSession(id);
      if (controller(id).getSnapshot().generation === generation) {
        s.agent = { generation, payload };
        save();
      }
    },
    getModel: (key, revision) => {
      const config = state.versions[revision];
      if (!config || config.modelKey !== key)
        fail('受理的模型版本已失效。', 'missing');
      return clone(config);
    },
    recordUsage: (id, call) => {
      if (!Object.hasOwn(state.sessions, id)) return;
      const s = requireSession(id);
      (s.usage ??= []).push(call);
      laterSave();
    },
    onPermission: (spec, permission) => {
      const s = requireSession(spec.conversationId),
        id = spec.runId + ':' + permission.id;
      s.permissions[id] = {
        ...permission,
        id,
        sdkId: permission.id,
        runId: spec.runId,
        generation: spec.generation,
        status: 'pending',
      };
      save();
    },
    onDelivery: async (spec, files) => {
      const s = requireSession(spec.conversationId);
      for (const file of files.slice(0, 20)) {
        try {
          const real = await fsp.realpath(
            path.resolve(spec.envelope.workspaceSnapshot.dir, file.path),
          );
          if (
            privatePath(real) ||
            !inside(spec.envelope.workspaceSnapshot.dir, real)
          )
            continue;
          const stat = await fsp.stat(real);
          if (!stat.isFile()) continue;
          const id = 'file-' + randomUUID();
          s.files[id] = {
            id,
            path: real,
            root: spec.envelope.workspaceSnapshot.dir,
            name: path.basename(real),
            size: stat.size,
            runId: spec.runId,
          };
          const c = controller(spec.conversationId);
          if (c.getSnapshot().generation !== spec.generation) continue;
          c.applyFact({
            type: 'artifact-updated',
            artifact: {
              artifactId: id,
              kind: 'file',
              path: real,
              name: path.basename(real),
              size: stat.size,
              producerRunId: spec.runId,
              conversationId: spec.conversationId,
              previewKind: 'text',
              status: 'ready',
            },
            generation: spec.generation,
          });
          save();
        } catch {
          /* Unreadable or outside scope is never a successful delivery. */
        }
      }
    },
    attachmentPrompt: async (envelope) => {
      const s = requireSession(envelope.conversationId),
        blocks = [],
        images = [];
      for (const id of envelope.attachmentIds ?? []) {
        const a = s.attachments[id];
        if (!a) fail('附件记录不存在。', 'missing');
        const buffer = await fsp.readFile(a.path);
        if (a.kind === 'image') {
          const config = state.versions[envelope.modelPolicySnapshot.revision];
          if (!config.supportsVision)
            fail('当前模型不支持图片，请选择支持图片的模型。');
          images.push({
            type: 'image',
            data: buffer.toString('base64'),
            mimeType: MIME[path.extname(a.name).toLowerCase()],
          });
        } else
          blocks.push(
            `附件 ${a.name}：\n${isDocumentFile(a.path) ? (await readDocumentText(a.path)).text : buffer.toString('utf8').slice(0, 120000)}`,
          );
      }
      for (const ref of envelope.references ?? []) {
        if (ref.kind === 'conversation') {
          const other = requireSession(ref.targetConversationId);
          blocks.push(
            `引用会话 ${other.title}：\n${(other.flow?.timeline ?? [])
              .slice(-20)
              .map((i) =>
                i.kind === 'user'
                  ? i.text
                  : i.parts
                      .filter((p) => p.kind === 'text')
                      .map((p) => p.content)
                      .join('\n'),
              )
              .join('\n')
              .slice(0, 24000)}`,
          );
        } else if (ref.refPath) {
          const real = await fsp.realpath(ref.refPath);
          if (
            privatePath(real) ||
            !inside(envelope.workspaceSnapshot.dir, real)
          )
            fail('引用超出当前云端目录。', 'permission');
          blocks.push(
            ref.kind === 'folder'
              ? `引用目录 ${real}：\n${(await fsp.readdir(real)).slice(0, 200).join('\n')}`
              : `引用文件 ${real}：\n${(await fsp.readFile(real, 'utf8')).slice(0, 24000)}`,
          );
        }
      }
      const skillDirective = buildSkillDirectiveBlock(envelope.skills);
      if (skillDirective) blocks.push(skillDirective);
      return { text: [envelope.text, ...blocks].join('\n\n'), images };
    },
  });
  function pruneVersions() {
    const keep = new Set(Object.values(state.models));
    for (const job of jobs.values())
      keep.add(job.spec.envelope?.modelPolicySnapshot?.revision);
    for (const session of Object.values(state.sessions))
      for (const input of session.flow?.pending ?? [])
        keep.add(input.modelPolicySnapshot?.revision);
    for (const revision of Object.keys(state.versions))
      if (!keep.has(revision)) delete state.versions[revision];
  }
  function attachmentView(a) {
    return {
      attachmentId: a.id,
      conversationId: a.conversationId,
      name: a.name,
      kind: a.kind,
      sizeBytes: a.size,
      status: 'ready',
      source: a.source,
      originPath: '',
      registeredAt: a.at,
      ...(a.thumbnailUrl ? { thumbnailUrl: a.thumbnailUrl } : {}),
    };
  }
  async function mutate(method, p) {
    switch (method) {
      case 'model.sync': {
        if (maintenanceActive())
          fail('云端组件正在维护，请稍后再同步模型。', 'busy');
        if (modelSyncActive)
          fail('云端仍在验证模型，请等待结果后重新核对。', 'busy');
        if (
          !Array.isArray(p.models) ||
          !p.models.length ||
          p.models.length > 50
        )
          fail('每次请选择 1 至 50 个模型。');
        modelSyncActive = true;
        try {
          const rawModels = (p.models ?? []).slice(0, 50),
            results = new Array(rawModels.length),
            validated = new Array(rawModels.length);
          let cursor = 0;
          const worker = async () => {
            for (;;) {
              const index = cursor++;
              if (index >= rawModels.length) return;
              const raw = rawModels[index],
                config = syncModelConfig(raw);
              const rejected = (message) =>
                (results[index] = { key: config.modelKey, ok: false, message });
              if (
                !config.modelKey ||
                !config.model ||
                !config.apiKey ||
                raw.oauthProvider
              ) {
                rejected('此模型缺少独立的 API Key，或账号授权暂不支持。');
                continue;
              }
              let endpoint;
              try {
                endpoint = new URL(config.baseUrl);
              } catch {
                rejected('模型接口地址无效。');
                continue;
              }
              if (
                !['https:', 'http:'].includes(endpoint.protocol) ||
                endpoint.username ||
                endpoint.password ||
                (!allowLoopbackModels && p.source !== 'manual' &&
                  /^(localhost|127\.|\[?::1\]?$|0\.0\.0\.0)/i.test(
                    endpoint.hostname,
                  ))
              ) {
                rejected('本机地址不可用，请配置云端可访问的模型地址。');
                continue;
              }
              try {
                await validateModel(config);
                const revision = hash(config);
                validated[index] = { config, revision };
                results[index] = { key: config.modelKey, ok: true, revision };
              } catch {
                rejected('服务器未能验证模型连接，原配置保留。');
              }
            }
          };
          await Promise.all(
            Array.from({ length: Math.min(4, rawModels.length) }, worker),
          );
          // The manual form saves one provider as a unit, like local setup.
          // A retry after one failed model must not leave duplicate providers.
          if (p.source === 'manual' && results.some(result => !result.ok)) {
            return { results: results.map(result => result.ok ? {
              key: result.key, ok: false, message: '同组有型号未通过验证，本组模型尚未添加。',
            } : result) };
          }
          for (const item of validated) {
            if (!item) continue;
            state.versions[item.revision] = item.config;
            state.models[item.config.modelKey] = item.revision;
            state.defaultModel ??= item.config.modelKey;
          }
          pruneVersions();
          save();
          return {
            results,
            models: Object.entries(state.models).map(([key, revision]) =>
              publicModel(state.versions[revision], revision),
            ),
          };
        } finally {
          modelSyncActive = false;
        }
      }
      case 'initialize.verify': {
        requireOnlineModel(state.defaultModel);
        const directory = await cloudDirectory(state.defaultDir, {
          writable: true,
          controlDir,
        });
        const temporary = await fsp.mkdtemp(
            path.join(directory, '.hemi-initialize-'),
          ),
          proof = randomUUID();
        try {
          await fsp.writeFile(path.join(temporary, 'proof'), proof + '\n', {
            mode: 0o600,
          });
          const output = await promisify(execFile)(
            '/bin/sh',
            [
              '-c',
              'IFS= read -r value < proof; test "$value" = "$1"; printf %s "$value"',
              'hemi-verify',
              proof,
            ],
            { cwd: temporary, timeout: 10000 },
          );
          if (output.stdout !== proof) fail('云端命令验证失败。');
          state.initialized = true;
          save();
          return { ok: true };
        } finally {
          await fsp.rm(temporary, { recursive: true, force: true });
        }
      }
      case 'configure': {
        if (p.defaultDir) {
          if (!path.isAbsolute(p.defaultDir) || privatePath(p.defaultDir))
            fail('请选择允许的云端工作目录。', 'permission');
          const exists = await fsp.stat(p.defaultDir).then(
            () => true,
            (e) => {
              if (e.code === 'ENOENT') return false;
              throw e;
            },
          );
          if (!exists) {
            await cloudDirectory(path.dirname(p.defaultDir), {
              writable: true,
              controlDir,
            });
            await fsp.mkdir(p.defaultDir, { recursive: true });
          }
          state.defaultDir = await cloudDirectory(p.defaultDir, {
            writable: true,
            controlDir,
          });
        }
        if (p.defaultModel) {
          requireOnlineModel(p.defaultModel);
          state.defaultModel = p.defaultModel;
        }
        if (!state.defaultModel) fail('至少需要一个通过云端验证的模型。');
        save();
        return { ok: true };
      }
      case 'session.create': {
        const modelKey = [state.lastConversationModelKey, state.defaultModel, ...Object.keys(state.models)]
          .find(key => key && state.models[key]);
        if (!modelKey) fail('请先同步一个可用的模型。', 'missing');
        const id = 'bot-' + randomUUID(),
          now = Date.now();
        state.sessions[id] = {
          id,
          title: '新对话',
          dir: state.defaultDir,
          modelKey,
          thinking: 'default',
          draft: {
            text: '',
            revision: 0,
            references: [],
            skills: [],
            attachmentIds: [],
          },
          attachments: {},
          permissions: {},
          files: {},
          createdAt: now,
          updatedAt: now,
        };
        state.order.unshift(id);
        state.lastConversationModelKey = modelKey;
        controller(id);
        save();
        return { id };
      }
      case 'session.update': {
        const s = requireSession(p.id);
        if (p.modelKey) {
          requireOnlineModel(p.modelKey);
          s.modelKey = p.modelKey;
        }
        if (p.dir) {
          s.dir = await cloudDirectory(p.dir, { writable: true, controlDir });
          state.recentDirs = [
            s.dir,
            ...state.recentDirs.filter((d) => d !== s.dir),
          ].slice(0, 8);
        }
        if (['default', 'off', 'low', 'medium', 'high'].includes(p.thinking))
          s.thinking = p.thinking;
        if (p.modelKey) state.lastConversationModelKey = s.modelKey;
        save();
        return { ok: true };
      }
      case 'session.rename': {
        const s = requireSession(p.id);
        s.title =
          String(p.title ?? '')
            .trim()
            .slice(0, 100) || '新对话';
        save();
        return { ok: true, session: view(s) };
      }
      case 'session.remove': {
        requireSession(p.id);
        const c = controller(p.id),
          job = jobs.get(p.id);
        await c.command({ type: 'stop' });
        if (job) await job.settled.promise;
        await c.close();
        controllers.delete(p.id);
        state.order = state.order.filter((id) => id !== p.id);
        delete state.sessions[p.id];
        await fsp.rm(path.join(dataDir, 'attachments', p.id), {
          recursive: true,
          force: true,
        });
        save();
        return { ok: true };
      }
      case 'session.order': {
        const ids = (p.ids ?? []).filter((id) => state.sessions[id]);
        state.order = [...new Set([...ids, ...state.order])];
        save();
        return { ok: true };
      }
      case 'session.draft': {
        const s = requireSession(p.id);
        if (!Number.isSafeInteger(p.revision)) fail('草稿版本无效。');
        const next = {
          text: String(p.text ?? '').slice(0, 100000),
          revision: p.revision,
          references: p.references ?? [],
          skills: p.skills ?? [],
          attachmentIds: p.attachmentIds ?? [],
        };
        if (p.revision <= s.draft.revision) {
          const same =
            hash({ ...next, revision: 0 }) ===
            hash({ ...s.draft, revision: 0 });
          return {
            ok: same,
            ...(!same ? { code: 'conflict' } : {}),
            draft: s.draft,
          };
        }
        s.draft = next;
        save();
        return { ok: true, draft: s.draft };
      }
      case 'flow.command': {
        if (maintenanceActive() && p.command?.type !== 'stop')
          fail('云端组件正在维护，请完成后再提交任务。', 'busy');
        if (!state.enabled) fail('Bot 已停止，请先启动。', 'busy');
        const s = requireSession(p.id),
          c = controller(p.id),
          cmd = clone(p.command ?? {});
        if (!COMMANDS.has(cmd.type)) fail('不支持的对话操作。', 'unsupported');
        if (cmd.input) {
          delete cmd.input.modelPolicySnapshot;
          delete cmd.input.workspaceSnapshot;
          cmd.input.conversationId = s.id;
          cmd.input.inputSource = 'text';
          if (!validId(cmd.input.inputId)) fail('缺少稳定输入身份。');
          if (!String(cmd.input.text ?? '').trim() && !(Array.isArray(cmd.input.attachmentIds) && cmd.input.attachmentIds.length)) fail('消息不能为空。');
          if (cmd.input.workflow)
            fail('当前 Bot 尚未安装该工作流能力。', 'unsupported');
        }
        if (cmd.patch) {
          delete cmd.patch.modelPolicySnapshot;
          delete cmd.patch.workspaceSnapshot;
        }
        if (cmd.type === 'rewind' && cmd.input) {
          const original = c
            .getSnapshot()
            .timeline.find(
              (item) => item.kind === 'user' && item.id === cmd.targetInputId,
            );
          if (original)
            cmd.input = {
              attachmentIds: original.attachmentIds ?? [],
              references: original.references ?? [],
              skills: original.skills ?? [],
              ...cmd.input,
            };
        }
        const result = await c.command(cmd);
        await persistSession(s.id);
        if (result.ok && cmd.type === 'send') {
          if (s.title === '新对话')
            s.title = String(cmd.input.text ?? '').trim().slice(0, 24) || s.attachments[cmd.input.attachmentIds?.[0]]?.name.slice(0,24) || '新对话';
          save();
        }
        return result;
      }
      case 'permission.decide': {
        const s = requireSession(p.id),
          perm = s.permissions[p.permissionId];
        if (
          !perm ||
          perm.status !== 'pending' ||
          perm.generation !== controller(p.id).getSnapshot().generation ||
          perm.runId !== controller(p.id).getSnapshot().activeRunId
        )
          fail('确认已失效，请刷新状态。', 'conflict');
        if (!executor.decide(p.id, perm.sdkId, p.value))
          fail('确认已失效，请刷新状态。', 'conflict');
        perm.status = p.value === perm.options.at(-1) ? 'denied' : 'approved';
        save();
        return { ok: true };
      }
      case 'attachment.add': {
        const s = requireSession(p.id),
          name = path.basename(String(p.name ?? '')),
          kind = guessAttachmentKind(name),
          bytes = Buffer.from(String(p.base64 ?? ''), 'base64');
        if (
          !kind ||
          !bytes.length ||
          bytes.length > (kind === 'image' ? 10 : 20) * 1024 * 1024
        )
          fail('文件类型不支持，或超过附件大小限制。');
        const id = 'att-' + randomUUID(),
          dir = path.join(dataDir, 'attachments', s.id);
        privateDirectory(dir);
        const file = path.join(dir, id + path.extname(name));
        fs.writeFileSync(file, bytes, { mode: 0o600 });
        const a = {
          id,
          conversationId: s.id,
          name,
          kind,
          path: file,
          size: bytes.length,
          source: ['paste', 'drop'].includes(p.source) ? p.source : 'picker',
          at: Date.now(),
        };
        s.attachments[id] = a;
        save();
        return { attachment: attachmentView(a) };
      }
      case 'service.stop': {
        state.enabled = false;
        save();
        for (const id of controllers.keys())
          await controller(id).command({ type: 'stop' });
        await executor.close();
        await Promise.all([...jobs.values()].map((job) => job.settled.promise));
        save();
        return { ok: true };
      }
      case 'service.start': {
        state.enabled = true;
        save();
        return { ok: true };
      }
      case 'maintenance.begin': {
        if (jobs.size || modelSyncActive)
          fail('云端仍有工作，请等待任务完成后维护。', 'busy');
        maintenanceUntil = Date.now() + 15 * 60 * 1000;
        return { ok: true };
      }
      case 'maintenance.end': {
        maintenanceUntil = 0;
        return { ok: true };
      }
      default:
        fail('不支持的操作。', 'unsupported');
    }
  }
  async function request(method, p = {}) {
    if (method !== 'handshake' && p.instanceId !== state.instanceId)
      fail('云端 Bot 身份不同，请重新核对连接。', 'conflict');
    if (method.startsWith('pairing.') || method.startsWith('devices.'))
      return gateway.management(method, p);
    if (method==='resource.stat'||method==='resource.chunk')return resourceFiles(method,p);
    if (method.startsWith('attachment.upload.'))return uploads(method,p);
    if (method === 'handshake')
      return {
        instanceId: state.instanceId,
        bootId,
        activeJobs: jobs.size,
        protocol: BOT_PROTOCOL,
        version: BOT_VERSION,
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        home: os.homedir(),
        dataDir,
        defaultDir: state.defaultDir,
        enabled: state.enabled,
        configured: state.initialized === true,
        capabilities: { devicePairing: 1 },
      };
    if (method === 'snapshot' && p.revision === state.revision)
      return {
        instanceId: state.instanceId,
        revision: state.revision,
        notModified: true,
        deviceAccess: gateway.summary(),
      };
    if (method === 'model.test' || method === 'model.list') {
      const config = syncModelConfig(p.config ?? {});
      // This draft is entered explicitly for the Bot: localhost names the
      // server. Importing desktop profiles keeps the original loopback guard.
      modelEndpoint(config, { allowLoopback: true });
      if (!config.apiKey) fail('请填写 API Key。');
      try {
        if (method === 'model.list') return { ok: true, ...(await listRemoteModels(config)) };
        if (!config.model) fail('请填写模型型号。');
        const start = Date.now();
        await validateModel(config);
        return { ok: true, latencyMs: Date.now() - start };
      } catch {
        return { ok: false, error: method === 'model.list' ? '服务器无法拉取模型列表，请检查接口地址和 API Key，或手动填写型号。' : '服务器未能验证模型连接，请检查接口地址、API Key 和型号。' };
      }
    }
    if (method === 'snapshot')
      return {
        instanceId: state.instanceId,
        revision: state.revision,
        enabled: state.enabled,
        defaultDir: state.defaultDir,
        defaultModel: state.defaultModel,
        lastConversationModelKey: state.lastConversationModelKey ?? null,
        recentDirs: state.recentDirs,
        deviceAccess: gateway.summary(),
        models: Object.entries(state.models).map(([key, rev]) =>
          publicModel(state.versions[rev], rev),
        ),
        sessions: state.order
          .filter((id) => state.sessions[id])
          .map((id) => view(state.sessions[id])),
        ...(p.id && Object.hasOwn(state.sessions, p.id)
          ? { detail: detail(p.id) }
          : {}),
      };
    if (method === 'session.open') {
      const session = requireSession(p.id);
      // Opening a conversation counts as the last model choice, just like local
      // chat. Background reads must not replace that preference.
      if (p.activate !== false && state.models[session.modelKey] && state.lastConversationModelKey !== session.modelKey) {
        state.lastConversationModelKey = session.modelKey;
        save();
      }
      return detail(p.id);
    }
    if (method === 'operation.get') {
      if (!validId(p.operationId)) fail('无效的操作身份。');
      const operation = state.operations[p.operationId];
      return operation
        ? {
            status: operation.status,
            ...(operation.status === 'done'
              ? { result: clone(operation.result) }
              : {}),
          }
        : { status: 'missing' };
    }
    if (method === 'diagnostics')
      return {
        protocol: BOT_PROTOCOL,
        version: BOT_VERSION,
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        enabled: state.enabled,
        maintenance: maintenanceActive(),
        activeJobs: jobs.size,
        sessionCount: state.order.length,
        modelCount: Object.keys(state.models).length,
        configured: state.initialized === true,
      };
    if (method === 'flow.snapshot')
      return clone(controller(p.id).getSnapshot());
    if (method === 'directory.list')
      return listCloudDirectories(p.path ?? state.defaultDir, { controlDir });
    if (method === 'attachment.read' || method === 'attachment.document') {
      const s = requireSession(p.id),
        a = s.attachments[p.attachmentId];
      if (!a) fail('附件不存在或不属于当前会话。', 'missing');
      if (method === 'attachment.document') {
        if (/\.xlsx$/i.test(a.path))
          return {
            ok: true,
            format: 'xlsx',
            sheets: (await readDocumentText(a.path)).sheets,
          };
        const doc = await readDocumentBytes(a.path);
        return {
          ok: true,
          format: doc.format,
          base64: Buffer.from(doc.bytes).toString('base64'),
        };
      }
      const b = await fsp.readFile(a.path);
      return a.kind === 'image'
        ? {
            ok: true,
            kind: 'image',
            dataUrl: `data:${MIME[path.extname(a.name).toLowerCase()]};base64,${b.toString('base64')}`,
          }
        : {
            ok: true,
            kind: 'text',
            text: isDocumentFile(a.path)
              ? (await readDocumentText(a.path)).text
              : b.toString('utf8'),
            markdown: /\.md$/i.test(a.name),
          };
    }
    if (method === 'file.resolve') {
      const s = requireSession(p.id);
      const { raw, absolute } = fileLinkPath(s, p.path);
      const retained = new Set(
        (s.flow?.timeline ?? []).map((item) => item.runId),
      );
      const files = Object.values(s.files).filter((file) =>
        retained.has(file.runId),
      );
      const exact = files.filter((file) => file.path === absolute);
      const matches = exact.length
        ? exact
        : files.filter(
            (file) => !path.isAbsolute(raw) && file.path.endsWith('/' + raw),
          );
      const paths = new Set(matches.map((file) => file.path)),
        file = paths.size === 1 ? matches.at(-1) : null;
      const target = file ?? await readLinkedFile(s, absolute);
      return {
        ok: true,
        artifactId: target.id,
        path: target.path,
        name: target.name,
      };
    }
    if (method === 'file.read' || method === 'file.download') {
      const s = requireSession(p.id);
      const linked = method === 'file.read' && String(p.artifactId).startsWith('link-');
      const file = linked
        ? await readLinkedFile(s, fileLinkPath(s, p.path).absolute)
        : await readOwnedFile(s, p.artifactId);
      if (linked && file.id !== p.artifactId)
        fail('文件链接不属于当前会话或原文件已变化。', 'missing');
      const b = await fsp.readFile(file.real);
      const mime = MIME[path.extname(file.name).toLowerCase()];
      if (method === 'file.download')
        return { ok: true, name: file.name, base64: b.toString('base64') };
      if (isDocumentFile(file.real)) {
        if (p.textOnly)
          return {
            ok: true,
            kind: 'text',
            text: (await readDocumentText(file.real)).text,
          };
        const doc = /\.xlsx$/i.test(file.real)
          ? {
              ok: true,
              format: 'xlsx',
              sheets: (await readDocumentText(file.real)).sheets,
            }
          : await readDocumentBytes(file.real).then((doc) => ({
              ok: true,
              format: doc.format,
              base64: Buffer.from(doc.bytes).toString('base64'),
            }));
        return {
          ok: true,
          name: file.name,
          path: file.path,
          kind: 'document',
          document: doc,
        };
      }
      const text =
        /\.(txt|md|mdx|json|csv|tsv|xml|html?|css|[cm]?jsx?|tsx?|py|sh|ya?ml|toml|ini|log|sql|svg)$/i.test(
          file.name,
        );
      return {
        ok: true,
        name: file.name,
        path: file.path,
        ...(mime
          ? {
              kind: 'image',
              dataUrl: `data:${mime};base64,${b.toString('base64')}`,
            }
          : text
            ? {
                kind: 'text',
                text: b.toString('utf8'),
                markdown: /\.md$/i.test(file.name),
              }
            : {
                kind: 'unsupported',
                message: '此文件暂不支持在线预览，可以下载到本机。',
              }),
      };
    }
    if (method === 'references') {
      const s = requireSession(p.id),
        dir = await cloudDirectory(s.dir, { controlDir }),
        q = String(p.query ?? '').toLowerCase();
      const names = (await fsp.readdir(dir, { withFileTypes: true }))
        .filter((e) => !e.name.startsWith('.'))
        .slice(0, 200)
        .map((e) => ({
          kind: e.isDirectory() ? 'folder' : 'file',
          key: 'file-' + hash(path.join(dir, e.name)).slice(0, 16),
          name: e.name,
          subtitle: path.join(dir, e.name),
          refPath: path.join(dir, e.name),
        }));
      return {
        candidates: [
          ...names,
          ...state.order
            .filter((id) => id !== s.id)
            .map((id) => ({
              kind: 'conversation',
              key: 'conv-' + id,
              name: state.sessions[id].title,
              subtitle: 'Bot 会话',
              targetConversationId: id,
            })),
        ]
          .filter((v) => !q || v.name.toLowerCase().includes(q))
          .slice(0, 60),
      };
    }
    if (method === 'skills') {
      const s = requireSession(p.id);
      return {
        commands: [
          { id: 'model', name: '/model', description: '切换当前会话模型' },
        ],
        skills: discoverProjectSkills(s.dir).map((v) => ({
          skillId: v.id ?? v.name,
          name: v.name,
          description: v.description,
          source: 'project',
        })),
        skillsError: '',
      };
    }
    // Durable operation identities prevent an uncertain SSH outcome from silently repeating side effects.
    if (!validId(p.requestId)) fail('缺少操作身份。');
    const key = p.requestId,
      digest = hash({ method, p }),
      known = state.operations[key];
    if (known) {
      if (known.hash !== digest) fail('操作身份已用于其他内容。', 'conflict');
      if (known.status !== 'done')
        fail('上次操作结果待核对，请刷新云端状态。', 'needs-review');
      return clone(known.result);
    }
    state.operations[key] = { hash: digest, status: 'pending' };
    save();
    try {
      const result = await mutate(method, p);
      state.operations[key] = { hash: digest, status: 'done', result };
      const keys = Object.keys(state.operations);
      for (const old of keys.slice(0, Math.max(0, keys.length - 1000)))
        delete state.operations[old];
      save();
      return clone(result);
    } catch (error) {
      delete state.operations[key];
      save();
      throw error;
    }
  }
  function detail(id) {
    const s = requireSession(id);
    return {
      ...view(s),
      draft: clone(s.draft),
      flow: clone(controller(id).getSnapshot()),
      attachments: Object.values(s.attachments).map(attachmentView),
      permissions: clone(s.permissions),
      usage: clone(s.usage ?? []),
    };
  }
  // Recover interrupted runs before publishing any snapshot. Recovery never auto-resends accepted work.
  for (const id of state.order) controller(id);
  save();
  const resourceFiles=createResourceFiles({resolve:async p=>{
    const session=requireSession(p.id);
    if(p.kind==='deliverable')return readOwnedFile(session,p.artifactId);
    if(p.kind!=='attachment')fail('文件资源类型无效。');
    const attachment=session.attachments[p.attachmentId];
    if(!attachment)fail('附件不存在或不属于当前会话。','missing');
    let real;try{real=await fsp.realpath(attachment.path);}catch{fail('附件原文件已被移动或删除。','missing');}
    if(!inside(path.join(dataDir,'attachments',session.id),real))fail('附件不在本会话目录内。','permission');
    return{real,name:attachment.name,stat:await fsp.stat(real)};
  }});
  const uploads=createAttachmentUploads({dataDir,requireSession,register(item,bytes){
    const s=requireSession(item.conversationId),id='att-'+item.uploadId;
    if(s.attachments[id]){
      if(s.attachments[id].sha256!==item.sha256||s.attachments[id].name!==item.name)fail('附件身份已用于其他内容。','conflict');
      return attachmentView(s.attachments[id]);
    }
    const dir=path.join(dataDir,'attachments',s.id);privateDirectory(dir);
    const file=path.join(dir,id+path.extname(item.name));fs.writeFileSync(file,bytes,{mode:0o600});
    const value={id,conversationId:s.id,name:item.name,kind:item.kind,path:file,size:bytes.length,source:'picker',at:Date.now(),sha256:item.sha256};
    s.attachments[id]=value;save();return attachmentView(value);
  }});
  const gateway = await createDeviceGateway({ dataDir, instanceId: state.instanceId, request });
  return {
    request,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async close() {
      closed = true;
      clearTimeout(flushTimer);
      await gateway.close();
      await executor.close();
      for (const c of controllers.values()) await c.close();
      save();
    },
  };
}
