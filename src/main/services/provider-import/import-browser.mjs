// 047 导入浏览器宿主：隔离 session 的 WebContentsView。
//
// 每站点独立的持久 session＋只含登录补全的专用 preload（不暴露 Hemi API）、
// sandbox/contextIsolation 开、nodeIntegration 关——网站拿不到任何 Hemi 桥。
// 站内导航经 native-shell 策略注册表放行（同 origin），站外/协议跳转照旧拦；
// popup 一律 deny（首版 OAuth 弹窗不支持时如实暴露，转手动配置）。
// 生命周期：成功/明确撤销后回收 View/连接/监听，保留站点登录状态。
import { fileURLToPath } from 'node:url';
import { setNavigationPolicy, clearNavigationPolicy } from '../../windows/native-shell.mjs';
import { loginSiteKey } from './login-store.mjs';
import { createLoginMemory } from './login-memory.mjs';

/**
 * @param {{ WebContentsView: any, sessionFromPartition: any, mainWindow: any, siteOrigin: string, operationId: string, allowInsecure?: boolean, loginStore?: any, onLoginMemoryError?: Function }} deps
 */
export function createImportBrowser({ WebContentsView, sessionFromPartition, mainWindow, siteOrigin, operationId, allowInsecure = false, loginStore, onLoginMemoryError }) {
  const partition = `persist:hemi-newapi-${loginSiteKey(siteOrigin)}`;
  const ses = sessionFromPartition(partition);
  // 网站一律拿不到系统权限（通知/剪贴板/媒体/USB……）；不绕证书校验。
  try {
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  } catch {
    /* 部分测试 session 无此方法 */
  }

  const view = new WebContentsView({
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      preload: fileURLToPath(new URL('../../../preload/provider-login.cjs', import.meta.url)),
    },
  });
  const contents = view.webContents;
  const loginMemory = loginStore ? createLoginMemory({ contents, session: ses, siteOrigin, store: loginStore, onError: onLoginMemoryError }) : null;
  let restored = null;
  contents.setUserAgent(
    `${contents.getUserAgent()} HemiImport/1`,
  );

  // 站内导航放行（同 origin＋同协议）；其余沿全局守卫拦下交系统浏览器。
  const allowedOrigin = siteOrigin;
  setNavigationPolicy(contents.id, (url) => {
    try {
      const target = new URL(url);
      const sameOrigin = target.origin === allowedOrigin;
      const schemeOk = target.protocol === 'https:' || (allowInsecure && target.protocol === 'http:');
      return sameOrigin && schemeOk;
    } catch {
      return false;
    }
  });

  contents.setWindowOpenHandler(() => ({ action: 'deny' }));

  let disposed = false;
  let lastVisible = false;

  return {
    view,
    contents,
    session: ses,
    partition,
    async loadInitial(targetUrl) {
      restored ??= loginMemory?.restore() ?? Promise.resolve();
      await restored;
      if (disposed) throw new Error('导入浏览器已关闭');
      await contents.loadURL(targetUrl);
    },
    async confirmLogin(identity) { await loginMemory?.confirmLogin(identity); },
    async flushLoginMemory() { await loginMemory?.flush(); },
    setViewport({ bounds, visible }) {
      if (disposed || view.isDestroyed?.()) return;
      const safe = clampBounds(bounds);
      view.setBounds(safe);
      lastVisible = visible !== false && (safe.width > 0 && safe.height > 0);
      view.setVisible(lastVisible);
    },
    /** 最近一次 setViewport 的可见结果（验证 harness 用——View 原生无可见性查询）。 */
    isVisible() {
      return lastVisible;
    },
    isDisposed() {
      return disposed;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      clearNavigationPolicy(contents.id);
      try { await loginMemory?.dispose(); }
      catch { onLoginMemoryError?.('登录状态未能保存，浏览器已关闭'); }
      try {
        mainWindow?.contentView?.removeChildView?.(view);
      } catch { /* 窗口可能已销毁 */ }
      try {
        if (!contents.isDestroyed()) contents.close();
      } catch { /* ignore */ }
      ses.flushStorageData?.();
      await ses.cookies?.flushStore?.();
      await ses.closeAllConnections?.();
    },
  };
}

function clampBounds(raw) {
  const num = (value, fallback = 0) => (Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback);
  const x = num(raw?.x);
  const y = num(raw?.y);
  const width = Math.min(num(raw?.width), 10000);
  const height = Math.min(num(raw?.height), 10000);
  return { x, y, width, height };
}
