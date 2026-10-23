import type { MessageView, TaskView } from "../types/api.js";
import type {
  TaskStateSnapshot,
  TranscriptItem,
} from "../types/presentation.js";
export function taskSnapshot(task: TaskView): TaskStateSnapshot {
  return {
    seq: 0,
    key: null,
    taskId: null,
    readOnly: false,
    verifying: false,
    verified: false,
    permission: null,
    progressText: "",
    queueCount: 0,
    steeredCount: 0,
    log: [],
    resultText: null,
    outcomeReason: null,
    verification: null,
    artifacts: [],
    lastAction: null,
    ...task,
  };
}
export function transcript(message: MessageView): TranscriptItem {
  return {
    ...message,
    author: message.author === "assistant" ? "hemi" : "user",
    createdAt: message.createdAt ?? 0,
    taskSnap: message.task ? taskSnapshot(message.task) : undefined,
    flow: message.runId
      ? {
          runId: message.runId,
          itemId: message.itemId ?? message.id,
          inputId: message.inputId,
          partIds: message.partIds ?? [],
        }
      : undefined,
  };
}
