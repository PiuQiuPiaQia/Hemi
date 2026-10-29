import {useConversationBridge} from './conversation-bridge';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConversationList, ConversationStatus } from '@shared/protocol';
import {reconcileConversationList} from '@hemi/conversation-flow/core';

/** 两处列表共用只读状态投影。文字 token 不触发重读档案；慢列表回执不能盖掉实时状态。 */
export function useConversationList(active = true, readConversationId: string | null = null) {
  const bridge = useConversationBridge();
  const [storedList, setList] = useState<ConversationList>({ sessions: [], storageError: null });
  const [error, setError] = useState('');
  const [focused, setFocused] = useState(() => document.hasFocus() && document.visibilityState === 'visible');
  const reading = useRef(new Map<string, number>());
  const statuses = useRef(new Map<string, ConversationStatus | null>());
  const loadEpoch = useRef(0);
  const refreshOrderPending = useRef(false);
  const loadList = useCallback(async (refreshOrder = false) => {
    if (refreshOrder) refreshOrderPending.current = true;
    const epoch = ++loadEpoch.current;
    try {
      const result = await bridge?.listConversations();
      if (epoch !== loadEpoch.current) return;
      if (result) {
        const reorder = refreshOrderPending.current;
        refreshOrderPending.current = false;
        setList(previous => {
          const sessions = result.sessions.map(session => statuses.current.has(session.id)
            ? { ...session, status: statuses.current.get(session.id) } : session);
          return { ...result, sessions: reconcileConversationList(previous.sessions, sessions, reorder) };
        });
      }
      setError('');
    } catch (loadError) {
      if (epoch === loadEpoch.current) setError(loadError instanceof Error ? loadError.message : '会话列表读取失败');
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    statuses.current.clear();
    const offFlow = bridge?.onFlowChanged?.(({ conversationId, change }) => {
      if (change.conversationStatus === undefined || (statuses.current.has(conversationId)
        && statuses.current.get(conversationId) === change.conversationStatus)) return;
      statuses.current.set(conversationId, change.conversationStatus);
      if (statuses.current.size > 100) statuses.current.delete(statuses.current.keys().next().value!);
      setList(prev => prev.sessions.some(session => session.id === conversationId && session.status !== change.conversationStatus)
        ? { ...prev, sessions: prev.sessions.map(session => session.id === conversationId
          ? { ...session, status: change.conversationStatus } : session) } : prev);
    });
    const offList = bridge?.onConversationsChanged?.(event => void loadList(event?.kind === 'reorder'));
    const onFocus = () => { setFocused(document.hasFocus() && document.visibilityState === 'visible'); void loadList(); };
    const onBlur = () => setFocused(false);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onFocus);
    setFocused(document.hasFocus() && document.visibilityState === 'visible');
    void loadList();
    return () => {
      ++loadEpoch.current;
      offFlow?.(); offList?.();
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [active, loadList]);

  const unreadAt = storedList.sessions.find(session => session.id === readConversationId)?.unreadAt;
  useEffect(() => {
    if (!active || !focused || !readConversationId || !unreadAt || !document.hasFocus()
      || reading.current.get(readConversationId) === unreadAt || !bridge?.markConversationRead) return;
    const id = readConversationId;
    reading.current.set(id, unreadAt);
    void bridge.markConversationRead(id, unreadAt).then(result => {
      if (!result.ok) return;
      setList(prev => ({ ...prev, sessions: prev.sessions.map(session => session.id === id && session.unreadAt === unreadAt
        ? { ...session, unreadAt: result.unreadAt } : session) }));
      // 废弃清读之前的慢列表响应，重新取主进程已提交的版本。
      void loadList();
    }).catch(() => {}).finally(() => {
      if (reading.current.get(id) === unreadAt) reading.current.delete(id);
    });
  }, [active, focused, readConversationId, unreadAt, loadList]);
  const setPinned = useCallback(async (id: string, pinned: boolean) => {
    try {
      const result = await bridge.setConversationPinned(id, pinned);
      if (!result.ok) throw new Error(result.storageError || '会话置顶设置失败');
      await loadList();
    } catch (pinError) {
      setError(pinError instanceof Error ? pinError.message : '会话置顶设置失败');
    }
  }, [bridge, loadList]);
  return { list: storedList, setList, error, setError, loadList, setPinned };
}
