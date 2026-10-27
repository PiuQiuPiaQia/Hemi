import { useEffect, useRef, useState } from 'react';
import { ArrowDown, CheckCheck, ChevronRight, CircleAlert, MessageSquarePlus, Square } from 'lucide-react';

import { Markdown } from '@/shared/markdown';
import type { TaskActionName, TaskStateSnapshot } from '@/shared/types';
import { TaskArchiveSection, useTaskArchive } from '@/windows/voice/task-panel';
import { TaskConversationFlow } from './task-conversation-flow';

/**
 * 025 → 056：任务/子 agent 的执行过程（2026-10-15 用户裁决改版）。
 * 原独立抽屉（占第三栏、自带头与关闭）改为预览 Tab 队列里的一页正文
 * （{kind:'process'}），对话流的角色行点击打开；Tab 行、收起与 Esc 由预览
 * 面板（file-preview）承担，这里只渲染过程本身。
 *
 * 新子任务在右侧复用 ConversationFlow，按 SDK 顺序展示独立会话的思考、正文、
 * 工具和结果；主对话只保留派单入口。旧档缺少 conversation 时保留日志时间线。
 * 旧过程可见性（056 用户反馈「看不到执行了什么」）：步骤标题就是动作本体
 * （「读取 src/foo.mjs」而非「已完成」），单步耗时与时刻并排；运行中的一步
 * 用快照 progressText 单列；终态后在时间线下方交代报告全文（子 agent 报告
 * 即回传主 agent 的那份，12k 封顶）与核验结论。运行中持续接收进度并自动
 * 跟随最新一步；用户上翻后停止跟随、出「回到最新」。011 档案与续跑收在底部。
 */

import { formatDuration, processStepsOf, taskElapsedMs } from './lib/task-process-state';
export { formatDuration, processStepsOf, taskElapsedMs } from './lib/task-process-state';
export type { ProcessStep } from './lib/task-process-state';

function clock(at: number) {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function stateLabelOf(snap: TaskStateSnapshot): string {
  if (snap.phase === 'waiting') return snap.permission ? '等待授权' : snap.progressText || '等待执行';
  if (snap.phase === 'stopping') return '停止中';
  if (snap.phase !== 'terminal') return snap.progressText || '进行中';
  switch (snap.outcome) {
    case 'complete':
      return '已完成';
    case 'stopped':
      return '已停止';
    case 'denied':
      return '未获授权';
    case 'blocked':
      return '已阻止';
    case 'startfailed':
      return '未能启动';
    case 'partial':
      return '部分完成';
    case 'unknown':
      return '结果待核实';
    case 'reportfailed':
      return '总结失败';
    default:
      return '已结束';
  }
}

export function TaskProcessBody({
  snap,
  onAction,
  onContinueDiscuss,
  onArchiveResumed = () => {},
}: {
  snap: TaskStateSnapshot;
  onAction?: (action: TaskActionName, payload?: { taskId?: string; taskKey?: string }) => void;
  onContinueDiscuss?: (snap: TaskStateSnapshot) => void;
  /** 011 档案续跑成功后收起这页（关闭所属 Tab 由宿主接手）。 */
  onArchiveResumed?: () => void;
}) {
  const steps = processStepsOf(snap);
  const inFlight = snap.phase !== 'terminal';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!inFlight) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [inFlight]);
  const elapsed = taskElapsedMs(snap, now);

  const [openKey, setOpenKey] = useState<string | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const archive = useTaskArchive(archiveOpen ? snap.taskId : null, archiveOpen);

  // 自动跟随：运行中且停在底部时，新步骤到达滚到底；上翻即停止跟随。
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [follow, setFollow] = useState(true);
  const lastStepKey = steps[steps.length - 1]?.key;
  useEffect(() => {
    if (!inFlight || !follow) return;
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [inFlight, follow, lastStepKey]);

  const role = [snap.agentTitle, snap.agent].filter(Boolean).join(' ');
  const sourceCount = snap.delivery?.sources.length ?? snap.sources?.length ?? 0;
  const approvals = snap.approvals?.count ?? 0;
  const stoppable = snap.phase === 'preparing' || snap.phase === 'running' || snap.phase === 'waiting';
  const reportText = snap.phase === 'terminal' ? snap.resultText?.trim() ?? '' : '';

  return (
    <div className="h25-process" aria-label="执行过程">
      <header className="h25-process-head">
        <div className="h25-process-heading">
          <p>
            {role || '任务'} · {stateLabelOf(snap)}
            {elapsed != null ? ` · ${formatDuration(elapsed)}` : ''}
          </p>
          <h2 title={snap.taskText}>{snap.taskText || '（没有任务描述）'}</h2>
        </div>
      </header>

      {!snap.conversation ? <dl className="h25-process-stats">
        <div>
          <dt>步骤</dt>
          <dd>{steps.length}</dd>
        </div>
        <div>
          <dt>来源</dt>
          <dd>{sourceCount}</dd>
        </div>
        <div>
          <dt>授权</dt>
          <dd>{approvals}</dd>
        </div>
      </dl> : null}

      {snap.conversation ? <TaskConversationFlow key={snap.taskId ?? snap.key} snap={snap} /> : <div
        className="h25-process-body"
        ref={bodyRef}
        tabIndex={0}
        onScroll={(event) => {
          if (!inFlight) return;
          const body = event.currentTarget;
          const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 8;
          if (atBottom !== follow) setFollow(atBottom);
        }}
      >
        {steps.length ? (
          <ol className="h25-timeline">
            {steps.map((step) => {
              const expandable = Boolean(step.detail) && !step.attention;
              const open = openKey === step.key;
              const state = step.running ? 'running' : step.attention ? 'attention' : 'done';
              return (
                <li key={step.key} data-state={state}>
                  <span className="h25-timeline-node" aria-hidden="true">
                    {step.running ? (
                      <i className="h37-spinner" />
                    ) : step.attention ? (
                      <CircleAlert />
                    ) : (
                      <CheckCheck />
                    )}
                  </span>
                  <button
                    type="button"
                    className="h25-timeline-step"
                    aria-expanded={expandable ? open : undefined}
                    disabled={!expandable}
                    onClick={() => {
                      setOpenKey(open ? null : step.key);
                      if (inFlight) setFollow(false);
                    }}
                  >
                    <strong>
                      {step.title}
                      {expandable ? <ChevronRight className="h25-timeline-caret" aria-hidden="true" /> : null}
                    </strong>
                    <time>
                      {step.running
                        ? '进行中'
                        : step.duration
                          ? `${clock(step.at)} · ${step.duration}`
                          : clock(step.at)}
                    </time>
                  </button>
                  {step.attention && step.detail ? <p className="h25-timeline-note">{step.detail}</p> : null}
                  {expandable && open ? <code className="h25-timeline-detail">{step.detail}</code> : null}
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="h25-process-empty">这条任务没有留下执行记录。</p>
        )}
        {reportText ? (
          <section className="h25-process-report" aria-label="报告">
            <h3>报告</h3>
            <div className="md selectable">
              <Markdown text={reportText} />
            </div>
          </section>
        ) : null}
        {snap.verification?.verdict === 'complete' || snap.verification?.verdict === 'partial' ? (
          <p className="h25-process-verify">
            {snap.verification.verdict === 'complete' ? '核验：完成' : '核验：部分完成'}
          </p>
        ) : null}
        {archiveOpen ? <TaskArchiveSection snap={snap} record={archive} onResumed={onArchiveResumed} /> : null}
        {inFlight && !follow ? (
          <div className="h25-process-follow">
            <button type="button" onClick={() => setFollow(true)}>
              <ArrowDown aria-hidden="true" />
              回到最新
            </button>
          </div>
        ) : null}
      </div>}
      {snap.conversation && archiveOpen ? (
        <div className="h25-process-body">
          <TaskArchiveSection snap={snap} record={archive} onResumed={onArchiveResumed} />
        </div>
      ) : null}

      <footer className="h25-process-foot">
        {snap.taskId && !archiveOpen && !inFlight ? (
          <button type="button" className="h37-btn h37-btn-ghost h37-btn-sm" onClick={() => setArchiveOpen(true)}>
            档案与续跑
          </button>
        ) : null}
        <span className="h25-process-foot-note">{snap.conversation ? '子任务独立对话' : '时间为本机时间'}</span>
        {!inFlight && onContinueDiscuss && snap.taskId ? (
          <button type="button" className="h37-btn h37-btn-ghost h37-btn-sm" onClick={() => onContinueDiscuss(snap)}>
            <MessageSquarePlus aria-hidden="true" />
            继续讨论
          </button>
        ) : null}
        {stoppable && onAction ? (
          <button
            type="button"
            className="h37-btn h37-btn-danger h37-btn-sm"
            onClick={() => onAction('stop', { taskId: snap.taskId ?? snap.key ?? undefined })}
          >
            <Square aria-hidden="true" />
            停止
          </button>
        ) : null}
      </footer>
    </div>
  );
}
