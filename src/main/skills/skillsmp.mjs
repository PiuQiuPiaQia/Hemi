import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * 034：SkillsMP 发现层走匿名 REST 关键词搜索（https://skillsmp.com/api/v1/skills/search）。
 * 背景：公开 MCP（/mcp）自 2026-10-30 起要求账号鉴权（HTTP 401），匿名只剩这个端点；
 * 匿名限流约 50 次/天、10 次/分钟（响应头 X-RateLimit-*），搜索缓存是限流兜底。
 * REST 没有详情端点：详情按用途拆两条路——预览用最近搜索缓存命中（用户点的就是缓存
 * 里的条目，不烧限流额度）；检查更新用 creator（仓库 owner）精确查询拿新鲜数据。
 * 安装来源一律由 github-source 按 GitHub 固定提交独立核对，不信任 SkillsMP 元数据
 * 里的任何可安装声明。
 */
export const SKILLSMP_ENDPOINT = 'https://skillsmp.com/api/v1/skills/search';

/** GitHub 用户/组织登录名的宽松校验（与 SkillsMP creator 参数同口径）。 */
const CREATOR_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;

function failure(message) {
  throw new Error(message);
}

function httpsUrl(value) {
  return typeof value === 'string' && value.startsWith('https://') && value.length <= 500 ? value : null;
}

/** 只保留已知字段并截断——SkillsMP 元数据仅用于展示，不进入执行链路。 */
function normalizeSkill(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!id || !name || id.length > 200 || name.length > 200) return null;
  return {
    id, name,
    author: typeof raw.author === 'string' ? raw.author.trim().slice(0, 120) : '',
    description: typeof raw.description === 'string' ? raw.description.trim().slice(0, 600) : '',
    contentLanguage: typeof raw.contentLanguage === 'string' ? raw.contentLanguage.slice(0, 8) : '',
    githubUrl: httpsUrl(raw.githubUrl),
    skillUrl: httpsUrl(raw.skillUrl),
    stars: Number.isFinite(raw.stars) ? raw.stars : null,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : null,
  };
}

const describeNetError = (error) => {
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return '请求超时';
  const cause = typeof error.cause?.message === 'string' ? `：${error.cause.message}` : '';
  return `${error.message}${cause}`;
};

/** 匿名 GET；网络抖动重试一次，限流（429）与业务错误（success:false）给用户能懂的 reason。 */
async function restRequest(fetchImpl, url, { timeoutMs = 15000 } = {}) {
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
      if (response.status === 429) {
        const retry = Number(response.headers.get('retry-after'));
        const wait = Number.isFinite(retry) && retry > 0 ? Math.ceil(Math.min(retry, 600)) : null;
        failure(wait ? `SkillsMP 限流，请约 ${wait} 秒后再试` : 'SkillsMP 限流，请稍后再试');
      }
      if (!response.ok) failure(`SkillsMP 请求失败：HTTP ${response.status}`);
      let payload = null;
      try {
        payload = JSON.parse(await response.text());
      } catch {
        payload = null;
      }
      if (!payload || typeof payload !== 'object') {
        lastError = 'SkillsMP 返回格式无法解析';
        continue;
      }
      if (payload.success === false) {
        const message = typeof payload.error?.message === 'string' ? payload.error.message : '';
        failure(`SkillsMP 服务错误：${message || '未知错误'}`);
      }
      return payload.data && typeof payload.data === 'object' ? payload.data : {};
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('SkillsMP ')) throw error;
      lastError = `SkillsMP 连接失败：${describeNetError(error)}`;
    }
  }
  failure(lastError);
}

function validCache(value) {
  if (value?.schema !== 1 || typeof value.query !== 'string' || !Array.isArray(value.skills)
    || !Number.isFinite(value.checkedAt) || value.skills.length > 50) return null;
  const skills = value.skills.map(normalizeSkill).filter(Boolean);
  return { ...value, skills };
}

/**
 * 搜索缓存只用于离线/失败时展示「上次结果 + 时间」与预览详情命中，不把旧数据当实时。
 * 持久化到 userData/skills/skillsmp-cache.json（原子写）。
 */
export function createSkillsmpClient({ fetchImpl = fetch, cacheFile = null, log = null } = {}) {
  let cache = null;
  let cacheLoaded = false;
  const loadCache = () => {
    if (cacheLoaded) return;
    cacheLoaded = true;
    try {
      if (cacheFile && existsSync(cacheFile)) cache = validCache(JSON.parse(readFileSync(cacheFile, 'utf8')));
    } catch (error) {
      log?.warn?.(`SkillsMP 搜索缓存不可用：${error.message}`);
    }
  };
  const persistCache = async (entry) => {
    if (!cacheFile) return;
    const temporary = `${cacheFile}.${randomUUID()}.tmp`;
    try {
      await mkdir(path.dirname(cacheFile), { recursive: true });
      await writeFile(temporary, JSON.stringify(entry, null, 2) + '\n', { flag: 'wx' });
      await rename(temporary, cacheFile);
    } catch (error) {
      log?.warn?.(`SkillsMP 搜索缓存写入失败：${error.message}`);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  };
  return {
    cachedSearch() {
      loadCache();
      return cache;
    },
    /** 预览用：在最近一次搜索结果里按 id 取条目（不发网络请求）。 */
    cachedEntry(id) {
      loadCache();
      const trimmed = String(id ?? '').trim();
      if (!trimmed) return null;
      return cache?.skills.find((skill) => skill.id === trimmed) ?? null;
    },
    async search({ query, sortBy = 'stars', page = 1, limit = 20 }) {
      const term = String(query ?? '').trim();
      if (!term) failure('请输入搜索关键词');
      const params = new URLSearchParams({
        q: term.slice(0, 200),
        sortBy: sortBy === 'recent' ? 'recent' : 'stars',
        page: String(Math.min(Math.max(1, Math.trunc(page) || 1), 50)),
        limit: String(Math.min(Math.max(1, Math.trunc(limit) || 20), 50)),
      });
      const payload = await restRequest(fetchImpl, `${SKILLSMP_ENDPOINT}?${params.toString()}`);
      const skills = Array.isArray(payload?.skills) ? payload.skills.map(normalizeSkill).filter(Boolean) : [];
      const rawPagination = payload?.pagination && typeof payload.pagination === 'object' ? payload.pagination : {};
      const entry = {
        schema: 1, query: term, sortBy: sortBy === 'recent' ? 'recent' : 'stars',
        skills,
        pagination: {
          page: Number(rawPagination.page) || 1,
          totalPages: Number(rawPagination.totalPages) || 1,
          total: Number(rawPagination.total) || skills.length,
          hasNext: rawPagination.hasNext === true,
        },
        checkedAt: Date.now(),
      };
      cache = entry;
      await persistCache(entry);
      return entry;
    },
    /** 检查更新用：按作者（GitHub owner）列条目再按 id 匹配——REST 没有单条详情端点。
     *  作者技能可能超过一页：跟随 hasNext 翻页，3 页（150 条）封顶防限流放大。 */
    async detail(id, { creator = null } = {}) {
      const trimmed = String(id ?? '').trim();
      if (!trimmed || trimmed.length > 200) failure('SkillsMP 条目 ID 无效');
      const owner = String(creator ?? '').trim();
      if (!CREATOR_PATTERN.test(owner)) failure('无法确定条目作者，暂不能在线核对');
      for (let page = 1; page <= 3; page += 1) {
        const params = new URLSearchParams({ creator: owner, limit: '50', page: String(page), sortBy: 'stars' });
        const payload = await restRequest(fetchImpl, `${SKILLSMP_ENDPOINT}?${params.toString()}`);
        const list = Array.isArray(payload?.skills) ? payload.skills : [];
        const skill = normalizeSkill(list.find((item) => item?.id === trimmed));
        if (skill) return skill;
        if (payload?.pagination?.hasNext !== true) break;
      }
      failure('SkillsMP 没有返回该条目的详情（可能已撤架）');
    },
  };
}
