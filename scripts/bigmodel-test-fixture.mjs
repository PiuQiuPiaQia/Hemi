// Synthetic protocol peer: verifies Hemi's real crypto and wire requests.
import assert from 'node:assert/strict';
import { createHash, createHmac, hkdfSync, createCipheriv, generateKeyPairSync, randomBytes, verify } from 'node:crypto';

const jwt = (payload, signature) => `${Buffer.from(JSON.stringify({ alg: 'HS256', sign_type: 'SIGN' })).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${signature}`;
export function createBigModelTestProvider() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const state = { polls: 0, pending: 0, issued: 0, handshakes: 0, handshakeStatus: 200, modelCalls: 0, rejectSignatures: 0, keys: [{ name: 'hemi-coding-plan', apiKey: 'hemi-test-key' }], mapping: undefined, pollStatus: 'ready', authorizeUrl: 'https://bigmodel.cn/login?appId=zcode&state=synthetic', rawFailure: false };
  const zcodeToken = jwt({ exp: Math.floor(Date.now() / 1000) + 86400 }, 'synthetic-zcode');
  let projectToken;
  const restoreProjectToken = candidate => {
    if (projectToken) return;
    assert.match(candidate, /\.synthetic-project-\d+$/);
    assert.equal(JSON.parse(Buffer.from(candidate.split('.')[1], 'base64url').toString()).api_key, 'hemi-test-key');
    projectToken = candidate;
  };
  const reply = (rawUrl, init = {}) => {
    const url = new URL(rawUrl);
    if (!['bigmodel.cn', 'zcode.z.ai', 'open.bigmodel.cn'].includes(url.hostname)) return null;
    const headers = new Headers(init.headers), body = JSON.parse(init.body || '{}');
    const envelope = data => Response.json({ code: 0, data });
    if (url.pathname === '/api/v1/oauth/cli/init') {
      assert.equal(body.provider, 'bigmodel'); assert.match(headers.get('authorization'), /^Bearer [a-f0-9]{64}$/);
      return envelope({ flow_id: 'synthetic-flow', authorize_url: state.authorizeUrl, expires_at: Math.floor(Date.now() / 1000) + 300, poll_interval_sec: 1 });
    }
    if (url.pathname === '/api/v1/oauth/cli/poll/synthetic-flow') {
      state.polls++;
      if (state.polls <= state.pending) return envelope({ status: 'pending' });
      return envelope(state.pollStatus === 'ready' ? { status: 'ready', token: zcodeToken, bigmodel: { access_token: 'synthetic-bigmodel-login' }, user: { user_id: 'synthetic-user' } } : { status: state.pollStatus });
    }
    if (url.pathname === '/api/biz/customer/getCustomerInfo') {
      assert.equal(headers.get('authorization'), 'synthetic-bigmodel-login');
      return Response.json({ code: 200, data: { organizations: [{ organizationId: 'test-org', organizationName: '默认机构', projects: [{ projectId: 'team-project', projectType: '2' }, { projectId: 'test-project', projectName: '默认项目', projectType: '1' }] }] } });
    }
    if (url.pathname === '/api/biz/v1/organization/test-org/projects/test-project/api_keys') {
      assert.equal(headers.get('authorization'), 'synthetic-bigmodel-login');
      if (init.method === 'POST') { assert.equal(body.name, 'hemi-coding-plan'); assert.equal(body.usageScene, 1); state.keys.push({ name: body.name, apiKey: 'hemi-test-key' }); return Response.json({ code: 200, data: state.keys.at(-1) }); }
      return Response.json({ code: 200, data: state.keys });
    }
    if (url.pathname.endsWith('/api_keys/hemi-test-key/access_tokens')) {
      assert.equal(headers.get('authorization'), 'Bearer synthetic-bigmodel-login');
      assert.deepEqual(body, { clientType: 'zcode', clientVersion: '3.16.3' });
      projectToken = jwt({ token_use: 'project_access', api_key: 'hemi-test-key', exp: Math.floor(Date.now() / 1000) + 18000 }, `synthetic-project-${++state.issued}`);
      return Response.json({ code: 200, data: { enable: true, tokenType: 'Bearer', accessToken: projectToken, expiresIn: 18000, expiresAt: Math.floor(Date.now() / 1000) + 18000 } });
    }
    if (url.pathname === '/api/v1/agent/configs') return envelope({ proxyEndpoint: { mapping: state.mapping ?? [{ from: 'https://open.bigmodel.cn/api/anthropic/v1/messages', to: 'https://zcode.z.ai/api/v1/ultra/anthropic/v1/messages', zcodeAuthorizationHeader: 'X-ZCode-Authorization' }] } });
    if (url.pathname === '/api/paas/c1f3a7e2/v2/client') {
      assert.equal(url.origin, 'https://open.bigmodel.cn', 'key exchange stays on the original provider before inference routing');
      state.handshakes++;
      if (state.handshakeStatus !== 200) return new Response('PRIVATE UPSTREAM BODY', { status: state.handshakeStatus });
      restoreProjectToken(body.accessToken);
      assert.equal(body.accessToken, projectToken); assert.equal(headers.get('authorization'), `Bearer ${projectToken}`);
      const hmacKey = hkdfSync('sha256', projectToken, 'WD_CLIENT_SIGN_KDF_SALT', 'getSignKey_hmac', 32);
      assert.equal(body.sig, createHmac('sha256', hmacKey).update(`get_sign_key\nhemi-test-key\n${body.ts}\n${body.nonce}`).digest('base64'));
      const aesKey = hkdfSync('sha256', projectToken, 'WD_CLIENT_SIGN_KDF_SALT', 'ed25519_priv', 32);
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', aesKey, iv);
      cipher.setAAD(Buffer.from('hemi-test-key'));
      const encrypted = Buffer.concat([cipher.update(privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), 'utf8'), cipher.final()]);
      return Response.json({ code: 200, data: { privateCipher: Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString('base64') } });
    }
    if (url.pathname === '/api/v1/ultra/anthropic/v1/messages') {
      assert.equal(url.origin, 'https://zcode.z.ai', 'only inference is rerouted through the ZCode gateway');
      state.modelCalls++;
      restoreProjectToken(headers.get('x-api-key'));
      assert.equal(headers.get('authorization'), `Bearer ${projectToken}`); assert.equal(headers.get('x-api-key'), projectToken);
      assert.match(headers.get('x-zcode-authorization'), /^Bearer [^.]+\.[^.]+\.synthetic-zcode$/);
      assert.equal(headers.get('x-app-id'), 'zcode');
      const sessionId = headers.get('x-session-id'), ts = headers.get('x-client-ts'), nonce = headers.get('x-client-nonce');
      assert.equal(headers.get('x-zcode-app-version'), '3.16.3');
      assert.equal(headers.get('x-client-version'), '3.16.3');
      const message = `hemi-test-key\n${ts}\n3.16.3\n${sessionId}\n${nonce}`;
      assert.ok(verify(null, Buffer.from(message), publicKey, Buffer.from(headers.get('x-client-sig'), 'base64')));
      const challenge = createHash('sha256').update(`hemi-test-key\nzcode\n${sessionId}\n${ts}`).digest('hex').slice(0, 32);
      assert.equal(createHash('sha256').update(`${challenge}\n${headers.get('x-client-pow')}`).digest()[0], 0);
      assert.equal(JSON.parse(body.metadata.user_id).session_id, sessionId);
      assert.ok(!JSON.stringify(body).includes('synthetic-bigmodel-login'));
      if (state.rejectSignatures-- > 0) return Response.json({ code: 401, msg: 'VERIFY_SIGNATURE_INVALID' }, { status: 401 });
      if (state.rawFailure) return Response.json({ error: { message: 'synthetic-bigmodel-login PRIVATE UPSTREAM BODY' } }, { status: 403 });
      // The common fixture below supplies actual Anthropic text/tool SSE frames.
    }
    return null;
  };
  return { state, reply };
}
