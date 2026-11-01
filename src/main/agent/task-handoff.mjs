import { TASK_HANDOFF_TOOL, TASK_SUBMISSION_SCHEMA, parseTaskSubmission } from '../../shared/task-handoff.mjs';

/** Session-local channel. Every new task gets fresh state, including resumed sessions. */
export function createTaskHandoffChannel({ getExecution = () => null, stopped = () => false } = {}) {
  let identity, submitted = null, repair = false;
  const ownerKey = () => JSON.stringify(getExecution()?.owner ?? null);
  const valid = () => identity !== undefined && identity === ownerKey() && !stopped() && !getExecution()?.cancelled?.();
  return {
    begin() { identity = ownerKey(); submitted = null; repair = false; },
    read() { return valid() && submitted ? structuredClone(submitted) : null; },
    acceptsInstructions() { return valid() && !repair && !submitted; },
    invalidate() { submitted = null; },
    setRepair(value) { repair = value; },
    extension: { name: 'hemi-task-handoff', factory(pi) {
      pi.on('tool_call', event => {
        if (!valid()) return { block: true, reason: '交接所属任务已停止或改变' };
        if (event.toolName !== TASK_HANDOFF_TOOL && (repair || submitted)) return { block: true, reason: '当前仅允许提交交接结果，不能重新执行工作' };
      });
      pi.registerTool({
        name: TASK_HANDOFF_TOOL, label: '提交子任务交接',
        description: '本轮最后一步：按固定协议提交已有结果、未完成项和验证。接收仅代表结构有效，主任务仍需验收；提交后不能继续执行工具。',
        parameters: TASK_SUBMISSION_SCHEMA, executionMode: 'sequential',
        async execute(_id, args) {
          const reply = (value, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], isError });
          if (!valid()) return reply({ accepted: false, error: '交接所属任务已停止或改变' }, true);
          try {
            const data = parseTaskSubmission(args);
            if (submitted && JSON.stringify(submitted) !== JSON.stringify(data)) throw new Error('本轮已有不同的交接提交；不能覆盖已接收结果');
            submitted = data;
            return reply({ accepted: true, version: 1, guidance: '交接已接收，请结束本轮；主任务将验收，勿继续操作。' });
          } catch (error) { return reply({ accepted: false, error: error.message }, true); }
        },
      });
    } },
  };
}
