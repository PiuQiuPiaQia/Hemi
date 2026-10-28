// 当前视图身份独立于会话更新时间与草稿内容：后台任务不能抢走重启入口。
// 缺少标记的旧版本仍沿用最近会话；显式新建则必须恢复 draft-new。
export const DRAFT_NEW_KEY = 'draft-new';
const RESUME_KEY = 'hemi.conversation-resume.v1';
type ResumeStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function createConversationResume(storage: ResumeStorage) {
  return {
    remember(key: string) {
      storage.setItem(RESUME_KEY, key);
    },
    async restore<T>(bridge: {
      getLastConversation(): Promise<T | null>;
      openConversation(id: string): Promise<T>;
    }): Promise<T | null> {
      const key = storage.getItem(RESUME_KEY);
      if (key === DRAFT_NEW_KEY) return null;
      if (key && /^conv-[a-z0-9-]+$/.test(key)) {
        try { return await bridge.openConversation(key); }
        catch { /* 已删除或损坏的目标回落到最近可用会话。 */ }
      }
      return bridge.getLastConversation();
    },
  };
}
