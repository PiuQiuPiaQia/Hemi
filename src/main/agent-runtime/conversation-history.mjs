import { createHash } from 'node:crypto';

const MAX_PAGE_CHARS = 16000;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** 只投影已保存的公开消息；不带私有 SDK 条目，也不展开引用或工具结果。 */
export function conversationHistoryMessages(session) {
  return (session.turns ?? []).filter(turn => turn && !turn.withdrawn).map(turn => ({
    id: String(turn.id ?? ''),
    author: turn.author === 'user' ? '用户' : 'Hemi',
    createdAt: Number(turn.createdAt) || null,
    text: typeof turn.text === 'string' ? turn.text : (turn.parts ?? [])
      .filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n'),
    attachments: (turn.attachments ?? []).map(item => String(item.name ?? item.id ?? '附件')),
    references: (turn.references ?? []).map(item => String(item.name ?? item.title ?? item.targetConversationId ?? item.refPath ?? item.kind ?? '引用')),
  }));
}

export function conversationHistoryText(messages) {
  return messages.map((message, index) => [
    `--- 消息 ${index + 1} | ${message.author} | ${message.id} | ${message.createdAt ?? ''} ---`,
    message.text,
    ...(message.attachments.length ? [`［附件：${message.attachments.join('、')}］`] : []),
    ...(message.references.length ? [`［引用：${message.references.join('、')}］`] : []),
  ].join('\n')).join('\n\n');
}

/** 当前实例的档案读入口。快照归请求方会话；每次续读重新核对来源。 */
export function createConversationHistoryReader({ loadSession, contextStore }) {
  function load(conversationId) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(conversationId ?? '')) throw new Error('无效会话 ID');
    const session = loadSession(conversationId);
    if (!session || session.corrupt || session.id !== conversationId) throw new Error('当前实例中找不到该会话，或会话记录已损坏');
    return session;
  }

  function validateSource(source) {
    if (source?.kind !== 'conversation') return false;
    try {
      const messages = conversationHistoryMessages(load(source.conversationId));
      return messages.length >= source.turnCount && hash(messages.slice(0, source.turnCount)) === source.historyVersion;
    } catch { return false; }
  }

  async function read({ conversationId, snapshotRef = null, offset = 0, limit = 8000 }, { owner, signal, cancelled = () => false }) {
    const checkActive = () => {
      signal?.throwIfAborted();
      if (cancelled()) throw new DOMException('根目标已停止', 'AbortError');
    };
    checkActive();
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset 必须是非负整数字符偏移');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_CHARS) throw new Error(`limit 必须为 1～${MAX_PAGE_CHARS} 的整数`);
    let source;
    if (!snapshotRef) {
      if (offset !== 0) throw new Error('首次读取请从 offset=0 开始；续读须携带首次返回的 snapshotRef');
      const session = load(conversationId);
      const messages = conversationHistoryMessages(session);
      source = { kind: 'conversation', conversationId, title: session.title || conversationId, turnCount: messages.length, historyVersion: hash(messages) };
      snapshotRef = await contextStore.put({ owner, source, kind: 'conversation-history', content: [{ type: 'text', text: conversationHistoryText(messages) }] });
      checkActive();
    }
    const page = await contextStore.read({ ref: snapshotRef, owner, offset, limit,
      validateSource: current => {
        source = current;
        if (current?.kind !== 'conversation' || current.conversationId !== conversationId) throw new Error('snapshotRef 与目标会话 ID 不一致');
        if (!validateSource(current)) throw new Error('原会话已编辑、撤回、删除或不可读取，请去掉 snapshotRef 并从 offset=0 重新读取');
        return true;
      },
    });
    checkActive();
    if (offset > page.totalChars) throw new Error(`offset 超出会话长度（${page.totalChars} 字符）`);
    return { conversationId, title: source.title, turnCount: source.turnCount, snapshotRef,
      version: page.version, totalChars: page.totalChars, offset, nextOffset: page.nextOffset,
      text: page.content[0].text.slice(page.content[0].text.indexOf('\n') + 1) };
  }

  return { read, validateSource };
}
