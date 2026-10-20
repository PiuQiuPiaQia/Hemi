import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROXY_ENV_KEYS,
  applyExecutorProxyEnv,
  parseScutilProxy,
} from './shell-proxy.mjs';

const SCUTIL_HTTPS = `
<dictionary>  {
    HTTPSEnable : 1
    HTTPSProxy : 127.0.0.1
    HTTPSPort : 7897
    HTTPEnable : 0
    SOCKSEnable : 0
}
`;

const SCUTIL_HTTP_ONLY = `
<dictionary>  {
    HTTPEnable : 1
    HTTPProxy : 10.0.0.2
    HTTPPort : 8888
    HTTPSEnable : 0
    SOCKSEnable : 0
}
`;

const SCUTIL_SOCKS_ONLY = `
<dictionary>  {
    SOCKSEnable : 1
    SOCKSProxy : 127.0.0.1
    SOCKSPort : 1080
    HTTPEnable : 0
    HTTPSEnable : 0
}
`;

const SCUTIL_OFF = `
<dictionary>  {
    HTTPEnable : 0
    HTTPSProxy : 127.0.0.1
    HTTPSPort : 7897
    SOCKSEnable : 0
}
`;

test('parseScutilProxy：HTTPS 代理优先（开着才算，没开不取）', () => {
  assert.equal(parseScutilProxy(SCUTIL_HTTPS), 'http://127.0.0.1:7897');
  // HTTPS 残留地址但开关关＝系统代理未启用，不得返回。
  assert.equal(parseScutilProxy(SCUTIL_OFF), null);
});

test('parseScutilProxy：无 HTTPS 时退 HTTP，再退 SOCKS', () => {
  assert.equal(parseScutilProxy(SCUTIL_HTTP_ONLY), 'http://10.0.0.2:8888');
  assert.equal(parseScutilProxy(SCUTIL_SOCKS_ONLY), 'socks5://127.0.0.1:1080');
  assert.equal(parseScutilProxy(''), null);
  assert.equal(parseScutilProxy(null), null);
});

test('applyExecutorProxyEnv：开写大小写成对，关全清（幂等）', () => {
  const applied = applyExecutorProxyEnv(true, 'http://127.0.0.1:7897');
  assert.equal(applied, 'http://127.0.0.1:7897');
  for (const key of PROXY_ENV_KEYS) {
    assert.equal(process.env[key], 'http://127.0.0.1:7897', key);
  }
  // 开着但读不到代理（如非 macOS）＝清空，不残留半套变量。
  assert.equal(applyExecutorProxyEnv(true, null), null);
  for (const key of PROXY_ENV_KEYS) {
    assert.equal(process.env[key], undefined, key);
  }
  assert.equal(applyExecutorProxyEnv(false, 'http://x:1'), null);
  for (const key of PROXY_ENV_KEYS) {
    assert.equal(process.env[key], undefined, key);
  }
});
