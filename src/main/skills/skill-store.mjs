import { createHash, randomUUID } from 'node:crypto';
import {
  lstat, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile,
} from 'node:fs/promises';
import { existsSync, lstatSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSkillMetadata, prepareSkills } from './skill-definition.mjs';

const OFFICIAL_DIR = fileURLToPath(new URL('./official/', import.meta.url));
export const OFFICIAL_CATALOG_URL =
  'https://raw.githubusercontent.com/PiuQiuPiaQia/Hemi/main/src/main/skills/official/catalog.json';
const OFFICIAL_BASE = new URL('./', OFFICIAL_CATALOG_URL);
const MAX_PACKAGE = 8 * 1024 * 1024;
// 单文件上限 2026-10-31 自 1 MiB 上调到 2 MiB：真实市场技能带数据文件
// （pbakaus/impeccable 的 font-index.json 1,100,013B，超旧限 393 字节）被拒。
const MAX_FILE = 2 * 1024 * 1024;
const MAX_TOTAL = 4 * 1024 * 1024;
// 文件数只是登记规模上限，真正的安全边界是总量/单文件字节数；64 会拒绝
// 真实市场技能（xuemian168/bazi-skill 87 文件，2026-10-09），上调到 256。
const MAX_FILES = 256;

/**
 * 原生可执行载荷的魔数（Mach-O 全变体与 fat 包、ELF、PE）。文件类型不设白名单——
 * 完整收录来源的全部文件，可执行内容是唯一硬边界，按内容判定不受扩展名伪装影响。
 */
const EXECUTABLE_MAGIC = [
  [0xfe, 0xed, 0xfa, 0xce], // Mach-O 32 位大端
  [0xfe, 0xed, 0xfa, 0xcf], // Mach-O 64 位大端
  [0xce, 0xfa, 0xed, 0xfe], // Mach-O 32 位小端
  [0xcf, 0xfa, 0xed, 0xfe], // Mach-O 64 位小端
  [0xca, 0xfe, 0xba, 0xbe], // fat/universal（同为 Java class 头）
  [0xbe, 0xba, 0xfe, 0xca], // fat 字节交换
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0x4d, 0x5a], // PE/DOS
];

const isExecutableBytes = (bytes) => EXECUTABLE_MAGIC.some(
  (magic) => magic.length <= bytes.length && magic.every((byte, index) => bytes[index] === byte),
);

/** 034 SkillsMP、内置、本地复制/远传共用文件边界；可信本机 symlink 不走载荷限制。 */
export const SKILL_LIMITS = {
  maxFile: MAX_FILE, maxTotal: MAX_TOTAL, maxFiles: MAX_FILES,
};

export const ORIGIN_LABELS = { market: 'Hemi 内置目录', local: '本地导入', skillsmp: 'SkillsMP 市场' };

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function failure(message) {
  throw new Error(message);
}

function safeRelative(name) {
  if (typeof name !== 'string' || !name || name.length > 240 || name.includes('\\') || name.includes('\0')
    || path.posix.isAbsolute(name) || name.split('/').some((part) => !part || part === '.' || part === '..')
    || !/^[\w.\-/]+$/.test(name)) {
    failure(`不支持的文件路径：${String(name).slice(0, 80)}`);
  }
  return name;
}

function metadataOf(bytes) {
  return parseSkillMetadata(bytes.toString('utf8'));
}

function validateFiles(files) {
  if (!Array.isArray(files) || files.length > MAX_FILES) failure('文件数量超限或格式错误');
  if (!files.length) failure('缺少 SKILL.md');
  const seen = new Set();
  let total = 0;
  const result = [];
  for (const file of files) {
    const relative = safeRelative(file?.path);
    const key = relative.toLowerCase();
    if (seen.has(key)) failure(`重复文件：${relative}`);
    seen.add(key);
    if (typeof file.contentBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.contentBase64)) {
      failure(`文件编码无效：${relative}`);
    }
    const bytes = Buffer.from(file.contentBase64, 'base64');
    if (bytes.length > MAX_FILE) failure(`单文件超过 2 MiB：${relative}`);
    if (isExecutableBytes(bytes)) failure(`文件包含可执行内容：${relative}`);
    total += bytes.length;
    if (total > MAX_TOTAL) failure('Skill 文件总量超过 4 MiB');
    result.push({ path: relative, bytes });
  }
  const skill = result.find((file) => file.path === 'SKILL.md');
  if (!skill) failure('缺少 SKILL.md');
  return { files: result, metadata: metadataOf(skill.bytes) };
}

function parseBundle(bytes) {
  if (bytes.length > MAX_PACKAGE) failure('Skill 包超过 8 MiB');
  let bundle;
  try { bundle = JSON.parse(bytes.toString('utf8')); } catch { failure('Skill 包不是合法 JSON'); }
  if (bundle?.schema !== 1) failure('不支持的 Skill 包版本');
  return validateFiles(bundle.files);
}

/** 034 SkillsMP：GitHub 来源走同一校验器（路径边界、可执行内容、大小、frontmatter）。 */
export function validateFileSet(files) {
  return validateFiles(files);
}

/** 受控版本身份：与市场包/本地导入一致的规范 bundle 字节（sha256 对它计算）。 */
export function bundleBytesOf(validatedFiles) {
  return Buffer.from(JSON.stringify({
    schema: 1,
    files: validatedFiles.map((file) => ({ path: file.path, contentBase64: Buffer.from(file.bytes).toString('base64') })),
  }) + '\n');
}

function validGithubSource(value) {
  const github = value?.github;
  if (typeof github?.entryId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,191}$/.test(github.entryId)
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(github.repo ?? '')
    || typeof github.path !== 'string' || github.path.length > 240
    || (github.path ? github.path.split('/').some((part) => !part || part === '.' || part === '..' || part.includes('\\')) : false)
    || !/^[0-9a-f]{40}$/.test(github.commit ?? '')
    || typeof github.url !== 'string' || !github.url.startsWith('https://')
    || typeof github.githubUrl !== 'string' || !github.githubUrl.startsWith('https://')) failure('SkillsMP 来源身份无效');
  return github;
}

function validCatalog(input) {
  if (input?.schema !== 1 || input?.publisher !== 'Hemi' || !Array.isArray(input.items)
    || input.items.length > 200 || typeof input.publishedAt !== 'string') failure('官方目录格式错误');
  const ids = new Set();
  const items = input.items.map((item) => {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(item?.id ?? '') || ids.has(item.id)
      || item.name !== item.id || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 80 || typeof item.description !== 'string'
      || !item.description.trim() || item.description.length > 1024
      || typeof item.author !== 'string' || !item.author.trim()
      || !/^\d+\.\d+\.\d+$/.test(item.version ?? '')
      || !/^bundles\/[a-z0-9.-]+\.json$/.test(item.package ?? '')
      || !/^[a-f0-9]{64}$/.test(item.sha256 ?? '')
      || !Array.isArray(item.files) || !item.files.includes('SKILL.md')
      || item.files.length > MAX_FILES) failure(`官方目录条目无效：${String(item?.id).slice(0, 50)}`);
    item.files.forEach(safeRelative);
    ids.add(item.id);
    return {
      id: item.id, name: item.name, title: item.title, description: item.description,
      author: item.author, version: item.version, package: item.package,
      sha256: item.sha256, files: [...item.files],
    };
  });
  return { schema: 1, publisher: 'Hemi', publishedAt: input.publishedAt, items };
}

function readJsonIfExists(file) {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

function validStoredIndex(value) {
  if (value?.schema !== 1 || !Array.isArray(value.installed) || value.installed.length > 200) failure('格式不受支持');
  const ids = new Set();
  for (const item of value.installed) {
    const linked = item?.importMode === 'symlink';
    if (linked && (item.origin !== 'local' || item.sha256 !== null
      || !/^[a-f0-9-]{36}$/.test(item.linkId ?? '')
      || typeof item.sourcePath !== 'string' || !path.isAbsolute(item.sourcePath) || item.sourcePath.includes('\0')
      || item.files?.length !== 1 || item.files[0] !== 'SKILL.md')) failure('本地链接登记无效');
    if (item?.importMode !== undefined && !['symlink', 'copy'].includes(item.importMode)) failure('导入方式无效');
    if (!/^(market:[a-z0-9][a-z0-9-]{0,63}|local:[a-f0-9-]{36}|skillsmp:[a-z0-9][a-z0-9-]{0,191})$/.test(item?.id ?? '')
      || ids.has(item.id) || (!linked && !/^[a-f0-9]{64}$/.test(item.sha256 ?? ''))
      || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(item.name ?? '')
      || !['market', 'local', 'skillsmp'].includes(item.origin)
      || typeof item.enabled !== 'boolean' || !Array.isArray(item.files)
      || !item.files.includes('SKILL.md') || item.files.length > MAX_FILES) failure('条目身份或文件清单无效');
    item.files.forEach(safeRelative);
    if (item.origin === 'skillsmp') {
      if (item.id !== `skillsmp:${item.github?.entryId}`) failure('SkillsMP 条目身份与登记不一致');
      validGithubSource(item);
    }
    ids.add(item.id);
  }
  return value;
}

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function boundedFetch(fetchImpl, url, limit, timeoutMs) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.origin !== OFFICIAL_BASE.origin
    || !target.pathname.startsWith(OFFICIAL_BASE.pathname)) failure('官方目录地址越界');
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  if (!response.ok) failure(`下载失败：HTTP ${response.status}`);
  const chunks = [];
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) failure('下载内容超出大小限制');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > limit) failure('下载内容超出大小限制');
  return bytes;
}

async function localFiles(sourceDir, relative = '') {
  const out = [];
  for (const name of (await readdir(path.join(sourceDir, relative))).sort()) {
    if (name.startsWith('._') || name === '.DS_Store') continue;
    const file = path.posix.join(relative, name);
    if (!file || file.includes('\\') || file.split('/').some((part) => !part || part === '.' || part === '..')) {
      failure(`不支持的文件路径：${file}`);
    }
    const absolute = path.join(sourceDir, file);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) failure(`不允许符号链接：${file}`);
    if (stat.isDirectory()) {
      out.push(...await localFiles(sourceDir, file));
    } else if (stat.isFile()) {
      safeRelative(file);
      if (stat.size > MAX_FILE) failure(`单文件超过 2 MiB：${file}`);
      out.push({ path: file, contentBase64: (await readFile(absolute)).toString('base64') });
    } else failure(`不支持的文件类型：${file}`);
    if (out.length > MAX_FILES) failure(`文件数量超过 ${MAX_FILES}`);
  }
  return out;
}

/** 远传/显式复制通道：继续执行包体、路径及可执行内容限制。 */
export async function readSkillDirectory(sourceDir) {
  if (typeof sourceDir !== 'string' || !path.isAbsolute(sourceDir) || !(await lstat(sourceDir)).isDirectory()) failure('请选择有效的 Skill 文件夹');
  const files = await localFiles(sourceDir);validateFiles(files);return files;
}

export function createSkillStore({ root, fetchImpl = fetch, catalogUrl = OFFICIAL_CATALOG_URL, log = null } = {}) {
  if (!root) throw new Error('Skill root 必填');
  const indexFile = path.join(root, 'index.json');
  const catalogFile = path.join(root, 'catalog-cache.json');
  const builtIn = validCatalog(readJsonIfExists(path.join(OFFICIAL_DIR, 'catalog.json')));
  let index = { schema: 1, installed: [] };
  let storageError = '';
  try {
    const stored = readJsonIfExists(indexFile);
    if (stored) index = validStoredIndex(stored);
  } catch (error) {
    storageError = `Skill 登记文件损坏：${error.message}。请检查 ${indexFile}`;
    log?.warn?.(storageError);
  }
  let catalog = builtIn;
  let catalogSource = 'built-in';
  let catalogError = '';
  let checkedAt = null;
  try {
    const cached = readJsonIfExists(catalogFile);
    if (cached) {
      catalog = validCatalog(cached.catalog);
      checkedAt = cached.checkedAt ?? null;
      catalogSource = 'cached';
    }
  } catch (error) {
    catalogError = `缓存目录失效：${error.message}`;
  }
  const refs = new Map();
  let serial = Promise.resolve();
  const run = (action) => {
    const result = serial.then(action);
    serial = result.catch(() => {});
    return result;
  };
  // 链接使用独立登记代号而非内容摘要；lease 只保留受管链接，不冻结或复制源目录。
  const directoryOf = (entry) => path.join(root, 'versions', entry.id.replace(':', '_'),
    entry.importMode === 'symlink' ? `link-${entry.linkId}` : entry.sha256);
  const pathKey = (value) => process.platform === 'win32'
    ? path.toNamespacedPath(path.resolve(value)).toLowerCase() : path.resolve(value);
  const linkedMetadata = (entry) => {
    const dir = directoryOf(entry);
    if (!lstatSync(dir).isSymbolicLink()
      || pathKey(path.resolve(path.dirname(dir), readlinkSync(dir))) !== pathKey(entry.sourcePath)
      || !statSync(dir).isDirectory()) failure('本地技能链接或源目录已失效，请重新导入');
    const file = path.join(dir, 'SKILL.md');
    if (!lstatSync(file).isFile()) failure('SKILL.md 必须是普通文件，不能是软链');
    const metadata = metadataOf(readFileSync(file));
    if (metadata.name !== entry.name) failure('Skill name 与安装登记不一致，请重新导入');
    return metadata;
  };
  const sourceStatus = (entry) => {
    if (entry.importMode !== 'symlink') return {};
    try { linkedMetadata(entry); return { sourceAvailable: true }; }
    catch (error) { return { sourceAvailable: false, sourceError: `本地技能源不可用：${error.message}` }; }
  };
  const viewOf = (entry) => ({
    id: entry.id, name: entry.name, title: entry.title ?? entry.name, description: entry.description,
    version: entry.version, sha256: entry.sha256, origin: entry.origin,
    author: entry.author, enabled: entry.enabled, files: [...entry.files],
    sourcePath: entry.sourcePath ?? null,
    ...(entry.origin === 'local' ? { importMode: entry.importMode ?? 'copy', ...sourceStatus(entry) } : {}),
    github: entry.github ?? null,
    updateAvailable: entry.origin === 'market'
      ? Boolean(catalog.items.find((item) => item.id === entry.marketId && item.sha256 !== entry.sha256))
      : false,
    sourceWithdrawn: entry.origin === 'market' && !catalog.items.some((item) => item.id === entry.marketId),
  });
  const state = () => ({
    installed: index.installed.map(viewOf),
    catalog: catalog.items.map((item) => ({
      ...item,
      installedId: index.installed.find((entry) => entry.marketId === item.id)?.id ?? null,
    })),
    catalogSource, catalogError, storageError, checkedAt, publishedAt: catalog.publishedAt,
  });
  const conflict = (name, id) => index.installed.find((entry) => entry.name.toLowerCase() === name.toLowerCase() && entry.id !== id);
  async function pruneInternal() {
    if (storageError) return;
    const versionsRoot = path.join(root, 'versions');
    if (!existsSync(versionsRoot)) return;
    const keep = new Set(index.installed.map(directoryOf));
    for (const [dir, count] of refs) if (count > 0) keep.add(dir);
    for (const owner of await readdir(versionsRoot)) {
      const ownerDir = path.join(versionsRoot, owner);
      if (!(await lstat(ownerDir)).isDirectory()) continue;
      for (const version of await readdir(ownerDir)) {
        const dir = path.join(ownerDir, version);
        // lstat 不跟随源；Windows junction 也只移除链接本身，绝不递归源目录。
        if (!keep.has(dir)) await rm(dir, { recursive: !(await lstat(dir)).isSymbolicLink(), force: true });
      }
    }
  }
  async function publish({ id, origin, marketId = null, version, author, sourcePath = null, github = null, sha, parsed }) {
    if (storageError) failure(storageError);
    const { files, metadata } = parsed;
    const existing = conflict(metadata.name, id);
    if (existing) failure(`同名 Skill 已安装：${metadata.name}（来自${ORIGIN_LABELS[existing.origin] ?? existing.origin}${existing.origin === 'skillsmp' ? ` ${existing.github?.repo ?? ''}` : existing.origin === 'local' ? ` ${existing.sourcePath ?? ''}` : ''}）。请先卸载原来源，再添加本来源；不会静默换用。`);
    const entry = {
      id, origin, marketId, version, author, sourcePath, github,
      ...(origin === 'local' ? { importMode: 'copy' } : {}),
      sha256: sha, name: metadata.name, title: metadata.title, description: metadata.description,
      enabled: index.installed.find((item) => item.id === id)?.enabled ?? true,
      files: files.map((file) => file.path),
    };
    const finalDir = directoryOf(entry);
    let created = false;
    if (existsSync(finalDir)) {
      if (!lstatSync(finalDir).isDirectory()) failure('受控版本目录已损坏');
      for (const file of files) {
        const target = path.join(finalDir, file.path);
        if (!existsSync(target) || !lstatSync(target).isFile()
          || !(await readFile(target)).equals(file.bytes)) failure(`受控版本内容已损坏：${file.path}`);
      }
    } else {
      const stage = path.join(root, 'staging', randomUUID());
      await mkdir(stage, { recursive: true });
      try {
        for (const file of files) {
          const target = path.join(stage, file.path);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, file.bytes, { flag: 'wx', mode: 0o600 });
        }
        await mkdir(path.dirname(finalDir), { recursive: true });
        await rename(stage, finalDir);
        created = true;
      } finally {
        await rm(stage, { recursive: true, force: true }).catch(() => {});
      }
    }
    const next = { schema: 1, installed: [...index.installed.filter((item) => item.id !== id), entry] };
    try {
      await atomicJson(indexFile, next);
      index = next;
    } catch (error) {
      if (created) await rm(finalDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    await pruneInternal().catch((error) => log?.warn?.(`Skill 旧版本清理失败：${error.message}`));
    return viewOf(entry);
  }
  async function publishLink(sourcePath, metadata, id) {
    if (storageError) failure(storageError);
    const existing = conflict(metadata.name, id);
    if (existing) failure(`同名 Skill 已安装：${metadata.name}。请先卸载原来源，再添加本来源；不会静默换用。`);
    const entry = {
      id, origin: 'local', importMode: 'symlink', linkId: randomUUID(), sourcePath,
      version: '随源更新', author: '本地', sha256: null,
      ...metadata, enabled: index.installed.find(item => item.id === id)?.enabled ?? true,
      // 仅登记入口，不遍历或假装持有整棵源目录的文件清单。
      files: ['SKILL.md'],
    };
    const dir = directoryOf(entry);
    await mkdir(path.dirname(dir), { recursive: true });
    try {
      await symlink(sourcePath, dir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      failure(`无法创建本地技能软链接（${error.code ?? error.message}）；未复制源文件。可显式选择“复制”后重试`);
    }
    try {
      linkedMetadata(entry);
      const next = { schema: 1, installed: [...index.installed.filter(item => item.id !== id), entry] };
      await atomicJson(indexFile, next);
      index = next;
    } catch (error) {
      await rm(dir, { force: true }).catch(() => {});
      throw error;
    }
    await pruneInternal().catch(error => log?.warn?.(`Skill 旧版本清理失败：${error.message}`));
    return viewOf(entry);
  }
  return {
    state,
    enabledSummaries() {
      return index.installed.filter((item) => item.enabled && sourceStatus(item).sourceAvailable !== false)
        .slice(0, 30).map((item) => ({
          id: item.id, name: item.name, title: item.title ?? item.name, description: item.description.slice(0, 160),
        }));
    },
    snapshot(skillId = null) {
      const enabled = index.installed.filter((item) => item.enabled);
      if (skillId && !enabled.some((item) => item.id === skillId)) failure('指定的 Skill 未安装或已禁用');
      const diagnostics = storageError ? [{ type: 'warning', source: 'library', path: indexFile, message: storageError }] : [];
      const candidates = enabled.flatMap((item) => {
        const status = sourceStatus(item);
        if (status.sourceAvailable === false) {
          diagnostics.push({ type: 'warning', source: 'library', path: directoryOf(item),
            skillId: item.id, name: item.name, message: status.sourceError });
          return [];
        }
        return [{
          id: item.id, name: item.name, version: item.version, sha256: item.sha256,
          ...(item.origin === 'local' ? { importMode: item.importMode ?? 'copy' } : {}),
          description: item.description ?? '',
          path: directoryOf(item), source: 'library',
        }];
      });
      const { items } = prepareSkills(candidates, { diagnostics });
      if (skillId && !items.some(item => item.id === skillId)) {
        const invalid = diagnostics.find(item => item.skillId === skillId);
        failure(`指定的 Skill 不可用：${invalid?.path ?? skillId}：${invalid?.message ?? '文件失效'}`);
      }
      for (const item of items) refs.set(item.path, (refs.get(item.path) ?? 0) + 1);
      let released = false;
      return {
        items,
        diagnostics,
        selectedId: skillId,
        release() {
          if (released) return;
          released = true;
          for (const item of items) refs.set(item.path, Math.max(0, (refs.get(item.path) ?? 1) - 1));
          void run(pruneInternal).catch((error) => log?.warn?.(`Skill 旧版本清理失败：${error.message}`));
        },
      };
    },
    refreshCatalog: () => run(async () => {
      try {
        const bytes = await boundedFetch(fetchImpl, catalogUrl, 256 * 1024, 12000);
        const next = validCatalog(JSON.parse(bytes.toString('utf8')));
        const timestamp = Date.now();
        await atomicJson(catalogFile, { checkedAt: timestamp, catalog: next });
        catalog = next;
        checkedAt = timestamp;
        catalogSource = 'online';
        catalogError = '';
        return { ok: true, state: state() };
      } catch (error) {
        catalogError = `官方目录刷新失败：${error.message}`;
        log?.warn?.(catalogError);
        return { ok: false, reason: catalogError, state: state() };
      }
    }),
    installMarket: (marketId) => run(async () => {
      const item = catalog.items.find((candidate) => candidate.id === marketId);
      if (!item) failure('市场条目不存在或已撤架');
      const id = `market:${item.id}`;
      let bytes;
      const bundled = path.join(OFFICIAL_DIR, item.package);
      if (catalogSource === 'built-in' && existsSync(bundled)) {
        bytes = await readFile(bundled);
      } else try {
        bytes = await boundedFetch(fetchImpl, new URL(item.package, catalogUrl).href, MAX_PACKAGE, 20000);
      } catch (error) {
        if (!existsSync(bundled)) throw error;
        const fallback = await readFile(bundled);
        if (sha256(fallback) !== item.sha256) throw error;
        bytes = fallback;
      }
      if (sha256(bytes) !== item.sha256) failure('Skill 包 SHA-256 校验失败');
      const parsed = parseBundle(bytes);
      if (parsed.metadata.name !== item.name || parsed.metadata.title !== item.title
        || parsed.metadata.description !== item.description
        || parsed.files.map((file) => file.path).sort().join('|') !== [...item.files].sort().join('|')) {
        failure('Skill 包与官方目录声明不一致');
      }
      return { ok: true, skill: await publish({
        id, origin: 'market', marketId: item.id, version: item.version,
        author: item.author, sha: item.sha256, parsed,
      }), state: state() };
    }),
    /** A remote host receives the selected files, never a path on the client machine. */
    importFiles: ({files, id = null}) => run(async () => {
      const parsed = validateFiles(files);
      if (id && !index.installed.some(item => item.id === id && item.origin === 'local')) failure('待更新的导入技能不存在');
      const bytes = bundleBytesOf(parsed.files);
      return {ok: true, skill: await publish({id: id ?? `local:${randomUUID()}`, origin: 'local',
        version: '本地导入', author: '本地', sha: sha256(bytes), parsed}), state: state()};
    }),
    importDirectory: (sourceDir, { mode = 'symlink' } = {}) => run(async () => {
      if (!['symlink', 'copy'].includes(mode)) failure('不支持的本地技能导入方式');
      if (typeof sourceDir !== 'string' || !path.isAbsolute(sourceDir) || sourceDir.includes('\0')) failure('请选择有效的 Skill 文件夹');
      // 信任用户明确选择的本机目录；归一目录别名，不递归扫描/编码链接源。
      const sourcePath = await realpath(sourceDir);
      if (!(await lstat(sourcePath)).isDirectory()) failure('导入目标不是文件夹');
      const managedRoot = await realpath(root).catch(() => path.resolve(root));
      const relative = path.relative(managedRoot, sourcePath);
      if (!relative || ['versions', 'staging'].some(dir => relative === dir || relative.startsWith(`${dir}${path.sep}`))) {
        failure('不能从 Hemi 受管技能目录导入，请选择原始源目录');
      }
      let existing = index.installed.find((item) => item.origin === 'local'
        && (item.sourcePath === sourcePath || item.sourcePath === sourceDir));
      // 旧副本曾保存原始路径（例如 macOS /var 别名）；只用于识别同源，不迁移旧副本。
      if (!existing) {
        for (const item of index.installed.filter(item => item.origin === 'local' && item.sourcePath)) {
          if (await realpath(item.sourcePath).catch(() => null) === sourcePath) { existing = item; break; }
        }
      }
      const id = existing?.id ?? `local:${randomUUID()}`;
      if (mode === 'symlink') {
        const file = path.join(sourcePath, 'SKILL.md');
        const info = await lstat(file).catch(error => {
          if (error.code === 'ENOENT') failure('缺少 SKILL.md');
          throw error;
        });
        if (!info.isFile()) failure('SKILL.md 必须是普通文件，不能是软链');
        const metadata = metadataOf(await readFile(file));
        return { ok: true, skill: await publishLink(sourcePath, metadata, id), state: state() };
      }
      try {
        const files = await localFiles(sourcePath);
        const bytes = Buffer.from(JSON.stringify({ schema: 1, files }) + '\n');
        const parsed = parseBundle(bytes);
        return { ok: true, skill: await publish({
          id, origin: 'local', version: '本地导入', author: '本地',
          sourcePath, sha: sha256(bytes), parsed,
        }), state: state() };
      } catch (error) {
        failure(`复制导入失败：${error.message}`);
      }
    }),
    /** 034 SkillsMP：固定提交快照落地。expectedSha256 是用户预览确认过的 bundle 摘要，不符即拒绝。 */
    installFromSnapshot: ({
      skillsmpId, author = 'SkillsMP', githubUrl, skillsmpUrl, repo, dirPath, commit,
      files, metadata, expectedSha256 = null,
    }) => run(async () => {
      if (storageError) failure(storageError);
      const bundleBytes = bundleBytesOf(files);
      const sha = sha256(bundleBytes);
      if (expectedSha256 && expectedSha256 !== sha) failure('来源文件与预览时不一致（固定提交内容变化），请重新预览确认');
      const id = `skillsmp:${skillsmpId}`;
      return { ok: true, skill: await publish({
        id, origin: 'skillsmp', version: commit.slice(0, 7),
        author: author || 'SkillsMP',
        github: { entryId: skillsmpId, url: skillsmpUrl ?? '', githubUrl, repo, path: dirPath, commit },
        sha, parsed: { files, metadata },
      }), state: state() };
    }),
    setEnabled: (id, enabled) => run(async () => {
      if (storageError) failure(storageError);
      const existing = index.installed.find((item) => item.id === id);
      if (!existing) failure('Skill 不存在');
      const next = {
        schema: 1,
        installed: index.installed.map((item) => item.id === id ? { ...item, enabled: Boolean(enabled) } : item),
      };
      await atomicJson(indexFile, next);
      index = next;
      return { ok: true, state: state() };
    }),
    remove: (id) => run(async () => {
      if (storageError) failure(storageError);
      if (!index.installed.some((item) => item.id === id)) failure('Skill 不存在');
      const next = { schema: 1, installed: index.installed.filter((item) => item.id !== id) };
      await atomicJson(indexFile, next);
      index = next;
      await pruneInternal().catch((error) => log?.warn?.(`Skill 副本清理失败：${error.message}`));
      return { ok: true, state: state() };
    }),
    readSkill: async (id) => {
      const entry = index.installed.find((item) => item.id === id);
      if (!entry) failure('Skill 不存在');
      if (entry.importMode === 'symlink') linkedMetadata(entry);
      const file = path.join(directoryOf(entry), 'SKILL.md');
      if (!(await lstat(file)).isFile()) failure('Skill 原文文件已失效');
      return (await readFile(file, 'utf8')).slice(0, MAX_FILE);
    },
    managedPath: (id) => {
      const entry = index.installed.find((item) => item.id === id);
      if (!entry) failure('Skill 不存在');
      const dir = directoryOf(entry);
      if (entry.importMode === 'symlink') linkedMetadata(entry);
      else if (!lstatSync(dir).isDirectory()) failure('Skill 目录已失效');
      return dir;
    },
    prune: () => run(pruneInternal),
  };
}
