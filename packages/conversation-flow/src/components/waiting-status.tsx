import { useFlowClock } from "../host/context.js";
import { useState } from "react";
import { waitingStatusText } from "../presentation/thinking-format.js";

/**
 * 请求已发出、尚无任何思考/正文事件时的占位（048 续：原「正在想」标签＋正文
 * 「正在想…」点阵重复两遍且无计时，久等分不清卡死还是在等）。与思考折叠头
 * 同位同形（13 号 muted 中字重、24 高、明暗流动），收到 thinking_start 即原地
 * 换成「思考中 · Ns」不跳版。计时自挂载起（挂载即本轮发出）。
 */
export function WaitingStatus({ startedAt }: { startedAt?: number }) {
  const [origin] = useState(() => startedAt ?? Date.now());
  const now = useFlowClock();
  return (
    <span className="h24-waiting-status" role="status">
      {waitingStatusText(now - origin)}
    </span>
  );
}
