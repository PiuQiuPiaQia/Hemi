import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { UsageHistoryPage } from '@/windows/voice/usage-history-page';
import type { UsageHistoryResponse } from '@/shared/types';
import { installNativeInput } from '@/lib/native-input';
import '@/globals.css';
import '@/styles/index.css';
import '@/appearance/appearance.css';
import { initializeAppearance } from '@/appearance/runtime';
import { StartupStage } from '@/appearance/startup-stage';

installNativeInput();

// Mock window.hemiVoice.getUsageHistory
const mockGetUsageHistory = async (): Promise<UsageHistoryResponse> => {
  // 模拟延迟
  await new Promise(resolve => setTimeout(resolve, 800));

  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  // 生成最近 90 天的每日数据
  const daily = Array.from({ length: 90 }, (_, i) => {
    const date = new Date(now - (89 - i) * dayMs);
    const dateStr = date.toISOString().split('T')[0];
    const requests = Math.floor(Math.random() * 50);
    const input = requests * (Math.floor(Math.random() * 2000) + 500);
    const output = requests * (Math.floor(Math.random() * 1500) + 300);
    return {
      date: dateStr,
      requests,
      input,
      output,
      cacheRead: Math.floor(input * 0.3),
      cacheWrite: Math.floor(input * 0.1),
    };
  });

  // 生成模拟请求记录
  const records = Array.from({ length: 150 }, (_, i) => {
    const at = now - i * 3600000 - Math.random() * 3600000;
    const status = Math.random() > 0.9 ? 'error' : Math.random() > 0.95 ? 'running' : 'success';
    const models = ['gpt-4o', 'claude-3.5-sonnet', 'deepseek-v3', 'gpt-4o-mini', 'gemini-2.0-flash'];
    const protocols = ['openai', 'anthropic', 'openai', 'openai', 'google'];
    const roles = ['main', 'explorer', 'fixer', 'designer', 'oracle'];
    const purposes = ['chat', 'task', 'chat', 'task', 'task'];
    const thinkingLevels = ['medium', 'high', 'low', 'medium', 'high'];

    const idx = i % models.length;
    const input = Math.floor(Math.random() * 5000) + 1000;
    const output = Math.floor(Math.random() * 2000) + 500;
    const durationMs = Math.floor(Math.random() * 30000) + 5000;
    const ttftMs = Math.floor(Math.random() * 2000) + 300;

    return {
      id: `req-${i}`,
      conversationId: i % 3 === 0 ? `conv-${Math.floor(i / 3)}` : null,
      at,
      endedAt: status === 'running' ? null : at + durationMs,
      url: `https://api.${protocols[idx]}.com/v1/chat/completions`,
      model: models[idx],
      protocol: protocols[idx],
      thinkingLevel: thinkingLevels[idx],
      role: roles[idx],
      purpose: purposes[idx],
      status: status as 'success' | 'error' | 'running',
      httpStatus: status === 'error' ? 500 : status === 'running' ? null : 200,
      ttftMs: status === 'running' ? null : ttftMs,
      durationMs: status === 'running' ? null : durationMs,
      tps: status === 'success' ? output / ((durationMs - ttftMs) / 1000) : null,
      input,
      output: status === 'running' ? null : output,
      cacheRead: Math.floor(input * 0.2),
      cacheWrite: Math.floor(input * 0.05),
      reasoning: Math.random() > 0.7 ? Math.floor(Math.random() * 1000) : null,
      error: status === 'error' ? 'Internal server error: Model overloaded' : null,
    };
  });

  const totals = daily.reduce(
    (acc, day) => ({
      requests: acc.requests + day.requests,
      input: acc.input + day.input,
      output: acc.output + day.output,
      cacheRead: acc.cacheRead + day.cacheRead,
      cacheWrite: acc.cacheWrite + day.cacheWrite,
    }),
    { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  );

  return {
    records: records.slice(0, 50),
    total: records.length,
    daily,
    totals,
    earliestAt: now - 90 * dayMs,
  };
};

// 注入 mock
(window as any).hemiVoice = {
  ...(window as any).hemiVoice,
  getUsageHistory: mockGetUsageHistory,
};

const root = document.getElementById('root');
if (!root) {
  throw new Error('Hemi 渲染容器不存在。');
}

void initializeAppearance().then(() =>
  createRoot(root).render(
    <StrictMode>
      <StartupStage>
        <UsageHistoryPage onClose={() => console.log('Close usage history')} />
      </StartupStage>
    </StrictMode>
  )
);
