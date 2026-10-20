import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeSiteUrl } from './import-url.mjs';

test('补全 https＋剥路径/query → 规范 origin', () => {
  assert.deepEqual(normalizeSiteUrl('vvcode.top'), { ok: true, siteOrigin: 'https://vvcode.top' });
  assert.deepEqual(normalizeSiteUrl(' https://vvcode.top/sign-in?x=1 '), { ok: true, siteOrigin: 'https://vvcode.top' });
  assert.deepEqual(normalizeSiteUrl('https://cf.vvcode.top:8443/x'), { ok: true, siteOrigin: 'https://cf.vvcode.top:8443' });
});

test('拒绝：空/坏 URL/userinfo/非 http(s)/控制字符', () => {
  assert.equal(normalizeSiteUrl('').ok, false);
  assert.equal(normalizeSiteUrl('https://user:pass@vvcode.top').ok, false);
  assert.equal(normalizeSiteUrl('ftp://vvcode.top').ok, false);
  assert.equal(normalizeSiteUrl('https://vv\u0007code.top').ok, false);
  assert.equal(normalizeSiteUrl('不是地址').ok, false);
});

test('显式 http 放行（自建站，含本机/局域网）；https 仍拒私网', () => {
  assert.deepEqual(normalizeSiteUrl('http://vvcode.top'), { ok: true, siteOrigin: 'http://vvcode.top' });
  assert.deepEqual(normalizeSiteUrl('http://127.0.0.1:8080'), { ok: true, siteOrigin: 'http://127.0.0.1:8080' });
  assert.deepEqual(normalizeSiteUrl('http://localhost:9100'), { ok: true, siteOrigin: 'http://localhost:9100' });
  assert.deepEqual(normalizeSiteUrl('http://192.168.1.5:3000'), { ok: true, siteOrigin: 'http://192.168.1.5:3000' });
  // https 分支守首版门禁：私网/内网照旧拒
  assert.equal(normalizeSiteUrl('https://192.168.1.5').code, 'private-host');
  assert.equal(normalizeSiteUrl('https://10.0.0.2').code, 'private-host');
  assert.equal(normalizeSiteUrl('https://box.internal').code, 'private-host');
});
