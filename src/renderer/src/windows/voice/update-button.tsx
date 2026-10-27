import { CircleAlert, Download, LoaderCircle, RotateCw } from 'lucide-react';
import { runUpdaterAction, useUpdater, type UpdaterAction } from './lib/use-updater';

/** Quiet until an update is available; downloading never implies permission to restart. */
export function UpdateButton() {
  const { state, operation, error } = useUpdater();
  if (!state?.supported) return null;
  const phase = state.phase;
  const failed = Boolean(error || phase === 'error');
  if (!operation && !error && !['available', 'downloading', 'downloaded'].includes(phase)
    && !(phase === 'error' && state.availableVersion)) return null;

  const downloading = operation === 'download' || phase === 'downloading';
  const restarting = operation === 'install';
  const checking = operation === 'check' || phase === 'checking';
  const busy = Boolean(operation) || phase === 'downloading' || phase === 'checking';
  const percent = state.progressPercent == null ? null : Math.max(0, Math.min(100, Math.round(state.progressPercent)));
  let label: string, description: string, action: UpdaterAction;
  if (restarting) {
    label = '正在重启应用更新'; description = '正在结束当前会话，随后重启并安装更新。'; action = 'install';
  } else if (downloading) {
    label = percent == null ? '正在下载更新' : `正在下载更新（${percent}%）`;
    description = '下载完成后，点击此处重启应用更新。'; action = 'download';
  } else if (checking) {
    label = '正在检查更新'; description = '正在读取新版本信息。'; action = 'check';
  } else if (failed) {
    label = '重新检查更新'; description = error || state.errorMessage || '更新未完成，请重试。'; action = 'check';
  } else if (phase === 'downloaded') {
    label = '待重启应用更新'; description = `v${state.availableVersion} 已下载，点击重启并使用新版本。`; action = 'install';
  } else {
    label = '下载更新'; description = `发现新版本 v${state.availableVersion}，点击下载。`; action = 'download';
  }

  return <div className="h24-update-slot">
    <button type="button" className="h24-navrail-item h24-update-button"
      data-phase={failed ? 'error' : phase} aria-label={label} title={`${label}\n${description}`}
      aria-disabled={busy || undefined} aria-busy={busy || undefined}
      onClick={() => { if (!busy) void runUpdaterAction(action); }}>
      {downloading && percent !== null && percent > 0 ? <span className="h24-update-progress" role="progressbar" aria-label="更新下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <svg viewBox="0 0 32 32" aria-hidden="true">
          <circle className="h24-update-track" cx="16" cy="16" r="12" />
          <circle className="h24-update-arc" cx="16" cy="16" r="12" pathLength="100" strokeDasharray={`${percent} 100`} transform="rotate(-90 16 16)" />
        </svg><span aria-hidden="true">{percent}</span>
      </span> : busy ? <span className="h24-update-spinner"><LoaderCircle className="size-4" aria-hidden="true" /></span>
        : failed ? <CircleAlert className="size-4" aria-hidden="true" />
          : phase === 'downloaded' ? <RotateCw className="size-4" aria-hidden="true" /> : <Download className="size-4" aria-hidden="true" />}
      {!busy && !failed ? <span className="h24-update-dot" aria-hidden="true" /> : null}
    </button>
    <span className="sr-only" role="status">{downloading ? '正在下载更新' : label}</span>
  </div>;
}
