import { observeAuxiliaryTransport } from '../agent-runtime/auxiliary-transport.mjs';
/**
 * 主脑模型的配置层（主进程专用）。
 *
 * 048 起，线协议实现（两方言的流式解析、思考字段、usage、重试）统一委托
 * pi-chat.mjs（pi-ai 同源实现）；056 起，对话回合由主 agent 的 Pi 会话承担
 * （agent/main-agent.mjs，系统提示词也在那里），本文件保留：
 * ［本轮上下文］块组装、探活与拉模型（pingTextModel/
 * listRemoteModels，非流式不经 SSE 解析器）、单发轻量调用入口 chatTurn
 * （口 mouth.mjs、自动标题、经验提炼共用）。本文件不 import Electron、
 * `fetch` 可注入，离线可测（electron/text-model.test.mjs）。
 */

import { modelBaseUrl } from '../lib/pi-model.mjs';

/** 本轮上下文块的标题行（系统提示词按这个名字指认它）。 */
export const TURN_CONTEXT_HEADER = '［本轮上下文 · Hemi 宿主注入，不是用户说的话］';

/**
 * 逐回合变化的上下文块（环境时间、工作区绑定、宿主诊断、最近任务依据、任务清单），
 * 由主 agent 随本次 prompt 写入用户消息；后续请求与重建原样重放，
 * 避免删除旧上下文后破坏供应商已缓存的历史前缀。
 * 全空返回空串（不产出孤零零的标题）。
 */
export function buildTurnContextBlock({
  ambientBlock = '',
  workspaceBlock = '',
  runtimeBlock = '',
  taskEvidenceBlock = '',
  routingBlock = '',
} = {}) {
  const parts = [ambientBlock, workspaceBlock, runtimeBlock, taskEvidenceBlock, routingBlock]
    .filter((part) => typeof part === 'string' && part.trim());
  return parts.length ? [TURN_CONTEXT_HEADER, ...parts].join('\n\n') : '';
}

/**
 * 逐回合工作区块（2026-10-20 conv-mvg1qofb 复盘）：会话中途改绑工作区只在重建
 * 实例时打一次系统段补丁，模型容易被旧回合的搜索历史带偏（改绑后仍满家目录找
 * 项目）。本块随每回合用户消息重申当前绑定与执行目录；与系统段的
 * ［工作区 · 当前项目］（workspace/context.mjs）分工：那份进 system，这份逐回合
 * 可见。空入参不出块。
 */
export function buildWorkspaceTurnBlock(workspace = null) {
  if (!workspace || typeof workspace !== 'object') return '';
  const name = String(workspace.name ?? '').trim() || '未命名';
  const dir = String(workspace.dir ?? '').trim();
  if (workspace.type === 'project' && workspace.host) {
    return `【工作区】本回合绑定远端项目「${name}」（${workspace.host}）：${dir}。远端路径与文件操作按该目录解析；本机命令仍在用户家目录执行。`;
  }
  if (workspace.type === 'project') {
    return `【工作区】本回合绑定项目「${name}」：${dir}。你的执行目录（cwd）就是它；目录类请求与「这个目录」「当前目录」这类指代先按它解析，对不上时再向用户澄清。`;
  }
  if (workspace.type === 'default') {
    const cwdNote = dir ? `，执行目录（cwd）是 ${dir}（通常为空）` : '';
    return `【工作区】本回合在默认空间，未绑定项目${cwdNote}。用户问具体项目或目录时先确认位置，不在家目录里整片搜索。`;
  }
  return '';
}

/** 请求地址归一：容忍结尾斜杠；已指向 completions 的原样使用。 */
export function normalizeBaseUrl(baseUrl) {
  const base = modelBaseUrl(baseUrl);
  return base ? `${base}/chat/completions` : '';
}

/** 归一化 HTTP 错误为可念出来的中文。 */
export function describeHttpError(status, bodyText) {
  let detail = '';
  try {
    const parsed = JSON.parse(bodyText);
    detail = parsed?.error?.message ?? parsed?.message ?? '';
  } catch {
    detail = bodyText.slice(0, 120);
  }
  const suffix = detail ? `：${detail}` : '';

  if (status === 401 || status === 403) return `文本模型鉴权失败，请检查 API Key。${suffix}`;
  if (status === 404) return `文本模型端点或型号不存在，请检查设置。${suffix}`;
  if (status === 429) return `文本模型请求被限流，请稍后再说。${suffix}`;
  if (status >= 500) return `文本模型服务出错了，请稍后再试。${suffix}`;
  return `文本模型请求失败（HTTP ${status}）。${suffix}`;
}

/**
 * 032：探活失败文案 → 结构化类别（llm.ipc 的 testModelProfile 消费，渲染层
 * 按类给就地反馈）。文案来自 pingTextModel/describeHttpError（本仓自己写的，
 * 稳定前缀可匹配）：缺项／鉴权／模型不可用／超时／网络（含限流与服务端 5xx，
 * 原文案如实描述原因）。
 */
export function classifyModelError(message) {
  const text = String(message ?? '');
  if (/未配置/.test(text)) return 'missing';
  if (/鉴权失败/.test(text)) return 'auth';
  if (/端点或型号不存在/.test(text)) return 'model';
  if (/超时/.test(text)) return 'timeout';
  return 'network';
}

/**
 * 一轮对话：流式请求收完整句（048 起两方言统一委托 pi-ai 实现）。
 *
 * @param {object} options
 * @param {string} options.baseUrl   供应商根地址（openai 方言 SDK 自拼 /chat/completions，
 *        anthropic 方言剥 /v1 后 SDK 拼 /v1/messages）
 * @param {string} options.apiKey
 * @param {string} options.model
 * @param {Array}  options.messages  buildMessages() 的产物
 * @param {string} [options.api] 线协议（046）：openai-completions（缺省）｜
 *        anthropic-messages——两方言都交 pi-ai 同源实现（048），思考形状按
 *        模型 compat／显式 thinkingFormat 构造。
 * @param {string} [options.thinkingLevel] 思考强度档位（033；default＝厂商中档）
 * @param {string} [options.thinkingFormat] 厂商格式显式覆盖（缺省按 baseUrl 探测）
 * @param {AbortSignal} [options.signal] 外部取消（结束通话 / 新回合）
 * @param {(text: string) => void} [options.onDelta] 增量回调（003 TTS / 004 进度预埋）
 * @param {(event: {kind: string, text?: string}) => void} [options.onEvent]
 *        048 结构化增量事件（thinking_start/thinking/thinking_end/text）
 * @param {number} [options.timeoutMs] 无首字超时，openai 默认 10s／anthropic 30s
 * @param {number} [options.maxPreStreamRetries] 首字前瞬时故障重试次数（默认 2；
 *        038 自动路由传 0——备用切换由薄包装负责，两层都重试会放大请求量）
 * @param {typeof fetch} [options.fetchImpl] 测试注入
 * @param {(payload: object) => void} [options.onPayload] 请求体观测（等价单测）
 * @returns {Promise<{content: string, finishReason: string, toolCalls: Array, usage: object|null,
 *          thinking?: {text: string, durationMs: number}, usageDetail?: object}>}
 *          usage＝服务真实返回的用量（旧三字段口径）；缺失为 null（不写零）。
 *          thinking／usageDetail 为 048 增量契约（S2 起消费）。
 */
export async function chatTurn(options) {
  // 两方言整条委托 pi-chat（懒加载——pi-ai 的 SDK 实现只在对话时才进内存）。
  const { chatTurnPi } = await import('./pi-chat.mjs');
  return chatTurnPi(options);
}


const PING_TIMEOUT_MS = 20000;
/** anthropic 方言探活超时对齐对话侧默认（pi-chat：anthropic 30s／openai 10s 量级）。 */
const PING_ANTHROPIC_TIMEOUT_MS = 30000;

/**
 * 连通性测试（设置页「测试连通性」按钮）：最小非流式请求探活。
 *
 * 刻意不走 chatTurn：它的首字计时只认 content 分片，推理模型（deepseek-flash
 * 实测）正文前会先吐一段 reasoning_content——好端端的连通会被误判成首字超时。
 * 探活只关心「HTTP 200 + 服务端回了什么模型」，非流式一次拿全，sample 允许为空。
 *
 * @returns {Promise<{ok: true, latencyMs: number, resolvedModel: string, sample: string}>}
 *          失败抛错（message 已是可展示的中文）。
 */
/** anthropic 探活端点：剥尾斜杠与 /v1（OpenAI 习惯）后拼 /v1/messages——与 pi-chat 同口径。 */
function anthropicPingUrl(baseUrl) {
  const base = modelBaseUrl(baseUrl, 'anthropic-messages');
  return base ? `${base}/v1/messages` : '';
}

async function pingTextModelRaw({
  baseUrl,
  apiKey,
  model,
  api = 'openai-completions',
  timeoutMs,
  fetchImpl = fetch,
}) {
  const anthropic = api === 'anthropic-messages';
  const url = anthropic ? anthropicPingUrl(baseUrl) : normalizeBaseUrl(baseUrl);
  if (!url) throw new Error('文本模型端点未配置。');
  if (!apiKey) throw new Error('未配置 API Key，请先填写并保存。');
  if (!model) throw new Error('未配置型号，请先填写。');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? (anthropic ? PING_ANTHROPIC_TIMEOUT_MS : PING_TIMEOUT_MS));
  const startedAt = Date.now();
  let response;
  let data = null;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      signal: controller.signal,
      headers: anthropic
        ? {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          }
        : {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
      // max_tokens 给小值控成本即可；推理模型把它花在思考上、正文为空也算探活成功。
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 16,
        stream: false,
      }),
    });
    if (response.ok) {
      data = await response.json().catch(() => null);
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`连通性测试超时（${Math.round((timeoutMs ?? (anthropic ? PING_ANTHROPIC_TIMEOUT_MS : PING_TIMEOUT_MS)) / 1000)} 秒），请检查网络或端点。`);
    }
    throw new Error('连不上文本模型服务，请检查网络。');
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throw new Error(describeHttpError(response.status, bodyText));
  }
  if (controller.signal.aborted) {
    throw new Error(`连通性测试超时（${Math.round((timeoutMs ?? (anthropic ? PING_ANTHROPIC_TIMEOUT_MS : PING_TIMEOUT_MS)) / 1000)} 秒），请检查网络或端点。`);
  }

  const latencyMs = Date.now() - startedAt;
  const resolvedModel = typeof data?.model === 'string' && data.model ? data.model : model;
  const rawContent = anthropic
    ? Array.isArray(data?.content)
      ? data.content.find((block) => block?.type === 'text')?.text
      : undefined
    : data?.choices?.[0]?.message?.content;
  return {
    ok: true,
    latencyMs,
    // 服务端实际用的模型名：别名（deepseek-v4-flash → deepseek-flash）在这里现形。
    resolvedModel,
    sample: typeof rawContent === 'string' ? rawContent.trim().slice(0, 60) : '',
  };
}

/**
 * 041 拉取模型列表：解析 GET /models 的响应体（纯函数，测试直接喂样本）。
 * OpenAI 兼容形（DeepSeek/千问/Kimi/GLM/OpenRouter/Ollama v1）＝`{ data: [{ id }] }`；
 * 个别网关回 Ollama 原生形 `{ models: [{ name }] }`，一并容忍。去重、排序、过滤空值。
 */
export function parseModelsResponse(payload) {
  const rows = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : [];
  const ids = new Set();
  for (const row of rows) {
    if (row == null || typeof row !== 'object') continue;
    for (const field of ['id', 'name', 'model']) {
      const value = row[field];
      if (typeof value === 'string' && value.trim()) {
        ids.add(value.trim());
        break;
      }
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

const LIST_MODELS_TIMEOUT_MS = 15000;

/**
 * 拉取供应商的可用模型列表（设置页「拉取模型列表」按钮）。
 * 地址沿用 normalizeBaseUrl 口径：用户填 `/v1` 也好、完整 `/chat/completions` 也好，
 * 都归一到同一基地，再把末段换成 `/models`。Key 为空时不带 Authorization
 * （本地端点免 Key 可用）。失败抛错（message 可直接展示）。
 *
 * @returns {Promise<{models: string[]}>}
 */
export async function listRemoteModels({
  baseUrl,
  apiKey,
  timeoutMs = LIST_MODELS_TIMEOUT_MS,
  fetchImpl = fetch,
}) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) throw new Error('文本模型端点未配置。');
  const url = normalized.replace(/\/chat\/completions$/, '/models');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let data = null;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      signal: controller.signal,
      ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
    });
    if (response.ok) {
      data = await response.json().catch(() => null);
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`拉取模型列表超时（${Math.round(timeoutMs / 1000)} 秒），请检查网络或端点。`);
    }
    throw new Error('连不上模型服务，请检查网络或接口地址。');
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throw new Error(describeHttpError(response.status, bodyText));
  }
  if (controller.signal.aborted) {
    throw new Error(`拉取模型列表超时（${Math.round(timeoutMs / 1000)} 秒），请检查网络或端点。`);
  }

  const models = parseModelsResponse(data);
  if (!models.length) throw new Error('服务没有返回任何模型。');
  return { models };
}

export async function pingTextModel(options) { return observeAuxiliaryTransport(options, 'diagnostic', fetchImpl => pingTextModelRaw({ ...options, fetchImpl })); }
