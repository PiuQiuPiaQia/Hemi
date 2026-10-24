import type { ResourceProgress } from './progress.js';
const size = (value: number) => value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(value / 1024)} KB`;
export function ResourceProgressView({ progress }: {
    progress: ResourceProgress;
}) {
    const { phase, received, total } = progress;
    const label = phase === 'queued' ? '等待中…' : phase === 'verifying' ? '校验中…' : phase === 'preparing' ? '准备中…' : phase === 'downloading' && total !== undefined ? `${size(received)} / ${size(total)} · ${Math.floor(received / Math.max(1, total) * 100)}%` : '加载中…';
    return <div className="resource-progress" role="status"><p>{label}</p>{phase === 'downloading' && total !== undefined ? <progress aria-label="文件下载进度" value={received} max={Math.max(1, total)}/> : null}</div>;
}
