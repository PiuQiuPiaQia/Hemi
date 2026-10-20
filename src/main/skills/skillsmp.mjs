import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * 034：SkillsMP 公开 MCP（https://skillsmp.com/mcp，Streamable HTTP，无鉴权只读）。
 * 只承担发现：search_skills / get_skill。安装来源一律由 github-source 按 GitHub
 * 固定提交独立核对，不信任 SkillsMP 元数据里的任何可安装声明。
 */
export const SKILLSMP_ENDPOINT = 'https://skillsmp.com/mcp';
const MCP_PROTOCOL = '2025-06-18';

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

let callSeq = 0;

const describeNetError = (error) => {
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return '请求超时';
  const cause = typeof error.cause?.message === 'string' ? `：${error.cause.message}` : '';
  return `${error.message}${cause}`;
};

async function mcpRequest(fetchImpl, method, params, { timeoutMs = 15000 } = {}) {
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetchImpl(SKILLSMP_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': MCP_PROTOCOL,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++callSeq, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
      if (response.status === 429) {
        const retry = Number(response.headers.get('retry-after'));
        const wait = Number.isFinite(retry) && retry > 0 ? Math.ceil(Math.min(retry, 600)) : null;
        failure(wait ? `SkillsMP 限流，请约 ${wait} 秒后再试` : 'SkillsMP 限流，请稍后再试');
      }
      if (!response.ok) failure(`SkillsMP 请求失败：HTTP ${response.status}`);
      const text = await response.text();
      let payload = null;
      try {
        payload = JSON.parse(text);
      } catch {
        const dataLine = text.split(/\r?\n/).find((line) => line.startsWith('data:'));
        if (dataLine) {
          try { payload = JSON.parse(dataLine.slice(5).trim()); } catch { /* 走下面的格式错误 */ }
        }
      }
      if (!payload || typeof payload !== 'object') {
        lastError = 'SkillsMP 返回格式无法解析';
        continue;
      }
      if (payload.error) failure(`SkillsMP 服务错误：${typeof payload.error?.message === 'string' ? payload.error.message : '未知错误'}`);
      return payload.result ?? {};
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('SkillsMP ')) throw error;
      lastError = `SkillsMP 连接失败：${describeNetError(error)}`;
    }
  }
  failure(lastError);
}

async function callTool(fetchImpl, name, args) {
  const result = await mcpRequest(fetchImpl, 'tools/call', { name, arguments: args });
  const text = Array.isArray(result?.content) && typeof result.content[0]?.text === 'string'
    ? result.content[0].text : '';
  if (result?.isError) failure(`SkillsMP 查询失败：${text.slice(0, 200) || '未知错误'}`);
  try {
    return JSON.parse(text);
  } catch {
    failure('SkillsMP 结果无法解析');
  }
}

function validCache(value) {
  if (value?.schema !== 1 || typeof value.query !== 'string' || !Array.isArray(value.skills)
    || !Number.isFinite(value.checkedAt) || value.skills.length > 50) return null;
  const skills = value.skills.map(normalizeSkill).filter(Boolean);
  return { ...value, skills };
}

/**
 * 搜索缓存只用于离线/失败时展示「上次结果 + 时间」，不把旧数据当实时。
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
    async search({ query, sortBy = 'stars', page = 1, limit = 20 }) {
      const term = String(query ?? '').trim();
      if (!term) failure('请输入搜索关键词');
      const payload = await callTool(fetchImpl, 'search_skills', {
        query: term.slice(0, 200),
        sortBy: sortBy === 'recent' ? 'recent' : 'stars',
        page: Math.min(Math.max(1, Math.trunc(page) || 1), 50),
        limit: Math.min(Math.max(1, Math.trunc(limit) || 20), 50),
      });
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
    async detail(id) {
      const trimmed = String(id ?? '').trim();
      if (!trimmed || trimmed.length > 200) failure('SkillsMP 条目 ID 无效');
      const payload = await callTool(fetchImpl, 'get_skill', { id: trimmed });
      const skill = normalizeSkill(payload?.skill);
      if (!skill) failure('SkillsMP 没有返回该条目的详情（可能已撤架）');
      return skill;
    },
  };
}
