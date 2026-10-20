import { useEffect, useState } from "react";
type Entry = {
  invocationId: string;
  conversationId: string;
  definitionRevision: number;
  createdAt: number;
  run?: {
    status: string;
    startedAt: number;
    finishedAt?: number;
    modelPlan?: { config: { model: string } };
  };
};
const status: Record<string, string> = {
  queued: "排队中",
  running: "执行中",
  waiting: "等待操作",
  completed: "已完成",
  failed: "失败",
  stopped: "已停止",
  interrupted: "执行中断",
};
export function WorkflowHistory({
  workflowId,
  onOpenConversation,
  onOpenResult,
}: {
  workflowId: string;
  onOpenConversation?: (id: string) => void;
  onOpenResult?: (entry: {
    invocationId: string;
    conversationId: string;
  }) => void;
}) {
  const [entries, setEntries] = useState<Entry[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    let alive = true,
      timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const rows = await window.hemiVoice.workflowListInvocations(workflowId);
        if (alive) setEntries(rows as Entry[]);
      } catch (e) {
        if (alive) setError(String(e));
      }
      if (alive) timer = setTimeout(() => void load(), 1500);
    };
    void load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [workflowId]);
  return (
    <section aria-label="运行记录">
      <h2>运行记录</h2>
      {error ? <p role="alert">{error}</p> : null}
      {!entries.some((e) => e.run) ? <p>还没有运行记录。</p> : null}
      {entries
        .filter((e) => e.run)
        .map((entry) => (
          <article className="h59-row" key={entry.invocationId}>
            <header>
              <strong>
                v{entry.definitionRevision} ·{" "}
                {status[entry.run!.status] ?? entry.run!.status}
              </strong>
              <time>
                {new Date(
                  entry.run!.startedAt ?? entry.createdAt,
                ).toLocaleString()}
              </time>
            </header>
            <p>
              {entry.run!.modelPlan?.config.model}
              {entry.run!.finishedAt
                ? ` · ${Math.max(0, Math.round((entry.run!.finishedAt - entry.run!.startedAt) / 1000))} 秒`
                : ""}
            </p>
            <footer>
              {onOpenResult ? (
                <button onClick={() => onOpenResult(entry)}>运行结果</button>
              ) : null}
              <button
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent("hemi:workflow-preview", {
                      detail: { invocationId: entry.invocationId },
                    }),
                  )
                }
              >
                查看过程
              </button>
              <button
                onClick={() => onOpenConversation?.(entry.conversationId)}
              >
                关联对话
              </button>
            </footer>
          </article>
        ))}
    </section>
  );
}
