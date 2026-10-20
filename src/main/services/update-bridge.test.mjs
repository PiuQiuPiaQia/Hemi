import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createUpdateBridge,
  defaultChannelFile,
  pickRelease,
  rewriteChannelYml,
} from './update-bridge.mjs';

/** electron-builder 生成的 latest-mac.yml 形态（files[].url 相对名 + 顶层 path）。 */
const SAMPLE_YML = [
  'version: 0.4.0',
  'files:',
  '  - url: Hemi-0.4.0-arm64-mac.zip',
  '    sha512: 7d9b2c…==',
  '    size: 434567890',
  'path: Hemi-0.4.0-arm64-mac.zip',
  "releaseDate: '2026-10-07T10:00:00.000Z'",
  'sha512: 7d9b2c…==',
].join('\n');

/** electron-builder nsis target 的 latest.yml 形态（files 含 exe 与 blockmap 两条）。 */
const SAMPLE_WIN_YML = [
  'version: 0.4.0',
  'files:',
  '  - url: Hemi-0.4.0-setup.exe',
  '    sha512: 3fa1b2…==',
  '    size: 157286400',
  '  - url: Hemi-0.4.0-setup.exe.blockmap',
  '    sha512: bb00cc…==',
  '    size: 1048576',
  'path: Hemi-0.4.0-setup.exe',
  "releaseDate: '2026-10-12T10:00:00.000Z'",
  'sha512: 3fa1b2…==',
].join('\n');

function fakeGithub({ releases, assets = {}, authed = true } = {}) {
  /** 记录到的请求（url → Authorization），供断言鉴权行为。 */
  const seen = new Map();
  const impl = async (url, { headers } = {}) => {
    seen.set(String(url), headers?.Authorization ?? null);
    if (String(url).includes('/releases?')) {
      if (!authed) return new Response('{"message":"Not Found"}', { status: 404 });
      return Response.json(releases);
    }
    const assetMatch = /\/releases\/assets\/(\d+)$/.exec(String(url));
    if (assetMatch) {
      const body = assets[assetMatch[1]];
      if (body == null) return new Response('{"message":"Not Found"}', { status: 404 });
      return new Response(body, {
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(body.length),
        },
      });
    }
    return new Response('{"message":"Not Found"}', { status: 404 });
  };
  return { impl, seen };
}

function releaseEntry(id, tag, { draft = false, prerelease = false, assets = [] } = {}) {
  return { id, tag_name: tag, draft, prerelease, assets };
}

test('defaultChannelFile：win32→latest.yml，其余→latest-mac.yml', () => {
  assert.equal(defaultChannelFile('win32'), 'latest.yml');
  assert.equal(defaultChannelFile('darwin'), 'latest-mac.yml');
  assert.equal(defaultChannelFile('linux'), 'latest-mac.yml');
});

test('pickRelease：跳过 draft/prerelease，要求带清单资产，无可选返回 null', () => {
  const manifest = { id: 11, name: 'latest-mac.yml' };
  assert.deepEqual(
    pickRelease([
      releaseEntry(1, 'v0.5.0-beta.1', { prerelease: true, assets: [manifest] }),
      releaseEntry(2, 'v0.5.0-rc', { draft: true, assets: [manifest] }),
      releaseEntry(3, 'v0.4.1', { assets: [manifest, { id: 12, name: 'Hemi-0.4.1-arm64-mac.zip' }] }),
      releaseEntry(4, 'v0.4.0', { assets: [manifest] }),
    ], 'latest-mac.yml'),
    { id: 3, tag: 'v0.4.1', assets: [manifest, { id: 12, name: 'Hemi-0.4.1-arm64-mac.zip' }] },
  );
  assert.equal(pickRelease([]), null);
  assert.equal(pickRelease(null), null);
  // 唯一一档是 draft：按无可更新版本处理（不是报错）。
  assert.equal(pickRelease([releaseEntry(9, 'v1.0.0', { draft: true })]), null);
  // 有 release 但没清单资产（纯源码 tag）：不可作为更新来源。
  assert.equal(pickRelease([releaseEntry(8, 'v1.0.0')]), null);
});

test('pickRelease（win）：要求 latest.yml 资产——只有 latest-mac.yml 的旧 release 不可作为 win 更新来源', () => {
  const macOnly = releaseEntry(3, 'v0.6.8', { assets: [{ id: 11, name: 'latest-mac.yml' }] });
  assert.equal(pickRelease([macOnly], 'latest.yml'), null);
  const withWin = releaseEntry(4, 'v0.6.9', {
    assets: [
      { id: 21, name: 'latest-mac.yml' },
      { id: 22, name: 'latest.yml' },
    ],
  });
  assert.equal(pickRelease([macOnly, withWin], 'latest.yml')?.id, 4);
});

test('rewriteChannelYml：files[].url 与 path 改写为回环绝对地址，其余字段原样', () => {
  const out = rewriteChannelYml(SAMPLE_YML, 'http://127.0.0.1:45678', 3);
  assert.match(out, /- url: http:\/\/127\.0\.0\.1:45678\/asset\/3\/Hemi-0\.4\.0-arm64-mac\.zip/);
  assert.match(out, /path: http:\/\/127\.0\.0\.1:45678\/asset\/3\/Hemi-0\.4\.0-arm64-mac\.zip/);
  // sha512/size/version 是完整性锚点，一个字符都不能动。
  assert.match(out, /sha512: 7d9b2c…==/);
  assert.match(out, /size: 434567890/);
  assert.match(out, /version: 0\.4\.0/);
  // 已是绝对地址的 url 不重复改写。
  const already = 'path: https://example.com/x.zip';
  assert.equal(rewriteChannelYml(already, 'http://127.0.0.1:1', 1), already);
});

test('回环桥：latest-mac.yml 路由带 token 取清单并改写；token 为空时不带 Authorization', async () => {
  const manifestAsset = { id: 11, name: 'latest-mac.yml' };
  const gh = fakeGithub({
    releases: [releaseEntry(3, 'v0.4.1', { assets: [manifestAsset] })],
    assets: { 11: SAMPLE_YML },
  });
  // channelFile 显式钉 mac：桥默认按 process.platform 取，win 机上跑测试不能漂移。
  const bridge = await createUpdateBridge({ token: 'ghp_test', fetchImpl: gh.impl, channelFile: 'latest-mac.yml' });
  try {
    const yml = await (await fetch(`${bridge.url}/latest-mac.yml`)).text();
    assert.match(yml, new RegExp(`http://127\\.0\\.0\\.1:${bridge.port}/asset/3/`));
    assert.equal(gh.seen.get(`https://api.github.com/repos/PiuQiuPiaQia/Hemi/releases?per_page=20`), 'Bearer ghp_test');
    assert.equal(gh.seen.get('https://api.github.com/repos/PiuQiuPiaQia/Hemi/releases/assets/11'), 'Bearer ghp_test');

    // 匿名形态（repo 公开后的样子）：同样的请求不带 Authorization 头。
    const ghAnon = fakeGithub({
      releases: [releaseEntry(3, 'v0.4.1', { assets: [manifestAsset] })],
      assets: { 11: SAMPLE_YML },
    });
    const bridgeAnon = await createUpdateBridge({ token: null, fetchImpl: ghAnon.impl, channelFile: 'latest-mac.yml' });
    try {
      const res = await fetch(`${bridgeAnon.url}/latest-mac.yml`);
      assert.equal(res.status, 200);
      assert.equal(ghAnon.seen.get('https://api.github.com/repos/PiuQiuPiaQia/Hemi/releases?per_page=20'), null);
    } finally {
      await bridgeAnon.close();
    }
  } finally {
    await bridge.close();
  }
});

test('回环桥（win）：latest.yml 路由按清单参数化，mac 清单路由不再暴露', async () => {
  const gh = fakeGithub({
    releases: [releaseEntry(4, 'v0.4.0', {
      assets: [
        { id: 21, name: 'latest-mac.yml' },
        { id: 22, name: 'latest.yml' },
        { id: 23, name: 'Hemi-0.4.0-setup.exe' },
      ],
    })],
    assets: { 22: SAMPLE_WIN_YML },
  });
  const bridge = await createUpdateBridge({ channelFile: 'latest.yml', fetchImpl: gh.impl });
  try {
    const yml = await (await fetch(`${bridge.url}/latest.yml`)).text();
    // files 两条（exe 与 blockmap）与顶层 path 都改写为回环地址（差量已关，
    // blockmap 条目仅原样转发，更新器不会去取）。
    assert.match(yml, new RegExp(`- url: http://127\\.0\\.0\\.1:${bridge.port}/asset/4/Hemi-0\\.4\\.0-setup\\.exe$`, 'm'));
    assert.match(yml, new RegExp(`- url: http://127\\.0\\.0\\.1:${bridge.port}/asset/4/Hemi-0\\.4\\.0-setup\\.exe\\.blockmap$`, 'm'));
    assert.match(yml, new RegExp(`^path: http://127\\.0\\.0\\.1:${bridge.port}/asset/4/Hemi-0\\.4\\.0-setup\\.exe$`, 'm'));
    // sha512 是完整性锚点，一个字符都不能动。
    assert.match(yml, /sha512: 3fa1b2…==/);
    // 只暴露目标清单路由：win 桥上不服务 latest-mac.yml。
    assert.equal((await fetch(`${bridge.url}/latest-mac.yml`)).status, 404);
  } finally {
    await bridge.close();
  }
});

test('回环桥：资产路由按 releaseId+名寻址流式转发，未知寻址 404', async () => {
  const zipName = 'Hemi-0.4.1-arm64-mac.zip';
  const payload = 'PK-zip-bytes';
  const gh = fakeGithub({
    releases: [releaseEntry(3, 'v0.4.1', {
      assets: [{ id: 11, name: 'latest-mac.yml' }, { id: 12, name: zipName }],
    })],
    assets: { 12: payload },
  });
  const bridge = await createUpdateBridge({ fetchImpl: gh.impl });
  try {
    const res = await fetch(`${bridge.url}/asset/3/${encodeURIComponent(zipName)}`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), payload);
    assert.equal(res.headers.get('content-length'), String(payload.length));

    // 未知资产名 / 未知 releaseId：404（不是 500）。
    assert.equal((await fetch(`${bridge.url}/asset/3/nope.zip`)).status, 404);
    assert.equal((await fetch(`${bridge.url}/asset/999/${zipName}`)).status, 404);
    // 其余路径一概 404。
    assert.equal((await fetch(`${bridge.url}/etc/passwd`)).status, 404);
  } finally {
    await bridge.close();
  }
});

test('回环桥：清单资产取不到（API 404/无 release）时如实 404，不返回半截清单', async () => {
  const gh = fakeGithub({ releases: [releaseEntry(3, 'v0.4.1', { assets: [{ id: 11, name: 'latest-mac.yml' }] })], assets: {} });
  const bridge = await createUpdateBridge({ fetchImpl: gh.impl, channelFile: 'latest-mac.yml' });
  try {
    assert.equal((await fetch(`${bridge.url}/latest-mac.yml`)).status, 502);
  } finally {
    await bridge.close();
  }

  const ghEmpty = fakeGithub({ releases: [] });
  const bridgeEmpty = await createUpdateBridge({ fetchImpl: ghEmpty.impl, channelFile: 'latest-mac.yml' });
  try {
    const res = await fetch(`${bridgeEmpty.url}/latest-mac.yml`);
    assert.equal(res.status, 404);
    assert.match(await res.text(), /no release/);
  } finally {
    await bridgeEmpty.close();
  }
});
