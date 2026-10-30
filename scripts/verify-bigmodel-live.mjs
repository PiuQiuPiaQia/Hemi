// One small real request through the production provider. Account material is
// read only from the chosen userData and kept in memory; no chats are loaded.
// node scripts/verify-bigmodel-live.mjs --user-data=/absolute/path
// --refresh forces project-token renewal in memory without changing userData.
// --expire-after-auth exercises renewal inside the signed request, after SDK auth.
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createLocalSecretStorage } from '../src/main/lib/local-secrets.mjs';
import { createOAuthCredentials } from '../src/main/services/oauth-credentials.mjs';
import { createOAuthModels } from '../src/main/services/oauth-models.mjs';
import { bigModelCodingProvider } from '../src/main/services/bigmodel-coding.mjs';

const userData = process.argv.find(arg => arg.startsWith('--user-data='))?.slice(12);
const modelId = process.argv.find(arg => arg.startsWith('--model='))?.slice(8) ?? 'glm-5.3-flash';
const maxTokens = Number(process.argv.find(arg => arg.startsWith('--max-tokens='))?.slice(13) ?? 512);
const inputBytes = Number(process.argv.find(arg => arg.startsWith('--input-bytes='))?.slice(14) ?? 0);
const refresh = process.argv.includes('--refresh');
const expireAfterAuth = process.argv.includes('--expire-after-auth');
if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 2048) throw new Error('Diagnostic output must be between 1 and 2048 tokens.');
if (!Number.isInteger(inputBytes) || inputBytes < 0 || inputBytes > 16000) throw new Error('Diagnostic input must be between 0 and 16000 random bytes.');
if (!userData || !path.isAbsolute(userData)) throw new Error('Pass an absolute --user-data path containing the already-authorized BigModel account.');
const source = createOAuthCredentials({ filePath: path.join(userData, 'runtime-v2/oauth-credentials.json'),
  safeStorage: createLocalSecretStorage({ directory: path.join(userData, 'secrets') }),
});
let credential = await source.read('bigmodel');
if (!credential) throw new Error('The selected userData has no BigModel login.');
if (refresh) credential.expires = 0;
let mutations = Promise.resolve(), expiryInjected = false;
const memory = {
  read: async id => id === 'bigmodel' ? structuredClone(credential) : undefined,
  list: async () => [{ providerId: 'bigmodel', type: 'oauth' }],
  modify(id, update, options) {
    const operation = mutations.then(async () => {
      options?.signal?.throwIfAborted();
      if (id !== 'bigmodel') throw new Error('Unexpected provider');
      const next = await update(structuredClone(credential));
      options?.signal?.throwIfAborted();
      if (next) credential = next;
      return structuredClone(credential);
    });
    mutations = operation.catch(() => {});
    return operation;
  },
};
const requests = [];
const fetchImpl = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const started = Date.now();
  const response = await fetch(input, init);
  const body = url.pathname.endsWith('/messages') ? JSON.parse(init.body) : null;
  const requestPath = url.pathname.replace(/\/organization\/[^/]+\/projects\/[^/]+\/api_keys\/[^/]+/,
    '/organization/:organization/projects/:project/api_keys/:key');
  requests.push({ origin: url.origin, path: requestPath, status: response.status, elapsedMs: Date.now() - started,
    ...(body ? { maxTokens: body.max_tokens, thinking: body.thinking?.type, requestId: new Headers(init.headers).get('x-request-id'), responseRequestId: response.headers.get('x-request-id') } : {}),
  });
  return response;
};
const runtime = createOAuthModels(memory, [bigModelCodingProvider(memory, { fetchImpl })]);
const model = runtime.models.getModel('bigmodel', modelId);
if (!model) throw new Error('Choose one of the configured BigModel Coding Plan models.');
const content = inputBytes ? `Reply only OK. Ignore the random verification payload below; do not quote it.\n${randomBytes(inputBytes).toString('hex')}` : '只回复 OK';
const reply = await runtime.models.completeSimple(model, { messages: [{ role: 'user', content, timestamp: Date.now() }] },
  { maxTokens, maxRetries: 0, signal: AbortSignal.timeout(30000), onPayload: expireAfterAuth ? async () => {
    await memory.modify('bigmodel', async current => ({ ...current, expires: 0 }));
    expiryInjected = true;
  } : undefined });
console.log(JSON.stringify({ model: model.id, ok: reply.stopReason === 'stop', stopReason: reply.stopReason,
  expiryInjected,
  text: reply.content.filter(part => part.type === 'text').map(part => part.text).join(''), error: reply.errorMessage,
  usage: { input: reply.usage.input, output: reply.usage.output, cacheRead: reply.usage.cacheRead, cacheWrite: reply.usage.cacheWrite }, requests,
}, null, 2));
if (reply.stopReason !== 'stop') process.exitCode = 1;
