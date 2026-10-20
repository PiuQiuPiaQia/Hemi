// 047 导入验证：两种协议的严格最小探活 ＋ 新 Key 的推理端模型列表。
//
// 与 text-model.pingTextModel 的差别（technical-plan §4）：探活是导入门禁，
// 必须「严格」——200＋HTML、空 JSON、错误对象都不放行；失败带本地错误码，
// 不把站点原文直接进日志/渲染层。请求走无账号 Cookie 的独立通道（直接
// fetchImpl，不经站点 session），仅带模型 Key，禁重定向。
//
// 端点归一与 agent／轻量调用／设置探活共用，避免完整接口地址重复拼接。
import { modelBaseUrl } from '../../lib/pi-model.mjs';

export const PROBE_TIMEOUT_MS = 20000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export function openaiEndpoint(baseUrl) {
  const base = modelBaseUrl(baseUrl);
  if (!base) throw new Error('接口地址缺失');
  return `${base}/chat/completions`;
}

export function openaiModelsEndpoint(baseUrl) {
  return openaiEndpoint(baseUrl).replace(/\/chat\/completions$/, '/models');
}

/** Anthropic 供应商 baseUrl → /v1/messages（吸收尾斜杠、/v1、/v1/messages 变体）。 */
export function anthropicEndpoint(baseUrl) {
  const base = modelBaseUrl(baseUrl, 'anthropic-messages');
  if (!base) throw new Error('接口地址缺失');
  return `${base}/v1/messages`;
}

async function readJson(response) {
  const text = await response.text();
  if (!text || text.length > MAX_BODY_BYTES) return { kind: 'empty' };
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return { kind: 'html' };
  try {
    return { kind: 'json', value: JSON.parse(trimmed) };
  } catch {
    return { kind: 'bad-json' };
  }
}

function codeForStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'endpoint-missing';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'server-error';
  return 'http-error';
}

const CODE_MESSAGES = {
  auth: 'Key 没被接受（401/403）',
  'endpoint-missing': '这个地址上没有对应接口（404）',
  'rate-limited': '站点限流了，稍后再试',
  'server-error': '站点服务出错（5xx）',
  'http-error': '站点返回了非成功状态',
  network: '连不上站点',
  timeout: '请求超时',
  'not-json': '响应不是合法 JSON（可能是 HTML 页面）',
  'shape-mismatch': '响应不像这个协议的成功结构',
  'no-choices': '响应里没有 choices',
  'no-content': '响应里没有 content',
};

function fail(code, status = 0, extra = null) {
  return { ok: false, code, message: CODE_MESSAGES[code] ?? '验证失败', ...(status ? { status } : {}), ...(extra ? { detail: extra } : {}) };
}

async function requestJson({ url, init, fetchImpl, timeoutMs, label }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, { ...init, signal: controller.signal, redirect: 'error' });
  } catch (error) {
    if (controller.signal.aborted) return { failed: fail('timeout') };
    return { failed: fail('network', 0, String(error?.cause?.code ?? '')) };
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const body = await readJson(response);
    return {
      failed: fail(codeForStatus(response.status), response.status),
      remoteMessage: body.kind === 'json' && body.value?.error?.message
        ? String(body.value.error.message).slice(0, 200)
        : null,
    };
  }
  const body = await readJson(response);
  if (body.kind !== 'json') return { failed: fail('not-json', response.status) };
  return { response, body: body.value };
}

/**
 * openai-completions 最小非流式请求。成功标准：JSON 对象且 choices 为非空数组。
 */
export async function probeOpenaiChat({ baseUrl, apiKey, model, fetchImpl = globalThis.fetch?.bind(globalThis), timeoutMs = PROBE_TIMEOUT_MS }) {
  if (typeof fetchImpl !== 'function') throw new Error('probeOpenaiChat 缺少 fetchImpl');
  const url = openaiEndpoint(baseUrl);
  const result = await requestJson({
    url,
    init: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 16,
        stream: false,
      }),
    },
    fetchImpl,
    timeoutMs,
  });
  if (result.failed) return result.failed;
  const value = result.body;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('shape-mismatch', result.response.status);
  const choices = value.choices;
  if (!Array.isArray(choices) || choices.length === 0) return fail('no-choices', result.response.status);
  const first = choices[0];
  // 合法空正文（content 缺省）不算失败；有 message.content 则回显前 80 字做连通证据。
  const sample = typeof first?.message?.content === 'string' ? first.message.content.slice(0, 80) : '';
  return { ok: true, latencyMs: Date.now(), resolvedModel: typeof value.model === 'string' ? value.model : null, sample };
}

/**
 * anthropic-messages 最小非流式请求。成功标准：JSON 对象、content 为数组、role=assistant。
 */
export async function probeAnthropicMessages({ baseUrl, apiKey, model, fetchImpl = globalThis.fetch?.bind(globalThis), timeoutMs = PROBE_TIMEOUT_MS }) {
  if (typeof fetchImpl !== 'function') throw new Error('probeAnthropicMessages 缺少 fetchImpl');
  const url = anthropicEndpoint(baseUrl);
  const result = await requestJson({
    url,
    init: {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'ping' }],
        stream: false,
      }),
    },
    fetchImpl,
    timeoutMs,
  });
  if (result.failed) return result.failed;
  const value = result.body;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('shape-mismatch', result.response.status);
  if (!Array.isArray(value.content)) return fail('no-content', result.response.status);
  if (value.role && value.role !== 'assistant') return fail('shape-mismatch', result.response.status);
  const text = value.content.find((block) => block?.type === 'text' && typeof block.text === 'string');
  return { ok: true, latencyMs: Date.now(), resolvedModel: typeof value.model === 'string' ? value.model : null, sample: text ? text.text.slice(0, 80) : '' };
}

/**
 * 新 Key 的模型可见列表（GET {openai baseUrl}/models）。严格解析：
 * { data: [{ id }] } 或 { models: [{ name }] }；保留条目的
 * supported_endpoint_types 元数据（New API 扩展字段，缺省视为未知）。
 */
export async function fetchOpenaiModels({ baseUrl, apiKey, fetchImpl = globalThis.fetch?.bind(globalThis), timeoutMs = PROBE_TIMEOUT_MS }) {
  if (typeof fetchImpl !== 'function') throw new Error('fetchOpenaiModels 缺少 fetchImpl');
  const url = openaiModelsEndpoint(baseUrl);
  const result = await requestJson({
    url,
    init: { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } },
    fetchImpl,
    timeoutMs,
  });
  if (result.failed) return result.failed;
  const value = result.body;
  const rawList = Array.isArray(value?.data)
    ? value.data
    : Array.isArray(value?.models)
      ? value.models
      : null;
  if (!rawList) return fail('shape-mismatch', result.response.status);
  const models = [];
  for (const item of rawList) {
    const id = typeof item?.id === 'string' ? item.id : typeof item?.name === 'string' ? item.name : null;
    if (!id) continue;
    const endpointTypes = Array.isArray(item?.supported_endpoint_types)
      ? item.supported_endpoint_types.filter((t) => typeof t === 'string')
      : null;
    models.push({ id, ...(endpointTypes ? { endpointTypes } : {}) });
  }
  return { ok: true, models };
}
