import { createHash, createHmac, hkdfSync, createDecipheriv, createPrivateKey, sign, randomBytes, randomUUID } from 'node:crypto';
import os from 'node:os';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { codingJson, tokenClaims, ZCODE_ORIGIN, ZCODE_VERSION } from './bigmodel-coding-auth.mjs';

const MODEL_URL = 'https://open.bigmodel.cn/api/anthropic/v1/messages';
const GATEWAY_URL = `${ZCODE_ORIGIN}/api/v1/ultra/anthropic/v1/messages`;
const digest = value => createHash('sha256').update(value).digest();
const hex = size => randomBytes(size).toString('hex');
function waitFor(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
const verificationFailure = async response => {
  if (response.status !== 401) return false;
  const body = await response.clone().json().catch(() => null);
  return [body?.msg, body?.reason, body?.data?.reason, body?.error?.reason, body?.error?.message].some(value => ['VERIFY_SIGNATURE_INVALID', 'VERIFY_APIKEY_EXPIRED'].includes(value));
};

export function codingIdentity(deviceId, model = false) {
  return {
    'HTTP-Referer': ZCODE_ORIGIN,
    'User-Agent': `ZCode/${ZCODE_VERSION}${model ? ' ai-sdk/anthropic/3.0.81' : ''}`,
    'X-ZCode-App-Version': ZCODE_VERSION, 'X-Title': 'Z Code@electron', 'X-Release-Channel': 'stable',
    'X-Client-Language': Intl.DateTimeFormat().resolvedOptions().locale,
    'X-Client-Timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
    'X-Platform': `${process.platform}-${process.arch}`,
    'X-Os-Category': process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
    'X-Os-Version': os.release(), ...(model ? { 'X-ZCode-Agent': 'glm' } : { 'X-Device-Mid': deviceId }),
  };
}

/** Private keys stay in memory and are scoped to one issued project token. */
export function createCodingTransport(credentials) {
  let current;
  function stateFor(credential) {
    if (current?.token !== credential.access) current = { token: credential.access };
    return current;
  }
  async function route(state, credential, fetchImpl, signal) {
    if (state.route && state.route.expires > Date.now()) return state.route;
    try {
      const data = await codingJson(fetchImpl, `${ZCODE_ORIGIN}/api/v1/agent/configs`, { signal,
        headers: { ...codingIdentity(credential.deviceId), 'x-api-key': credential.access },
      });
      const mapping = data?.proxyEndpoint?.mapping;
      if (mapping !== undefined && !Array.isArray(mapping)) throw new Error('GLM 编程套餐路由配置无效。');
      const entry = mapping?.find(item => typeof item?.from === 'string' && item.from.replace(/\/+$/, '') === MODEL_URL);
      if (entry) {
        let target;
        try { target = new URL(entry.to); } catch { throw new Error('GLM 编程套餐路由地址无效。'); }
        if (target.href !== GATEWAY_URL || target.username || target.password) throw new Error('GLM 编程套餐路由地址无效。');
        if (entry.zcodeAuthorizationHeader !== undefined && (typeof entry.zcodeAuthorizationHeader !== 'string' || entry.zcodeAuthorizationHeader.toLowerCase() !== 'x-zcode-authorization')) throw new Error('GLM 编程套餐路由配置无效。');
        state.route = { url: target.href, jwt: entry.zcodeAuthorizationHeader?.toLowerCase() === 'x-zcode-authorization', expires: Date.now() + 300000 };
      } else state.route = { url: GATEWAY_URL, jwt: true, expires: Date.now() + 300000 };
    } catch (error) {
      signal.throwIfAborted();
      if (/^GLM 编程套餐路由/.test(error?.message)) throw error;
      state.route = { ...(state.route ?? { url: GATEWAY_URL, jwt: true }), expires: Date.now() + 30000 };
    }
    return state.route;
  }
  async function privateKey(state, credential, origin, fetchImpl, signal) {
    if (!state.key) state.key = (async () => {
      const ts = String(Date.now()), nonce = hex(16);
      const derived = info => Buffer.from(hkdfSync('sha256', credential.access, 'WD_CLIENT_SIGN_KDF_SALT', info, 32));
      const hmacKey = derived('getSignKey_hmac');
      let sig;
      try { sig = createHmac('sha256', hmacKey).update(`get_sign_key\n${credential.apiKeyId}\n${ts}\n${nonce}`).digest('base64'); }
      finally { hmacKey.fill(0); }
      const data = await codingJson(fetchImpl, `${origin}/api/paas/c1f3a7e2/v2/client`, { method: 'POST', stage: '签名握手', signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${credential.access}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken: credential.access, ts, nonce, sig }),
      });
      if (typeof data?.privateCipher !== 'string') throw new Error('GLM 编程套餐请求签名初始化失败。');
      const encrypted = Buffer.from(data.privateCipher, 'base64'), aesKey = derived('ed25519_priv');
      let plain, pkcs8;
      try {
        if (encrypted.length <= 28) throw new Error('cipher');
        const decipher = createDecipheriv('aes-256-gcm', aesKey, encrypted.subarray(0, 12));
        decipher.setAAD(Buffer.from(credential.apiKeyId));
        decipher.setAuthTag(encrypted.subarray(-16));
        plain = Buffer.concat([decipher.update(encrypted.subarray(12, -16)), decipher.final()]);
        pkcs8 = Buffer.from(plain.toString('utf8'), 'base64');
        return createPrivateKey({ key: pkcs8, type: 'pkcs8', format: 'der' });
      } catch { throw new Error('GLM 编程套餐请求签名初始化失败。'); }
      finally { aesKey.fill(0); plain?.fill(0); pkcs8?.fill(0); }
    })().catch(error => { state.key = null; throw error; });
    return waitFor(state.key, signal);
  }
  async function signedHeaders(key, credential, headers, sessionId, signal) {
    const ts = String(Date.now()), nonce = hex(16), prefix = hex(12);
    const challenge = digest(`${credential.apiKeyId}\nzcode\n${sessionId}\n${ts}`).toString('hex').slice(0, 32);
    let counter = 0, proof;
    do {
      signal.throwIfAborted();
      proof = `${prefix}${(counter++).toString(16).padStart(8, '0')}`;
      if (counter % 128 === 0) await yieldToLoop(undefined, { signal });
    } while (digest(`${challenge}\n${proof}`)[0] !== 0);
    const signature = sign(null, Buffer.from(`${credential.apiKeyId}\n${ts}\n${ZCODE_VERSION}\n${sessionId}\n${nonce}`), key).toString('base64');
    return new Headers({ ...Object.fromEntries(headers), 'X-Client-Ts': ts, 'X-Client-Version': ZCODE_VERSION,
      'X-Client-Sig': signature, 'X-Session-Id': sessionId, 'X-Client-Nonce': nonce, 'X-App-Id': 'zcode', 'X-Client-Pow': proof });
  }
  return {
    forRequest({ fetchImpl, sessionId = randomUUID(), token }) {
      return async (input, init) => {
        const request = new Request(input, init);
        const signal = request.signal;
        try {
          const source = new URL(request.url);
          if (`${source.origin}${source.pathname}` !== MODEL_URL || request.method !== 'POST') throw new Error('GLM 编程套餐请求地址无效。');
          signal.throwIfAborted();
          const credential = await credentials.read('bigmodel', { signal });
          if (!credential || credential.access !== token || credential.expires <= Date.now()) throw new Error('GLM 编程套餐登录已更新，请重新发送或重新登录。');
          const state = stateFor(credential);
          const target = await route(state, credential, fetchImpl, signal);
          const headers = new Headers(request.headers);
          headers.delete('content-length'); headers.delete('host');
          for (const name of [...headers.keys()]) if (name.startsWith('x-stainless-') || name.startsWith('x-client-') || name === 'anthropic-beta') headers.delete(name);
          for (const [name, value] of Object.entries(codingIdentity(credential.deviceId, true))) headers.set(name, value);
          headers.set('authorization', `Bearer ${credential.access}`);
          headers.set('x-api-key', credential.access);
          if (target.jwt) {
            if (Number(tokenClaims(credential.zcodeToken).exp) * 1000 <= Date.now()) throw new Error('GLM 编程套餐登录已失效，请重新登录。');
            headers.set('X-ZCode-Authorization', `Bearer ${credential.zcodeToken}`);
          }
          headers.set('x-request-id', randomUUID()); headers.set('x-query-id', randomUUID());
          headers.set('x-zcode-trace-id', randomUUID()); headers.set('x-zcode-session-type', 'main');
          const body = JSON.parse(await request.text());
          body.metadata = { ...body.metadata, user_id: JSON.stringify({ device_id: credential.deviceId, account_uuid: '', session_id: sessionId }) };
          let response;
          for (let attempt = 0; attempt < 2; attempt++) {
            // Signing wraps endpoint routing: key exchange belongs to the
            // original model provider, while only inference uses the gateway.
            const key = await privateKey(state, credential, source.origin, fetchImpl, signal);
            const signed = await signedHeaders(key, credential, headers, sessionId, signal);
            if ((await credentials.read('bigmodel', { signal }))?.access !== credential.access) throw new Error('GLM 编程套餐登录已更新，请重新发送或重新登录。');
            signal.throwIfAborted();
            response = await fetchImpl(target.url, { method: 'POST', headers: signed, body: JSON.stringify(body), signal, redirect: 'error' });
            if (attempt || !await verificationFailure(response)) break;
            await response.body?.cancel().catch(() => {});
            state.key = null;
          }
          if (response.ok) return response;
          await response.body?.cancel().catch(() => {});
          const message = response.status === 401 ? 'GLM 编程套餐登录或请求签名已失效，请重新登录。' : response.status === 429 ? 'GLM 编程套餐额度或并发已达上限，请稍后重试。' : 'GLM 编程套餐请求失败，请检查套餐状态后重试。';
          return Response.json({ type: 'error', error: { type: 'api_error', message } }, { status: response.status });
        } catch (error) {
          signal.throwIfAborted();
          const message = /^GLM 编程套餐/.test(error?.message) ? error.message : 'GLM 编程套餐连接失败，请检查网络后重试。';
          return Response.json({ type: 'error', error: { type: 'api_error', message } }, { status: /登录|令牌/.test(message) ? 401 : 503 });
        }
      };
    },
  };
}
