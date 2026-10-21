import { useEffect, useState } from 'react';
import { ChevronRight, Clock3, Square, Terminal } from 'lucide-react';
import type { RunActivityView } from '@shared/protocol';

const elapsed = (since: number, now: number) => {
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
};

export function RunActivity({ activity, onStop }: { activity?: RunActivityView | null; onStop?: () => void }) {
  const [now, setNow] = useState(Date.now);
  const visible = Boolean(activity && (activity.jobs.length || activity.resources.length));
  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [visible]);
  if (!activity || !visible) return null;
  const waiting = activity.phase !== 'running';
  const resource = activity.resources[0];
  const interactive = resource?.resource.scope === 'desktop' || resource?.resource.scope.startsWith('browser:');
  const blocker = resource?.blockers[0];
  const title = activity.phase === 'waiting-background' ? '等待后台任务完成'
    : activity.phase === 'waiting-resource' ? interactive ? '等待桌面或浏览器' : '等待工作区资源'
    : `${activity.jobs.length} 个任务在后台运行`;
  return <section className="h56-run-activity" data-phase={activity.phase} aria-label="当前任务状态">
    <div className="h56-run-activity-head">
      {waiting ? <Clock3 aria-hidden="true" /> : <Terminal aria-hidden="true" />}
      <span role="status">{title}</span>
      {activity.since ? <span className="h56-run-activity-time">已等待 {elapsed(activity.since, now)}</span> : null}
      {onStop ? <button type="button" onClick={onStop} aria-label="停止当前任务及后台命令"><Square aria-hidden="true" />停止任务</button> : null}
    </div>
    <p>{activity.phase === 'waiting-resource'
      ? interactive ? '另一个任务正在使用桌面或浏览器，交接后自动继续。'
        : `另一个操作正在占用此工作区${blocker?.description ? `：${blocker.description}` : ''}。释放后自动继续。`
      : waiting ? '完成后会自动继续当前任务，无需重复发送。' : '正在处理其他步骤，后台完成后会自动接着处理结果。'}</p>
    {activity.jobs.map(job => <details className="h56-background-job" key={job.id}>
      <summary aria-label={`查看后台命令输出：${job.command.split('\n')[0]}`}><ChevronRight aria-hidden="true" /><span title={job.command}>{job.command.split('\n')[0]}</span><span>{elapsed(job.startedAt, now)}</span></summary>
      <pre className="selectable" aria-label="后台命令最近输出">{job.output || '命令正在运行，尚无输出。'}</pre>
    </details>)}
  </section>;
}
