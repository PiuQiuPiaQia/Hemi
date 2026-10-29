import test from 'node:test';
import assert from 'node:assert/strict';
import { botOAuthFailure } from './oauth-errors.mjs';

test('Bot OAuth failure distinguishes server networking, auth, quota and storage stages without exposing raw data', () => {
  const privateValue = 'Bearer private-token-refresh-and-client-secret';
  const cases = [
    [new TypeError('fetch failed', { cause: Object.assign(new Error(privateValue), { code: 'UND_ERR_CONNECT_TIMEOUT' }) }), 'catalog', 'timeout'],
    [Object.assign(new Error(privateValue), { status: 401 }), 'catalog', 'unauthorized'],
    [Object.assign(new Error(privateValue), { status: 403 }), 'catalog', 'forbidden'],
    [new Error('模型验证失败', { cause: 'OpenAI API error (403): ' + privateValue }), 'inference', 'forbidden'],
    [Object.assign(new Error(privateValue), { status: 403, providerCode: 'unsupported_country_region_territory' }), 'catalog', 'region'],
    [new Error('模型验证失败', { cause: 'subscription_sharing_usage_limit_exceeded ' + privateValue }), 'inference', 'quota'],
    [new Error('模型验证失败', { cause: 'Connection error. ' + privateValue }), 'inference', 'network'],
    [new Error('模型验证失败', { cause: 'Failed to extract accountId from token' }), 'inference', 'unauthorized'],
    [Object.assign(new Error(privateValue), { code: 'ENOTFOUND' }), 'catalog', 'dns'],
    [Object.assign(new Error(privateValue), { code: 'CERT_HAS_EXPIRED' }), 'catalog', 'tls'],
    [Object.assign(new Error(privateValue), { code: 'ENOSPC' }), 'storage', 'disk'],
    [Object.assign(new Error(privateValue), { code: 'EACCES' }), 'save', 'permission'],
    [new Error(privateValue), 'inference', 'unknown'],
  ];
  for (const [error, stage, expected] of cases) {
    const failure = botOAuthFailure(error, stage);
    assert.equal(failure.reason, expected);
    assert.equal(failure.stage, stage);
    assert.match(failure.message, /原配置已保留/);
    assert.ok(!JSON.stringify(failure).includes(privateValue));
  }
});
