/**
 * 059 Skill 节点执行器（S4，运行接线 §6「按执行类型分派」）：
 * Skill 引用／版本校验（纯函数）＋受控租约（skill-store snapshot 的引用计数）。
 *
 * 边界：Skill executor 与普通执行共用共享节点 worker（createNodeAgentExecutor），
 * 差异只有两处——节点会话挂选中的 Skill（快照随尝试释放）、引用失效时节点失败
 * dependency-unavailable（不静默降级为普通执行）。
 */

/**
 * 校验 Skill 引用可满足（纯函数，不触 IO）。
 * @param {object} params
 * @param {Array<{name: string, version?: string}>} params.refs 定义里的 skillRefs
 * @param {Array<{name: string, version?: string, path?: string}>} params.available 当前可用的 Skill（collectSkills/snapshot items）
 * @returns {{ ok: boolean, selected: Array, missing: Array<{name: string, reason: string}> }}
 */
export function resolveSkillRefs({ refs, available, diagnostics = [] }) {
  const byName = new Map((available ?? []).map((item) => [item.name, item]));
  const selected = [];
  const missing = [];
  for (const ref of refs ?? []) {
    if (!ref?.name) {
      missing.push({ name: String(ref?.name ?? ''), reason: '引用缺少 Skill 名' });
      continue;
    }
    const hit = byName.get(ref.name);
    if (!hit) {
      const invalid = diagnostics.find(item => item.name === ref.name);
      missing.push({ name: ref.name, reason: invalid ? `${invalid.message}；${invalid.path}` : '未安装或已禁用' });
      continue;
    }
    // 版本声明时比对；skill-store 本地导入 version='本地导入'（非 semver），只有声明
    // 了具体 semver 且两端都可解析时才比对，否则按名匹配（版本可核对性由 snapshot
    // 的 sha256 受控目录承担）。
    if (ref.version && hit.version && /^\d+\.\d+\.\d+$/.test(ref.version) && /^\d+\.\d+\.\d+$/.test(hit.version) && hit.version !== ref.version) {
      missing.push({ name: ref.name, reason: `版本不符：需要 ${ref.version}，安装的是 ${hit.version}` });
      continue;
    }
    selected.push(hit);
  }
  return { ok: missing.length === 0, selected, missing };
}

/**
 * 拿一个受控 Skill 租约（快照引用计数；executor 的 release 必须调用 lease.release）。
 * 失败抛带 code 的错误（dependency-unavailable），由 runner 记为节点失败。
 * @param {object} params
 * @param {Array<{name: string, version?: string}>} params.refs
 * @param {{ snapshot: (id: string|null) => { items: Array, release: Function } | null }} params.skillService
 */
export function acquireSkillLease({ refs, skillService }) {
  if (!refs || refs.length === 0) return { items: [], release: () => {} };
  if (!skillService?.snapshot) {
    const error = new Error('Skill 服务不可用');
    error.code = 'dependency-unavailable';
    throw error;
  }
  let lease = null;
  try {
    lease = skillService.snapshot(null); // 全启用集合＋引用计数；失效文件在此抛
  } catch (error) {
    const wrapped = new Error(`Skill 快照失效：${error instanceof Error ? error.message : String(error)}`);
    wrapped.code = 'dependency-unavailable';
    throw wrapped;
  }
  const verdict = resolveSkillRefs({ refs, available: lease.items ?? [], diagnostics: lease.diagnostics });
  if (!verdict.ok) {
    lease.release();
    const error = new Error(`Skill 依赖不可用：${verdict.missing.map((m) => `${m.name}（${m.reason}）`).join('；')}`);
    error.code = 'dependency-unavailable';
    throw error;
  }
  let released = false;
  return {
    items: verdict.selected,
    release: () => {
      if (released) return;
      released = true;
      lease.release();
    },
  };
}
