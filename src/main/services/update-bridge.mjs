/**
 * 044 · 更新分发回环桥：electron-updater ↔ api.github.com。
 *
 * 为什么需要它：仓库是私有的，GitHub 的网页下载路由（releases.atom 与
 * releases/download/…）对 Bearer token 一律 404（2026-10-07 用草稿 release
 * 实测：带有效 token 仍 404，同 token 走 api.github.com 资产端点 200）。
 * electron-updater 自带的 GitHub provider 第一步就是拉 releases.atom，私有
 * 仓直接死。所以主进程起一个只绑 127.0.0.1 的 HTTP 桥：
 *
 *   GET /latest-mac.yml          → api.github.com 列 release（跳过 draft/prerelease），
 *                                  取最新一档的 latest-mac.yml 资产，把 files/path 的
 *                                  相对文件名改写成指向本桥的绝对地址后原样返回。
 *                                  （win32 实例吃 latest.yml，路由与筛选同名参数化。）
 *   GET /asset/<releaseId>/<名>  → 按名找到该 release 的资产 id，以
 *                                  Accept: application/octet-stream 流式转发字节。
 *
 * electron-updater 侧按 generic provider 指向 http://127.0.0.1:<port>，版本
 * 比较、sha512 校验、zip 解包、退出时装包全部用原生实现——桥只做寻址翻译，
 * 不碰内容。yml 里的 sha512 链路不变，资产完整性仍由 electron-updater 逐字
 * 节校验。repo 转公开后无需改任何代码（token 为空即匿名）。
 */
import http from 'node:http';
import { Readable } from 'node:stream';

import { UPDATE_OWNER, UPDATE_REPO } from '../../shared/release-info.mjs';

const GH_API = 'https://api.github.com';
/** 列表页大小：一页内找不到带清单的正式版就按「无可更新版本」处理。 */
const RELEASES_PER_PAGE = 20;

/** 平台对应的 electron-updater 清单文件名（generic provider 按 channel+平台后缀请求）。 */
export function defaultChannelFile(platform = process.platform) {
  return platform === 'win32' ? 'latest.yml' : 'latest-mac.yml';
}

/**
 * 从 releases 列表里挑更新目标：第一个非 draft、非 prerelease、且带目标清单
 * 资产（默认 latest-mac.yml，win 实例传 latest.yml）的条目（GitHub 按新到旧
 * 排序）。返回 null＝没有可用的。
 */
export function pickRelease(releases, channelFile = defaultChannelFile()) {
  for (const release of Array.isArray(releases) ? releases : []) {
    if (release.draft || release.prerelease) continue;
    const assets = Array.isArray(release.assets) ? release.assets : [];
    if (!assets.some((asset) => asset?.name === channelFile)) continue;
    return { id: release.id, tag: release.tag_name, assets };
  }
  return null;
}

/**
 * 把 yml 里 files[].url 与顶层 path 的相对文件名改写为指向本桥的绝对地址。
 * version/sha512/size 等其余字段一字不动（sha512 是完整性锚点，绝不能碰）。
 */
export function rewriteChannelYml(yml, bridgeOrigin, releaseId) {
  return yml.replace(/^(\s*(?:-\s+)?url:\s+|path:\s+)(\S+)\s*$/gm, (line, prefix, file) => {
    if (/^https?:\/\//.test(file)) return line;
    return `${prefix}${bridgeOrigin}/asset/${releaseId}/${encodeURIComponent(file)}`;
  });
}

function ghHeaders(token, accept) {
  const headers = { Accept: accept, 'User-Agent': 'hemi-updater' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * 起桥。resolve 后即可把 `url` 交给 electron-updater setFeedURL。
 * fetchImpl 可注入（单测用假 GitHub）；默认主进程全局 fetch。
 */
export async function createUpdateBridge({
  owner = UPDATE_OWNER,
  repo = UPDATE_REPO,
  token = null,
  fetchImpl = globalThis.fetch,
  log = null,
  channelFile = defaultChannelFile(),
} = {}) {
  const apiBase = `${GH_API}/repos/${owner}/${repo}`;

  async function listReleases() {
    const response = await fetchImpl(`${apiBase}/releases?per_page=${RELEASES_PER_PAGE}`, {
      headers: ghHeaders(token, 'application/vnd.github+json'),
    });
    if (!response.ok) {
      throw new Error(`列 release 失败（${response.status}）`);
    }
    return response.json();
  }

  async function fetchAssetBytes(assetId) {
    const response = await fetchImpl(`${apiBase}/releases/assets/${assetId}`, {
      headers: ghHeaders(token, 'application/octet-stream'),
    });
    if (!response.ok) {
      throw new Error(`取资产 ${assetId} 失败（${response.status}）`);
    }
    return response;
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1`);
      try {
        if (req.method === 'GET' && url.pathname === `/${channelFile}`) {
          const release = pickRelease(await listReleases(), channelFile);
          if (!release) {
            res.writeHead(404).end('no release with update manifest');
            return;
          }
          const manifest = release.assets.find((asset) => asset.name === channelFile);
          const upstream = await fetchAssetBytes(manifest.id);
          const rewritten = rewriteChannelYml(
            await upstream.text(),
            `http://127.0.0.1:${port}`,
            release.id,
          );
          const body = Buffer.from(rewritten, 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/yaml', 'Content-Length': body.length });
          res.end(body);
          return;
        }
        const assetMatch = /^\/asset\/(\d+)\/(.+)$/.exec(url.pathname);
        if (req.method === 'GET' && assetMatch) {
          const releaseId = Number(assetMatch[1]);
          const name = decodeURIComponent(assetMatch[2]);
          const list = await listReleases();
          const release = (Array.isArray(list) ? list : []).find((entry) => entry?.id === releaseId);
          const asset = release?.assets?.find((entry) => entry?.name === name);
          if (!asset) {
            res.writeHead(404).end(`asset not found: ${name}`);
            return;
          }
          const upstream = await fetchAssetBytes(asset.id);
          // 字节流直通：content-length 透传，electron-updater 才能算下载进度。
          res.writeHead(upstream.status ?? 200, {
            'Content-Type': upstream.headers?.get('content-type') ?? 'application/octet-stream',
            ...(upstream.headers?.get('content-length')
              ? { 'Content-Length': upstream.headers.get('content-length') }
              : {}),
          });
          Readable.fromWeb(upstream.body).pipe(res);
          return;
        }
        res.writeHead(404).end();
      } catch (error) {
        log?.warn?.(`更新桥处理 ${req.method} ${url.pathname} 失败：${error?.message ?? error}`);
        if (!res.headersSent) res.writeHead(502).end(String(error?.message ?? error));
        else res.end();
      }
    })();
  });

  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    // 只绑回环：桥上流转的是带 token 才能取的私有资产，不对局域网暴露。
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const port = server.address().port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    async close() {
      await new Promise((resolvePromise) => server.close(() => resolvePromise()));
    },
  };
}
