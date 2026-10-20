/**
 * 063 · 输入框的标签感知撤销栈（textarea 受控值的自定义 undo/redo）。
 *
 * 受控 textarea 的原生 undo 本就随程序化赋值断裂；标签要求「撤销同时恢复
 * 展示与身份」，这里用全量快照栈统一实现：每次正文变化前压栈（连续击键在
 * coalesceMs 内合批），Cmd+Z／Cmd+Shift+Z 弹栈恢复。无标签草稿同样受益。
 */
import type { MessageReferenceView, SkillSelectionView } from '@/shared/types';

export type TagUndoState = {
  text: string;
  skills: SkillSelectionView[];
  references: MessageReferenceView[];
  caret: number;
};

export function createTagUndoStack({ limit = 120, coalesceMs = 700, now = () => Date.now() } = {}) {
  /** undo 栈（旧→新）；redo 在新快照压入时清空。 */
  const undoStack: TagUndoState[] = [];
  let redoStack: TagUndoState[] = [];
  let lastPushAt = 0;

  return {
    /** 状态即将变化时压当前快照；同类连续编辑（击键连打）按时间合批。 */
    push(state: TagUndoState, { coalesce = true } = {}) {
      const at = now();
      const previous = undoStack[undoStack.length - 1];
      if (
        coalesce && previous && at - lastPushAt <= coalesceMs
        && previous.skills.length === state.skills.length
        && previous.references.length === state.references.length
      ) {
        lastPushAt = at;
        return;
      }
      undoStack.push({ ...state, skills: [...state.skills], references: [...state.references] });
      if (undoStack.length > limit) undoStack.shift();
      redoStack = [];
      lastPushAt = at;
    },
    /** 程序化变化（插标签/删标签/选候选）不合批、必压栈。 */
    pushCheckpoint(state: TagUndoState) {
      this.push(state, { coalesce: false });
    },
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    /** 撤销：当前态进 redo，弹一条 undo；没有可撤销时返回 null。 */
    undo(current: TagUndoState): TagUndoState | null {
      const state = undoStack.pop();
      if (!state) return null;
      redoStack.push({ ...current, skills: [...current.skills], references: [...current.references] });
      lastPushAt = 0;
      return state;
    },
    redo(current: TagUndoState): TagUndoState | null {
      const state = redoStack.pop();
      if (!state) return null;
      undoStack.push({ ...current, skills: [...current.skills], references: [...current.references] });
      lastPushAt = 0;
      return state;
    },
    /** 换会话/清空草稿：整栈作废。 */
    reset() {
      undoStack.length = 0;
      redoStack = [];
      lastPushAt = 0;
    },
  };
}
