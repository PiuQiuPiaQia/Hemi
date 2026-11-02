/** 1–65535 整数端口（字符串或数字都收）。 */
export declare function isValidPort(port: unknown): boolean;

/** ssh://user@host:2222 → user@host:2222；其他原样。显示用，不用于 argv/命令。 */
export declare function formatSshTarget(target: unknown): string;

/** resolveRemoteTarget 结果：成功带目标串与端口；失败带可展示原因。 */
export type RemoteTargetResult =
  | { ok: true; target: string; port: number | null }
  | { ok: false; reason: string };

/**
 * 服务器输入 + 可选端口 → SSH 目标串（带端口折成 ssh://user@host:port）。
 * host 可带嵌入式端口（user@host:2222、[::1]:2222、ssh://…:2222）；显式 port 优先。
 */
export declare function resolveRemoteTarget(input: { host: unknown; port?: unknown }): RemoteTargetResult;
