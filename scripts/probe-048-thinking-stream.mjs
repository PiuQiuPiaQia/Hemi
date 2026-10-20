// 048 探针：对话侧各供应商/模型的流式「思考文本」是否真实可得。
//
// 每个模型跑两路，同一道需推理的题：
//   raw   —— 现行对话路径（text-model.chatTurn，openai 方言手写 SSE／anthropic 方言委托 pi-ai），
//            fetch 包一层旁路抄录原始 SSE：统计传输里出现的思考字段名与字符数（证明「线上有没有」）；
//   piai  —— pi-ai streamSimple 直连（目录条目命中即用，宿主端点覆盖）：统计 thinking_delta
//            分片数/字符数、正文字符数、usage（证明「归一后拿不拿得到」）。
// 只读真实模型目录（不写任何配置），Key 经 safeStorage 现场解密。
//
// 运行：npx electron scripts/probe-048-thinking-stream.mjs [providerName/model 过滤子串]
// 结果：逐行打印 + 末行 HEMI_PROBE_048=<JSON>；明细另存 /tmp/hemi-probe-048.json
import { app, safeStorage } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

app.setName('hemi'); // 与正式应用同一 Keychain 身份，密文可解密
// 真实目录只读；Chromium 自身状态落临时目录，不碰正式 userData（可与运行中的 Hemi 共存）。
const REAL_USER_DATA = path.join(app.getPath('appData'), 'hemi');
app.setPath('userData', '/tmp/hemi-probe-048-ud');

const QUESTIONS = {
  easy: '一个笼子里有鸡和兔共 35 只，脚共 94 只。鸡和兔各几只？只用一句话给出答案。',
  // 难题：逼 adaptive 型号真正长思考（观察思考是逐步流出还是正文前整段到达）
  hard: '有 12 枚外观相同的硬币，其中恰有一枚重量不同（不知偏轻偏重）。用天平称 3 次找出它并判断轻重。请给出完整称法，最后用两三句话总结。',
};
const QUESTION = QUESTIONS[process.env.HEMI_PROBE_Q ?? 'easy'] ?? QUESTIONS.easy;
const FILTER = process.argv.slice(2).find((arg) => !arg.startsWith('-') && !arg.endsWith('.mjs')) ?? '';
const TIMEOUT_MS = 120000;

const { chatTurn } = await import('../src/main/services/text-model.mjs');
const { reasoningLevelOf, modelBaseUrl } = await import('../src/main/lib/pi-model.mjs');
const { ANTHROPIC_MODELS } = await import('@earendil-works/pi-ai/providers/anthropic.models');
const { DEEPSEEK_MODELS } = await import('@earendil-works/pi-ai/providers/deepseek.models');
const { ZAI_CODING_CN_MODELS } = await import('@earendil-works/pi-ai/providers/zai-coding-cn.models');
const { ZAI_MODELS } = await import('@earendil-works/pi-ai/providers/zai.models');
const { anthropicMessagesApi } = await import('@earendil-works/pi-ai/api/anthropic-messages.lazy');
const { openAICompletionsApi } = await import('@earendil-works/pi-ai/api/openai-completions.lazy');

/** fetch 旁路：响应体 tee 一份按行抄录，不改变主路径消费。 */
function teeFetch(sink) {
  return async (url, init) => {
    const response = await fetch(url, init);
    sink.status = response.status;
    if (!response.body) return response;
    const [a, b] = response.body.tee();
    (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of b) sink.raw += decoder.decode(chunk, { stream: true });
      sink.ended = true;
    })().catch((error) => { sink.teeError = String(error?.message ?? error); });
    return new Response(a, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

/** 原始 SSE 里思考相关字段的盘点（openai：delta.reasoning*；anthropic：thinking_delta/redacted）。 */
function scanRawSse(raw) {
  const fields = {};
  const bump = (key, chars) => {
    fields[key] ??= { frames: 0, chars: 0 };
    fields[key].frames += 1;
    fields[key].chars += chars;
  };
  let contentChars = 0;
  let usage = null;
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let json;
    try { json = JSON.parse(payload); } catch { continue; }
    // openai-completions
    const delta = json?.choices?.[0]?.delta;
    if (delta) {
      for (const key of ['reasoning_content', 'reasoning', 'reasoning_text']) {
        if (typeof delta[key] === 'string' && delta[key]) bump(`delta.${key}`, delta[key].length);
      }
      if (Array.isArray(delta.reasoning_details) && delta.reasoning_details.length) {
        bump('delta.reasoning_details', JSON.stringify(delta.reasoning_details).length);
      }
      if (typeof delta.content === 'string') {
        const think = delta.content.match(/<think>[\s\S]*?(<\/think>|$)/);
        if (think) bump('content.<think>', think[0].length);
        contentChars += delta.content.length;
      }
    }
    if (json?.usage) usage = json.usage;
    // anthropic-messages
    if (json?.type === 'content_block_start' && json.content_block?.type) {
      bump(`block_start.${json.content_block.type}`, 0);
    }
    if (json?.type === 'content_block_delta') {
      const d = json.delta ?? {};
      if (d.type === 'thinking_delta') bump('thinking_delta', String(d.thinking ?? '').length);
      if (d.type === 'signature_delta') bump('signature_delta', String(d.signature ?? '').length);
      if (d.type === 'text_delta') contentChars += String(d.text ?? '').length;
    }
    if (json?.type === 'message_delta' && json.usage) usage = { ...(usage ?? {}), ...json.usage };
    if (json?.type === 'message_start' && json.message?.usage) usage = json.message.usage;
  }
  return { fields, contentChars, usage };
}

function catalogModel(api, modelId) {
  if (api === 'anthropic-messages') return ANTHROPIC_MODELS[modelId] ?? null;
  return DEEPSEEK_MODELS[modelId] ?? ZAI_CODING_CN_MODELS[modelId] ?? ZAI_MODELS[modelId] ?? null;
}

async function runRaw({ provider, model, apiKey }) {
  const sink = { raw: '', status: 0, ended: false };
  const started = Date.now();
  let firstDeltaMs = null;
  let result = null;
  let error = null;
  try {
    result = await chatTurn({
      baseUrl: provider.baseUrl,
      apiKey,
      model: model.model,
      api: provider.api,
      thinkingLevel: model.thinkingLevel,
      thinkingFormat: model.thinkingFormat,
      messages: [{ role: 'user', content: QUESTION }],
      onDelta: () => { firstDeltaMs ??= Date.now() - started; },
      timeoutMs: TIMEOUT_MS,
      fetchImpl: teeFetch(sink),
    });
  } catch (err) {
    error = String(err?.message ?? err);
  }
  for (let i = 0; i < 20 && !sink.ended; i += 1) await new Promise((r) => setTimeout(r, 100));
  return {
    httpStatus: sink.status,
    elapsedMs: Date.now() - started,
    firstTextMs: firstDeltaMs,
    visibleText: result?.content ?? null,
    hemiUsage: result?.usage ?? null,
    error,
    rawSse: scanRawSse(sink.raw),
    rawSample: sink.raw.slice(0, 1500),
  };
}

async function runPiAi({ provider, model, apiKey }) {
  const catalog = catalogModel(provider.api, model.model);
  const isAnthropic = provider.api === 'anthropic-messages';
  const chatModel = catalog
    ? { ...catalog, provider: 'hemi-probe', baseUrl: isAnthropic ? modelBaseUrl(provider.baseUrl, 'anthropic-messages') : provider.baseUrl }
    : {
      id: model.model, name: model.model, provider: 'hemi-probe', api: provider.api,
      baseUrl: isAnthropic ? modelBaseUrl(provider.baseUrl, 'anthropic-messages') : provider.baseUrl,
      reasoning: true, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192,
    };
  const reasoning = isAnthropic ? reasoningLevelOf(model.thinkingLevel, chatModel) : 'medium';
  const api = isAnthropic ? anthropicMessagesApi() : openAICompletionsApi();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  const stats = {
    catalogHit: Boolean(catalog), reasoning,
    thinkingDeltas: 0, thinkingChars: 0, textDeltas: 0, textChars: 0,
    thinkingStartMs: null, thinkingEndMs: null, firstThinkingMs: null, firstTextMs: null, thinkingTimeline: [], thinkingBlocks: 0, redactedThinking: 0,
    stopReason: null, usage: null, error: null, thinkingSample: '',
  };
  try {
    const stream = api.streamSimple(chatModel, { messages: [{ role: 'user', content: QUESTION, timestamp: Date.now() }] }, {
      apiKey, signal: controller.signal, ...(reasoning ? { reasoning } : {}),
    });
    for await (const event of stream) {
      if (event.type === 'thinking_start') {
        stats.thinkingStartMs ??= Date.now() - started;
      } else if (event.type === 'thinking_end') {
        stats.thinkingEndMs = Date.now() - started;
      } else if (event.type === 'thinking_delta') {
        if (stats.thinkingTimeline.length < 400) stats.thinkingTimeline.push(Date.now() - started);
        stats.thinkingDeltas += 1;
        stats.thinkingChars += event.delta.length;
        stats.firstThinkingMs ??= Date.now() - started;
        if (stats.thinkingSample.length < 300) stats.thinkingSample += event.delta;
      } else if (event.type === 'text_delta') {
        stats.textDeltas += 1;
        stats.textChars += event.delta.length;
        stats.firstTextMs ??= Date.now() - started;
      } else if (event.type === 'done') {
        stats.stopReason = event.reason;
        const u = event.message?.usage;
        stats.usage = u ? { input: u.input, output: u.output, cacheRead: u.cacheRead, totalTokens: u.totalTokens } : null;
        for (const block of event.message?.content ?? []) {
          if (block.type === 'thinking') {
            stats.thinkingBlocks += 1;
            if (block.redacted) stats.redactedThinking += 1;
          }
        }
      } else if (event.type === 'error') {
        stats.error = event.error?.errorMessage ?? String(event.error?.message ?? 'error');
      }
    }
  } catch (err) {
    stats.error = String(err?.message ?? err);
  } finally {
    clearTimeout(timer);
  }
  stats.elapsedMs = Date.now() - started;
  stats.thinkingSample = stats.thinkingSample.slice(0, 300);
  return stats;
}

// 注意：ESM 入口顶层 await app.whenReady() 会与入口求值互等死锁（2026-10-08 实测），走 then。
app.whenReady().then(main);

async function main() {
const results = [];
try {
  const directory = JSON.parse(await readFile(path.join(REAL_USER_DATA, 'text-model-profiles.json'), 'utf8'));
  if (!safeStorage.isEncryptionAvailable()) throw new Error('safeStorage 不可用，无法解密 Key');
  for (const provider of directory.providers ?? []) {
    let apiKey = '';
    try { apiKey = safeStorage.decryptString(Buffer.from(provider.encryptedApiKey ?? '', 'base64')); } catch { /* 无 Key */ }
    for (const model of provider.models ?? []) {
      const label = `${provider.name}/${model.model}`;
      if (FILTER && !label.includes(FILTER)) continue;
      if (!apiKey) {
        results.push({ label, skipped: 'no-key' });
        console.log(`- ${label}: 跳过（无 Key）`);
        continue;
      }
      console.log(`… ${label}（${provider.api}，思考档 ${model.thinkingLevel}）`);
      const ctx = { provider, model, apiKey };
      const [raw, piai] = [await runRaw(ctx), await runPiAi(ctx)];
      const rawThinkingChars = Object.entries(raw.rawSse.fields)
        .filter(([key]) => !key.startsWith('block_start') && key !== 'signature_delta')
        .reduce((sum, [, v]) => sum + v.chars, 0);
      results.push({ label, api: provider.api, baseUrl: provider.baseUrl, thinkingLevel: model.thinkingLevel, raw, piai });
      console.log(`  raw : HTTP ${raw.httpStatus} ${raw.elapsedMs}ms 首字 ${raw.firstTextMs ?? '-'}ms 思考字段 ${JSON.stringify(raw.rawSse.fields)} 正文 ${raw.rawSse.contentChars} 字 ${raw.error ? `错误：${raw.error}` : ''}`);
      console.log(`  piai: ${piai.elapsedMs}ms 目录${piai.catalogHit ? '命中' : '未命中'} reasoning=${piai.reasoning ?? '-'} 思考 ${piai.thinkingDeltas} 片/${piai.thinkingChars} 字（start ${piai.thinkingStartMs ?? '-'}ms 首片 ${piai.firstThinkingMs ?? '-'}ms end ${piai.thinkingEndMs ?? '-'}ms，块 ${piai.thinkingBlocks}，redacted ${piai.redactedThinking}） 正文 ${piai.textChars} 字（首字 ${piai.firstTextMs ?? '-'}ms） usage ${JSON.stringify(piai.usage)} ${piai.error ? `错误：${piai.error}` : ''}`);
      if (piai.thinkingSample) console.log(`  思考样本：${piai.thinkingSample.replace(/\s+/g, ' ').slice(0, 160)}`);
      results.at(-1).verdict = {
        rawHasThinkingText: rawThinkingChars > 0,
        piaiHasThinkingText: piai.thinkingChars > 0,
      };
    }
  }
} catch (error) {
  console.error(`探针失败：${error?.stack ?? error}`);
}
await writeFile('/tmp/hemi-probe-048.json', `${JSON.stringify(results, null, 2)}\n`);
console.log(`HEMI_PROBE_048=${JSON.stringify(results.map((r) => ({ label: r.label, skipped: r.skipped, ...(r.verdict ?? {}) })))}`);
app.exit(0);
}
