import { useEffect, useState } from 'react';

import { BrandIcon } from '@/components/brand-icon';

import type { UpdaterState } from '@shared/protocol';
import { openExternal } from '@/shared/open-external';
import { HEMI_RELEASES_PAGE_URL } from '@/shared/types';

/**
 * 044 设置页·关于与更新（通用页）。自包含：自己读状态、订阅广播、触发动作。
 * 状态机在主进程 updater 服务；这里只按 phase 出文案与主按钮：
 *   idle/not-available/error → 检查更新；available → 下载更新；
 *   downloading → 进度；downloaded → 重启并更新（退出时也会自动装上）。
 * 开发实例（supported=false）只展示版本与说明，不出按钮。
 */
export function AboutUpdateSection() {
  const [state, setState] = useState<UpdaterState | null>(null);

  useEffect(() => {
    void window.hemiVoice?.updaterGetState().then(setState).catch(() => {});
    const unsubscribe = window.hemiVoice?.onUpdaterChanged(setState);
    return () => unsubscribe?.();
  }, []);

  const phase = state?.phase ?? 'idle';
  const version = state?.currentVersion ?? '';
  const supported = state?.supported ?? true;

  const run = (action: () => Promise<unknown> | undefined) => {
    void Promise.resolve(action()).catch(() => {});
  };

  let statusText: string;
  let actionButton: React.ReactNode = null;
  if (!supported) {
    statusText = state?.unsupportedReason === 'dev'
      ? '这是开发实例，不支持自动更新；装上正式安装包后可以在这里检查。'
      : '当前平台不支持应用内更新，可以去发布页下载新版。';
  } else {
    switch (phase) {
      case 'checking':
        statusText = '正在检查有没有新版本…';
        actionButton = (
          <button type="button" className="h37-btn h37-btn-secondary" disabled>
            检查中…
          </button>
        );
        break;
      case 'available':
        statusText = `有新版本 v${state?.availableVersion ?? ''} 可以下载。`;
        actionButton = (
          <button
            type="button"
            className="h37-btn h37-btn-primary"
            onClick={() => run(() => window.hemiVoice?.updaterDownload())}
          >
            下载更新
          </button>
        );
        break;
      case 'downloading': {
        const percentText = state?.progressPercent != null ? `（${state.progressPercent}%）` : '';
        statusText = `正在下载新版本${percentText}。`;
        actionButton = (
          <button type="button" className="h37-btn h37-btn-secondary" disabled>
            下载中…
          </button>
        );
        break;
      }
      case 'downloaded':
        statusText = `v${state?.availableVersion ?? ''} 已下载好，退出时会自动装上；也可以现在重启换到新版。`;
        actionButton = (
          <button
            type="button"
            className="h37-btn h37-btn-primary"
            onClick={() => run(() => window.hemiVoice?.updaterInstall())}
          >
            重启并更新
          </button>
        );
        break;
      case 'not-available':
        statusText = '已经是最新版本。';
        actionButton = <CheckButton run={run} />;
        break;
      case 'error':
        statusText = state?.errorMessage
          ? `上次${state.errorMessage.includes('下载') ? '下载' : '检查'}没成功：${state.errorMessage}`
          : '上次没成功，可以再试一次。';
        actionButton = <CheckButton run={run} />;
        break;
      default:
        statusText = '尚未检查更新。';
        actionButton = <CheckButton run={run} />;
    }
  }

  return (
    <section className="h37-section" id="settings-about">
      <div className="h37-section-head">
        <h3>关于与更新</h3>
      </div>
      <div className="h37-group">
        <div className="h37-row">
          <BrandIcon width={32} height={32} />
          <span className="h37-row-text">
            {/* P2：行标题直接报版本（原「版本与更新」与分组标题重复、版本号挂在组头右侧） */}
            <b>{version ? `Hemi ${version}` : 'Hemi'}</b>
            <span>{statusText}</span>
          </span>
          {actionButton ? <span className="h37-row-end">{actionButton}</span> : null}
        </div>
        {phase === 'available' || phase === 'downloading' || phase === 'downloaded' ? (
          <div className="h37-row">
            <span className="h37-row-text">
              <b>这次更新改了什么</b>
            </span>
            <span className="h37-row-end">
              <button
                type="button"
                className="h37-link"
                onClick={() => void openExternal(HEMI_RELEASES_PAGE_URL)}
              >
                去发布页看 ↗
              </button>
            </span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function CheckButton({ run }: { run: (action: () => Promise<unknown> | undefined) => void }) {
  return (
    <button
      type="button"
      className="h37-btn h37-btn-secondary"
      onClick={() => run(() => window.hemiVoice?.updaterCheck())}
    >
      检查更新
    </button>
  );
}
