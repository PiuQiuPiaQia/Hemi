import type { TaskStateSnapshot } from './protocol';

export function taskCardTurnId(taskId: string): string;
export function taskResultTurnId(snap: Pick<TaskStateSnapshot, 'taskId' | 'key' | 'outcome'>): string;
export function terminalAnnouncementText(snap: Pick<TaskStateSnapshot, 'resultText' | 'outcome' | 'outcomeReason'> & Partial<Pick<TaskStateSnapshot, 'recentToolCalls'>>): string | null;
