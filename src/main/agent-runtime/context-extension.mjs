import { projectToolText } from './context-store.mjs';

export function contextExtension({ getExecution, sourceFor, validateSource }) {
  const validate = source => source?.kind === 'conversation'
    ? getExecution()?.validateConversationSource?.(source) ?? false : validateSource(source);
  return { name: 'hemi-context-store', factory: pi => {
    pi.registerTool({ name: 'context_read', label: '读取上下文引用', description: '按 ref 分段读取原始快照。offset／limit 按字符计；nextOffset 非空表示后面仍有未读内容；图像返回真实图像块。',
      parameters: { type: 'object', properties: { ref: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['ref'] },
      async execute(_id, args) {
        const execution = getExecution();
        if (!execution || execution.cancelled?.()) return { isError: true, content: [{ type: 'text', text: '执行归属已失效' }] };
        try { return await execution.contextStore.read({ ...args, owner: execution.owner, allowedRefs: execution.allowedRefs, imageInput: (execution.actualCandidate ?? execution.plan.primary).supportsVision === true, validateSource: validate }); }
        catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
      },
    });
    pi.registerTool({ name: 'task_read', label: '读取子任务报告', description: '按准确 taskId 读取本对话已完成子任务的原始报告，可分段，不会重新执行。不能读取对话历史；conv- 开头的是会话 ID，应使用 conversation_read。',
      parameters: { type: 'object', properties: { taskId: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['taskId'] },
      async execute(_id, args) {
        const execution = getExecution();
        if (!execution || execution.cancelled?.() || execution.fatalError) return { isError: true, content: [{ type: 'text', text: execution?.fatalError ?? '执行归属已失效' }] };
        try {
          if (String(args.taskId).startsWith('conv-')) throw new Error('这是会话 ID，请使用 conversation_read({ conversationId: "' + args.taskId + '" }) 读取历史；task_read 只读子任务报告');
          const state = await execution.journal.snapshot();
          const task = state.tasks[args.taskId];
          if (!task || task.owner.conversationId !== execution.owner.conversationId) throw new Error('任务不属于当前对话或报告不可用');
          if (!task.result.reportRef) throw new Error('任务没有可读取的完整报告');
          return await execution.contextStore.read({ ref: task.result.reportRef, owner: execution.owner, allowedRefs: execution.allowedRefs, imageInput: (execution.actualCandidate ?? execution.plan.primary).supportsVision === true, validateSource, offset: args.offset, limit: args.limit });
        } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
      },
    });
    pi.on('tool_call', event => {
      const execution = getExecution();
      if (!execution || execution.cancelled?.() || execution.fatalError) return { block: true, reason: '根目标已停止，不能开始新动作' };
      const needsImage = /^(screen_view|browser_screenshot)$/.test(event.toolName) || (event.toolName === 'ui_type' && event.input?.view !== false) || (['ui_click','ui_key','ui_scroll'].includes(event.toolName) && event.input?.view === true);
      if (needsImage && !(execution.actualCandidate ?? execution.plan.primary).supportsVision) return { block: true, reason: '当前固定模型不支持图像，请明确选择支持图像的模型或在已配置路由中委派 imageInput 任务' };
    });
    pi.on('tool_result', async event => {
      if (['context_read','task_read','conversation_read'].includes(event.toolName)) return;
      const execution = getExecution();
      if (execution?.contextStore && event.content?.some(block => block.type === 'image') && !(execution.actualCandidate ?? execution.plan.primary).supportsVision) {
        try {
          const ref = event.details?.hemiObservationRef ?? await execution.contextStore.put({ owner:execution.owner, source:await sourceFor(event), content:event.content });
          if(execution.allowedRefs && !execution.allowedRefs.includes(ref))execution.allowedRefs.push(ref);
          return { content:[{type:'text',text:`unsupported-modality：本工具返回了图像，当前模型未看图；原始快照 ${ref}。需要图像时委派已配置且支持 imageInput 的角色读取。已生效的动作不要重跑。`}], isError:event.toolName==='read'?true:Boolean(event.isError), details:{...event.details,hemiUnsupportedModality:true,hemiObservationRef:ref} };
        } catch(error) { execution.fatalError=`图像结果保存失败：${error.message}`;return {isError:true,content:[{type:'text',text:execution.fatalError}]}; }
      }
      if (!execution?.contextStore || (event.content ?? []).reduce((size, block) => size + (block.type === 'text' ? block.text.length : 0), 0) <= execution.budgets.outputChars) return;
      try {
      const ref = event.details?.hemiObservationRef ?? await execution.contextStore.put({ owner: execution.owner, source: await sourceFor(event), content: event.content });
      if (execution.allowedRefs && !execution.allowedRefs.includes(ref)) execution.allowedRefs.push(ref);
      return { content: projectToolText(event.content, ref, execution.budgets.outputChars) };
      } catch (error) {
        execution.fatalError = `原始工具结果保存失败：${error.message}`;
        return { isError: true, content: [{ type: 'text', text: execution.fatalError }] };
      }
    });
  } };
}
