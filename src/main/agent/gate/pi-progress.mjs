export const PROGRESS_TOOL = 'report_progress';
export const COMMUNICATION_GUIDANCE = '【消息用途协议】普通正文用于交付用户需要的答案和可用的中间成果，始终保持可见。需要告知正在做什么、新发现、等待或阻塞原因时，必须使用 report_progress 发送简短进度，不再用普通正文重复。不要把实质结论、完整步骤或答案放进进度。答案之后可以继续调用工具，最后只补充必要结果；后续工具和短确认不会取代已交付的答案。文件交付前先完成必要的登记，再给用户可用的链接与说明。';

/** A side-effect-free message channel for providers without native assistant phases. */
export default function hemiProgress(pi) {
  pi.registerTool({
    name: PROGRESS_TOOL,
    label: '报告进度',
    description: '向用户报告简短进度；完成后归入可折叠的过程记录。只用于正在做什么、新发现、等待原因，不放用户需要的结论、操作步骤或完整答案。普通正文用于交付答案，后续工具不会隐藏它。无须为常规操作逐步播报。',
    promptSnippet: 'report_progress：简短过程说明；普通正文交付答案',
    constrainedSampling: { type: 'json_schema', strict: 'prefer' },
    promptGuidelines: [
      '需要报告进度时使用 report_progress；不要再用普通正文重复同一条进度。',
      '实质结论、可用的中间成果和最终答案写在普通正文中。答案之后可继续调用工具，最后补充必要结果，不用重复已交付的答案。',
    ],
    parameters: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 2000, description: '简短进度说明，不含实质答案' } }, required: ['text'], additionalProperties: false },
    async execute(_id, params) {
      if (typeof params?.text !== 'string' || !params.text.trim() || params.text.length > 2000) {
        return { isError: true, content: [{ type: 'text', text: '进度未发送：text 必须为 1–2000 字符的非空文字。请修正；实质答案直接写普通正文。' }] };
      }
      return { content: [{ type: 'text', text: '进度已发送，无需重复。继续处理或直接交付答案。' }], details: { progressText: params.text.trim() } };
    },
  });
}
