export function replyCreatedAt(endedAt: number, taskSubmittedAt: number | null): number;
export function insertByCreatedAt<T extends { createdAt: number }>(list: T[], item: T): T[];
