import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { UsageHistoryPage } from '@/windows/voice/usage-history-page';
import type { UsageHistoryQuery, UsageHistoryRecord, UsageHistoryResponse } from '@/shared/types';
import { localDateKey } from '@/utils/usage-history-dates';
import { installNativeInput } from '@/lib/native-input';
import '@/globals.css';
import '@/styles/index.css';
import '@/appearance/appearance.css';
import { initializeAppearance } from '@/appearance/runtime';
import { StartupStage } from '@/appearance/startup-stage';

installNativeInput();

// 固定的合成记录：刷新不重新抽样，日期、统计、搜索与分页遵守实际服务契约。
const fixtureNow = new Date();
const fixtureModels = ['gpt-4o', 'claude-3.5-sonnet', 'deepseek-v3', 'gpt-4o-mini', 'gemini-2.0-flash'];
const fixtureRecords: UsageHistoryRecord[] = Array.from({ length: 180 }, (_, i): UsageHistoryRecord => {
  const date = new Date(fixtureNow);
  date.setDate(date.getDate() - Math.floor(i / 12));
  date.setHours(Math.min(fixtureNow.getHours(), 23) - (i % 12), 0, 0, 0);
  const at = date.getTime();
  const status = i % 10 === 0 ? 'error' : i % 29 === 0 ? 'running' : 'success';
  const idx = i % fixtureModels.length;
  const input = 1000 + i * 23;
  const output = 500 + i * 7;
  const durationMs = 5000 + i * 123;
  const ttftMs = 300 + i * 5;
  return {
    id: `req-${i}`, conversationId: i % 3 === 0 ? `conv-${Math.floor(i / 3)}` : null,
    at, endedAt: status === 'running' ? null : at + durationMs,
    url: 'https://fixture.invalid/v1/chat/completions',
    model: fixtureModels[idx], protocol: idx === 1 ? 'anthropic' : 'openai',
    thinkingLevel: 'high', role: i % 2 ? 'main' : 'designer', purpose: 'chat', status,
    httpStatus: status === 'error' ? 500 : status === 'running' ? null : 200,
    ttftMs: status === 'running' ? null : ttftMs, durationMs: status === 'running' ? null : durationMs,
    tps: status === 'success' ? output / ((durationMs - ttftMs) / 1000) : null,
    input, output: status === 'running' ? null : output,
    cacheRead: Math.floor(input * 0.2), cacheWrite: Math.floor(input * 0.05), reasoning: i % 4 ? null : i * 5,
    error: status === 'error' ? '合成测试：模型繁忙' : null,
  };
}).sort((a, b) => b.at - a.at);
const historicalDate = new Date(fixtureNow);
historicalDate.setDate(historicalDate.getDate() - 89);
fixtureRecords.push({ ...fixtureRecords[0], id: 'historical-model-only', at: historicalDate.getTime(), model: 'historical-model' });
const availableModels = [...new Set(fixtureRecords.map(record => record.model!))].sort();

const mockGetUsageHistory = async (query: UsageHistoryQuery = {}): Promise<UsageHistoryResponse> => {
  await new Promise(resolve => setTimeout(resolve, 300));
  const search = query.query?.trim().toLowerCase();
  const records = fixtureRecords.filter(record =>
    (query.from === undefined || record.at >= query.from)
    && (query.to === undefined || record.at <= query.to)
    && (!query.model || record.model === query.model)
    && (!query.status || query.status === 'all' || record.status === query.status)
    && (!search || [record.url, record.model, record.protocol, record.role, record.purpose]
      .some(value => value?.toLowerCase().includes(search)))
  );
  const daily = new Map<string, UsageHistoryResponse['daily'][number]>();
  const totals = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const record of records) {
    const date = localDateKey(new Date(record.at));
    const day = daily.get(date) ?? { date, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    day.requests += 1;
    totals.requests += 1;
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
      day[key] += record[key] ?? 0;
      totals[key] += record[key] ?? 0;
    }
    daily.set(date, day);
  }
  const offset = query.offset ?? 0;
  return {
    records: records.slice(offset, offset + (query.limit ?? 50)), total: records.length,
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)), totals,
    earliestAt: fixtureRecords.at(-1)?.at ?? null, models: availableModels,
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
