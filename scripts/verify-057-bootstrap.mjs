// 057 旧档引导验证：无 flow 快照的旧会话，flow:getSnapshot 现场从 turns 投影
// （顺序/身份/task 投影/幂等）。运行：
//   HEMI_USER_DATA_DIR=<隔离目录> npx electron scripts/verify-057-bootstrap.mjs
import { app, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { IPC } from '../src/shared/ipc-channels.mjs';
import { initializeStableSafeStorageIdentity } from '../src/main/lib/config-store.mjs';
import { registerAllIpcHandlers } from '../src/main/ipc/index.mjs';

const UD = process.env.HEMI_USER_DATA_DIR;
if (!UD) {
  console.error('需要 HEMI_USER_DATA_DIR（隔离 userData）');
  process.exit(2);
}
app.setName('hemi'); // 与正式应用同一 Keychain/storage 身份，拷来的密文可解密
app.setPath('userData', path.resolve(UD));

const conversationsDir = path.join(UD, 'conversations');
fs.mkdirSync(conversationsDir, { recursive: true });
const OLD_TURNS = [
  { id: 'u1', createdAt: 10, author: 'user', text: '旧问题' },
  { id: 'u2', createdAt: 10.5, author: 'user', text: '已撤回的旧排队项', withdrawn: true },
  { id: 'h1', createdAt: 11, author: 'hemi', text: '旧回答', usage: { modelKey: 'x' } },
  {
    id: 'h2', createdAt: 11.5, author: 'hemi', text: '带分段的回执',
    parts: [
      { type: 'thinking', text: '想一想', startedAt: 11.4, endedAt: 11.5 },
      { type: 'tools', calls: [{ id: 'tc1', tool: 'bash', args: { command: 'ls' }, state: 'done' }] },
      { type: 'text', text: '分段正文' },
    ],
  },
  { id: 't1', createdAt: 12, author: 'hemi', kind: 'task', text: '旧任务', taskId: 'task-old', taskSnap: { taskId: 'task-old', key: 'task-old', agent: 'fixer', phase: 'terminal', outcome: 'complete', taskText: '旧任务', toolCallId: 'tc-old', resultText: '很长的报告'.repeat(50) } },
  { id: 'e1', createdAt: 13, author: 'hemi', kind: 'error', text: '旧错误' },
];
fs.writeFileSync(path.join(conversationsDir, 'conv-old.json'), JSON.stringify({
  id: 'conv-old', createdAt: 1, updatedAt: 2, turns: OLD_TURNS,
}, null, 2));

const finish = (code, payload) => {
  console.log(`HEMI_VERIFY_057_BOOTSTRAP=${JSON.stringify(payload)}`);
  setTimeout(() => app.exit(code), 300);
};
setTimeout(() => finish(1, { error: 'timeout' }), 120000).unref?.();

app.whenReady().then(async () => {
  try {
    initializeStableSafeStorageIdentity();
    await registerAllIpcHandlers();
    const handler = ipcMain._invokeHandlers?.get(IPC.flow.getSnapshot);
    const snap = await handler({}, { conversationId: 'conv-old' });
    const timeline = snap?.timeline ?? [];
    const checks = {
      // withdrawn 不复活：6 条 turns → 5 项。
      count: timeline.length === 5,
      order: JSON.stringify(timeline.map((e) => e.kind)) === JSON.stringify(['user', 'assistant', 'assistant', 'assistant', 'assistant']),
      userItem: timeline[0]?.text === '旧问题',
      plainReply: timeline[1]?.parts?.[0]?.content === '旧回答',
      segmented: JSON.stringify(timeline[2]?.parts?.map((p) => p.kind)) === JSON.stringify(['thinking', 'tool', 'text']),
      delegation: timeline[3]?.parts?.[0]?.kind === 'delegation' && timeline[3]?.parts?.[0]?.taskId === 'task-old',
      taskProjected: snap?.tasks?.['task-old']?.agent === 'fixer',
      taskPreviewBounded: (snap?.tasks?.['task-old']?.resultPreview ?? '').length === 200,
      notice: timeline[4]?.parts?.[0]?.kind === 'notice',
    };
    const again = await handler({}, { conversationId: 'conv-old' });
    checks.idempotent = again?.timeline?.length === 5;
    const ok = Object.values(checks).every(Boolean);
    finish(ok ? 0 : 1, { ok, checks, revision: snap?.revision });
  } catch (error) {
    finish(1, { error: String(error?.message ?? error) });
  }
});
