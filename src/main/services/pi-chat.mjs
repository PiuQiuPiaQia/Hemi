/**
 * 对话侧统一的 pi-ai 实现（048 S1；046 anthropic 方言的泛化）。
 *
 * 两条线协议（openai-completions / anthropic-messages）都走 pi-ai 的
 * streamSimple——协议解析（思考字段、usage、工具分片、SSE 容错）不再自研，
 * Hemi 只负责：模型定义（目录命中/通用兜底）、思考档映射、消息形状转换、
 * 首字门、错误归位与 chatTurn 输出契约。anthropic-chat.mjs 的手写 SSE
 * （text-model.mjs）随本模块退役。
 *
 * 输入输出契约与 text-model.chatTurn 完全一致（content/finishReason/toolCalls/
 * usage、onDelta、首字超时、外部取消、结构化错误字段 kind/status/serviceCode/
 * outputStarted），llm.ipc 无感切换。048 S2 起额外产出：
 * - onEvent({kind})：思考类增量事件（thinking_start/thinking/thinking_end）；
 * - result.thinking {text, durationMs} / result.usageDetail（pi-ai 归一用量＋生成时长）。
 */

import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { piModelOf, reasoningLevelOf } from '../lib/pi-model.mjs';
import { streamOAuthModel } from './oauth-models.mjs';
import { describeHttpError } from './text-model.mjs';
import { controlledStream } from '../agent-runtime/usage-ledger.mjs';

const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 10000;
const FIRST_TEXT_TIMEOUT_ANTHROPIC_MS = 30000;

/**
 * 合成历史助手消息要带 pi-ai AssistantMessage 的完整契约字段：内部上下文估算
 * （estimateContextTokens，max_tokens 收缩必经）会读历史 assistant 的
 * stopReason 和 usage——缺了就在真机历史（assistant 打头）上崩
 * undefined.totalTokens（2026-10-07 dev 实测）。零用量＋stop＝估算器视为
 * 「无可用用量」安全跳过。
 */
function syntheticAssistantMessage(blocks) {
  return {
    role: 'assistant',
    content: blocks,
    stopReason: 'stop',
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    api: 'assistant-message',
    provider: 'hemi-chat',
    timestamp: 0,
  };
}

/** data:image/png;base64,xxx → {data, mimeType}（pi-ai ImageContent 块）。 */
function parseDataUrl(url) {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(String(url ?? ''));
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

/**
 * OpenAI 形状消息 → pi-ai 消息（两方言共用）。工具往返（llm.ipc 的
 * execute_task 有限轮）必须完整往返：assistant.tool_calls → toolCall 块，
 * role:'tool' → toolResult 消息——丢掉任一侧模型都无法继续工具循环。
 * 028 图片直传（user content 为 parts 数组）转 pi-ai 图像块——anthropic
 * 方言此前丢图片消息（046 只收字符串 content），此处一并修复。
 */
export function buildPiMessages(messages) {
  const systemParts = [];
  const turns = [];
  const toolNameById = new Map();
  for (const entry of Array.isArray(messages) ? messages : []) {
    if (!entry) continue;
    if (entry.role === 'system') {
      if (typeof entry.content === 'string' && entry.content.trim()) systemParts.push(entry.content.trim());
      continue;
    }
    if (entry.role === 'tool') {
      const text = typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content ?? '');
      turns.push({
        role: 'toolResult',
        toolCallId: String(entry.tool_call_id ?? ''),
        toolName: toolNameById.get(String(entry.tool_call_id ?? '')) ?? String(entry.tool_call_id ?? ''),
        content: [{ type: 'text', text }],
        isError: false,
        timestamp: 0,
      });
      continue;
    }
    if (entry.role === 'assistant' && Array.isArray(entry.tool_calls) && entry.tool_calls.length) {
      // 只有工具调用、没有正文的 assistant 消息（appendToolExchange 的产物）也要进上下文。
      const blocks = [];
      if (typeof entry.content === 'string' && entry.content.trim()) {
        blocks.push({ type: 'text', text: entry.content.trim() });
      }
      for (const call of entry.tool_calls) {
        const id = String(call?.id ?? '');
        const name = String(call?.function?.name ?? '');
        let args = {};
        try { args = JSON.parse(call?.function?.arguments || '{}'); } catch { args = {}; }
        toolNameById.set(id, name);
        blocks.push({ type: 'toolCall', id, name, arguments: args });
      }
      turns.push(syntheticAssistantMessage(blocks));
      continue;
    }
    if (entry.role === 'user' || entry.role === 'assistant') {
      if (Array.isArray(entry.content)) {
        // 028 多模直传：text parts + image_url parts → pi-ai 内容块。
        const blocks = [];
        let hasContent = false;
        for (const part of entry.content) {
          if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
            blocks.push({ type: 'text', text: part.text.trim() });
            hasContent = true;
          } else if (part?.type === 'image_url') {
            const image = parseDataUrl(part.image_url?.url);
            if (image) {
              blocks.push({ type: 'image', data: image.data, mimeType: image.mimeType });
              hasContent = true;
            }
          }
        }
        if (hasContent) {
          turns.push(entry.role === 'assistant'
            ? syntheticAssistantMessage(blocks)
            : { role: 'user', content: blocks });
        }
        continue;
      }
      if (typeof entry.content === 'string' && entry.content.trim()) {
        if (entry.role === 'assistant') {
          // pi-ai 要求 assistant 消息 content 是块数组——裸字符串在多轮历史
          // 的 transformMessages 里崩（undefined.length，2026-10-07 真机实测）。
          turns.push(syntheticAssistantMessage([{ type: 'text', text: entry.content.trim() }]));
        } else {
          turns.push({ role: 'user', content: entry.content.trim() });
        }
      }
    }
  }
  return { systemParts, turns };
}

function piToolsFrom(tools) {
  return (Array.isArray(tools) ? tools : [])
    .filter((tool) => tool?.function?.name)
    .map((tool) => ({
      name: String(tool.function.name),
      description: String(tool.function.description ?? ''),
      parameters: tool.function.parameters ?? { type: 'object', properties: {} },
    }));
}

/** pi-ai 归一 usage → 旧 usage 契约；全零视为「服务未回用量」（不写零、不编造）。 */
function legacyUsageOf(usage) {
  if (!usage) return null;
  const input = Number(usage.input) || 0;
  const output = Number(usage.output) || 0;
  const cacheRead = Number(usage.cacheRead) || 0;
  const cacheWrite = Number(usage.cacheWrite) || 0;
  const totalTokens = Number(usage.totalTokens) || input + output + cacheRead + cacheWrite;
  if (!input && !output && !cacheRead && !cacheWrite) return null;
  return { promptTokens: input, completionTokens: output, totalTokens };
}

const STOP_REASON_TO_FINISH = {
  stop: 'stop',
  length: 'length',
  toolUse: 'tool_calls',
  deferred: 'stop',
};

function describeAbort(externalAborted) {
  return new Error(externalAborted ? '回合已取消。' : '等待文本模型首字超时，请检查网络或换个型号试试。');
}

/** 错误事件文本里的 serviceCode（OpenAI 形错误体的 code/type 字段，尽力而为）。 */
function serviceCodeFrom(text) {
  for (const pattern of [/"code"\s*:\s*"([^"]+)"/, /"type"\s*:\s*"([^"]+)"/]) {
    const match = String(text ?? '').match(pattern);
    if (match?.[1]) return match[1];
  }
  return '';
}

/** Anthropic 单请求显式缓存断点上限。 */
const MAX_CACHE_BREAKPOINTS = 4;
/** 可挂 cache_control 的内容块类型（thinking 类不能挂；openai 形 parts 只有 text/image_url）。 */
const CACHEABLE_BLOCK_TYPES = new Set(['text', 'image', 'tool_use', 'tool_result']);

function cacheControlsOf(params) {
  const found = [];
  const scan = (blocks) => {
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) if (block?.cache_control) found.push(block.cache_control);
  };
  scan(params?.system);
  scan(params?.tools);
  for (const message of params?.messages ?? []) scan(message?.content);
  return found;
}

/** 本回合用户消息下标：从尾部找第一条带非 tool_result 内容的 user 消息（工具续轮的结果回传不算）。 */
function currentTurnIndex(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    if (typeof message.content === 'string') return index;
    if (Array.isArray(message.content) && message.content.some((block) => block?.type !== 'tool_result')) return index;
  }
  return -1;
}

/**
 * 历史末尾补一个显式缓存断点（就地改写并返回请求体）。
 *
 * pi-ai 的显式断点只落在工具尾、system 与末条消息；末条 user 消息带着逐回合
 * 变化的［本轮上下文］，下回合重放时已不是同一段内容——没有断点落在「历史
 * 末尾」，历史部分永远读不到缓存，每轮全量重写。这里给本回合用户消息之前
 * 的最后一条历史消息挂断点：下回合的断点向前回溯即命中它，只有最近一来一回
 * ＋本轮上下文按未命中计。
 *
 * 只在请求体已带显式断点（端点认 cache_control）且未到上限时补；openai 方言
 * 的自动前缀缓存（DeepSeek/OpenAI）没有断点，原样放行。
 */
export function addHistoryCacheBreakpoint(params) {
  const messages = params?.messages;
  if (!Array.isArray(messages)) return params;
  const existing = cacheControlsOf(params);
  if (!existing.length || existing.length >= MAX_CACHE_BREAKPOINTS) return params;
  const turnIndex = currentTurnIndex(messages);
  if (turnIndex < 1) return params;
  const target = messages[turnIndex - 1];
  const cacheControl = { ...existing[0] };
  if (typeof target?.content === 'string') {
    if (target.content) target.content = [{ type: 'text', text: target.content, cache_control: cacheControl }];
    return params;
  }
  if (!Array.isArray(target?.content)) return params;
  for (let index = target.content.length - 1; index >= 0; index -= 1) {
    const block = target.content[index];
    if (!CACHEABLE_BLOCK_TYPES.has(block?.type)) continue;
    if (!block.cache_control) block.cache_control = cacheControl;
    break;
  }
  return params;
}

/**
 * pi-ai 事件流 → chatTurn 契约（046 anthropic-chat 泛化到两方言）。
 * 首字门：正文/工具分片算活动（置 outputStarted、掐计时器）；思考分片只掐
 * 计时器不置 outputStarted（思考不上屏，自动路由切备用仍安全）。
 */
export async function chatTurnPi({
  oauthProvider,
  baseUrl,
  apiKey,
  model,
  messages,
  tools,
  api = 'openai-completions',
  thinkingLevel,
  thinkingFormat,
  supportsVision,
  maxTokens,
  signal,
  onDelta,
  onEvent = null,
  timeoutMs,
  maxPreStreamRetries = 2,
  runtimeExecution = null,
  fetchImpl = fetch,
  onPayload = null,
}) {
  const dialect = api === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions';
  const effectiveTimeoutMs = timeoutMs ?? (dialect === 'anthropic-messages'
    ? FIRST_TEXT_TIMEOUT_ANTHROPIC_MS
    : DEFAULT_FIRST_TOKEN_TIMEOUT_MS);
  if (!String(baseUrl ?? '').trim()) throw Object.assign(new Error('文本模型端点未配置。'), { kind: 'config' });
  if (!apiKey) throw Object.assign(new Error('未配置文本模型，请先在设置里填写 API Key。'), { kind: 'config' });
  if (!model) throw Object.assign(new Error('未配置文本模型型号，请先在设置里填写。'), { kind: 'config' });

  const { systemParts, turns } = buildPiMessages(messages);
  const hasImage = turns.some(turn => Array.isArray(turn.content) && turn.content.some(block => block.type === 'image'));
  if (hasImage && supportsVision === false) throw Object.assign(new Error('当前模型不支持图像输入'), { kind: 'config' });
  // 直接调用此 API 的调用者可显式携带图片；已声明文本模型时必须拒绝，不能让 SDK 静默丢图。
  const candidate = { oauthProvider, api: oauthProvider ? api : dialect, model, baseUrl, thinkingFormat, supportsVision: supportsVision ?? hasImage };
  const chatModel = piModelOf(candidate);
  const piTools = piToolsFrom(tools);
  const context = normalizeContext({
    ...(systemParts.length ? { systemPrompt: systemParts.join('\n\n') } : {}),
    messages: turns,
    ...(piTools.length ? { tools: piTools } : {}),
  });

  // 外部 signal 过不来（AbortSignal 不跨边界），转发到内部 controller。
  const controller = new AbortController();
  let externalAborted = false;
  if (signal) {
    if (signal.aborted) {
      externalAborted = true;
      controller.abort();
    } else {
      signal.addEventListener('abort', () => {
        externalAborted = true;
        controller.abort();
      }, { once: true });
    }
  }

  let firstTokenTimer = setTimeout(() => controller.abort(), effectiveTimeoutMs);
  const clearFirstTokenTimer = () => {
    if (!firstTokenTimer) return;
    clearTimeout(firstTokenTimer);
    firstTokenTimer = null;
  };

  const apiImpl = dialect === 'anthropic-messages' ? anthropicMessagesApi() : openAICompletionsApi();
  const reasoning = reasoningLevelOf(thinkingLevel, chatModel);
  // 请求体发出前补历史缓存断点，再交给调用方观测（单测断言看到的是真实线上形状）。
  const payloadHook = async (params, payloadModel) => {
    const prepared = addHistoryCacheBreakpoint(params);
    const observed = onPayload ? await onPayload(prepared, payloadModel) : undefined;
    return observed !== undefined ? observed : prepared;
  };
  const transport = oauthProvider ? (_model, ctx, opts) => streamOAuthModel(candidate, ctx, opts) : apiImpl.streamSimple;
  const streamFn = runtimeExecution ? controlledStream(transport, () => runtimeExecution) : transport;
  const stream = streamFn(chatModel, context, {
    apiKey,
    signal: controller.signal,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
    onPayload: payloadHook,
    maxRetries: maxPreStreamRetries,
    ...(maxTokens ? { maxTokens } : {}),
    ...(reasoning ? { reasoning } : {}),
  });

  let content = '';
  const toolCalls = [];
  let stopReason = '';
  let usage = null;
  let outputStarted = false; // 本次请求是否已产生可消费输出（路由切换的安全边界）
  let thinkingSeen = false;
  let thinkingText = '';
  let thinkingStartAt = null;
  let thinkingElapsedMs = 0;
  let firstFragmentAt = null;
  const touchFragment = () => {
    if (firstFragmentAt == null) firstFragmentAt = Date.now();
  };
  const emit = (event) => { onEvent?.(event); };

  try {
    for await (const event of stream) {
      if (event.type === 'text_delta') {
        const delta = typeof event.delta === 'string' ? event.delta : '';
        if (delta) {
          content += delta;
          outputStarted = true;
          clearFirstTokenTimer();
          touchFragment();
          onDelta?.(delta);
          emit({ kind: 'text', text: delta });
        }
      } else if (event.type === 'thinking_start') {
        // 思考分片不算首字活动（不上屏、不置 outputStarted），但证明流活着——
        // 推理模型难题思考常超 10s，不掐计时器会把正常思考误判成首字超时
        // （048 现网缺陷回归，2026-10-08 修复语义随迁移保留）。
        thinkingSeen = true;
        clearFirstTokenTimer();
        if (thinkingStartAt == null) thinkingStartAt = Date.now();
        emit({ kind: 'thinking_start' });
      } else if (event.type === 'thinking_delta') {
        thinkingSeen = true;
        clearFirstTokenTimer();
        touchFragment();
        const delta = typeof event.delta === 'string' ? event.delta : '';
        if (delta) {
          thinkingText += delta;
          emit({ kind: 'thinking', text: delta });
        }
      } else if (event.type === 'thinking_end') {
        if (thinkingStartAt != null) {
          thinkingElapsedMs += Date.now() - thinkingStartAt;
          thinkingStartAt = null;
        }
        emit({ kind: 'thinking_end' });
      } else if (event.type === 'toolcall_start' || event.type === 'toolcall_delta') {
        outputStarted = true;
        clearFirstTokenTimer();
        touchFragment();
      } else if (event.type === 'done') {
        stopReason = STOP_REASON_TO_FINISH[event.reason] ?? 'stop';
        // pi-ai 归一 usage（input/output/cacheRead/cacheWrite）；全零＝未回。
        usage = event.message?.usage ?? null;
        for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
          if (block?.type !== 'toolCall' || !block.name) continue;
          toolCalls.push({
            id: String(block.id ?? ''),
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.arguments ?? {}) },
          });
        }
      } else if (event.type === 'error') {
        // 首字门掐断/外部取消时 SDK 以 error 事件（而非 AbortError）收场——先归位
        // 到超时/取消语义，再谈其他错误（046 实测），否则超时被吞成一般失败。
        if (externalAborted || controller.signal.aborted) {
          clearFirstTokenTimer();
          throw Object.assign(describeAbort(externalAborted), {
            kind: externalAborted ? 'abort' : 'timeout',
            outputStarted: outputStarted || thinkingSeen,
          });
        }
        const message = event.error?.errorMessage
          ?? event.error?.message
          ?? ((typeof event.error === 'string' ? event.error : '') || '文本模型回应失败，请重试。');
        clearFirstTokenTimer();
        const statusMatch = String(message).match(/\b([45]\d\d)\b/);
        if (statusMatch) {
          const status = Number(statusMatch[1]);
          throw Object.assign(new Error(describeHttpError(status, String(message))), {
            kind: 'http',
            status,
            serviceCode: serviceCodeFrom(message),
            outputStarted,
          });
        }
        if (/stream ended without finish_reason/i.test(String(message))) {
          throw Object.assign(new Error('文本模型回应被截断，请重试。'), {
            kind: 'stream',
            outputStarted: true,
          });
        }
        if (outputStarted) {
          throw Object.assign(new Error('文本模型回应传输中断，请重试。'), {
            kind: 'stream',
            outputStarted: true,
          });
        }
        // 流内部的异常堆栈只留在 errorMessage 文本里——不打出来「为什么崩」永远靠猜。
        if (event.error?.stack) {
          console.error(`[pi-chat] stream error stack:\n${event.error.stack}`);
        }
        throw Object.assign(new Error('连不上文本模型服务，请检查网络。'), {
          kind: 'network',
          outputStarted: false,
        });
      }
    }
  } catch (error) {
    clearFirstTokenTimer();
    if (externalAborted || error?.name === 'AbortError') {
      throw Object.assign(describeAbort(externalAborted), {
        kind: externalAborted ? 'abort' : 'timeout',
        outputStarted: outputStarted || thinkingSeen,
      });
    }
    if (error?.kind) throw error;
    throw Object.assign(new Error('文本模型回应传输中断，请重试。'), {
      kind: 'stream',
      outputStarted: true,
      cause: error instanceof Error ? error : undefined,
    });
  }
  clearFirstTokenTimer();

  if (thinkingStartAt != null) thinkingElapsedMs += Date.now() - thinkingStartAt;

  if (!stopReason) {
    throw Object.assign(new Error('文本模型回应被截断，请重试。'), { kind: 'stream', outputStarted: true });
  }

  const legacyUsage = legacyUsageOf(usage);

  return {
    content: content.trim(),
    finishReason: toolCalls.length ? 'tool_calls' : stopReason,
    toolCalls,
    usage: legacyUsage,
    ...(thinkingText || thinkingElapsedMs
      ? {
        thinking: {
          text: thinkingText,
          durationMs: thinkingElapsedMs,
        },
      }
      : {}),
    ...(legacyUsage
      ? {
        usageDetail: {
          input: Number(usage.input) || 0,
          output: Number(usage.output) || 0,
          cacheRead: Number(usage.cacheRead) || 0,
          cacheWrite: Number(usage.cacheWrite) || 0,
          genMs: firstFragmentAt != null ? Date.now() - firstFragmentAt : 0,
        },
      }
      : {}),
  };
}
