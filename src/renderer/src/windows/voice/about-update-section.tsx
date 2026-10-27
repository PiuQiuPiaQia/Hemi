import type { ReactNode } from 'react';

import { BrandIcon } from '@/components/brand-icon';

import { runUpdaterAction, useUpdater, type UpdaterAction } from './lib/use-updater';
import { openExternal } from '@/shared/open-external';
import { HEMI_RELEASES_PAGE_URL } from '@/shared/types';

/**
 * 设置页与侧栏共用更新快照和操作锁；后台服务负责下载和安装。
 * 状态机在主进程 updater 服务；这里只按 phase 出文案与主按钮：
 *   idle/not-available/error → 检查更新；available → 下载更新；
 *   downloading → 进度；downloaded → 重启并更新（退出时也会自动装上）。
 * 开发实例（supported=false）只展示版本与说明，不出按钮。
 */
export function AboutUpdateSection() {
  const { state, operation, error } = useUpdater();

  const phase = state?.phase ?? 'idle';
  const version = state?.currentVersion ?? '';
  const supported = state?.supported ?? true;

  const run = (action: UpdaterAction) => { void runUpdaterAction(action); };

  let statusText: string;
  let actionButton: ReactNode = null;
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
            disabled={Boolean(operation)}
            onClick={() => run('download')}
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
        statusText = `v${state?.availableVersion ?? ''} 已下载好，重启即可安装更新。`;
        actionButton = (
          <button
            type="button"
            className="h37-btn h37-btn-primary"
            disabled={Boolean(operation)}
            onClick={() => run('install')}
          >
            {operation === 'install' ? '正在重启…' : '重启并更新'}
          </button>
        );
        break;
      case 'not-available':
        statusText = '已经是最新版本。';
        actionButton = <CheckButton run={run} />;
        break;
      case 'error':
        statusText = state?.errorMessage || '更新失败，请稍后重试。';
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
            <span role={error ? 'alert' : undefined}>{error || statusText}</span>
          </span>
          {actionButton ? <span className="h37-row-end">{actionButton}</span> : null}
        </div>
        {phase === 'available' || phase === 'downloading' || phase === 'downloaded' || phase === 'error' ? (
          <div className="h37-row">
            <span className="h37-row-text">
              <b>{phase === 'error' ? '手动下载更新' : '这次更新改了什么'}</b>
            </span>
            <span className="h37-row-end">
              <button
                type="button"
                className="h37-link"
                onClick={() => void openExternal(HEMI_RELEASES_PAGE_URL)}
              >
                {phase === 'error' ? '去发布页下载 ↗' : '去发布页看 ↗'}
              </button>
            </span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function CheckButton({ run }: { run: (action: UpdaterAction) => void }) {
  const { operation } = useUpdater();
  return (
    <button
      type="button"
      className="h37-btn h37-btn-secondary"
      disabled={Boolean(operation)}
      onClick={() => run('check')}
    >
      检查更新
    </button>
  );
}
