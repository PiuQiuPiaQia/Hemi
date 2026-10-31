import { fetchGithubSnapshot, parseGithubTreeUrl, resolveCommit } from './github-source.mjs';
import { createSkillsmpClient } from './skillsmp.mjs';

const failure = (message) => {
  throw new Error(message);
};

/**
 * 034 SkillsMP 编排层：把「发现（SkillsMP 匿名 REST 搜索）」与「安装（GitHub 固定提交）」接起来。
 * - preview：详情来自最近搜索缓存（REST 无详情端点；用户点的就是缓存里的条目，不烧限流额度）
 *   → 解析 githubUrl → 解析固定提交 → 按 tree blob 摘要取文件
 *   → 返回真实 SKILL.md、文件清单、commit 与 bundle 摘要供用户确认；不落任何状态。
 * - install：按预览钉住的 commit 重取文件，bundle 摘要与预览一致才交给 skill-store 原子发布。
 * - checkUpdate：只报告事实（最新/有新版/来源变化/暂不可核对），不自动安装。
 */
export function createSkillsmpService({ store, fetchImpl = fetch, cacheFile = null, log = null } = {}) {
  if (!store) throw new Error('SkillsMP 服务需要 skill store');
  const mp = createSkillsmpClient({ fetchImpl, cacheFile, log });

  const snapshotOf = async (githubUrl, pinnedCommit = null) => {
    try {
      return await fetchGithubSnapshot({ githubUrl, commit: pinnedCommit }, { fetchImpl });
    } catch (error) {
      if (/缺少 SKILL\.md/.test(error.message)) {
        failure('来源格式不兼容：该 GitHub 目录没有 SKILL.md，不能作为 Skill 添加。可以下载到本地整理后再导入。');
      }
      throw error;
    }
  };

  return {
    searchState: () => mp.cachedSearch(),
    async search({ query, sortBy } = {}) {
      try {
        const entry = await mp.search({ query, sortBy });
        return { ok: true, ...entry, live: true };
      } catch (error) {
        log?.warn?.(`SkillsMP 搜索失败：${error.message}`);
        return { ok: false, reason: error.message, cached: mp.cachedSearch() };
      }
    },
    async preview({ id } = {}) {
      const skill = mp.cachedEntry(id);
      if (!skill) failure('该条目不在最近搜索结果里，请重新搜索后再添加');
      if (!skill.githubUrl) failure('该条目没有 GitHub 来源，无法添加到 Hemi');
      const snapshot = await snapshotOf(skill.githubUrl);
      return {
        ok: true,
        preview: {
          skillsmpId: skill.id,
          entryName: skill.name,
          author: skill.author,
          skillUrl: skill.skillUrl,
          githubUrl: skill.githubUrl,
          name: snapshot.metadata.name,
          title: snapshot.metadata.title,
          description: snapshot.metadata.description,
          repo: snapshot.repo,
          dirPath: snapshot.dirPath,
          commit: snapshot.commit,
          files: snapshot.files.map((file) => ({ path: file.path, size: file.bytes.length })),
          totalBytes: snapshot.totalBytes,
          bundleSha256: snapshot.bundleSha256,
          skillMd: snapshot.files.find((file) => file.path === 'SKILL.md').bytes.toString('utf8'),
        },
      };
    },
    async install({ skillsmpId, commit, bundleSha256, githubUrl, author, skillUrl } = {}) {
      if (!/^[a-z0-9][a-z0-9-]{0,191}$/.test(String(skillsmpId ?? ''))) failure('SkillsMP 条目 ID 无效');
      if (!/^[0-9a-f]{40}$/.test(String(commit ?? ''))) failure('固定提交号无效');
      if (!/^[a-f0-9]{64}$/.test(String(bundleSha256 ?? ''))) failure('预览摘要无效');
      const location = parseGithubTreeUrl(String(githubUrl ?? ''));
      if (!location) failure('来源地址无效');
      const snapshot = await snapshotOf(String(githubUrl), String(commit));
      return store.installFromSnapshot({
        skillsmpId: String(skillsmpId),
        author: String(author ?? '') || 'SkillsMP',
        githubUrl: String(githubUrl),
        skillsmpUrl: typeof skillUrl === 'string' && skillUrl.startsWith('https://') ? skillUrl : '',
        repo: `${location.owner}/${location.repo}`,
        dirPath: location.dirPath,
        commit: String(commit),
        files: snapshot.files,
        metadata: snapshot.metadata,
        expectedSha256: String(bundleSha256),
      });
    },
    async checkUpdate({ id } = {}) {
      const view = store.state().installed.find((item) => item.id === String(id ?? ''));
      if (!view) failure('Skill 不存在');
      if (view.origin !== 'skillsmp' || !view.github) failure('仅 SkillsMP 来源的技能支持在线检查更新');
      let skill;
      try {
        // creator 用仓库 owner 精确列作者的条目（REST 匿名搜索支持的作者过滤）。
        skill = await mp.detail(view.github.entryId, { creator: view.github.repo.split('/')[0] });
      } catch (error) {
        return { ok: true, status: 'unavailable', reason: `暂无法核对 SkillsMP 条目：${error.message}` };
      }
      const location = parseGithubTreeUrl(skill.githubUrl ?? '');
      if (!location) {
        return { ok: true, status: 'source-changed', skill, reason: '条目来源不再是可解析的 GitHub 目录' };
      }
      const repo = `${location.owner}/${location.repo}`;
      if (repo !== view.github.repo || location.dirPath !== view.github.path) {
        return {
          ok: true, status: 'source-changed', skill,
          reason: `来源已从 ${view.github.repo}/${view.github.path || '根目录'} 变为 ${repo}/${location.dirPath || '根目录'}；已安装版本仍可用`,
        };
      }
      const commit = await resolveCommit(location, { fetchImpl });
      if (commit === view.github.commit) return { ok: true, status: 'up-to-date', commit };
      return { ok: true, status: 'update-available', commit, githubUrl: skill.githubUrl };
    },
  };
}
