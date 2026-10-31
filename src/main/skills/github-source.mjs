import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

import { SKILL_LIMITS, bundleBytesOf, validateFileSet } from './skill-store.mjs';

/**
 * 034 SkillsMP：从 GitHub 原仓库按**固定提交**完整收录 Skill 目录的全部文件。
 * 身份链：SkillsMP githubUrl → 解析 owner/repo/ref/目录 → ref 经 git 协议
 * （github.com/info/refs，不占 api.github.com 未鉴权 60 次/小时的额度，2026-10-31
 * 起 npx skills 同思路）解析成 commit SHA → codeload 取该 commit 整包归档并按
 * 目录收录（拒绝符号链接）→ 与内置/本地同一套边界校验（大小/数量在此预检；
 * 可执行内容与路径边界由 validateFiles 兜底）。
 * 归档链失败时回落旧链（api 树清单 + raw 逐文件与 blob SHA-1 比对 + Blobs API），
 * 兼容「raw 与 api 不同境」的网络处境；预览↔安装一致性始终由本地 bundle SHA-256
 * 锚定（预览展示的摘要与安装落地的摘要必须一致）。
 * 文件类型不设白名单——仓库里有什么（.gitignore/LICENSE/无扩展名文件）就装什么，
 * 安装永远以 commit + bundle SHA-256 为准，与 SkillsMP 元数据无关。
 */
const GITHUB_API = 'https://api.github.com';
const GITHUB_RAW = 'https://raw.githubusercontent.com';
const GITHUB_WEB = 'https://github.com';

function failure(message) {
  throw new Error(message);
}

/** 确定性失败：api 树只会给出同样结论（大小/数量/链接/目录缺失），直接报给用户，
 *  不回落旧链白烧 60 次/小时的额度、更不拿网络错误掩盖真实原因（2026-10-31：
 *  impeccable 技能单文件超限被 403 限流文案掩埋的教训）。 */
function failureFinal(message) {
  const error = new Error(message);
  error.deterministic = true;
  throw error;
}

const sha256Of = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** git blob 对象摘要：sha1(`blob <size>\0` + 内容)，与 GitHub tree 条目的 sha 对齐。 */
const gitBlobSha = (bytes) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

/**
 * 解析 SkillsMP 条目的 githubUrl。接受：
 * - https://github.com/{owner}/{repo}/tree/{ref}/{dir}
 * - https://github.com/{owner}/{repo}/blob/{ref}/{dir}/SKILL.md（取其目录）
 * - https://github.com/{owner}/{repo}（默认分支根目录）
 * 其余（其他域名、带查询串、非 tree/blob 深链）返回 null。
 */
export function parseGithubTreeUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 500) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.search || url.hash) return null;
  const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
  const [owner, repo, kind, ref, ...rest] = parts;
  if (!owner || !repo || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null;
  const repoName = repo.replace(/\.git$/, '');
  if (kind !== 'tree' && kind !== 'blob') {
    if (kind !== undefined) return null;
    return { owner, repo: repoName, ref: 'HEAD', dirPath: '' };
  }
  if (!ref || !/^[A-Za-z0-9._/-]+$/.test(ref)) return null;
  let dirPath = rest.join('/');
  if (kind === 'blob') {
    if (!dirPath.toLowerCase().endsWith('skill.md')) return null;
    dirPath = dirPath.split('/').slice(0, -1).join('/');
  }
  if (dirPath && dirPath.split('/').some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) return null;
  return { owner, repo: repoName, ref, dirPath };
}

/** 响应体被代理/网络截断或停滞时——重试一次再判失败；4xx 语义错误立即失败。 */
async function githubJson(fetchImpl, url, kind) {
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'hemi-skill-source' },
        signal: AbortSignal.timeout(15000),
        redirect: 'manual',
      });
    } catch (error) {
      lastError = `${kind}请求失败：${error.name === 'TimeoutError' || error.name === 'AbortError' ? '超时' : error.message}`;
      continue;
    }
    // api.github.com 正常不走重定向；301/302＝仓库改名或转移（SkillsMP 条目过期）。
    if (response.status >= 300 && response.status < 400) failure('仓库已改名或转移，SkillsMP 条目过期了；换一个同类技能，或等条目更新');
    if (response.status === 451) failure('该仓库已被 GitHub 下架（法律原因），装不了；换一个同类技能试试');
    if (response.status === 403 || response.status === 429) failure(`${kind}接口限流（HTTP ${response.status}），请稍后再试`);
    if (response.status === 404) failure(`${kind}地址不存在（可能已删除或为私有仓库）`);
    if (!response.ok) failure(`${kind}请求失败：HTTP ${response.status}`);
    try {
      return JSON.parse(await response.text());
    } catch {
      lastError = `${kind}返回不完整（网络中断或格式无法解析）`;
    }
  }
  failure(lastError);
}

/**
 * 把分支/tag 引用解析成固定 commit SHA（安装与预览都钉在这个 SHA 上）。
 * 主路走 git 智能协议的引用通告（github.com/info/refs）：与 api.github.com 不同境，
 * 没有 60 次/小时的匿名配额（2026-10-31 实测额度耗尽时照常可用；npx skills 的
 * clone 同通道）。附注标签用通告里的 `^{}` 剥壳行直接解到 commit。协议路任何
 * 不确定（非 200/格式认不出/引用没命中）都退回 API 路——错误文案与旧版一致。
 */
export async function resolveCommit({ owner, repo, ref }, { fetchImpl = fetch } = {}) {
  if (/^[0-9a-f]{40}$/.test(ref)) return ref;
  const viaGit = await resolveCommitViaRefsAdvertisement(fetchImpl, { owner, repo, ref }).catch(() => null);
  if (viaGit && /^[0-9a-f]{40}$/.test(viaGit)) return viaGit;
  return resolveCommitViaApi(fetchImpl, { owner, repo, ref });
}

/** git v0 引用通告解析：pkt-line 流里收 refs/heads、refs/tags（含 `^{}` 剥壳）与 HEAD。 */
async function resolveCommitViaRefsAdvertisement(fetchImpl, { owner, repo, ref }) {
  const url = `${GITHUB_WEB}/${owner}/${repo}/info/refs?service=git-upload-pack`;
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': 'hemi-skill-source' },
    signal: AbortSignal.timeout(8000),
    redirect: 'manual',
  });
  if (!response.ok) return null; // 3xx/4xx/5xx 交给 API 路报准确原因（改名/下架/删除）
  const advertisement = parseRefsAdvertisement(await response.text());
  const { refs, headSymref } = advertisement;
  if (ref === 'HEAD') return refs.get('HEAD') ?? refs.get(headSymref) ?? null;
  // 附注标签先看剥壳行（指向 commit）；轻量标签与分支同形。
  return refs.get(`refs/tags/${ref}^{}`) ?? refs.get(`refs/heads/${ref}`) ?? refs.get(`refs/tags/${ref}`) ?? null;
}

/**
 * 按 pkt-line 长度前缀遍历引用通告（不能按行切分：flush 包 `0000` 后无换行，
 * 直接拼接下一条，行切分会吞掉第一条引用）。首条引用带 `\0capabilities`，
 * 从中取 `symref=HEAD:` 目标做 HEAD 兜底。
 */
function parseRefsAdvertisement(text) {
  const bytes = Buffer.from(text, 'utf8');
  const refs = new Map();
  let headSymref = '';
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const prefix = bytes.toString('latin1', offset, offset + 4);
    if (!/^[0-9a-f]{4}$/.test(prefix)) break;
    const length = Number.parseInt(prefix, 16);
    if (length === 0 || length === 4) { offset += 4; continue; } // flush-pkt / 空包：跳过，引用清单在首个 flush 之后
    if (offset + length > bytes.length) break; // 截断
    const payload = bytes.toString('utf8', offset + 4, offset + length).replace(/\n$/, '');
    offset += length;
    const withCaps = payload.match(/^([0-9a-f]{40}) ([^\0]+)\0(.*)$/);
    if (withCaps) {
      refs.set(withCaps[2], withCaps[1]);
      const symref = withCaps[3].match(/(?:^|\s)symref=HEAD:([^\s]+)/);
      if (symref) headSymref = symref[1];
      continue;
    }
    const plain = payload.match(/^([0-9a-f]{40}) (\S+)$/);
    if (plain) refs.set(plain[2], plain[1]);
  }
  return { refs, headSymref };
}

/** API 兜底路（原实现）：git/ref 端点小响应；附注标签跟随对象链接解引用。 */
async function resolveCommitViaApi(fetchImpl, { owner, repo, ref }) {
  const dereference = async (object) => {
    if (object?.type === 'commit' && /^[0-9a-f]{40}$/.test(object.sha ?? '')) return object.sha;
    if (object?.type === 'tag' && typeof object.url === 'string') {
      const tag = await githubJson(fetchImpl, object.url, 'GitHub 标签');
      if (/^[0-9a-f]{40}$/.test(tag?.object?.sha ?? '') && tag.object.type === 'commit') return tag.object.sha;
    }
    failure('GitHub 返回的提交号无效');
  };
  let branch = ref;
  if (ref === 'HEAD') {
    const info = await githubJson(fetchImpl, `${GITHUB_API}/repos/${owner}/${repo}`, 'GitHub 仓库');
    if (typeof info?.default_branch !== 'string' || !info.default_branch) failure('GitHub 仓库没有默认分支');
    branch = info.default_branch;
  }
  for (const kind of ['heads', 'tags']) {
    const data = await githubJson(
      fetchImpl,
      `${GITHUB_API}/repos/${owner}/${repo}/git/ref/${kind}/${branch}`,
      'GitHub 提交',
    ).catch((error) => (/地址不存在/.test(error.message) ? null : Promise.reject(error)));
    if (data?.object) return dereference(data.object);
  }
  failure('GitHub 引用不存在（分支或标签可能已删除）');
}

/** 非递归读一个树对象；truncated 理论上不会出现在单目录层级，出现即拒绝。 */
async function treeOf(fetchImpl, { owner, repo, sha }) {
  const data = await githubJson(fetchImpl, `${GITHUB_API}/repos/${owner}/${repo}/git/trees/${sha}`, 'GitHub 文件树');
  if (data?.truncated) failure('GitHub 目录过大，无法安全固定来源；可下载到本地整理后导入');
  return Array.isArray(data?.tree) ? data.tree : null;
}

/**
 * 兜底链的 api 树清单（2026-10-31 起归档主路免 API，此函数只在归档失败时走）：
 * 沿 dirPath 逐段下钻后，优先**一次 recursive 树**拿全子树——逐目录收集会把一次
 * 安装放大到几十次调用（20 目录的技能预览+安装 ≈44 次，一条技能就烧穿 60 次/小时
 * 配额；zcode/dsh 均为整包一次请求）。GitHub 对超大子树会置 truncated，此时回落
 * 到逐目录广度收集（每步响应极小，弱网更稳）。
 */
async function listBlobs(fetchImpl, { owner, repo, commit, dirPath }) {
  let treeSha = commit;
  if (dirPath) {
    for (const segment of dirPath.split('/')) {
      const entries = await treeOf(fetchImpl, { owner, repo, sha: treeSha });
      const next = entries?.find((entry) => entry.path === segment && entry.type === 'tree');
      if (!next) failure('GitHub 来源目录不存在（仓库结构可能已变化）');
      treeSha = next.sha;
    }
  }
  const recursiveSha = treeSha;
  const recursive = await githubJson(
    fetchImpl,
    `${GITHUB_API}/repos/${owner}/${repo}/git/trees/${recursiveSha}?recursive=1`,
    'GitHub 文件树',
  ).catch(() => null);
  if (recursive && !recursive?.truncated && Array.isArray(recursive.tree)) {
    const blobs = [];
    let total = 0;
    for (const entry of recursive.tree) {
      if (entry.type === 'tree') continue;
      const checked = blobOf(entry);
      total += checked.size;
      if (total > SKILL_LIMITS.maxTotal) failure('Skill 文件总量超过 4 MiB');
      blobs.push(checked);
      if (blobs.length > SKILL_LIMITS.maxFiles) failure(`文件数量超过 ${SKILL_LIMITS.maxFiles}`);
    }
    if (blobs.length) return blobs;
    failure('GitHub 来源目录没有可用文件');
  }
  const blobs = [];
  const queue = [{ sha: recursiveSha, prefix: '' }];
  let total = 0;
  while (queue.length) {
    const { sha, prefix } = queue.shift();
    const entries = await treeOf(fetchImpl, { owner, repo, sha });
    for (const entry of entries ?? []) {
      const relative = prefix ? `${prefix}/${entry.path}` : entry.path;
      if (entry.type === 'tree') {
        queue.push({ sha: entry.sha, prefix: relative });
        continue;
      }
      const checked = blobOf({ ...entry, path: relative });
      total += checked.size;
      if (total > SKILL_LIMITS.maxTotal) failure('Skill 文件总量超过 4 MiB');
      blobs.push(checked);
      if (blobs.length > SKILL_LIMITS.maxFiles) failure(`文件数量超过 ${SKILL_LIMITS.maxFiles}`);
    }
  }
  if (!blobs.length) failure('GitHub 来源目录没有可用文件');
  return blobs;
}

/** 单条 tree 条目收编为受控 blob；子模块/符号链接/超限在此拒绝。 */
function blobOf(entry) {
  if (entry.type === 'commit' || entry.mode === '160000') failure(`来源包含子模块引用：${entry.path}`);
  if (entry.type !== 'blob') failure(`不支持的文件类型：${entry.path}`);
  if (entry.mode === '120000') failure(`来源包含符号链接：${entry.path}`);
  if (!Number.isFinite(entry.size) || entry.size > SKILL_LIMITS.maxFile) failure(`单文件超过 2 MiB：${entry.path}`);
  return { path: entry.path, sha: entry.sha, size: entry.size };
}

/** raw 单发在弱网下必抖（实测单文件超时即整次安装失败）：网络错误重试 3 次，HTTP 状态码是确定性失败不重试。 */
async function fetchRaw(fetchImpl, { owner, repo }, commit, repoPath) {
  const url = `${GITHUB_RAW}/${owner}/${repo}/${commit}/${repoPath.split('/').map(encodeURIComponent).join('/')}`;
  let lastError = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await fetchImpl(url, { signal: AbortSignal.timeout(20000), redirect: 'error' });
      if (!response.ok) failure(`下载 ${repoPath} 失败：HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > SKILL_LIMITS.maxFile) failure(`单文件超过 2 MiB：${repoPath}`);
      return bytes;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('下载 ')) throw error;
      lastError = `下载 ${repoPath} 失败：${error.name === 'TimeoutError' || error.name === 'AbortError' ? '超时' : error.message}`;
    }
  }
  failure(lastError);
}

/** 归档体积上限：整仓 tar.gz 可能远大于 Skill 子树，超限直接拒绝（消息指引用本地导入）。 */
const MAX_ARCHIVE = 64 * 1024 * 1024;

/**
 * 整包一次拉取固定提交的 tar.gz（codeload）——免 API 主路的运输层。raw.githubusercontent.com
 * 在部分网络时段整段不可达（2026-10-09 晚实测三连 000），而 codeload/api 始终
 * ~1s 可达；zcode（api zipball）/dsh（codeload tar.gz/{sha}）同思路。gzip 解压
 * 即完整性校验（CRC 不符会抛错回落旧链）。
 * 时间预算收紧到 8 秒/次：单技能小仓 ~1.5s 即得；hosting 多技能的 monorepo
 * （如 openclaw/openclaw）整仓归档流几十 MiB，8 秒内下不完就放弃转旧链逐文件
 * （只拉 Skill 子树，体积小）——两条运输路各救各的场。
 */
async function fetchArchiveTarball(fetchImpl, { owner, repo }, commit) {
  const url = `https://codeload.github.com/${owner}/${repo}/tar.gz/${commit}`;
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    let response;
    try {
      response = await fetchImpl(url, { signal: AbortSignal.timeout(8000), redirect: 'error' });
      if (!response.ok) failure(`下载仓库归档失败：HTTP ${response.status}`);
      const chunks = [];
      let size = 0;
      if (response.body) {
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > MAX_ARCHIVE) failure('仓库归档超过 64 MiB，无法安全读取；可下载到本地整理后导入');
          chunks.push(Buffer.from(chunk));
        }
      } else {
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > MAX_ARCHIVE) failure('仓库归档超过 64 MiB，无法安全读取；可下载到本地整理后导入');
        chunks.push(bytes);
      }
      return gunzipSync(Buffer.concat(chunks));
    } catch (error) {
      if (error instanceof Error && (error.message.startsWith('下载 ') || error.message.includes('64 MiB'))) throw error;
      lastError = `下载仓库归档失败：${error.name === 'TimeoutError' || error.name === 'AbortError' ? '超时' : error.message}`;
    }
  }
  failure(lastError);
}

/**
 * 内存解析 tar（ustar/GNU/pax 长名），只登记普通文件，返回 仓库相对路径 → 内容。
 * 不落盘、不物化符号链接——链接条目记入返回 Map 的 linkEntries 属性，由调用方
 * 决定是否拒绝（技能目录内出现链接须整单拒绝）；其余成员（目录/子树外文件）忽略。
 */
export function parseTarArchive(bytes) {
  const files = new Map();
  const links = [];
  let offset = 0;
  let pendingLongName = null;
  let pendingPaxPath = null;
  const blockSize = 512;
  const readString = (start, length) => {
    const end = bytes.indexOf(0, start);
    return bytes.subarray(start, Math.min(end < 0 ? start + length : end, start + length)).toString('utf8');
  };
  const readSize = (start) => {
    // GNU base-256（首字节带高位 0x80）仅大文件出现，这里按八进制为主、base-256 兜底。
    if (bytes[start] & 0x80) {
      let value = bytes[start] & 0x7f;
      for (let index = start + 1; index < start + 12; index += 1) value = value * 256 + bytes[index];
      return value;
    }
    const text = readString(start, 12).trim();
    return text ? Number.parseInt(text, 8) || 0 : 0;
  };
  while (offset + blockSize <= bytes.length) {
    const header = bytes.subarray(offset, offset + blockSize);
    if (header.every((byte) => byte === 0)) break;
    let name = readString(offset, 100);
    const size = readSize(offset + 124);
    const typeflag = String.fromCharCode(bytes[offset + 156] || 0);
    const prefix = readString(offset + 345, 155);
    const dataStart = offset + blockSize;
    const data = bytes.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / blockSize) * blockSize;
    if (typeflag === 'L') { // GNU 长名：内容是下一条目的真实路径
      pendingLongName = data.toString('utf8').replace(/\0.*$/s, '');
      continue;
    }
    if (typeflag === 'x' || typeflag === 'X') { // pax 扩展头：path= 记录覆盖下一条目名
      const record = data.toString('utf8').match(/(?:^|\n)\d+ path=([^\n]+)/);
      pendingPaxPath = record ? record[1] : null;
      continue;
    }
    if (typeflag === 'g' || typeflag === 'K') continue; // pax 全局头 / GNU 长链接：与文件名无关
    if (pendingLongName !== null) {
      name = pendingLongName;
      pendingLongName = null;
    } else if (pendingPaxPath !== null) {
      name = pendingPaxPath;
      pendingPaxPath = null;
    } else if (prefix) {
      name = `${prefix}/${name}`;
    }
    if (typeflag === '2' || typeflag === '1') {
      // 符号/硬链接：不登记内容；剥根后的路径记入 linkEntries 供上层拒绝。
      const withoutRoot = name.replace(/^[^/]+\//, '');
      if (withoutRoot) links.push(withoutRoot);
    }
    if (typeflag === '0' || typeflag === '\0' || typeflag === '7') {
      const withoutRoot = name.replace(/^[^/]+\//, ''); // 剥掉 <repo>-<ref>/ 根目录段
      if (withoutRoot && !withoutRoot.endsWith('/')) files.set(withoutRoot, data);
    }
    // 目录('5')等：不登记。
  }
  files.linkEntries = links;
  return files;
}

/** Blobs API 兜底：按 blob SHA 直取内容（api.github.com 与 raw 不同境，被墙时段常仍可达）。 */
async function fetchBlobViaApi(fetchImpl, { owner, repo }, sha) {
  const data = await githubJson(fetchImpl, `${GITHUB_API}/repos/${owner}/${repo}/git/blobs/${sha}`, 'GitHub 文件');
  const base64 = typeof data?.content === 'string' ? data.content.replace(/\s+/g, '') : '';
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length || gitBlobSha(bytes) !== sha) failure('文件内容与 GitHub 文件树摘要不符（Blobs API）');
  return bytes;
}

/**
 * 归档主链路：codeload 整包一次请求，按技能目录收录普通文件——全程零
 * api.github.com 调用（未鉴权 60 次/小时配额留给兜底路）。gzip 由 gunzip 校验
 * 传输完整性；目录内出现链接条目即整单拒绝；大小/数量在此预检，SKILL.md 等
 * 结构校验交给 validateFileSet。归档内容即该 commit 的权威树（export-ignore
 * 隐藏的文件不会出现，与 git clone 到手的目录一致）。任何失败由调用方回落旧链。
 */
async function snapshotFromArchive(fetchImpl, location, commit, githubUrl) {
  const tarBytes = await fetchArchiveTarball(fetchImpl, location, commit);
  const archive = parseTarArchive(tarBytes);
  const prefix = location.dirPath ? `${location.dirPath}/` : '';
  const linkPath = (archive.linkEntries ?? []).find((name) => name.startsWith(prefix));
  if (linkPath) failureFinal(`来源包含符号链接：${prefix ? linkPath.slice(prefix.length) : linkPath}`);
  const rawFiles = [];
  let total = 0;
  for (const [name, bytes] of archive) {
    if (!name.startsWith(prefix)) continue;
    const relative = prefix ? name.slice(prefix.length) : name;
    if (!relative || relative.endsWith('/')) continue;
    if (bytes.length > SKILL_LIMITS.maxFile) failureFinal(`单文件超过 2 MiB：${relative}`);
    total += bytes.length;
    if (total > SKILL_LIMITS.maxTotal) failureFinal('Skill 文件总量超过 4 MiB');
    if (rawFiles.length >= SKILL_LIMITS.maxFiles) failureFinal(`文件数量超过 ${SKILL_LIMITS.maxFiles}`);
    rawFiles.push({ path: relative, contentBase64: bytes.toString('base64') });
  }
  if (!rawFiles.length) failureFinal('GitHub 来源目录不存在（仓库结构可能已变化）');
  const { files, metadata } = validateFileSet(rawFiles);
  return snapshotResult({ commit, location, githubUrl, files, metadata });
}

/**
 * 读取固定提交快照。pinnedCommit 传入时不再解析引用（安装路径：按预览钉住的
 * commit 重取，摘要必须与预览一致）。返回与市场/本地同一形状的受控文件集。
 */
export async function fetchGithubSnapshot({ githubUrl, commit: pinnedCommit = null }, { fetchImpl = fetch } = {}) {
  const location = parseGithubTreeUrl(githubUrl);
  if (!location) failure('来源不是可解析的 GitHub 目录地址');
  const commit = pinnedCommit ?? await resolveCommit(location, { fetchImpl });
  if (!/^[0-9a-f]{40}$/.test(commit)) failure('固定提交号无效');
  // 主链路：归档枚举（零 API 调用）；确定性失败（大小/数量/链接，树清单只会得出
  // 同样结论）直接报给用户，其余失败（含归档缺 SKILL.md 等可挽救场景）回落旧链
  // 用 api 树清单再核一遍——两条运输路各救各的场。
  const archived = await snapshotFromArchive(fetchImpl, location, commit, githubUrl).catch((error) => {
    if (error?.deterministic) throw error;
    return null;
  });
  if (archived) return archived;
  const blobs = await listBlobs(fetchImpl, { owner: location.owner, repo: location.repo, commit, dirPath: location.dirPath });
  const prefix = location.dirPath ? `${location.dirPath}/` : '';
  let fetched;
  try {
    const collected = new Array(blobs.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < blobs.length) {
        const index = cursor++;
        const blob = blobs[index];
        const bytes = await fetchRaw(fetchImpl, location, commit, `${prefix}${blob.path}`);
        if (gitBlobSha(bytes) !== blob.sha) failure(`文件内容与 GitHub 文件树摘要不符：${blob.path}`);
        collected[index] = { path: blob.path, contentBase64: bytes.toString('base64') };
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, blobs.length) }, worker));
    fetched = collected;
  } catch (rawError) {
    // 第三级：Blobs API。raw 被墙＋归档超预算（monorepo）两路都断时的最后一条——
    // api.github.com 与 raw 不同境，被墙时段常仍可达；每文件一次 API 调用，只适合
    // 文件少的技能（正好补上 monorepo 小技能的缺口）。失败时抛 raw 的错误（对
    // 用户的网络处境更有解释力）。
    try {
      fetched = await Promise.all(blobs.map(async (blob) => ({
        path: blob.path,
        contentBase64: (await fetchBlobViaApi(fetchImpl, location, blob.sha)).toString('base64'),
      })));
    } catch {
      throw rawError;
    }
  }
  const { files, metadata } = validateFileSet(fetched);
  return snapshotResult({ commit, location, githubUrl, files, metadata });
}

/** 归档/raw 两条运输路共用的收口：规范 bundle 摘要与快照形状。 */
function snapshotResult({ commit, location, githubUrl, files, metadata }) {
  const bundleSha256 = sha256Of(bundleBytesOf(files));
  return {
    commit,
    repo: `${location.owner}/${location.repo}`,
    dirPath: location.dirPath,
    githubUrl,
    metadata,
    files,
    bundleSha256,
    totalBytes: files.reduce((sum, file) => sum + file.bytes.length, 0),
  };
}
