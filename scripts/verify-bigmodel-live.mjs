// One small real request through the production provider. Account material is
// read only from the chosen userData and kept in memory; no chats are loaded.
// node scripts/verify-bigmodel-live.mjs --user-data=/absolute/path
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createLocalSecretStorage } from '../src/main/lib/local-secrets.mjs';
import { createOAuthCredentials } from '../src/main/services/oauth-credentials.mjs';
import { createOAuthModels } from '../src/main/services/oauth-models.mjs';
import { bigModelCodingProvider } from '../src/main/services/bigmodel-coding.mjs';

const userData = process.argv.find(arg => arg.startsWith('--user-data='))?.slice(12);
const modelId = process.argv.find(arg => arg.startsWith('--model='))?.slice(8) ?? 'glm-5.3-flash';
const inputBytes = Number(process.argv.find(arg => arg.startsWith('--input-bytes='))?.slice(14) ?? 0);
if (!Number.isInteger(inputBytes) || inputBytes < 0 || inputBytes > 16000) throw new Error('Diagnostic input must be between 0 and 16000 random bytes.');
if (!userData || !path.isAbsolute(userData)) throw new Error('Pass an absolute --user-data path containing the already-authorized BigModel account.');
const source = createOAuthCredentials({ filePath: path.join(userData, 'runtime-v2/oauth-credentials.json'),
  safeStorage: createLocalSecretStorage({ directory: path.join(userData, 'secrets') }),
});
let credential = await source.read('bigmodel');
if (!credential) throw new Error('The selected userData has no BigModel login.');
const memory = {
  read: async id => id === 'bigmodel' ? structuredClone(credential) : undefined,
  list: async () => [{ providerId: 'bigmodel', type: 'oauth' }],
  modify: async (id, update) => { if (id !== 'bigmodel') throw new Error('Unexpected provider'); credential = await update(structuredClone(credential)); return structuredClone(credential); },
};
const requests = [];
const fetchImpl = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const started = Date.now();
  const response = await fetch(input, init);
  const body = url.pathname.endsWith('/messages') ? JSON.parse(init.body) : null;
  requests.push({ origin: url.origin, path: url.pathname, status: response.status, elapsedMs: Date.now() - started,
    ...(body ? { maxTokens: body.max_tokens, thinking: body.thinking?.type, requestId: new Headers(init.headers).get('x-request-id'), responseRequestId: response.headers.get('x-request-id') } : {}),
  });
  return response;
};
const runtime = createOAuthModels(memory, [bigModelCodingProvider(memory, { fetchImpl })]);
const model = runtime.models.getModel('bigmodel', modelId);
if (!model) throw new Error('Choose one of the configured BigModel Coding Plan models.');
const content = inputBytes ? `Reply only OK. Ignore the random verification payload below; do not quote it.\n${randomBytes(inputBytes).toString('hex')}` : '只回复 OK';
const reply = await runtime.models.completeSimple(model, { messages: [{ role: 'user', content, timestamp: Date.now() }] },
  { maxTokens: 128, maxRetries: 0, signal: AbortSignal.timeout(30000) });
console.log(JSON.stringify({ model: model.id, ok: reply.stopReason === 'stop', stopReason: reply.stopReason,
  text: reply.content.filter(part => part.type === 'text').map(part => part.text).join(''), error: reply.errorMessage,
  usage: { input: reply.usage.input, output: reply.usage.output, cacheRead: reply.usage.cacheRead, cacheWrite: reply.usage.cacheWrite }, requests,
}, null, 2));
if (reply.stopReason !== 'stop') process.exitCode = 1;
