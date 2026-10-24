import {useConversationBridge} from './lib/conversation-bridge';
import { useEffect, useState } from 'react';
export {PermissionCard} from '@hemi/conversation-flow/parts';

import type { TaskHistoryRecord, TaskStateSnapshot } from '@/shared/types';

/**
 * 004 任务面：确认卡（PermissionCard）＋任务档案段（过程抽屉用）。
 * 056（2026-10-15 用户裁决）：任务卡退役——对话流与悬浮窗里的任务一律是一行
 * （compact-delegation），本文件只留确认卡与档案读取。
 */

export function useTaskArchive(taskId: string | null, expanded: boolean) {
  const bridge = useConversationBridge();
  const [record, setRecord] = useState<TaskHistoryRecord | null>(null);

  useEffect(() => {
    if (!expanded || !taskId) return;
    let cancelled = false;
    bridge
      ?.getTaskHistoryRecord(taskId)
      .then((result) => {
        if (!cancelled) setRecord(result);
      })
      .catch(() => {}); // 档案可能被裁剪/损坏：静默留在快照内容
    return () => {
      cancelled = true;
    };
  }, [expanded, taskId]);

  return record;
}

/** 任务卡详情区底部的档案段：报告全文、继续执行、重新总结。 */
export function TaskArchiveSection({
  snap,
  record,
  onResumed,
}: {
  snap: TaskStateSnapshot;
  record: TaskHistoryRecord | null;
  onResumed: () => void;
}) {
  void onResumed;
  if (!snap.taskId) return null;
  const report = record?.report?.trim() ?? null;

  return (
    <div className="task-archive">
      {report ? (
        <details className="detail-record">
          <summary>执行报告</summary>
          <pre className="archive-report">{report}</pre>
        </details>
      ) : null}
    </div>
  );
}
