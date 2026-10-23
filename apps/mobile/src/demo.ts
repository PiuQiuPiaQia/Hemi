import type { MessageView } from '@hemi/conversation-flow';

// Synthetic fixtures only: no network requests, model credentials or real Bot data.
export const initialMessages: MessageView[] = [
  {
    id: 'welcome-user', author: 'user', text: '帮我整理一下今天的工作安排。',
    actions: { edit: true },
  },
  {
    id: 'welcome-assistant', author: 'assistant', text: '',
    parts: [
      { type: 'thinking', text: '先按优先级整理，再给每件事留出专注时间。', startedAt: 1792713600000, endedAt: 1792713602000 },
      { type: 'text', text: '可以先从这三件事开始：\n\n1. **确认今天最重要的目标**，安排一段不被打断的时间。\n2. 集中处理需要协作的事项，及时同步进展。\n3. 下班前留 15 分钟，记录结果和明天的第一步。\n\n这是一段离线示例。连接 Bot 后，这里会展示真实的回复、思考过程和工具执行结果。' },
    ],
  },
];

export const demoReply = '收到。这是本机生成的**演示回复**，没有连接 Bot，也没有发送网络请求。\n\n对话区域使用与桌面相同的 `@hemi/conversation-flow`。你可以继续体验发送、停止、编辑和复制。';
