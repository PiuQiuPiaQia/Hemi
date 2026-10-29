/**
 * 043 B2a · 应用目录包装层：把平台应用清单包成宿主签发的目录条目（DTO）。
 *
 * 协议（renderer-platform-integration §授权 DTO）：
 * - rowId 只负责列表选择（React key/键盘移动/aria）；
 * - appRef 是主进程签发的可过期宿主引用，提交时经 resolveAppRef 复核目录
 *   代次与真实 OS 身份；渲染层不能自造 ref；
 * - 名称/位置仅用于展示，不是身份；catalogRevision 每次重新列举即推进，
 *   旧 ref 提交回 APP_REF_STALE，让弹窗刷新目录重新选择；
 * - darwin 分支：appRef 内编码 bundleId，复核时重新走已安装清单（应用被
 *   删除/改名即 APP_IDENTITY_CHANGED）。Windows 真实身份（exe/包）等
 *   WP-02/05 探针，B3 落地；本模块不预设 win32 实现。
 */

const APP_REF_PREFIX = 'hemi-appref-1:';

/** darwin：bundleId ↔ 不透明 appRef（base64url，避免分隔符歧义）。 */
export function encodeBundleAppRef(bundleId) {
  return `${APP_REF_PREFIX}${Buffer.from(`bundle:${bundleId}`, 'utf8').toString('base64url')}`;
}

export function decodeBundleAppRef(appRef) {
  if (typeof appRef !== 'string' || !appRef.startsWith(APP_REF_PREFIX)) return null;
  try {
    const decoded = Buffer.from(appRef.slice(APP_REF_PREFIX.length), 'base64url').toString('utf8');
    if (!decoded.startsWith('bundle:')) return null;
    return decoded.slice('bundle:'.length);
  } catch {
    return null;
  }
}

/**
 * 创建目录包装器。
 * @param {object} options
 * @param {() => Promise<Array<{bundleId: string; name: string; path?: string}>>} options.listInstalled
 *   平台清单来源（darwin 传 installed-apps 的 listInstalledApplications）
 * @param {() => string} [options.locale] 排序用 locale
 */
export function createAppCatalog({ listInstalled, locale = () => 'en', platform = 'darwin' } = {}) {
  if (typeof listInstalled !== 'function') throw new Error('createAppCatalog 需要 listInstalled');

  let catalogRevision = 0;

  /** 列举即推进代次：旧弹窗持有的 ref 随之过期（提交回 APP_REF_STALE）。 */
  async function refreshCatalog() {
    const installed = await listInstalled();
    catalogRevision += 1;
    return installed;
  }

  /**
   * 列举目录条目（ApplicationChoice DTO）。每次调用推进 catalogRevision——
   * 旧弹窗里持有的 ref 随之过期，提交即 APP_REF_STALE。
   * runningNames：bundleId → 运行态（调用方从驱动聚合后传入）。
   */
  async function listApplications({ runningNames = new Map() } = {}) {
    const installed = await refreshCatalog();
    const collator = new Intl.Collator(locale(), { sensitivity: 'base' });
    return installed
      .map((app, index) => ({
        rowId: `app-${catalogRevision}-${index}`,
        name: app.name || app.bundleId,
        platform,
        ref: { appRef: encodeBundleAppRef(app.bundleId), catalogRevision },
        running: runningNames.has(app.bundleId),
        icon: null,
        source: {
          kind: platform === 'win32' ? (app.appId ? 'package' : 'executable') : 'bundle',
          locationLabel: app.path ?? app.bundleId,
        },
      }))
      .sort((x, y) => Number(y.running) - Number(x.running) || collator.compare(x.name, y.name));
  }

  /**
   * 提交复核：ref 可解码、代次当前、bundleId 在新鲜清单里，才放行给权限
   * 服务（合同口径「每个动作重新核实身份」；listInstalled 自带缓存，重复
   * 调用不贵）。返回 { ok, bundleId } 或 { ok: false, errorCode }。
   */
  async function resolveAppRef(appRef, catalogRevisionInput) {
    const bundleId = decodeBundleAppRef(appRef);
    if (!bundleId) return { ok: false, errorCode: 'APP_REF_STALE' };
    // 渲染层经 IPC 只能送原生 number：字符串/小数/缺省都按过期引用拒绝。
    if (typeof catalogRevisionInput !== 'number' || !Number.isInteger(catalogRevisionInput)) {
      return { ok: false, errorCode: 'APP_REF_STALE' };
    }
    if (catalogRevisionInput !== catalogRevision) return { ok: false, errorCode: 'APP_REF_STALE' };
    const installed = await refreshCatalog();
    if (!installed.some((app) => app.bundleId === bundleId)) {
      return { ok: false, errorCode: 'APP_IDENTITY_CHANGED' };
    }
    return { ok: true, bundleId };
  }

  return { listApplications, resolveAppRef, get catalogRevision() { return catalogRevision; } };
}
