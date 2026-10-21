import { useEffect, useState } from 'react';

import type { BrowserActPreferences, BrowserBridgeStatus, BrowserControlPreferences } from '@/shared/types';

/**
 * 041 设置页·电脑与浏览器 →「浏览器控制」区块：总开关（默认关，R-07/D-7）、桥运行态、
 * 下载扩展（022 用户裁决：砍掉折叠引导与说明文，只留一个按钮）、快速决策（Jev）开关。
 * 状态与判定全在主进程与 Pi 扩展侧；这里只读配置、上抛保存/定位扩展目录。
 * 020 增补：browser_act（Jev 步进）——041（M-22）起地址/型号/Key/测试迁往
 * 模型与路由页的 BrowserDecisionSection，这里只留开关、摘要与「配置决策模型」跳转。
 */

const BRIDGE_HINT = '扩展可用时优先使用；未连接时自动使用独立浏览器。';

const BRIDGE_STATE_TEXT: Record<BrowserBridgeStatus['state'], string> = {
  off: '还没跑过浏览器任务，用时自动连接',
  connecting: '正在准备浏览器通道…',
  ready: '已连接 Chrome 扩展',
  error: '连接出了问题',
};

/** 037：状态 badge（短标签 + 色调）；完整说明仍在行描述里。 */
const BRIDGE_BADGE: Record<BrowserBridgeStatus['state'], { label: string; tone?: 'ok' | 'warn' | 'danger' }> = {
  off: { label: '待连接' },
  connecting: { label: '连接中' },
  ready: { label: '已连接', tone: 'ok' },
  error: { label: '出错', tone: 'danger' },
};

export function BrowserSection({ onConfigureDecision }: { onConfigureDecision?: () => void }) {
  const [prefs, setPrefs] = useState<BrowserControlPreferences | null>(null);
  const [bridge, setBridge] = useState<BrowserBridgeStatus | null>(null);
  const [exportedPath, setExportedPath] = useState<string | null>(null);
  const [act, setAct] = useState<BrowserActPreferences | null>(null);

  useEffect(() => {
    void window.hemiVoice?.getBrowserControl().then(setPrefs).catch(() => {});
    void window.hemiVoice?.getBrowserBridge().then(setBridge).catch(() => {});
    void window.hemiVoice?.getBrowserAct().then(setAct).catch(() => {});
    // 状态自动刷新：任务跑起来时，这里能看到「连接中 → 已连接」的变化，不用手动点。
    const timer = setInterval(() => {
      void window.hemiVoice?.getBrowserBridge().then(setBridge).catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, []);

  const toggleEnabled = (enabled: boolean) => {
    setPrefs((prev) => (prev ? { ...prev, enabled } : prev));
    void window.hemiVoice?.setBrowserControl({ enabled }).then(setPrefs).catch(() => {});
  };

  const toggleAct = (enabled: boolean) => {
    setAct((prev) => (prev ? { ...prev, enabled } : prev));
    void window.hemiVoice?.setBrowserAct({ enabled }).then(setAct).catch(() => {});
  };

  const exportExtension = async () => {
    try {
      const result = await window.hemiVoice?.exportBrowserExtension();
      if (result && 'path' in result && result.path) setExportedPath(result.path);
    } catch {
      /* 失败保持原状，用户可重试 */
    }
  };

  const enabled = prefs?.enabled ?? false;
  const bridgeState = bridge?.state ?? 'off';
  const headless = bridge?.backend === 'headless';
  const extensionConnected = bridge?.extensionConnected ?? (bridgeState === 'ready' && !headless);
  const badge = headless && bridgeState === 'ready' ? { label: '运行中', tone: 'ok' } : BRIDGE_BADGE[bridgeState];
  const actEnabled = act?.enabled ?? true;
  const decisionModel = act?.model?.trim() || 'typesafe-ai/jev';

  return (
    <section className="h37-section">
      <div className="h37-section-head">
        <h3>浏览器控制</h3>
      </div>
      <div className="h37-group">
        <div className="h37-row">
          <span className="h37-row-text">
            <b>启用浏览器控制</b>
            <span>{BRIDGE_HINT}</span>
          </span>
          <button
            type="button"
            role="switch"
            className="h37-switch"
            aria-checked={enabled}
            aria-label="启用浏览器控制"
            onClick={() => toggleEnabled(!enabled)}
          />
        </div>

        {enabled ? (
          <>
            <div className="h37-row h37-enter">
              <span className="h37-row-text">
                <b>浏览器通道</b>
                <span>
                  {headless ? '独立无头浏览器 · 独立登录状态' : BRIDGE_STATE_TEXT[bridgeState]}
                  {!headless && bridge?.detail ? `：${bridge.detail}` : ''}
                  {/* 021：显示已接入扩展的版本——改过扩展重新加载后，这里变了才算真的换新。
                      037 细节：版本号并进状态同一行。 */}
                  {!headless && bridge?.extensionConnected && bridge.extVersion ? ` · 扩展 v${bridge.extVersion}` : ''}
                </span>
                {!extensionConnected ? (
                  <span>下载并安装 Chrome 扩展，可复用你已有的登录状态。</span>
                ) : null}
                {bridge?.state === 'ready' && !headless && !bridge.extVersion ? (
                  <span className="h37-error-text">旧版扩展：请到 chrome://extensions 重新加载</span>
                ) : null}
              </span>
              <span className="h37-row-end">
                <span className="h37-badge" data-tone={badge.tone}>
                  {badge.label}
                </span>
                {/* 022 用户裁决：砍掉折叠引导和说明文，安装就一个按钮。 */}
                <button
                  type="button"
                  className="h37-btn h37-btn-secondary h37-btn-sm"
                  title="下载并安装 Chrome 扩展，可复用已有登录状态"
                  onClick={() => void exportExtension()}
                >
                  下载扩展
                </button>
              </span>
            </div>

            <div className="h37-row h37-enter">
              <span className="h37-row-text">
                <b>快速决策（Jev）</b>
                <span>
                  {act?.hasApiKey
                    ? `简单的页面操作一步完成，失败时自动回退逐步操作。页面文字会发给 ${act?.baseUrl || 'Jev 服务端'}。`
                    : '尚未配置决策模型，浏览器任务仍可用逐步操作。'}
                </span>
              </span>
              <button
                type="button"
                role="switch"
                className="h37-switch"
                aria-checked={actEnabled}
                aria-label="快速决策（Jev）"
                onClick={() => toggleAct(!actEnabled)}
              />
            </div>

            <div className="h37-row h37-enter">
              <span className="h37-row-text">
                <b>决策模型</b>
                <span>{act?.hasApiKey ? decisionModel : '未配置'}</span>
              </span>
              <span className="h37-row-end">
                {onConfigureDecision ? (
                  <button type="button" className="h37-link" onClick={onConfigureDecision}>
                    配置决策模型 →
                  </button>
                ) : null}
              </span>
            </div>
          </>
        ) : null}
      </div>
      {enabled && exportedPath ? (
        <p className="h37-section-foot h37-settings-foot-ok" title={exportedPath}>
          已下载。在 chrome://extensions 开启开发者模式，把这个文件夹拖进去或点「加载已解压」。
        </p>
      ) : null}
    </section>
  );
}
