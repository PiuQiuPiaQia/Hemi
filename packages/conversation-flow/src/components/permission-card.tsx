import { ShieldAlert } from "lucide-react";
import type {
  TaskStateSnapshot,
  TaskPermissionChoice,
} from "../types/presentation.js";
/** 042 卡面按钮的规范顺序：拒绝 → 本任务允许 → 持续允许（授权卡）；拒绝 → 允许这次（风险卡）。 */
const OPTION_ORDER = ["拒绝", "本任务允许", "允许这次", "持续允许"];

/** 按钮文案 → 决定。旧卡/旧 harness 的历史文案按语义映射，未知文案不擅自当拒绝以外的放行。 */
function choiceOf(option: string): TaskPermissionChoice {
  switch (option) {
    case "本任务允许":
    case "本会话允许":
      return "task";
    case "持续允许":
    case "永远允许":
      return "persistent";
    case "允许这次":
    case "仅此一次":
    case "允许一次":
      return "once";
    default:
      return "deny";
  }
}

export function PermissionCard({
  snap,
  onDecide,
  onStop,
  queuedTitles = [],
  disabled = false,
}: {
  snap: TaskStateSnapshot;
  onDecide: (choice: TaskPermissionChoice) => void;
  onStop: () => void;
  queuedTitles?: string[];
  disabled?: boolean;
}) {
  const permission = snap.permission;
  if (!permission) return null;
  const isGrant = permission.kind === "grant";
  // 042：选项由卡面携带（grant 三选一 / action 两钮），按规范顺序渲染；
  // 主按钮：授权卡＝持续允许，风险卡＝允许这次。
  const rawOptions = permission.options?.length
    ? permission.options
    : isGrant
      ? ["本任务允许", "持续允许", "拒绝"]
      : ["允许这次", "拒绝"];
  const rank = (option: string) => {
    const index = OPTION_ORDER.indexOf(option);
    return index < 0 ? OPTION_ORDER.length : index;
  };
  const cardOptions = [...rawOptions].sort((a, b) => rank(a) - rank(b));
  const primaryOption = cardOptions.includes("持续允许")
    ? "持续允许"
    : (cardOptions.find((o) => choiceOf(o) !== "deny") ?? cardOptions[0]);
  const cardFoot =
    isGrant || cardOptions.includes("本任务允许")
      ? "本任务允许：结束后收回。持续允许：下次可直接使用，随时可撤销。"
      : "这次的选择不会被记住；下次同样的操作，还会再问。";
  const seconds = Math.ceil(permission.remainingMs / 1000);
  const urgent = permission.remainingMs <= 3000;
  const args = permission.args ?? {};
  const command =
    typeof args.command === "string"
      ? args.command
      : typeof args.path === "string"
        ? args.path
        : "";
  // 005 精简（2026-09-19 用户反馈「卡片过大溢出」）：只留决策必需信息——
  // 摘要（钳两行）＋命令预览（单行省略）＋审查/危险理由＋折叠的完整命令＋按钮。
  // 042：grant/action 卡的 summary 是门控拼好的完整问句（「允许 Hemi 访问『微信』？」），
  // 原样作标题；只有旧卡（无 kind）沿用「允许…吗？」包装，且 bash 的旧摘要嵌整条
  // 命令（撑爆卡片的元凶），用固定短句＋预览替代。
  const title = permission.kind
    ? permission.summary
    : `允许${permission.tool === "bash" ? "执行这条命令" : permission.summary}吗？`;

  return (
    <section
      role="alertdialog"
      aria-modal="false"
      aria-label="操作授权请求"
      className={`permission-card permission-anchor${urgent ? " urgent" : ""}`}
    >
      <div className="permission-header">
        <span>
          <ShieldAlert />
          Hemi 需要你的允许
        </span>
        <span className="count-label">
          <span data-count>{seconds}</span> 秒
        </span>
        <button
          type="button"
          className="text-btn"
          onClick={onStop}
          disabled={disabled}
        >
          停止任务
        </button>
      </div>
      <div className="countdown-track">
        <div
          className="countdown-fill"
          style={{
            width: `${Math.max(0, Math.min(100, permission.remainingMs / 300))}%`,
          }}
        />
      </div>
      <div className="permission-body">
        {snap.taskText ? (
          <span className="perm-task" title={`属于任务：${snap.taskText}`}>
            属于任务 · {snap.taskText.slice(0, 12)}
          </span>
        ) : null}
        <h3>{title}</h3>
        {command ? <pre className="permission-command">{command}</pre> : null}
        {permission.note ? (
          <p className="permission-note">{permission.note}</p>
        ) : null}
        {command ? (
          <details>
            <summary>查看完整命令与路径</summary>
            <pre>{command}</pre>
          </details>
        ) : null}
      </div>
      <div className="permission-actions">
        {cardOptions.map((option) => (
          <button
            key={option}
            type="button"
            className={`tbtn${option === primaryOption ? " primary" : ""}`}
            disabled={disabled || permission.remainingMs <= 0}
            onClick={() => onDecide(choiceOf(option))}
          >
            {option}
          </button>
        ))}
      </div>
      <p className="permission-foot">{cardFoot}</p>
      {queuedTitles.length ? (
        <div className="perm-queued" role="status">
          处理完这张，还有 {queuedTitles.length} 项在等 · {queuedTitles[0]}
        </div>
      ) : null}
    </section>
  );
}
