// 037 Phase B：记忆桥核心（与 SDK 注解解耦，可离线单测）。
// hemiMemoryBridge(pi, …) 把这里的 tools/projectRequest 挂到 Pi 扩展面；
// 单测直接驱动 core，不建 Pi 会话。
import { countCodePoints } from '../../services/memory-format.mjs';

/** memory_read 结果首行的视图标记：代次序号过期即被投影改写。 */
export const VIEW_TAG_RE = /^［记忆视图 #(\d+)］\n?/;

export function createMemoryBridgeCore({ client, log = null }) {
  const textResult = (text) => ({ content: [{ type: 'text', text }] });

  const failureText = (result) => `操作未完成：${result?.message ?? '未知错误'}${result?.code ? `（${result.code}）` : ''}`;

  /** 视图文本→memory_read 结果（带代次标记，供后续投影判过期）。 */
  function buildReadResult(view) {
    const header = `［记忆视图 #${client.viewEpoch}］`;
    const parts = [header];
    if (view.data.text) parts.push(view.data.text);
    if (view.data.omittedCount > 0) parts.push(`（另有 ${view.data.omittedCount} 条超出投影预算省略，可换更具体的 memory_search）`);
    return textResult(parts.join('\n'));
  }

  const tools = {
    memory_read: {
      name: 'memory_read',
      label: 'Memory Read',
      description: '按需主动重读当前有效记忆（关于你＋全局约定＋本工作区，含工作记录与待办便签）。通常已有自动投影；需要核实更新、重读过期结果或确认投影恢复时使用。返回相同预算的最新视图，长期条目超预算时用 memory_search 定位。',
      parameters: { type: 'object', properties: {} },
      async execute() {
        const view = await client.buildView();
        if (!view.ok) return { ...textResult(`记忆当前不可读：${view.message}`), isError: true };
        client.noteEpoch(view.data.lease);
        return buildReadResult(view);
      },
    },
    memory_search: {
      name: 'memory_search',
      label: 'Memory Search',
      description: '在允许范围内按关键词搜索记忆条目（关于你/全局约定/本工作区）。semantic/deep 检索需要可选的 qmd 外装，未安装时不可用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词' },
          mode: { type: 'string', enum: ['keyword', 'semantic', 'deep'], description: '默认 keyword' },
        },
        required: ['query'],
      },
      async execute(_id, params) {
        const mode = params?.mode ?? 'keyword';
        if (mode !== 'keyword') {
          return textResult('semantic/deep 检索需要 qmd 外装，当前环境未安装；请用 keyword。');
        }
        const result = await client.searchEntries({ query: params?.query });
        if (!result.ok) return textResult(failureText(result));
        if (!result.data.matches.length) return textResult('没有匹配的记忆条目。');
        const lines = result.data.matches.slice(0, 20).map((m) => `- [${m.scopeLabel}｜${m.id} v${m.version}] ${m.title}${m.body ? `：${m.body.slice(0, 200)}` : ''}`);
        return textResult(`匹配 ${result.data.matches.length} 条：\n${lines.join('\n')}`);
      },
    },
  };

  /**
   * 每次模型请求的投影（context_with_system）。返回 SDK 契约的 { messages }
   * （裸数组会被派发器当 undefined 丢弃——handlerResult?.messages 落回原文）。
   * 消息处理纯函数化在 projectMessages，供单测；这里负责取视图、记代次与异常收敛。
   */
  async function projectRequest(messages) {
    let view = null;
    try {
      view = await client.buildView();
    } catch (error) {
      log?.warn?.(`[memory-bridge] 视图构建异常，本请求按降级处理：${error?.message ?? error}`);
    }
    if (!view?.ok) {
      client.noteDegraded?.(view?.message ?? '视图构建异常');
      return { messages: projectMessages(messages, '［长期记忆当前不可用（读取失败）：记忆工具暂时只读不可写，任务可继续，不要假设旧记忆内容。］', client.viewEpoch) };
    }
    const epoch = client.noteEpoch(view.data.lease);
    const body = view.data.text
      ? `${view.data.text}${view.data.omittedCount > 0 ? `\n（另有 ${view.data.omittedCount} 条超预算省略）` : ''}`
      : '（当前范围内还没有长期记忆。）';
    const header = `［长期记忆 · ${client.scopeLabel}｜全局］有效记忆如下；工作区约定只对当前工作区生效：`;
    return { messages: projectMessages(messages, `${header}\n${body}`, epoch) };
  }

  return { tools, projectRequest };
}

/**
 * 纯投影（单测入口）：克隆消息，把代次过期的 memory_read 结果（按 VIEW_TAG_RE
 * 标记）改写为重读提示，末尾追加仅本请求的 hemi_memory system 段。绝不改动
 * 其他消息与工具声明。
 */
export function projectMessages(messages, viewText, currentEpoch) {
  const projected = messages.map((message) => {
    if (message?.role !== 'toolResult' || !Array.isArray(message.content)) return message;
    let changed = false;
    const content = message.content.map((item) => {
      if (item?.type !== 'text' || typeof item.text !== 'string') return item;
      const match = item.text.match(VIEW_TAG_RE);
      if (!match) return item;
      const tagEpoch = Number(match[1]);
      if (Number.isInteger(tagEpoch) && tagEpoch >= currentEpoch) return item;
      changed = true;
      return { ...item, text: `［记忆视图已更新（代次 #${currentEpoch}）：上述读取结果中的条目可能已被删除或修改，需要时请重新 memory_read］` };
    });
    return changed ? { ...message, content } : message;
  });
  projected.push({ role: 'system', content: '', sections: { hemi_memory: viewText }, timestamp: Date.now() });
  return projected;
}

/** 供描述/校验复用的码点计数（与格式模块同口径）。 */
export { countCodePoints };
