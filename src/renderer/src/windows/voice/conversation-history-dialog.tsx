import {useConversationBridge} from './lib/conversation-bridge';
'use client';

import { useCallback, useState } from 'react';
import { MessageSquareText, Trash2 } from 'lucide-react';

import type { ConversationSummary } from '@/shared/types';
import { ConversationStatusIcon } from './conversation-status-icon';
import { useConversationList } from './lib/use-conversation-list';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ConversationContextMenu } from '@/windows/voice/conversation-context-menu';
import { formatRelative, displayTitle } from '@/windows/voice/lib/conversation-format';

/**
 * 015 会话列表：点一条载入继续聊（或回看详情——载入后完整对话就在右侧
 * 面板里，两者是同一个动作）。删除走两步确认；删掉当前打开的会话时，页面
 * 侧解除绑定（内容保留，下次发言以新 id 落盘，D-6）。
 * 2026-10-05：行右键弹菜单（复制会话 ID / 重命名）——这里单击即打开会话，
 * 双击重命名不可行，重命名只能经菜单进原位编辑（与侧栏同一套输入交互）。
 * 2026-10-07：菜单加删除（危险项菜单内两步确认），落盘与行尾 chip 共用
 * commitDelete；损坏行经菜单可删（清残留文件），chip 侧仍置灰维持原样。
 */

export function ConversationHistoryDialog({
  onOpen,
  onRemoved,
  onRenamed,
  triggerLabel,
  onShow,
}: {
  onOpen: (id: string) => void;
  onRemoved: (id: string) => void;
  /** 重命名落盘后上抛（当前会话改名时顶栏标题跟着换、侧栏列表同步刷新）。 */
  onRenamed?: (id: string, title: string) => void;
  /** 提供时渲染为文字触发器（设计稿侧栏「查看全部」）；缺省为图标按钮。 */
  triggerLabel?: string;
  onShow?: () => void;
}) {
  const bridge = useConversationBridge();
  const [open, setOpen] = useState(false);
  const { list, error, setError, loadList } = useConversationList(open);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  /** 右键菜单：命中的会话 + 落点（null＝收起）。 */
  const [menu, setMenu] = useState<{ session: ConversationSummary; x: number; y: number } | null>(null);
  /** 行内重命名：editingId 命中的行渲染输入框（与侧栏同一交互）。 */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const handleOpen = useCallback(
    (session: ConversationSummary) => {
      if (session.corrupt) return;
      setOpen(false);
      onOpen(session.id);
    },
    [onOpen],
  );

  // 实际删除落盘（行尾 chip 的两步确认与右键菜单的菜单内确认都走这里）。
  const commitDelete = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        await bridge?.removeConversation(id);
        onRemoved(id);
        await loadList();
      } catch (deleteError) {
        setError(deleteError instanceof Error ? deleteError.message : '删除失败');
      } finally {
        setBusyId(null);
      }
    },
    [loadList, onRemoved],
  );

  const handleDelete = useCallback(
    (id: string) => {
      if (confirmDeleteId !== id) {
        setConfirmDeleteId(id);
        return;
      }
      setConfirmDeleteId(null);
      void commitDelete(id);
    },
    [commitDelete, confirmDeleteId],
  );

  const commitRename = useCallback(
    async (id: string, title: string) => {
      setEditingId(null);
      try {
        const result = await bridge?.renameConversation?.(id, title);
        if (result?.ok) onRenamed?.(id, result.session.title);
      } catch {
        // 落盘失败：列表重载即回到旧标题，不打断用户
      }
      await loadList();
    },
    [loadList, onRenamed],
  );

  return (
    <>
      {triggerLabel ? (
        <button
          type="button"
          className="h24-sidebar-more"
          aria-label="查看全部会话"
          onClick={() => { onShow?.(); setOpen(true); }}
        >
          {triggerLabel}
        </button>
      ) : (
        <Button
          variant="ghost"
          size="icon-sm"
          className="icon-btn"
          aria-label="历史会话"
          title="历史会话"
          onClick={() => { onShow?.(); setOpen(true); }}
        >
          <MessageSquareText />
        </Button>
      )}
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) {
            setError('');
            setConfirmDeleteId(null);
            setMenu(null);
            setEditingId(null);
          }
        }}
      >
        <DialogContent className="history-dialog sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>历史会话</DialogTitle>
            <DialogDescription>点一条接着聊；当时的完整对话会回到右侧面板</DialogDescription>
          </DialogHeader>

          {error ? <p className="history-error">{error}</p> : null}
          {list.storageError ? <p className="history-error">{list.storageError}</p> : null}

          <div className="history-list">
            {list.sessions.length ? (
              list.sessions.map((session) => {
                const editing = editingId === session.id;
                const commit = () => {
                  const next = draft.trim();
                  if (!next || next === session.title) {
                    setEditingId(null);
                    return;
                  }
                  void commitRename(session.id, next);
                };
                return (
                  <div
                    key={session.id}
                    className="history-item"
                    data-corrupt={session.corrupt ? 'true' : 'false'}
                    onContextMenu={(event) => {
                      // 编辑输入框里保留系统右键（复制/粘贴）
                      if (editing) return;
                      event.preventDefault();
                      setMenu({ session, x: event.clientX, y: event.clientY });
                    }}
                  >
                    {editing ? (
                      <input
                        className="history-rename"
                        value={draft}
                        autoFocus
                        spellCheck={false}
                        aria-label="重命名会话"
                        onChange={(event) => setDraft(event.target.value)}
                        onBlur={commit}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            commit();
                          } else if (event.key === 'Escape') {
                            event.preventDefault();
                            setEditingId(null);
                          }
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        className="history-item-main"
                        onClick={() => handleOpen(session)}
                        disabled={Boolean(session.corrupt) || busyId === session.id}
                        title={session.corrupt ? '这条会话档案损坏，无法打开' : `${session.title}（右键可复制会话 ID 或重命名）`}
                      >
                        <span className="history-item-text">{displayTitle(session.title)}</span>
                        {!session.corrupt && <ConversationStatusIcon status={session.status} unreadAt={session.unreadAt} />}
                        <span className="history-time">
                          {formatRelative(session.updatedAt)} · {session.turnCount} 条
                        </span>
                      </button>
                    )}
                    <button
                      type="button"
                      className="history-chip-btn"
                      aria-label={`删除会话 ${session.title}`}
                      title="删除会话"
                      disabled={Boolean(session.corrupt) || busyId === session.id || editing}
                      onClick={() => void handleDelete(session.id)}
                    >
                      {confirmDeleteId === session.id ? '确认？' : <Trash2 className="size-3" />}
                    </button>
                  </div>
                );
              })
            ) : (
              <p className="history-empty">还没有存下的会话。聊过几句后自动保存。</p>
            )}
          </div>
        </DialogContent>
      </Dialog>
      {/* 常挂：复制后的 toast 要在菜单收起、弹窗关闭后继续显示 */}
      <ConversationContextMenu
        session={menu?.session ?? null}
        point={menu ? { x: menu.x, y: menu.y } : null}
        onRename={() => {
          if (!menu) return;
          setEditingId(menu.session.id);
          // 所见即所编：预填与行内显示同用 displayTitle（与侧栏一致）
          setDraft(displayTitle(menu.session.title));
        }}
        onDelete={() => {
          if (!menu) return;
          void commitDelete(menu.session.id);
        }}
        onClose={() => setMenu(null)}
      />
    </>
  );
}
