import { StrictMode, useEffect, useState } from 'react';
import { ModelRoutingDialog } from '@/windows/voice/model-routing-dialog';
import { createRoot } from 'react-dom/client';

import type {
  ApplicationChoice,
  ConversationSummary,
  ConversationStatus,
  MemoryEntryView,
  TaskArtifact,
  TaskDelivery,
  TaskStateSnapshot,
  TranscriptItem,
  TurnPart,
  TurnQueueState,
  UiState,
  WorkspaceState,
} from '@/shared/types';
import { initialUiState } from '@/windows/voice/lib/voice-bridge';
import { VoiceScreen } from '@/windows/voice/voice-screen';
import { ThinkingBlock } from '@/windows/voice/thinking-block';
import { projectFlowTimeline } from '@/windows/voice/lib/flow-timeline-view';
import { WorkflowCard } from '@/windows/voice/workflow-card';
import { WorkflowParametersDialog } from '@/windows/voice/workflow-parameters-dialog';
import { SessionUsage } from '@/windows/voice/session-usage-view';
import type { FlowSnapshotView, UsageRecord } from '@shared/protocol';
import { ScopePopover } from '@/windows/voice/scope-popover';
import { AccessAddDialog } from '@/windows/voice/access-add-dialog';
import { RemoteFolderDialog } from '@/windows/voice/remote-folder-dialog';
import { SettingsScreen } from '@/windows/voice/settings-screen';
import { setModelProfilesFixtureState } from '@/windows/voice/model-profiles-section';
import { setProviderImportFixtureState } from '@/windows/voice/newapi-import-section';
import { setMemorySectionPreset } from '@/windows/voice/memory-section';
import type { MemorySectionPreset } from '@/windows/voice/memory-section';
import { MemoryNotices } from '@/windows/voice/memory-notice';
import type { MemoryNoticeItem } from '@/windows/voice/memory-notice';
import { SetupScreen } from '@/windows/voice/setup-screen';
import { ConversationContextMenu } from '@/windows/voice/conversation-context-menu';
import { FloatingCaption } from '@/windows/caption/floating-caption';
import { FloatingOrb } from '@/windows/orb/floating-orb';
import { BrandIcon } from '@/components/brand-icon';
import { AppTopBar } from '@/windows/voice/app-top-bar';
import { TaskPopover } from '@/windows/orb/task-popover';
import { installNativeInput } from '@/lib/native-input';
import '@/globals.css';
import '@/styles/index.css';

installNativeInput();

/**
 * 开发用视觉 fixtures：把真实页面按交互稿场景渲染，供离屏截图与
 * requirements/004-agent-tool-calls/designs/2026-09-19-task-interactions 的
 * 静态稿件逐场景比对。仅 vite dev（/fixtures.html?scene=…）可达，不进生产构建。
 * 025：交付场景（四类结果卡/部分/降级/报告阅读视图）对照
 * requirements/025-adaptive-deliverables/designs 的候选稿。
 */

const now = Date.now();

/** fixtures 附件缩略图/预览用的 96×64 双色 PNG（青绿上／白线／暖橙下）。 */
const FIXTURE_IMAGE_DATA_URL = `data:image/png;base64,${'iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAIAAABqVuVZAAAA5UlEQVR4nO3Q2VFCARBE0ReRoIgCIrSieXQoLQguuKQ4mWgGfE/pne+uW1NnOItH8Tg+jy/iSXwZT+Or+DqexfN4Ed/Ey/g2XsXrWPFdfB9v4of4Mf6rnaHbQ906AAEEEEAANe4ABBBAAAHUuAMQQAABBFDjDkAAAQQQQI07AAEEEEAANe4ABBBAAAHUuDP8cCdvqKieVFvVTvWs2qsOqhfVq+pN9a46qj5Un6ov1bf+2x4ggAACCKDGe4AAAggggBrvAQIIIIAAarwHCCCAAAKo8R4ggAACCKDGe4AAAggggBrvfwELU44Asjm0FQAAAABJRU5ErkJggg=='}`;

/**
 * sidebar-context-menu-delete 场景专用：挂载后对 body 里的危险菜单项点一次，
 * 把删除的两步确认定格在武装态（「确认删除」浅红底）供静态截图——确认态是
 * 菜单组件内部 state，静态渲染无法直接给出。
 */
function ArmDangerConfirmOnce() {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const item = document.querySelector('.h37-menu-item[data-danger="true"]') as HTMLElement | null;
      item?.click();
    }, 50);
    return () => window.clearTimeout(timer);
  }, []);
  return null;
}

function transcripts(items: Array<[string, 'user' | 'hemi']>): TranscriptItem[] {
  return items.map(([text, author], index) => ({
    id: `t${index}`,
    text,
    createdAt: now - (items.length - index) * 60000,
    author,
  }));
}

const baseTask: TaskStateSnapshot = {
  seq: 1,
  key: 't1-demo',
  taskId: 'task-1-demo',
  conversationId: 'conv-fixture',
  phase: 'running',
  outcome: null,
  taskText: '把下载的图片按月份整理好',
  progressText: '正在移动图片 · 已完成 12 张',
  readOnly: false,
  verifying: false,
  verified: false,
  permission: null,
  queueCount: 0,
        steeredCount: 0,
  log: [
    { at: now - 60000, text: '已检查 37 张图片，按拍摄月份分组。' },
    { at: now - 30000, text: '已获得本次移动操作授权。' },
    { at: now - 5000, text: '开始移动文件，已完成 12 张。' },
  ],
  resultText: null,
  outcomeReason: null,
  verification: null,
  artifacts: [],
  lastAction: {
    tool: 'bash',
    args: { command: "mv -n -- '/Users/demo/Downloads/IMG_0918.jpg' '/Users/demo/Pictures/按月归档/2026-09/'" },
  },
  resumedFrom: null,
};

const runningTask: TaskStateSnapshot = { ...baseTask };
const waitingTask: TaskStateSnapshot = {
  ...baseTask,
  phase: 'waiting',
  progressText: '等待允许移动 · 尚未改动文件',
  readOnly: true,
  log: [
    { at: now - 60000, text: '已检查 37 张图片，按拍摄月份分组。' },
    { at: now - 10000, text: '等待允许移动图片，尚未改动文件。' },
  ],
  permission: {
    id: 'u1',
    kind: 'grant',
    summary: '允许 Hemi 编辑「~/Pictures/按月归档」？',
    tool: 'bash',
    args: { command: "mv -n -- '/Users/demo/Downloads/IMG_0918.jpg' '/Users/demo/Pictures/按月归档/2026-09/'" },
    note: '编辑（含访问）：可新建、修改、删除',
    options: ['本任务允许', '持续允许', '拒绝'],
    remainingMs: 7000,
  },
};
/** 042 独立风险确认卡（052 R-04 起两钮「本任务允许／拒绝」，任务内同类不再询问）。 */
const riskTask: TaskStateSnapshot = {
  ...waitingTask,
  progressText: '等待确认删除 · 尚未改动文件',
  permission: {
    id: 'u2',
    kind: 'action',
    summary: '删除「草稿」文件夹？',
    tool: 'bash',
    args: { command: "rm -rf -- '/Users/demo/Documents/草稿'" },
    note: '文件夹里的 14 个文件会被永久删除，无法撤销。',
    options: ['本任务允许', '拒绝'],
    remainingMs: 21000,
  },
};
const completeTask: TaskStateSnapshot = {
  ...baseTask,
  phase: 'terminal',
  outcome: 'complete',
  progressText: '37 张图片已按月份整理好',
  resultText: '37 张图片整理好了，已经按月份放进文件夹。',
  log: [...baseTask.log, { at: now, text: '37 张图片已处理；任务授权已失效。' }],
};
const stoppedTask: TaskStateSnapshot = {
  ...baseTask,
  phase: 'terminal',
  outcome: 'stopped',
  progressText: '已移动 12 张，剩余 25 张未处理',
  resultText: '已经停下了，12 张已整理，其余没有继续处理。',
  lastAction: null,
};
const deniedTask: TaskStateSnapshot = {
  ...baseTask,
  phase: 'terminal',
  outcome: 'denied',
  progressText: '本次移动未执行',
  outcomeReason: '用户拒绝了这一步',
  lastAction: null,
};
const blockedTask: TaskStateSnapshot = {
  ...baseTask,
  taskText: '删除下载文件夹中的所有文件',
  phase: 'terminal',
  outcome: 'blocked',
  progressText: '禁止规则已阻止本次操作',
  outcomeReason: '命令命中禁止规则：rm -rf ~/Downloads',
  lastAction: null,
};
const secondTask: TaskStateSnapshot = {
  ...runningTask,
  key: 't2-demo',
  taskId: 'task-2-demo',
  taskText: '再用浏览器查一下发布会消息',
  progressText: '正在读取网页 news.example.com',
  queueCount: 1,
};

/** 017：顶层快照（bundle）＝单任务快照 + 全量任务列表。 */
function bundleOf(...snaps: TaskStateSnapshot[]): TaskStateSnapshot {
  const last = snaps[snaps.length - 1];
  return { ...last, tasks: snaps };
}

// —— 025 交付 fixture（经主进程校验后的形状，字段与 TaskDelivery 人肉同步）——

const deliveryArtifacts: TaskArtifact[] = [
  { id: 'art-1', kind: 'file', name: '北京天气-明天.csv', path: '/Users/demo/Documents/北京天气-明天.csv', role: 'attachment', registeredAt: now - 60000 },
  { id: 'art-2', kind: 'file', name: '牛奶对比表.csv', path: '/Users/demo/Documents/牛奶对比表.csv', role: 'main', registeredAt: now - 60000 },
  { id: 'art-3', kind: 'file', name: '调研附录-访谈记录.md', path: '/Users/demo/Documents/调研附录-访谈记录.md', role: 'attachment', registeredAt: now - 60000 },
];

const summaryDelivery: TaskDelivery = {
  schemaVersion: 1,
  form: 'card',
  kind: 'summary',
  title: '明天（9 月 24 日）北京天气：多云转晴，建议带伞备用',
  summary: '明天北京多云转晴，最高 26℃、最低 15℃，午后降水概率 30%，早晚偏凉，建议带一件外套并备伞。',
  blocks: [
    {
      type: 'metrics',
      items: [
        { label: '最高气温', value: '26', unit: '℃' },
        { label: '最低气温', value: '15', unit: '℃' },
        { label: '降水概率（午后）', value: '30', unit: '%', note: '傍晚转晴' },
        { label: '空气质量', value: '良', note: '2026-09-23 18:00 预报' },
      ],
    },
    { type: 'p', text: '上午以多云为主，午后局部地区有短时阵雨，出行建议携带折叠伞；夜间转晴，昼夜温差接近 11℃.' },
  ],
  sources: [
    { id: 'src-1', title: '中国气象台 · 北京 24 小时预报', url: 'https://weather.cma.cn/daily/Beijing', note: '2026-09-23 18:00 更新' },
  ],
  mainArtifacts: [],
  attachmentArtifacts: [],
  reason: '用户只要一句结论加关键指标，卡片直读，无需报告',
  partial: null,
  degraded: [],
  presentationError: null,
  registeredAt: now - 30000,
};

/** 结果卡卡内直读场景（取自真实会话：7 天预报表＋指标＋两段说明）。 */
const weekWeatherDelivery: TaskDelivery = {
  ...summaryDelivery,
  title: '五常市未来一周天气（10/07–10/13）',
  summary: '未来一周五常以多云为主，10/10 与 10/12 有阵雨、10/11 转晴；最高温 15–21℃，最低温 4–9℃，10/13 起明显转凉。',
  blocks: [
    {
      type: 'table',
      caption: '数据源：中央气象台 nmc.cn 五常城市预报页，预报发布时间 10-07 12:00',
      columns: ['日期', '星期', '天况(白天/夜间)', '最高温', '最低温', '风'],
      rows: [
        ['10/07', '周三', '多云 / 多云', '19℃', '7℃', '西风 3~4级 / 南风 微风'],
        ['10/08', '周四', '多云 / 多云', '21℃', '4℃', '西南风 3~4级 / 东风 微风'],
        ['10/09', '周五', '多云 / 多云', '21℃', '8℃', '西南风 3~4级 / 西北风 微风'],
        ['10/10', '周六', '阵雨 / 阵雨', '19℃', '7℃', '西风 微风 / 北风 微风'],
        ['10/11', '周日', '晴 / 多云', '18℃', '9℃', '东风 3~4级 / 南风 3~4级'],
        ['10/12', '周一', '阵雨 / 多云', '21℃', '6℃', '南风 3~4级 / 西南风 3~4级'],
        ['10/13', '周二', '多云 / 多云', '15℃', '4℃', '西风 4~5级 / 西风 3~4级'],
      ],
    },
    {
      type: 'metrics',
      items: [
        { label: '当前气温（13:15 更新）', value: '20.3', unit: '℃' },
        { label: '风', value: '西南风 3 级' },
        { label: '相对湿度', value: '32', unit: '%' },
        { label: '空气质量', value: '优' },
      ],
    },
    { type: 'p', text: '今日逐时（℃）：14:00 18.8 → 17:00 16.0 → 20:00 10.5 → 23:00 9.2；今夜至明日凌晨最低约 7.2–7.6℃，昼夜温差大，早晚需加衣。' },
    { type: 'p', text: '提示：10/10 与 10/12 白天有阵雨，10/13 西风 4~5 级且最高温降至 15℃，为下周最凉、风最大的一天。' },
  ],
  sources: [
    { id: 'src-1', title: '中央气象台 · 五常天气预报', url: 'https://www.nmc.cn/publish/forecast/AHL/wuchang.html' },
  ],
};
const weekWeatherTask = () => deliveredTask(weekWeatherDelivery, {
  taskText: '查看五常市未来一周的天气',
  artifacts: [],
  resultText: '按中央气象台五常的预报，未来一周以多云为主，周六和周一白天有阵雨、周日晴，白天最高18到21度、夜里最低4到9度，昼夜温差大。',
});

const comparisonDelivery: TaskDelivery = {
  schemaVersion: 1,
  form: 'card',
  kind: 'comparison',
  title: '三款预算内牛奶对比：推荐 A 品牌',
  summary: '在 500ml/12 元预算内，A 品牌蛋白质与钙含量最高，B 品牌价格最低但蛋白略逊，推荐 A。',
  blocks: [
    {
      type: 'table',
      caption: '按每 100ml 含量对照；「未查到」为公开页面未标注',
      columns: ['候选', '蛋白质', '钙', '价格（500ml）', '产地'],
      rows: [
        ['A 品牌', '3.6g', '120mg', '11.9 元', '内蒙古'],
        ['B 品牌', '3.2g', '100mg', '9.9 元', '河北'],
        ['C 品牌', '未查到', '110mg', '12.0 元', '黑龙江'],
      ],
    },
    { type: 'p', text: '推荐理由：A 品牌两项核心指标均最高且价格居中；限制：C 品牌蛋白质未公开标注，比较口径以商品页为准。' },
  ],
  sources: [
    { id: 'src-1', title: 'A 品牌官方营养成分表', url: 'https://example.com/a-nutrition' },
    { id: 'src-2', title: 'B 品牌商品页', url: 'https://example.com/b-item' },
  ],
  mainArtifacts: ['art-2'],
  attachmentArtifacts: [],
  reason: '多候选同维度对照，表格卡最直观',
  partial: null,
  degraded: [],
  presentationError: null,
  registeredAt: now - 30000,
};

const checklistDelivery: TaskDelivery = {
  schemaVersion: 1,
  form: 'card',
  kind: 'checklist',
  title: '周末出行清单（9 月 27 日–28 日）',
  summary: '两天行程按出发前、第一天、第二天分组，共 9 项，含订票与天气前提。',
  blocks: [
    {
      type: 'checklist',
      groups: [
        {
          title: '出发前（周五晚）',
          items: [
            { text: '预订 9:06 高铁票', note: '候补第 2 轮未成功，需再确认' },
            { text: '给相机充两组电池' },
          ],
        },
        {
          title: '第一天',
          items: [{ text: '08:00 出发赶车', note: '地铁约 40 分钟' }, { text: '午后博物馆参观（需预约）' }],
        },
        { title: '第二天', items: [{ text: '上午市集，下午返程' }] },
      ],
    },
  ],
  sources: [],
  mainArtifacts: [],
  attachmentArtifacts: [],
  reason: '按时间分组只读清单，首期不做勾选',
  partial: { missing: ['高铁票仍未出票'] },
  degraded: [],
  presentationError: null,
  registeredAt: now - 30000,
};

const receiptDelivery: TaskDelivery = {
  schemaVersion: 1,
  form: 'file',
  kind: 'receipt',
  title: '图片整理完成：37 张已按月份归档',
  summary: '37 张图片按拍摄月份移入「图片/按月归档」，2026-08 与 2026-09 两个目录，另生成对照表。',
  blocks: [
    {
      type: 'metrics',
      items: [
        { label: '已归档', value: '37', unit: '张' },
        { label: '新建目录', value: '2', unit: '个' },
        { label: '未处理', value: '0', unit: '张' },
      ],
    },
  ],
  sources: [],
  mainArtifacts: ['art-2'],
  attachmentArtifacts: ['art-1'],
  reason: '操作回执＋主文件入口',
  partial: null,
  degraded: [],
  presentationError: null,
  registeredAt: now - 30000,
};

const reportDelivery: TaskDelivery = {
  schemaVersion: 1,
  form: 'report',
  kind: 'report',
  title: '主流 AI 助手交付形式调研',
  summary: '四家产品均以「卡片摘要＋可保存完整报告」承载复杂结果，形式选择普遍跟随用户用途而非内容字数。',
  blocks: [
    {
      type: 'metrics',
      items: [
        { label: '覆盖产品', value: '4', unit: '家' },
        { label: '引用官方文档', value: '6', unit: '篇' },
      ],
    },
    {
      type: 'section',
      title: '关键发现',
      blocks: [
        { type: 'p', text: '调研的四家产品在复杂结果上都不再输出纯文本：轻结论留在对话卡片，完整内容交给独立阅读视图或可导出文件，两条路径共享同一份数据。' },
        { type: 'p', text: '形式选择依据集中在「用户下一步要做什么」：确认、比较、行动、深读各自对应固定载体，字数与执行时长不参与判断。' },
      ],
    },
    {
      type: 'section',
      title: '对比与限制',
      blocks: [
        {
          type: 'table',
          columns: ['产品', '卡片摘要', '完整报告', '导出'],
          rows: [
            ['A 助手', '有', '有', 'HTML'],
            ['B 助手', '有', '有', 'PDF'],
            ['C 助手', '有', '无', '—'],
          ],
        },
        { type: 'p', text: '限制：各家文档未披露报告生成的内部判定阈值，此处仅记录可观察行为。' },
      ],
    },
  ],
  sources: [
    { id: 'src-1', title: 'A 助手 · 结果展示官方说明', url: 'https://example.com/docs/a-cards', note: '2026-09 检索' },
    { id: 'src-2', title: 'B 助手 · 导出功能文档', url: 'https://example.com/docs/b-export' },
    { id: 'src-3', title: 'C 助手 · 任务结果说明', url: 'https://example.com/docs/c-results' },
    { id: 'src-4', title: 'D 产品 · 交付格式公告', url: 'https://example.com/docs/d-formats' },
  ],
  mainArtifacts: [],
  attachmentArtifacts: ['art-3'],
  reason: '多主题调研需要目录与来源齐备的阅读视图',
  partial: null,
  degraded: [],
  presentationError: null,
  registeredAt: now - 30000,
};

const partialDelivery: TaskDelivery = {
  ...summaryDelivery,
  title: '水牛奶线上比价：3 家可查，2 家缺价',
  summary: '5 家目标商户中 3 家给出明确价格，其余 2 家页面未标注价格，已有部分按同口径对照。',
  blocks: [
    {
      type: 'table',
      columns: ['商户', '价格（1L）', '库存'],
      rows: [
        ['商户一', '23.9 元', '有'],
        ['商户二', '25.5 元', '有'],
        ['商户三', '未查到', '未知'],
      ],
    },
  ],
  partial: { missing: ['商户四、商户五价格页面未标注', '库存状态未逐一核对'], note: '已有部分可直接比较' },
  degraded: [],
};

const fallbackDelivery: TaskDelivery = {
  ...reportDelivery,
  title: '竞品交付形式调研（排版降级）',
  degraded: ['图片未展示（架构图.png）：文件未登记', '对比表超出 30 行上限，已截断'],
  presentationError: null,
};

/** 025：终态任务＋交付组合器。 */
function deliveredTask(
  delivery: TaskDelivery,
  overrides: Partial<TaskStateSnapshot> = {},
  artifacts: TaskArtifact[] = [],
): TaskStateSnapshot {
  return {
    ...baseTask,
    seq: 5,
    key: 't5-delivery',
    taskId: 'task-5-delivery',
    phase: 'terminal',
    outcome: delivery.partial ? 'partial' : 'complete',
    progressText: delivery.title,
    resultText: delivery.summary,
    readOnly: true,
    verified: !delivery.partial,
    log: [
      { at: now - 120000, text: '任务开始。' },
      { at: now - 60000, text: '阶段成果：结果已取得。' },
      { at: now - 30000, text: `成果已登记：「${delivery.title}」` },
    ],
    artifacts: [...deliveryArtifacts, ...artifacts],
    delivery,
    lastAction: null,
    ...overrides,
  };
}

/** 050：正文契约终态任务组合器（状态行＋正文＋提醒＋事实分组）。 */
function resultTask(overrides: Partial<TaskStateSnapshot> = {}): TaskStateSnapshot {
  return {
    ...baseTask,
    seq: 6,
    key: 't6-result',
    taskId: 'task-6-result',
    phase: 'terminal',
    outcome: 'complete',
    progressText: '已完成',
    resultText: '有 6 家可用。',
    resultVersion: 1,
    bodySource: 'executor',
    speechText: '查到了，6 家都能用，详情在屏幕上。',
    notices: [],
    sources: [],
    fileChanges: null,
    readOnly: true,
    verified: true,
    verification: { verdict: 'complete', evidence: ['已交叉核对 6 家官网'], unchecked: [], at: now },
    log: [
      { at: now - 346000, text: '任务开始。' },
      { at: now - 200000, text: '阶段成果：前 3 家已确认' },
      { at: now - 10000, text: '收尾判定已接收：complete' },
    ],
    startedAt: now - 346000,
    endedAt: now - 8000,
    artifacts: [],
    delivery: null,
    lastAction: null,
    ...overrides,
  };
}

const researchBody = [
  '有 6 家支持中转站生图生视频，其中 5 家同时支持视频（LibLib 的视频还在内测）。各家自述口径见下表（价格为 2026-10 官网标价）：',
  '',
  '| 平台 | 生图 | 生视频 | 起价 | 备注 |',
  '| --- | --- | --- | --- | --- |',
  '| 星流 | 支持 | 支持 | ¥0.2/张 | 新用户有免费额度 |',
  '| 即梦 | 支持 | 支持 | 未查到 | 企业版另询 |',
  '| LibLib | 支持 | 未上线 | ¥0.3/张 | 视频内测中 |',
  '| 吐司 | 支持 | 支持 | ¥0.25/张 | 每日签到送积分 |',
  '| 通义万相 | 支持 | 支持 | ¥0.2/张 | 阿里云体系 |',
  '| 海艺 | 支持 | 支持 | ¥0.28/张 | 老牌站，社区模板多 |',
  '',
  '星流与通义万相起价最低；要大量出图选带免费额度的星流，要视频模板选海艺。即梦的企业版价格没核实到，需要的话我可以再查。',
].join('\n');

const resultResearchTask = resultTask({
  taskText: '调研支持中转站生图生视频的平台',
  resultText: researchBody,
  notices: ['其中一个平台的标签页跳到了结账页，未下单，建议检查浏览器标签页'],
  sources: [
    { title: '星流官网', url: 'https://xingliu.example.com/pricing', visited: true },
    { title: '即梦定价说明', url: 'https://jimeng.example.com/price', visited: true },
    { title: 'LibLib 定价', url: 'https://liblib.example.com/plan', visited: false },
    { title: '通义万相', url: 'https://wanx.example.com/pricing', visited: true },
  ],
  verification: {
    verdict: 'partial',
    evidence: ['5 家价格页已交叉核对', '视频能力来自官方功能页'],
    unchecked: ['即梦企业版价格未核实到'],
    at: now - 8000,
  },
});

const resultCodeTask = resultTask({
  taskText: '给脚本加下载重试与进度上报',
  outcome: 'complete',
  resultText: '已完成：`download.sh` 增加了 3 次重试（指数退避）与百分比进度上报，日志格式不变。改动 3 个文件，共 +190 −34，详见下方文件改动。',
  fileChanges: {
    files: [
      { path: '/Volumes/工作/scripts/download.sh', kind: 'M', add: 42, del: 12, source: 'tool', attribution: 'task' },
      { path: '/Volumes/工作/scripts/lib/retry.sh', kind: 'A', add: 128, del: 0, source: 'tool', attribution: 'task' },
      { path: '/Volumes/工作/scripts/progress.sh', kind: 'M', add: 20, del: 22, source: 'git', attribution: 'task' },
      { path: '/Volumes/工作/scripts/old_report.sh', kind: 'D', add: 0, del: 0, source: 'git', attribution: 'task' },
      { path: '/Volumes/工作/scripts/utils/rename.sh', kind: 'R', add: 0, del: 0, source: 'git', attribution: 'task' },
    ],
    coverage: 'tools+git',
    degraded: null,
    tempExcluded: 2,
  },
});

const resultShortTask = resultTask({
  taskText: '查明天北京天气',
  resultText: '明天北京晴，12–24℃，西南风 3 级，空气质量良。',
  speechText: '明天北京晴，12 到 24 度。',
});

const resultFailedTask = resultTask({
  taskText: '查周五晚 Highspeed 余票',
  outcome: 'unknown',
  verified: false,
  resultText: '已查到周五晚的余票表（见下），但支付页最终确认未能完成，价格以下单页为准。\n\n| 车次 | 余票 | 价格 |\n| --- | --- | --- |\n| G1024 | 有 | ¥553 |\n| G1038 | 少量 | ¥553 |',
  outcomeReason: '支付环节需要短信验证码，未获授权继续',
  verification: { verdict: 'partial', evidence: ['余票表已读回'], unchecked: ['最终价格未在支付页确认'], at: now - 6000 },
});

const resultStoppedTask = resultTask({
  taskText: '整理下载目录里的安装包',
  outcome: 'stopped',
  verified: false,
  resultText: '已把 14 个安装包按类型移进 3 个子文件夹，截图与文档还没归类。',
  speechText: '停下了，安装包已经归好类，剩下的在屏幕上。',
  verification: { verdict: 'unknown', evidence: [], unchecked: ['截图与文档未归类'], at: now - 4000 },
});

const resultFilesMissingTask = resultTask({
  taskText: '把调研结果保存成 md 文件',
  resultText: '已保存为 `中转站调研.md`（含对比表与来源）；附了一张平台功能截图。',
  artifacts: [
    { id: 'art-r1', kind: 'file', name: '中转站调研.md', path: '/Volumes/工作/中转站调研.md', registeredAt: now - 30000, description: '调研正文与对比表' },
    { id: 'art-r2', kind: 'file', name: '功能截图.png', path: '/Volumes/工作/功能截图.png', registeredAt: now - 28000, available: false },
  ],
});

const resultLegacyTask = resultTask({
  taskText: '查五常未来一周天气（旧档案回看）',
  bodySource: 'legacy-delivery',
  resultText: '未来一周多云为主，周末有雨。\n\n- **10/07**：多云 8–18℃\n- **10/08**：小雨 9–17℃',
  speechText: '一周天气查到了，详情在屏幕上。',
});

const resultImagePartialTask = resultTask({
  taskText: '画两张办公室配色方案图',
  outcome: 'partial',
  verified: true,
  resultText: '画好了 2 张，其中 1 张生成成功，另 1 张解码失败（见下方占位），可点重新读取再试一次。\n\n![配色方案 A（成功）](/Users/demo/配色方案A.png) ![配色方案 B（解码失败）](/Users/demo/配色方案B.png)',
  speechText: '画了两张，有一张出了问题，详情在屏幕上。',
  artifacts: [
    { id: 'art-img-ok', kind: 'file', name: '配色方案A.png', path: '/Users/demo/配色方案A.png', registeredAt: now - 20000, description: '暖木色调方案' },
    { id: 'art-img-bad', kind: 'file', name: '配色方案B.png', path: '/Users/demo/配色方案B.png', registeredAt: now - 18000, description: '灰蓝调方案（读取失败）' },
  ],
  verification: { verdict: 'partial', evidence: ['方案 A 已读回确认'], unchecked: ['方案 B 解码失败未展示'], at: now - 5000 },
});

const resultRecheckTask = resultTask({
  taskText: '再核实即梦和可灵有没有站内生成页',
  resultText: '> **更正**：上一轮说可灵没有独立站内生成页，本轮实际打开 klingai.cn 确认有——生成入口在首页右上「创作」。依据：2026-10-10 实际打开页面核对。\n\n两家都有站内生成页：即梦 jianying.com 首页即创作台；可灵 klingai.cn 首页右上「创作」进入。',
  speechText: '核实过了，两家都有生成页，之前有一条要更正，详情在屏幕上。',
  sources: [
    { title: '即梦创作台', url: 'https://jimeng.jianying.com', visited: true },
    { title: '可灵创作入口', url: 'https://klingai.cn', visited: true },
  ],
});

const resultRunningTask: TaskStateSnapshot = {
  ...baseTask,
  taskText: '查一下本周杭州的演唱会排期',
  progressText: '正在读取页面内容',
  startedAt: now - 90000,
};

/* —— 050 像素 parity：逐字复刻 designs/2026-10-10-result-delivery 的场景数据
   （prototype.js 的示例内容），供 snapshot-compare 与视觉稿对 0.5% 门。
   数据来源标注：requirements/050-task-result-delivery/designs/…/prototype.js。 —— */

const P_RESEARCH_Q = '帮我调研一下，现在中转站类型有没有做那种生图生视频的网站？就是在平台上面就可以直接生图生视频。帮我找一下业内比较火的。';
const P_RESEARCH_BODY = `有。**站内直接生图生视频已经是头部中转站的标配**：下面 8 家都能在网页上直接出图出片，另有 2 家只确认了接口、没确认站内生成页。

| 平台 | 站内生成入口 | 代表价格（自述） | 官网 |
|---|---|---|---|
| 302.AI | 图片生成、视频生成栏目＋Media Studio | 按量计费，特价区 8.5 折 | [302.ai](https://302.ai/) |
| AiHubMix | Playground，一条链接最多开 6 个模型 | 与官方价对齐 | [aihubmix.com](https://aihubmix.com/) |
| API易 | 导航「AI出图」入口 | Nano Banana Pro 4K $0.09/张 | [apiyi.com](https://apiyi.com/) |
| RunAPI | 「模型体验」页，文生/图生视频 | Kling O1 $0.05–0.08/秒 | [runapi.ai](https://runapi.ai/zh-CN) |
| KIE.ai | 每个模型都有「试用模型」页 | GPT Image 2 1K $0.03/张 | [kie.ai](https://kie.ai/zh-CN) |
| WaveSpeedAI | Image / Video Generator、Cinema Studio | 按输出计费 | [wavespeed.ai](https://wavespeed.ai/) |
| AI/ML API | AI Playground 沙盒 | $20 起充 | [aimlapi.com](https://aimlapi.com/) |
| fal.ai | 首页在线试用（媒体生成平台，非中转站） | 按输出计费 | [fal.ai](https://fal.ai/) |
| CometAPI | 未确认站内生成页 | 官方价 8 折 | [cometapi.com](https://www.cometapi.com/) |
| OpenRouter | 未确认站内生成页（有视频生成接口） | Veo 3.1 $0.50/秒 | [openrouter.ai](https://openrouter.ai/) |

### 怎么分辨真能站内生成
- 有独立的图片／视频生成页或 Playground，而不只是价格表
- 文档里有视频生成接口和异步任务（提交后轮询）
- 计费单位按张、按秒，而不是按 token

**没核实到**：CometAPI、OpenRouter 的站内生成页；DMXAPI、云雾 API 的页面是脚本渲染，没取到正文。价格和模型数都是各家自述，未经第三方核验。`;
const P_RESEARCH_NOTICE = '后台有个不是本轮打开的标签页跳到了 Stripe 结账页，本轮没有在上面做任何输入或支付。';
const P_RESEARCH_SOURCES: Array<[string, string]> = [
  ['302.AI 官网', '302.ai'], ['AIHubMix 文档：图片/视频生成接口', 'docs.aihubmix.com'], ['AIHubMix Playground 与深链', 'docs.aihubmix.com'], ['API易 文档中心', 'docs.apiyi.com'],
  ['RunAPI 中文站', 'runapi.ai'], ['KIE.ai 中文站', 'kie.ai'], ['WaveSpeedAI 官网', 'wavespeed.ai'], ['AI/ML API 官网', 'aimlapi.com'],
  ['CometAPI 官网', 'cometapi.com'], ['OpenRouter：Video Generation 文档', 'openrouter.ai'], ['fal.ai 官网', 'fal.ai'], ['OhMyGPT 官网（对照：仅文字模型）', 'ohmygpt.com'],
];
const P_FOLLOW_Q = '这些网站的域名列一下发给我呀。';
const P_FOLLOW_A = `按上面调研的 10 家：

1. 302.AI — 302.ai
2. AiHubMix — aihubmix.com（Playground：playground.aihubmix.com）
3. API易 — apiyi.com
4. RunAPI — runapi.ai
5. KIE.ai — kie.ai
6. WaveSpeedAI — wavespeed.ai
7. AI/ML API — aimlapi.com
8. fal.ai — fal.ai
9. CometAPI — cometapi.com
10. OpenRouter — openrouter.ai

没取到正文的两家：DMXAPI — dmxapi.cn，云雾 API — yunwu.ai。`;
const P_RECHECK_Q = '再帮我核实一下 CometAPI 和 OpenRouter 到底有没有站内生成页。';
const P_RECHECK_BODY = `> **更正**：上一轮把 OpenRouter 记为「未确认站内生成页」。本轮登录后在 openrouter.ai 的 Chatroom 里能直接选视频模型生成，属于有站内生成；依据是本轮实际打开的生成页。

**CometAPI 仍然没有站内生成页**：官网只有模型列表和价格，控制台里也只有 API Key 与用量，生成需要走接口。

所以能站内直接生图生视频的是 9 家，CometAPI 只做接口转发。`;
const P_CODE_Q = '给设置页加一个「导出日志」按钮，导出成 zip 放到下载文件夹。';
const P_CODE_BODY = `已在 **设置 → 通用** 里加了「导出日志」按钮：点一下会把 \`hemi.log\` 和最近 7 天的任务档案打包成 zip，存到「下载」并在访达里选中。

### 验证
- \`npm test\` 通过（新增 3 条单测）
- \`npm run typecheck\` 通过
- 实机点了一次，生成 \`hemi-logs-2026-10-10.zip\`（412 KB），解压内容齐全

### 限制
- 任务档案超过 50 MB 时只打包最近 3 天，按钮下方会提示`;
const P_SHORT_Q = '把桌面上的截图都挪到「截图」文件夹。';
const P_SHORT_BODY = '挪好了，23 张截图都移到了 `~/Desktop/截图`，其他文件没动。';
const P_FAIL_Q = '帮我在 12306 抢明天上午去杭州的高铁票。';
const P_FAIL_BODY = `没能下单：后台浏览器里 12306 **没有登录状态**，下单页要求先登录。

已经查到明天上午还有余票的车次：

| 车次 | 出发 | 到达 | 二等座 |
|---|---|---|---|
| G7311 | 08:05 上海虹桥 | 09:08 杭州东 | 有 |
| G7501 | 09:12 上海虹桥 | 10:10 杭州东 | 12 张 |
| G1371 | 10:30 上海虹桥 | 11:27 杭州东 | 有 |

你在浏览器里登录 12306 后告诉我，我接着下单。`;
const P_STOP_Q = '把「旅行」文件夹里的视频都转成 GIF。';
const P_STOP_BODY = '按你的要求停下了。停止前转完了 1 个（`海边.gif`，8.4 MB），另外 4 个没开始。已转好的文件保留在原文件夹。';
const P_IMAGE_Q = '画三张 Hemi 秋天主题的手机壁纸。';
const P_IMAGE_BODY = '画好了三张。**第三张保存时出错**，文件不完整，前两张可以直接用；要的话我可以重画第三张。';
const P_WX_Q1 = '明天北京天气怎么样？';
const P_WX_B1 = '明天北京**晴转多云，3～14℃**，北风 3 级，早晚温差大，出门带件外套。';
const P_WX_Q2 = '那上海呢？';

/** parity 任务快照：outcome/正文/来源/改动按稿件场景逐字复刻。 */
function parityTask(overrides: Partial<TaskStateSnapshot> = {}): TaskStateSnapshot {
  return {
    ...baseTask,
    seq: 7,
    key: 't7-parity',
    taskId: 'task-7-parity',
    conversationId: 'conv-parity',
    phase: 'terminal',
    outcome: 'complete',
    progressText: '已完成',
    resultText: P_RESEARCH_BODY,
    resultVersion: 1,
    bodySource: 'executor',
    speechText: '查到了，详情在屏幕上。',
    notices: [],
    sources: [],
    fileChanges: null,
    readOnly: true,
    verified: true,
    verification: { verdict: 'complete', evidence: [], unchecked: [], at: now - 8000 },
    log: [
      { at: now - 346_000, text: '任务开始。' },
      { at: now - 300_000, text: '阶段成果：前 8 家已确认站内生成' },
      { at: now - 8000, text: '收尾判定已接收：complete' },
    ],
    startedAt: now - 346_000,
    endedAt: now - 8000,
    artifacts: [],
    delivery: null,
    lastAction: null,
    ...overrides,
  };
}

/** 稿件 sources（标题＋域名）→ 产品来源行（url 补 https 前缀）。 */
function paritySources(rows: Array<[string, string]>) {
  return rows.map(([title, domain]) => ({ title, url: `https://${domain}/`, visited: true }));
}

const parityResearch = parityTask({
  taskText: '调研中转站生图生视频平台',
  resultText: P_RESEARCH_BODY,
  notices: [P_RESEARCH_NOTICE],
  sources: paritySources(P_RESEARCH_SOURCES),
  verification: { verdict: 'partial', evidence: ['10 条关键断言已重开页面逐条核对'], unchecked: ['CometAPI、OpenRouter 站内生成页未核实'], at: now - 8000 },
});

const parityCode = parityTask({
  taskText: '设置页加「导出日志」按钮',
  resultText: P_CODE_BODY,
  startedAt: now - 412_000,
  verification: { verdict: 'complete', evidence: ['单测、类型检查通过；实机导出的 zip 已解压核对'], unchecked: [], at: now - 8000 },
  fileChanges: {
    files: [
      { path: 'src/main/ipc/log-export.ipc.mjs', kind: 'A', add: 86, del: 0, source: 'tool', attribution: 'task' },
      { path: 'src/main/ipc/log-export.test.mjs', kind: 'A', add: 58, del: 0, source: 'tool', attribution: 'task' },
      { path: 'src/renderer/src/windows/settings/settings-general.tsx', kind: 'M', add: 42, del: 3, source: 'tool', attribution: 'task' },
      { path: 'src/preload/index.cjs', kind: 'M', add: 4, del: 0, source: 'tool', attribution: 'task' },
      { path: 'scripts/dump-logs.sh', kind: 'D', add: 0, del: 31, source: 'git', attribution: 'task' },
    ],
    coverage: 'tools+git',
    degraded: null,
    tempExcluded: 1,
  },
});

const parityShort = parityTask({
  taskText: '把桌面截图移到「截图」文件夹',
  resultText: P_SHORT_BODY,
  startedAt: now - 9000,
  fileChanges: {
    files: [{ path: '~/Desktop → ~/Desktop/截图', kind: 'M', add: 0, del: 0, source: 'tool', attribution: 'task' }],
    coverage: 'tools',
    degraded: null,
    tempExcluded: 0,
  },
});

const parityFail = parityTask({
  taskText: '12306 抢明天上午去杭州的高铁票',
  outcome: 'denied',
  verified: false,
  resultText: P_FAIL_BODY,
  outcomeReason: '下单需要登录 12306，后台浏览器没有登录状态。',
  startedAt: now - 58_000,
  verification: { verdict: 'unknown', evidence: [], unchecked: ['未登录，未能进入下单'], at: now - 4000 },
  sources: paritySources([['12306 余票查询', '12306.cn']]),
});

const parityStopped = parityTask({
  taskText: '把「旅行」里的视频转成 GIF',
  outcome: 'stopped',
  verified: false,
  resultText: P_STOP_BODY,
  outcomeReason: '你在第 2 个文件时停止了任务。',
  startedAt: now - 41_000,
  verification: { verdict: 'unknown', evidence: [], unchecked: [], at: now - 3000 },
  fileChanges: {
    files: [{ path: '~/Movies/旅行/海边.gif', kind: 'A', add: 0, del: 0, source: 'tool', attribution: 'task' }],
    coverage: 'tools',
    degraded: null,
    tempExcluded: 0,
  },
});

const parityImage = parityTask({
  taskText: '画三张 Hemi 秋天主题手机壁纸',
  outcome: 'partial',
  verified: true,
  resultText: `${P_IMAGE_BODY}\n\n![壁纸-1-落叶.png](/Users/demo/壁纸-1-落叶.png) ![壁纸-2-黄昏.png](/Users/demo/壁纸-2-黄昏.png) ![壁纸-3-银杏.png](/Users/demo/壁纸-3-银杏.png)`,
  startedAt: now - 96_000,
  verification: { verdict: 'partial', evidence: ['前两张已读回核对'], unchecked: ['第三张读回失败'], at: now - 5000 },
  artifacts: [
    { id: 'art-img-ok', kind: 'file', name: '壁纸-1-落叶.png', path: '/Users/demo/壁纸-1-落叶.png', registeredAt: now - 20000, description: '1170×2532 · 2.1 MB' },
    { id: 'art-img-ok2', kind: 'file', name: '壁纸-2-黄昏.png', path: '/Users/demo/壁纸-2-黄昏.png', registeredAt: now - 19000, description: '1170×2532 · 1.9 MB' },
    { id: 'art-img-bad', kind: 'file', name: '壁纸-3-银杏.png', path: '/Users/demo/壁纸-3-银杏.png', registeredAt: now - 18000, description: '无法解码：文件不完整', availability: { state: 'undecodable', reason: 'PNG 文件不完整，无法解码' } },
  ],
});

const parityRecheck = parityTask({
  seq: 9,
  key: 't9-parity',
  taskId: 'task-9-parity',
  taskText: '补查 CometAPI、OpenRouter 站内生成页',
  resultText: P_RECHECK_BODY,
  startedAt: now - 74_000,
  sources: paritySources([['OpenRouter Chatroom（视频模型）', 'openrouter.ai'], ['CometAPI 控制台', 'cometapi.com']]),
});

const parityFilesMissing = parityTask({
  taskText: '调研中转站生图生视频平台',
  resultText: P_RESEARCH_BODY,
  notices: [P_RESEARCH_NOTICE],
  sources: paritySources(P_RESEARCH_SOURCES),
  verification: { verdict: 'partial', evidence: ['10 条关键断言已重开页面逐条核对'], unchecked: ['CometAPI、OpenRouter 站内生成页未核实'], at: now - 8000 },
  artifacts: [{ id: 'art-missing-1', kind: 'file', name: '中转站调研.md', path: '~/Documents/Hemi/默认空间/中转站调研.md', registeredAt: now - 30000, available: false }],
});

const parityWxDone = parityTask({
  taskText: '查明天北京天气',
  resultText: P_WX_B1,
  startedAt: now - 18_000,
  sources: paritySources([['中国天气网 · 北京', 'weather.com.cn']]),
});

const parityWxRunning: TaskStateSnapshot = {
  ...baseTask,
  key: 't8-parity',
  taskId: 'task-8-parity',
  conversationId: 'conv-parity',
  taskText: '查明天上海天气',
  progressText: '正在打开中国天气网上海页…',
  startedAt: now - 7000,
};

/** parity 会话侧栏（稿件 conversations）。 */
function paritySessions() {
  (window as unknown as { __hemiFixtureSessions?: unknown }).__hemiFixtureSessions = {
    sessions: [
      { id: 'conv-parity', title: '中转站生图生视频平台', createdAt: now - 3600_000, updatedAt: now - 60_000, turnCount: 6 },
      { id: 'conv-b', title: '导出日志按钮', createdAt: now - 7200_000, updatedAt: now - 5400_000, turnCount: 4 },
      { id: 'conv-c', title: '秋天主题壁纸', createdAt: now - 86400_000, updatedAt: now - 86000_000, turnCount: 3 },
    ],
    storageError: null,
  };
}

/** 稿件锚点滚动复刻：原型按 anchor scrollIntoView 定位视口（.msg-user /
 *  .result-actions / 指定回合），产品默认滚到底——parity 场景挂载后对齐，
 *  否则纯位移就能贡献 3–6% 像素差（实测 8px 位移＝3.5%）。 */
function ParityAnchor({ selector, index = 0 }: { selector: string; index?: number }) {
  useEffect(() => {
    // VoiceScreen 挂载后的自动滚底（transcripts effect）会覆盖同步滚动——
    // 让过它再锚定（两拍：先滚底执行，再锚定落位）。
    const t1 = window.setTimeout(() => {
      const nodes = document.querySelectorAll(selector);
      nodes[index]?.scrollIntoView({ block: 'start' });
    }, 120);
    const t2 = window.setTimeout(() => {
      const nodes = document.querySelectorAll(selector);
      nodes[index]?.scrollIntoView({ block: 'start' });
    }, 300);
    return () => { window.clearTimeout(t1); window.clearTimeout(t2); };
  }, [selector, index]);
  return null;
}

/** parity 线程：用户原话 → 应承 → 任务结果（与稿件 render 顺序一致）。 */
function parityThread(snap: TaskStateSnapshot, ack: string, question = P_RESEARCH_Q): TranscriptItem[] {
  return [
    { id: 'pu1', text: question, createdAt: now - 360_000, author: 'user' },
    { id: 'ph1', text: ack, createdAt: now - 350_000, author: 'hemi' },
    taskItem(snap),
  ];
}

function parityScreen(
  snap: TaskStateSnapshot,
  ack: string,
  extra: Partial<ScreenProps> = {},
  title = '中转站生图生视频平台',
  question = P_RESEARCH_Q,
): ScreenProps {
  return screenProps({
    sessionState: 'idle',
    callActive: false,
    transcripts: parityThread(snap, ack, question),
    taskSnaps: taskSnapsOf(snap),
    taskState: bundleOf(snap),
    currentConversationId: 'conv-parity',
    conversationTitle: title,
    ...extra,
  });
}

/** 027：多 Tab 预览场景的任务——报告 + md/图片/纯文本 + 一个未支持格式（PDF）。 */
const previewArtifacts: TaskArtifact[] = [
  { id: 'art-md', kind: 'file', name: '调研附录-访谈记录.md', path: '/Users/demo/Documents/调研附录-访谈记录.md', role: 'attachment', registeredAt: now - 60000 },
  { id: 'art-img', kind: 'file', name: '报价对比图.png', path: '/Users/demo/Documents/报价对比图.png', role: 'main', registeredAt: now - 60000 },
  { id: 'art-txt', kind: 'file', name: '核对记录.txt', path: '/Users/demo/Documents/核对记录.txt', role: 'attachment', registeredAt: now - 60000 },
  { id: 'art-pdf', kind: 'file', name: '原始报价单.pdf', path: '/Users/demo/Documents/原始报价单.pdf', role: 'attachment', registeredAt: now - 60000 },
];

const previewTask = deliveredTask(
  reportDelivery,
  { artifacts: previewArtifacts },
);

/** 033：工作区场景的任务——项目内成果（绝对路径 + 工作区归属）。 */
const deliveredWorkspaceTask = deliveredTask(
  {
    schemaVersion: 1,
    form: 'file',
    kind: 'summary',
    title: '报价对比文件',
    summary: '对比表已保存为 Markdown 文件，青木办公含运费总价最低。',
    blocks: [],
    sources: [],
    mainArtifacts: ['art-ws'],
    attachmentArtifacts: [],
    partial: null,
    degraded: [],
    presentationError: null,
    registeredAt: now - 60_000,
  },
  {
    workspace: { id: 'ws-atlas', type: 'project', name: 'Atlas', dir: '/Volumes/Projects/Atlas' },
  },
  [
    { id: 'art-ws', kind: 'file', name: '报价对比.md', path: '/Volumes/Projects/Atlas/报价对比.md', role: 'main', registeredAt: now - 60_000 },
  ],
);

/** 027：Tab 溢出场景——6 个可预览文件 + 报告共 7 个 Tab，当前项在队列中段。 */
const overflowArtifacts: TaskArtifact[] = [
  '报价-青木.md',
  '报价-安和.md',
  '报价-博远.md',
  '交货核对.md',
  '运费说明.md',
  '保修条款.md',
].map((name, index) => ({
  id: `art-f${index + 1}`,
  kind: 'file' as const,
  name,
  path: `/Users/demo/Documents/${name}`,
  role: 'attachment',
  registeredAt: now - 60000,
}));

const overflowTask = deliveredTask(
  reportDelivery,
  {
    artifacts: overflowArtifacts,
    // 当前 Tab 选第 4 个（交货核对.md）：溢出时自动滚入可见区的验收位。
  },
);
const parallelTask: TaskStateSnapshot = {
  ...runningTask,
  seq: 2,
  key: 't2-demo',
  taskId: 'task-2-demo',
  taskText: '再用浏览器查一下发布会消息',
  progressText: '正在读取网页 news.example.com',
  log: [{ at: now - 8000, text: '任务开始。' }],
};

/** 005 对话流任务卡条目：卡跟随触发它的消息原位保留。 */
function taskItem(snap: TaskStateSnapshot): TranscriptItem {
  return {
    id: `task-${snap.seq}`,
    text: snap.taskText,
    createdAt: now,
    author: 'hemi',
    kind: 'task',
    taskSeq: snap.seq,
    taskKey: snap.key ?? undefined,
    taskId: snap.taskId ?? undefined,
  };
}

function taskSnapsOf(...snaps: TaskStateSnapshot[]) {
  // 键位与产品一致（page.tsx cardKeyOf）：taskId 优先——快照表和卡条目的
  // 查找链都用 taskId 先查；此前 key 优先曾让 025 场景的卡静默缺失。
  return Object.fromEntries(
    snaps.map((snap) => [snap.taskId ?? snap.key ?? `s${snap.seq}`, snap]),
  );
}

/** 基础两句对话＋任务卡条目（任务场景的最小线程）。 */
function taskThread(snap: TaskStateSnapshot): TranscriptItem[] {
  return [
    ...transcripts([
      [`${snap.taskText}。`, 'user'],
      ['好，交给我吧。', 'hemi'],
    ]),
    taskItem(snap),
  ];
}

/**
 * 阶段简报成组（2026-10-09 用户反馈 conv-mv0nx45i：四条简报各挂一遍任务名
 * 胶囊、正文与正式回答同重，对话流很碎）。done=true 时任务已收尾，中途插了
 * 一轮闲聊（标识只在离开任务卡上下文时出现），简报超过折叠阈值。
 */
function stageBriefScene(done: boolean) {
  const question = '那它这个 Windows 的部分设计的合理吗？';
  const stages = [
    '已完成 043 需求与平台审计通读，开始核查实施情况',
    '已核实 B1/B2a 真实落地，继续核查能力消费与工具注册边界',
    '发现关键缺口：能力快照未接入工具注册与系统提示词，继续核实',
    '平台事实仅注入诊断块（机器可读），未写入模型可读能力说明，继续核验',
    ...(done ? ['对照 darwin 后端补齐能力缺口清单，开始整理结论', '结论成文：分层门控思路合理，缺口集中在能力声明与工具注册两处'] : []),
  ];
  const startedAt = now - 180_000;
  const snap: TaskStateSnapshot = {
    ...baseTask,
    seq: 3,
    key: 't3-stage',
    taskId: 'task-3-stage',
    inputSource: 'voice',
    taskText: question,
    startedAt,
    phase: done ? 'terminal' : 'running',
    outcome: done ? 'complete' : null,
    endedAt: done ? now - 5_000 : undefined,
    progressText: done ? '分层门控合理，缺口在能力声明与工具注册' : '正在执行命令',
    stageText: stages.at(-1),
    resumedFrom: { taskId: 'task-2-prev', taskText: '本项目现在在 Windows 上面可以正常运行吗？' },
    log: [
      { at: startedAt, text: '任务开始。' },
      ...stages.map((text, index) => ({ at: startedAt + (index + 1) * 18_000, text: `阶段成果：${text}` })),
    ],
    lastAction: { tool: 'bash', args: { command: 'wc -l src/main/platform/backend-win32.mjs' } },
    resultText: done
      ? '整体设计是合理的：平台能力按「先探针、后开放」分层门控，Windows 上没验证过的能力一律如实标成不可用，不会假装能用。真正的缺口有两处——能力快照还没接进工具注册和系统提示词，模型并不知道哪些工具在 Windows 上用不了；平台事实只写进了机器可读的诊断块。建议下一步把能力快照接进工具注册，再补一段模型可读的能力说明。'
      : null,
  };
  const stageItems = (from: number, to: number): TranscriptItem[] =>
    stages.slice(from, to).map((text, index) => ({
      id: `stage-${from + index}`,
      text,
      createdAt: startedAt + (from + index + 1) * 18_000,
      author: 'hemi' as const,
      taskId: snap.taskId ?? undefined,
    }));
  const items: TranscriptItem[] = [
    { id: 'sb-q', text: question, createdAt: startedAt - 40_000, author: 'user', inputSource: 'voice' },
    {
      id: 'sb-ack',
      text: '我接着刚才 Windows 那个任务，去看看这部分设计合不合理。',
      createdAt: startedAt - 1_000,
      author: 'hemi',
      thinking: { text: 'The user wants the Windows design evaluated; resume task-2 with execute_task.', durationMs: 3_390 },
    },
    { ...taskItem(snap), createdAt: startedAt },
    ...(done
      ? [
          ...stageItems(0, 1),
          { id: 'sb-chat-q', text: '顺便问下，win 安装包多大？', createdAt: startedAt + 30_000, author: 'user' as const, inputSource: 'text' as const },
          { id: 'sb-chat-a', text: 'v0.5.2 的 Windows 安装包是 129 MB。', createdAt: startedAt + 32_000, author: 'hemi' as const },
          ...stageItems(1, stages.length),
          { id: `task-result:${snap.taskId}:complete`, text: snap.resultText ?? '', createdAt: now - 5_000, author: 'hemi' as const, taskId: snap.taskId ?? undefined },
        ]
      : stageItems(0, stages.length)),
  ];
  return (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: items,
        taskSnaps: taskSnapsOf(snap),
        taskState: bundleOf(snap),
        currentConversationId: 'conv-fixture',
        conversationTitle: '项目在Windows上的运行情况',
      })}
    />
  );
}

/** 024 文字输入场景的基础两句对话。 */
function baseChat(): TranscriptItem[] {
  return transcripts([
    ['帮我把下载的图片按月份整理好。', 'user'],
    ['好，交给我。', 'hemi'],
  ]);
}

type ScreenProps = Parameters<typeof VoiceScreen>[0];

/**
 * VoiceScreen 场景的桥兜底：真实桥上的方法在 fixtures 里多为 no-op。
 * 覆盖 VoiceScreen/任务卡/权限拨盘/会话弹窗用到的全部读取方法——
 * 注意 ?. 只短路「桥不存在」，不短路「方法缺失」。
 */
/** 场景级侧栏会话覆盖（026 像素 parity 用）：场景渲染前置 window 变量即可。 */
const fixtureSessionsOverride = () =>
  (window as unknown as { __hemiFixtureSessions?: { sessions: ConversationSummary[]; storageError: string | null } })
    .__hemiFixtureSessions;

/** 033：工作区登记桩数据（磁盘路径英文、界面中文名映射——与产品口径一致）。 */
const fixtureWorkspaceState = (overrides: Partial<WorkspaceState> = {}): WorkspaceState => ({
  default: {
    id: 'default',
    type: 'default',
    name: '默认空间',
    dir: '/Users/demo/Library/Application Support/hemi/workspace/default',
    status: 'ok',
  },
  projects: [
    { id: 'ws-atlas', type: 'project', name: 'Atlas', dir: '/Volumes/Projects/Atlas', status: 'ok' },
    { id: 'ws-studio', type: 'project', name: 'Studio', dir: '/Users/demo/Projects/Studio', status: 'ok' },
  ],
  ...overrides,
});

/** 049：远端工作区场景数据（devbox 上的 atlas——芯片/菜单/警示的像素对照）。 */
const fixtureRemoteWorkspaceState = (overrides: Partial<WorkspaceState> = {}): WorkspaceState => ({
  default: {
    id: 'default',
    type: 'default',
    name: '默认空间',
    dir: '/Users/demo/Library/Application Support/hemi/workspace/default',
    status: 'ok',
  },
  projects: [
    {
      id: 'ws-remote-atlas', type: 'project', name: 'atlas', dir: '/home/dev/projects/atlas',
      status: 'ok', host: 'devbox', remoteHome: '/home/dev',
    },
    { id: 'ws-atlas', type: 'project', name: 'Atlas', dir: '/Volumes/Projects/Atlas', status: 'ok' },
  ],
  ...overrides,
});

const stubBridgeMethods: Record<string, (...args: unknown[]) => unknown> = {
  // 066 顶栏打开工作区目录：默认 finder；交互验收脚本可覆写断言调用参数。
  getWorkspaceOpenTarget: async () => ({ target: 'finder' }),
  setWorkspaceOpenTarget: async (target: unknown) => ({ target: String(target ?? 'finder') }),
  openWorkspaceDir: async (id: unknown, target: unknown) => ({ ok: true, target: String(target ?? 'finder'), id: String(id ?? '') }),
  // 044 应用内更新：设置页通用页常驻渲染 AboutUpdateSection，挂载即读状态
  // （缺方法会 TypeError 炸 console）。场景默认 idle，多状态场景覆写。
  updaterGetState: async () => ({
    supported: true,
    phase: 'idle',
    currentVersion: '0.3.0',
    availableVersion: null,
    progressPercent: null,
    errorMessage: null,
  }),
  updaterCheck: async () => ({ ok: true }),
  updaterDownload: async () => ({ ok: true }),
  updaterInstall: () => ({ ok: true }),
  onUpdaterChanged: () => () => {},
  // 2026-10-05 复制通道桩：真走页面剪贴板并如实回报（交互验收脚本会读
  // 系统剪贴板核对，不能假回 ok）。
  copyText: async (text: unknown) => {
    try {
      await navigator.clipboard.writeText(String(text));
      return { ok: true };
    } catch {
      return { ok: false };
    }
  },
  getSkillState: async () => ({
    installed: [
      {
        id: 'skillsmp:openclaw-openclaw-skills-nano-pdf-skill-md', name: 'nano-pdf', title: 'nano-pdf',
        description: '用自然语言指令编辑 PDF：合并、拆分、加水印与提取页。', version: '1f2a3b4',
        sha256: 'd'.repeat(64), origin: 'skillsmp', author: 'openclaw', enabled: true,
        files: ['SKILL.md', 'references/examples.md'], sourcePath: null,
        github: {
          entryId: 'openclaw-openclaw-skills-nano-pdf-skill-md', repo: 'openclaw/openclaw', path: 'skills/nano-pdf',
          commit: '1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a',
          url: 'https://skillsmp.com/creators/openclaw/openclaw/skills-nano-pdf',
          githubUrl: 'https://github.com/openclaw/openclaw/tree/main/skills/nano-pdf',
        },
        updateAvailable: false, sourceWithdrawn: false,
      },
    ],
    catalog: [
      { id: 'source-check', name: 'source-check', title: '资料核对', description: '核对时效性事实、原始来源和引用链；适合新闻、产品信息与资料查证。', author: 'Hemi', version: '1.0.0', package: 'bundles/source-check-1.0.0.json', sha256: 'a'.repeat(64), files: ['SKILL.md', 'references/checklist.md'], installedId: null },
      { id: 'meeting-notes', name: 'meeting-notes', title: '会议纪要', description: '将会议记录或转写整理成结论、行动项和待确认问题；适合会后纪要。', author: 'Hemi', version: '1.0.0', package: 'bundles/meeting-notes-1.0.0.json', sha256: 'b'.repeat(64), files: ['SKILL.md', 'references/template.md'], installedId: null },
      { id: 'draft-review', name: 'draft-review', title: '文稿校对', description: '校对中文文稿的错字、语义、结构与事实表述；适合邮件、方案和报告定稿。', author: 'Hemi', version: '1.0.0', package: 'bundles/draft-review-1.0.0.json', sha256: 'c'.repeat(64), files: ['SKILL.md', 'references/review-list.md'], installedId: null },
    ],
    catalogSource: 'built-in',
    catalogError: '',
    storageError: '',
    checkedAt: null,
    publishedAt: '2026-10-01',
    mpSearch: null,
  }),
  refreshSkillCatalog: async () => ({ ok: false, reason: 'fixture 离线' }),
  importLocalSkill: async () => ({ ok: false, cancelled: true }),
  installMarketSkill: async () => ({ ok: false, reason: 'fixture 不安装文件' }),
  setSkillEnabled: async () => ({ ok: false, reason: 'fixture 不修改状态' }),
  removeSkill: async () => ({ ok: false, reason: 'fixture 不修改状态' }),
  readSkill: async () => ({ ok: true, text: '# 技能原文\n' }),
  revealSkill: async () => ({ ok: true }),
  // 034 SkillsMP：搜索/预览/安装/检查更新桩——只给确定数据，不触网络。
  searchSkillsMp: async (payload: unknown = {}) => ({
    ok: true, live: true, query: (payload as { query?: string }).query ?? 'pdf', sortBy: 'stars', checkedAt: Date.now(),
    skills: [
      { id: 'openclaw-openclaw-skills-nano-pdf-skill-md', name: 'nano-pdf', author: 'openclaw', description: 'Edit PDFs with natural-language instructions using the nano-pdf CLI.', contentLanguage: 'en', githubUrl: 'https://github.com/openclaw/openclaw/tree/main/skills/nano-pdf', skillUrl: 'https://skillsmp.com/creators/openclaw/openclaw/skills-nano-pdf', stars: 390831, updatedAt: 1779015027 },
      { id: 'demo-excel-helper-skill-md', name: 'excel-helper', author: 'demo-org', description: '生成与核对 Excel 公式、透视表和数据清洗步骤。', contentLanguage: 'zh', githubUrl: 'https://github.com/demo-org/skills/tree/main/excel-helper', skillUrl: 'https://skillsmp.com/creators/demo-org/skills-excel-helper', stars: 2140, updatedAt: 1778900000 },
      { id: 'demo-git-review-skill-md', name: 'git-review', author: 'demo-org', description: '按团队规范审查 git 变更并生成提交说明。', contentLanguage: 'en', githubUrl: 'https://github.com/demo-org/skills/tree/main/git-review', skillUrl: 'https://skillsmp.com/creators/demo-org/skills-git-review', stars: 962, updatedAt: 1778700000 },
    ],
    pagination: { page: 1, totalPages: 1, total: 3, hasNext: false },
  }),
  previewSkillsMp: async () => ({
    ok: true,
    preview: {
      skillsmpId: 'openclaw-openclaw-skills-nano-pdf-skill-md', entryName: 'nano-pdf', author: 'openclaw',
      skillUrl: 'https://skillsmp.com/creators/openclaw/openclaw/skills-nano-pdf',
      githubUrl: 'https://github.com/openclaw/openclaw/tree/main/skills/nano-pdf',
      name: 'nano-pdf', title: 'nano-pdf', description: '用自然语言指令编辑 PDF：合并、拆分、加水印与提取页。',
      repo: 'openclaw/openclaw', dirPath: 'skills/nano-pdf', commit: '1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a',
      files: [{ path: 'SKILL.md', size: 2048 }, { path: 'references/examples.md', size: 512 }],
      totalBytes: 2560, bundleSha256: 'e'.repeat(64),
      skillMd: '---\nname: nano-pdf\ndescription: Edit PDFs with natural-language instructions.\n---\n\n# PDF 编辑\n\n按用户指令合并、拆分或标注 PDF；先确认输入输出路径再操作。\n',
    },
  }),
  installSkillsMp: async () => ({ ok: false, reason: 'fixture 不安装文件' }),
  checkSkillsMpUpdate: async () => ({ ok: true, status: 'up-to-date', commit: '1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a' }),
  getConfig: async () => ({ hasApiKey: true, resourceId: '', endpoint: '', keyStoredSecurely: false }),
  getMicrophonePermissionStatus: async () => 'granted',
  // 028：附件读取桩——fixtures 场景给确定内容，附件 Tab 不再「读取不可用」。
  // 图片附件（att-img*）返回 data URL，走 file-preview 的图片渲染分支。
  readAttachmentPreview: async (_conversationId, attachmentId) =>
    String(attachmentId ?? '').startsWith('att-img')
      ? { ok: true, kind: 'image', dataUrl: FIXTURE_IMAGE_DATA_URL }
      : {
          ok: true,
          kind: 'text',
          markdown: true,
          text: '# 项目笔记\n\n- 附件预览的 fixtures 桩内容。\n- 正文与成果预览共用同一渲染器。',
        },
  openAttachmentSource: async () => ({ ok: true, message: 'fixtures 桩：已请求打开原文件' }),
  resolveConversationLink: async (_conversationId, href) => ({
    ok: true, artifactId: 'fixture-local-image', name: '发布后的作品管理页.png', path: href,
  }),
  readConversationDeliverable: async (_conversationId, artifactId) => artifactId === 'fixture-local-image' ? ({
    ok: true, kind: 'image', name: '发布后的作品管理页.png', dataUrl: FIXTURE_IMAGE_DATA_URL,
  }) : ({
    ok: true, kind: 'video', name: '预览样片.webm', path: '/Users/demo/Movies/预览样片.webm',
    mediaUrl: new URL('./fixtures/preview-video.webm', window.location.href).href,
  }),
  openConversationDeliverable: async () => ({ ok: true, message: 'fixtures 桩：已请求系统打开' }),
  getUiPreferences: async () => ({
    floatingOrbEnabled: true,
    primarySpeakerEnabled: true,
    globalPushToTalkEnabled: true,
    globalPushToTalkReady: true,
    globalPushToTalkListening: true,
  }),
  // 034 v3：设置页常驻挂载记忆区块（MemorySection 不随 tab 切换卸载），
  // 所有 settings 场景挂载即读 getMemoryStatus——缺方法会 TypeError 炸
  // console（settings-model 曾因此过不了零错误门）；悬浮球开关桩同补。
  getMemoryStatus: async () => ({ exitSummaryEnabled: true, memoryDir: '~/Library/Application Support/hemi/memory' }),
  setMemoryExitSummary: async (next: { enabled?: boolean } | unknown) => ({
    exitSummaryEnabled: (next as { enabled?: boolean })?.enabled ?? true,
    memoryDir: '~/Library/Application Support/hemi/memory',
  }),
  setFloatingOrbEnabled: async (next: unknown) => ({ floatingOrbEnabled: next === true }),
  // 031 模型组目录：settings-model 场景静态渲染需要（缺方法会把错误文案画进
  // 截图）；目录形状与 settings-model-profiles 场景的 fixture 同源，动作回执
  // 原样确认（fixtures 不做真实编辑）。
  listModelProfiles: async () => ({
    version: 2,
    defaultModelId: 'mp-deep/m-chat',
    providers: [
      {
        id: 'mp-deep',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        hasApiKey: true,
        keyStoredSecurely: true,
        updatedAt: now - 86_400_000,
        models: [
          { id: 'm-chat', modelKey: 'mp-deep/m-chat', model: 'deepseek-chat', thinkingLevel: 'default', supportsVision: false, visionModel: '', isDefault: true },
          { id: 'm-reasoner', modelKey: 'mp-deep/m-reasoner', model: 'deepseek-reasoner', thinkingLevel: 'intermediate', supportsVision: false, visionModel: '', isDefault: false },
        ],
      },
    ],
  }),
  saveModelProfile: async () => ({ ok: true }),
  removeModelProfile: async () => ({ ok: true }),
  setDefaultModelProfile: async () => ({ ok: true }),
  // 2026-10-08：上次主脑模型选择记录桩（fixtures 不做真实落盘）。
  setLastConversationModel: async () => ({ ok: true, lastConversationModelKey: null }),
  testModelProfile: async () => ({ ok: true, latencyMs: 18, resolvedModel: 'stub', sample: 'pong' }),
  // 041 拉取模型列表桩：回内置样例（场景静态渲染不真发请求）。
  listRemoteModels: async () => ({ ok: true, models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder'] }),
  getTextModelConfig: async () => ({ hasApiKey: true, model: 'stub', baseUrl: '', keyStoredSecurely: false }),
  // 033：思考强度拨盘的落库桩（回执原样返回档位，供拨盘回显）。
  setThinkingLevel: async (level: unknown) => ({ thinkingLevel: level }),
  testTextModel: async () => ({ ok: true, latencyMs: 12, resolvedModel: 'stub', sample: 'pong' }),
  getTtsConfig: async () => ({ ttsEnabled: false, ttsVoice: '', ttsResourceId: '', hasApiKey: false, keyStoredSecurely: false }),
  getLastConversation: async () => null,
  getTaskState: async () => null,
  getUiState: async () => initialUiState,
  onUiState: () => () => {},
  onTaskState: () => () => {},
  onAsrEvent: () => () => {},
  onLlmDelta: () => () => {},
  onTtsAudio: () => () => {},
  onTtsState: () => () => {},
  onContextState: () => () => {},
  getContextState: async () => ({ objects: [] }),
  accessGetState: async () => ({
    health: 'ready', revision: 1, grants: [], resources: [], writeFailure: null,
  }),
  accessListApplications: async () => [
    { name: '微信', bundleId: 'com.tencent.xinWeChat', ref: { bundleId: 'com.tencent.xinWeChat' }, running: true },
    { name: '访达', bundleId: 'com.apple.finder', ref: { bundleId: 'com.apple.finder' }, running: true },
  ],
  accessPickDirectory: async () => null,
  accessAddApplication: async () => ({ ok: true, revision: 2 }),
  accessAddDirectory: async () => ({ ok: true, revision: 3 }),
  accessSetDirectoryCapability: async () => ({ ok: true }),
  accessSetUiEnabled: async () => ({ ok: true }),
  accessRemoveGrant: async () => ({ ok: true }),
  accessRevokeResource: async () => ({ ok: true }),
  onAccessChanged: () => () => {},
  getFloatingCaptionLayout: async () => ({ anchorX: 220, maxWidth: 300, placement: 'above' }),
  onFloatingCaptionLayout: () => () => {},
  onFloatingDragDetected: () => () => {},
  // 2026-09-24 悬停重置广播桩：把回调挂到 window 上，验收脚本可以模拟
  // 主进程的「窗口隐藏/重现」事件，验证 data-hovered 被清、球回落半透明。
  onFloatingVisibilityChanged: (callback: unknown) => {
    (window as unknown as { __hemiTestVisibilityCb?: (v: boolean) => void }).__hemiTestVisibilityCb =
      callback as (v: boolean) => void;
    return () => {};
  },
  getBrowserControl: async () => ({ browserControlEnabled: false }),
  getShellProxy: async () => ({ enabled: false, applied: false }),
  setShellProxy: async (enabled: unknown) => ({ enabled: enabled === true, applied: enabled === true }),
  getBrowserBridge: async () => ({ state: 'off' }),
  getBrowserAct: async () => ({ enabled: false, baseUrl: '', model: 'typesafe-ai/jev', hasApiKey: false }),
  setBrowserAct: async (next: unknown) => {
    const payload = (next ?? {}) as { enabled?: boolean; baseUrl?: string; model?: string; apiKey?: string };
    return { enabled: payload.enabled ?? false, baseUrl: payload.baseUrl ?? '', model: payload.model ?? 'typesafe-ai/jev', hasApiKey: Boolean(payload.apiKey) };
  },
  testBrowserAct: async () => ({ ok: true, latencyMs: 12, resolvedModel: 'typesafe-ai/jev', confidence: 1 }),
  getWebSearch: async () => ({ enabled: false, hasApiKey: false, provider: 'tavily' }),
  setWebSearch: async (next: unknown) => {
    const payload = (next ?? {}) as { enabled?: boolean; apiKey?: string };
    return {
      enabled: payload.enabled ?? false,
      hasApiKey: Boolean(payload.apiKey),
      provider: 'tavily',
    };
  },
  getTaskHistory: async () => ({ tasks: [], storageError: null }),
  // 033：工作区通道桩（选择/移除回执带同一份登记状态，评审交互可点）。
  getWorkspaceState: async () => fixtureWorkspaceState(),
  addWorkspaceFolder: async () => ({
    ok: true,
    workspace: { id: 'ws-new', type: 'project' as const, name: '新建项目', dir: '/Users/demo/Projects/新建项目', status: 'ok' as const },
    state: fixtureWorkspaceState({
      projects: [
        { id: 'ws-new', type: 'project' as const, name: '新建项目', dir: '/Users/demo/Projects/新建项目', status: 'ok' as const },
        { id: 'ws-atlas', type: 'project' as const, name: 'Atlas', dir: '/Volumes/Projects/Atlas', status: 'ok' as const },
        { id: 'ws-studio', type: 'project' as const, name: 'Studio', dir: '/Users/demo/Projects/Studio', status: 'ok' as const },
      ],
    }),
  }),
  removeWorkspace: async (id: unknown) => ({ ok: true, state: fixtureWorkspaceState({ projects: [] }) , removed: String(id) }),
  // 049：远端工作区通道桩（对话框校验/重试连接的交互评审可点）。
  addRemoteWorkspace: async (host: unknown, dir: unknown) => ({
    ok: true,
    workspace: {
      id: 'ws-remote-new', type: 'project' as const, name: String(dir ?? '/home/dev/projects/new').split('/').pop() || 'new',
      dir: String(dir ?? '/home/dev/projects/new'), status: 'ok' as const,
      host: String(host ?? 'devbox'), remoteHome: '/home/dev',
    },
    state: fixtureRemoteWorkspaceState(),
  }),
  probeRemoteWorkspace: async (id: unknown) => ({
    ok: true,
    state: fixtureRemoteWorkspaceState(),
    probed: String(id),
  }),
  downloadArtifact: async () => ({ ok: true, path: '/Users/demo/Downloads/report.md' }),
  // 侧栏的演示会话（与设计稿默认场景同名，供像素对照；末条超长标题验省略号）。
  listConversations: async () =>
    fixtureSessionsOverride() ?? ({
    sessions: [
      { id: 'conv-procurement', title: '团队工作笔记本采购', createdAt: now - 3600_000, updatedAt: now - 60_000, turnCount: 6 },
      // P1 时间分组取证：今天 / 昨天 / 7 天内 / 更早各至少一条（「昨天」取 30 小时前，跨自然日稳定落在昨天或 7 天内）
      { id: 'conv-files', title: '整理下载文件夹', createdAt: now - 86400_000, updatedAt: now - 7200_000, turnCount: 4 },
      { id: 'conv-weather', title: '明天北京天气', createdAt: now - 108000_000, updatedAt: now - 108000_000, turnCount: 2 },
      { id: 'conv-research', title: '工作笔记本方案调研', createdAt: now - 345600_000, updatedAt: now - 259200_000, turnCount: 9 },
      { id: 'conv-long', title: '超长标题场景：帮我把下载文件夹里所有截图按月份归档并且生成一份索引清单发给团队', createdAt: now - 2000000_000, updatedAt: now - 1728000_000, turnCount: 2 },
    ],
    storageError: null,
  }),
  renameConversation: async (id: unknown, title: unknown) => ({ ok: true, session: { id: String(id), title: String(title), createdAt: now, updatedAt: now, turnCount: 0 } }),
  reorderConversations: async () => ({ ok: true, count: 4 }),
  // 档案变更广播桩：fixtures 不广播，订阅方拿到的退订函数为空操作。
  onConversationsChanged: () => () => {},
  getUsageLedger: async () => ({ conversationId: '', records: [] }),
  onUsageChanged: () => () => {},
  // 025 交付通道桩（产物打开与报告保存都回成功，便于评审交互）。
  openArtifact: async () => ({ ok: true }),
  saveDeliveryReport: async () => ({ ok: true, path: '/Users/demo/Downloads/调研报告.html' }),
  openDeliverySource: async () => ({ ok: true }),
  readDeliveryImage: async (...args: unknown[]) => {
    const artifactId = String(args[1] ?? '');
    if (artifactId === 'art-img-ok' || artifactId === 'art-img-ok2') return { ok: true, dataUrl: fixtureQuoteChart() };
    if (artifactId === 'art-img-bad') return { ok: false, message: 'PNG 文件不完整，无法解码' };
    return { ok: false, message: 'fixtures 场景没有配图' };
  },
  // 027：预览面板路径点击（受控浏览器打开）——桩回成功。
  openArtifactPreviewFile: async () => ({ ok: true }),
  // 026/027 预览桩：按 artifactId 分流 Markdown/纯文本/图片/失效。
  readArtifactPreview: async (...args: unknown[]) => {
    const artifactId = String(args[1] ?? '');
    // AC-30 并行场景：侦察的交付文件正文（预览面读出的成果来源）。
    if (artifactId === 'art-p1') {
      return {
        ok: true, kind: 'text' as const, markdown: true,
        text: '# 季度差异对照\n\n报表差异结论：Q3 与 Q2 相比，收入列多了两行明细、备注列少了一列；明细数据共 1280 行一致。\n\n| 项目 | Q2 | Q3 |\n| --- | --- | --- |\n| 收入明细行 | 1278 | 1280 |\n| 备注列 | 1 | 0 |',
      };
    }
    if (artifactId === 'art-gone') return { ok: false, message: '文件不在原位置，可能已被移动或删除' };
    if (artifactId === 'art-img') return { ok: true, kind: 'image' as const, dataUrl: fixtureQuoteChart() };
    if (artifactId === 'p-md') {
      // 027 像素 parity：对齐候选稿 prototype 的 markdownMarkup 逐字段。
      return {
        ok: true,
        kind: 'text' as const,
        markdown: true,
        text: '已保存的 Markdown 文件\n\n# 办公椅核对说明\n\n按含运费总价比较，青木办公当前最低。交货日期有 1 项待确认。\n\n## 比较口径\n\n统一按报价单上的含税单价与本次配送运费计算合计。报价单没有列出的折扣和安装费用暂未计入。\n\n- 青木办公：¥1,280 + ¥80 = **¥1,360**\n- 安和家具：¥1,350 + ¥110 = ¥1,460\n- 博远办公：¥1,430 + ¥100 = ¥1,530\n\n## 下单前核对\n\n- 确认青木办公的到货日期与运费是否覆盖当前地址。\n- 确认博远办公报价单 C 的交货日期。\n- 检查三份报价的有效期与退换条件。\n\n这份说明作为独立文件保存；左侧报告是 Hemi 的可阅读结果，两者入口和身份不同。',
      };
    }
    if (artifactId === 'art-txt') {
      return {
        ok: true,
        kind: 'text' as const,
        markdown: false,
        text: '办公椅报价核对记录\n\n核对时间：2026-09-27 09:41\n\n1. 青木办公 ¥1,280 + ¥80 = ¥1,360\n2. 安和家具 ¥1,350 + ¥110 = ¥1,460\n3. 博远办公 ¥1,430 + ¥100 = ¥1,530\n\n待确认：报价单 C 的交货日期未填写。',
      };
    }
    return {
      ok: true,
      kind: 'text' as const,
      markdown: artifactId !== 'art-notes',
      text: artifactId === 'art-notes'
        ? '整理下载文件夹 · 执行说明\n\n1. 按月份建目录\n2. 移动截图\n3. 生成索引清单'
        : '# 调研附录 · 访谈记录\n\n按同一口径整理三家供应商的补充说明。\n\n## 口径\n\n- 含税单价加本次配送运费\n- 未列出的折扣与安装费不计入\n\n## 待核对\n\n- 报价单 C 的交货日期\n- 三份报价的有效期与退换条件',
    };
  },
  logLine: () => {},
};

/** 预览图片桩：本地绘制的三家报价对比 SVG（data URL，供 <img> 直读）。 */
function fixtureQuoteChart() {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="480">'
    + '<rect width="800" height="480" fill="#fbfcfb"/>'
    + '<rect x="90" y="220" width="130" height="180" fill="#206b54"/>'
    + '<rect x="345" y="160" width="130" height="240" fill="#527d8b"/>'
    + '<rect x="600" y="100" width="130" height="300" fill="#846b89"/>'
    + '<text x="90" y="430" font-size="22" fill="#47554c">青木 ¥1,360</text>'
    + '<text x="345" y="430" font-size="22" fill="#47554c">安和 ¥1,460</text>'
    + '<text x="600" y="430" font-size="22" fill="#47554c">博远 ¥1,530</text>'
    + '</svg>';
  const bytes = Array.from(new TextEncoder().encode(svg));
  return `data:image/svg+xml;base64,${window.btoa(String.fromCharCode(...bytes))}`;
}

/**
 * 026 R-10 交互走查用包装：复刻 page.tsx 的「继续讨论」闭环接线（任务 chip、
 * 空草稿播种、聚焦信号），让 fixtures 场景可真实演练该路径。仅走查相关场景
 * 使用；普通场景仍直接渲染 VoiceScreen。
 */
function WalkthroughVoiceScreen(props: React.ComponentProps<typeof VoiceScreen>) {
  const [discussContext, setDiscussContext] = useState<{ taskId: string; title: string } | null>(null);
  const [focusToken, setFocusToken] = useState(0);
  const [draft, setDraft] = useState(props.textDraft ?? '');
  return (
    <VoiceScreen
      {...props}
      textDraft={draft}
      onTextDraftChange={setDraft}
      discussContext={discussContext}
      onClearDiscussContext={() => setDiscussContext(null)}
      composerFocusToken={focusToken}
      onContinueDiscuss={(snap) => {
        const title = snap.delivery?.title?.trim() || snap.taskText.trim();
        if (!title) return;
        setDiscussContext({ taskId: snap.taskId ?? '', title });
        setDraft((current) => (current.trim() ? current : `关于「${title}」，我想继续讨论：`));
        setFocusToken((token) => token + 1);
      }}
    />
  );
}

/** 060：可控模型输出，经产品投影验证分段回答只在收口末尾复制。 */
function ReplyCopyFixture() {
  const variant = new URLSearchParams(window.location.search).get('copy-state') ?? 'done';
  const [settled, setSettled] = useState(variant !== 'live');
  useEffect(() => {
    const settle = () => setSettled(true);
    window.addEventListener('hemi-fixture:reply-settled', settle);
    return () => window.removeEventListener('hemi-fixture:reply-settled', settle);
  }, []);
  const runId = 'reply-copy-run';
  const task = { ...completeTask, taskId: 'reply-copy-task', toolCallId: 'reply-copy-call', agent: 'explorer', agentTitle: '侦察', taskText: '核对本次资料', log: [] };
  const parts: Array<{ partId: string; kind: string } & Record<string, unknown>> = [
    { partId: 'think-1', kind: 'thinking', content: '思考内容不应复制。', startedAt: now - 5000, endedAt: now - 4000 },
    ...(variant === 'thought-only' ? [] : [
      { partId: 'text-1', kind: 'text', content: '先核对资料，再给你完整结论。' },
      { partId: 'task-1', kind: 'delegation', toolCallId: task.toolCallId, taskId: task.taskId, status: 'done' },
      ...(variant === 'trailing-task' ? [] : [
        { partId: 'think-2', kind: 'thinking', content: '检查工具结果，不应复制。', startedAt: now - 3000, endedAt: now - 2000 },
        { partId: 'text-2', kind: 'text', content: variant === 'repeated' ? '先核对资料，再给你完整结论。' : '核对完成：正文分段展示，整轮只保留一个复制入口。' },
      ]),
    ]),
  ];
  const snapshot: FlowSnapshotView = {
    schemaVersion: 1, conversationId: 'reply-copy-conversation', revision: settled ? 2 : 1, generation: 1,
    phase: settled ? 'idle' : 'running', activeRunId: settled ? null : runId, queuePaused: false,
    pending: [], artifacts: {}, permissions: {}, pendingReports: [],
    tasks: { [task.taskId]: task },
    runs: { [runId]: { runId, startedAt: now - 6000, closedAt: settled ? now : null, outcome: variant === 'stopped' ? 'stopped' : 'complete' } },
    timeline: [
      { kind: 'user', runId, id: 'reply-copy-question', text: '请核对资料并给出结论。', inputSource: 'text', attachmentIds: [], acceptedAt: now - 6000, deliveredAt: now - 6000 },
      { kind: 'assistant', runId, itemId: 'reply-copy-answer', afterInputId: 'reply-copy-question', parts },
    ],
  };
  if (variant === 'multiple') {
    snapshot.runs['previous-run'] = { startedAt: now - 20000, closedAt: now - 15000 };
    snapshot.timeline.unshift(
      { kind: 'user', runId: 'previous-run', id: 'previous-question', text: '上一轮问题。', inputSource: 'text', attachmentIds: [], acceptedAt: now - 20000, deliveredAt: now - 20000 },
      { kind: 'assistant', runId: 'previous-run', itemId: 'previous-answer', afterInputId: 'previous-question', parts: [{ partId: 'previous-text', kind: 'text', content: '上一轮独立回答。' }] },
    );
  }
  const transcripts = projectFlowTimeline(snapshot).transcripts;
  return <VoiceScreen {...screenProps({
    sessionState: 'idle', callActive: false,
    transcripts: variant === 'legacy' ? transcripts.map(({ flow: _flow, ...item }) => item) : transcripts,
    taskSnaps: { [task.taskId]: task },
    turnPhase: settled ? 'idle' : 'replying', textModelBusy: !settled,
  })} />;
}

function screenProps(input: Partial<ScreenProps> & { streamingParts?: TurnPart[] }): ScreenProps {
  // 历史 fixture 的静态输入在这里转成正式 live row；产品不再另渲染流式尾块。
  const { streamingParts, ...overrides } = input;
  const liveParts: TurnPart[] = streamingParts ?? [
    ...(overrides.streamingThinking ? [{ type: 'thinking' as const, ...overrides.streamingThinking }] : []),
    ...(overrides.streamingReply ? [{ type: 'text' as const, text: overrides.streamingReply }] : []),
  ];
  const fixtureTurns = liveParts.length ? [...(overrides.transcripts ?? []), {
    id: 'fixture-live', author: 'hemi' as const, text: overrides.streamingReply ?? '', createdAt: now,
    live: true, parts: liveParts,
  }] : overrides.transcripts ?? [];
  // VoiceScreen 场景没有走 stubBridge/stubExecutor，window.hemiVoice 整体
  // 未定义、所有 ?. 调用静默短路——这是 fixtures 的既有约定。但任务卡详情
  // 区的档案段需要桥方法才能展示，这里补一个**全量 no-op 兜底桩**（既有
  // 桩保留、缺的方法补齐），防止「对象存在但方法缺失」的 TypeError 白屏。
  (window as unknown as { hemiVoice: unknown }).hemiVoice = {
    ...stubBridgeMethods,
    ...((window as unknown as { hemiVoice: object }).hemiVoice ?? {}),
    getTaskHistoryRecord: async (taskId: string) => ({
      taskId,
      taskText: '把下载的图片按月份整理好。',
      createdAt: now - 60_000,
      updatedAt: now,
      startedAt: now - 60_000,
      endedAt: now,
      outcome: 'unknown',
      outcomeReason: null,
      interrupted: false,
      pendingOnly: false,
      steeredCount: 0,
      hasReport: true,
      contextExcerpt: '',
      resultText: '整理到一半断了，已移动 12 张。',
      report: '第一步扫描下载文件夹（42 张）。\n第二步按月份建目录并移动（12/42）。\n第三步因窗口关闭中断，剩余 30 张未动。',
      steers: [],
      events: [
        { at: now - 60_000, text: '任务开始执行。' },
        { at: now - 30_000, text: '已建好 2026-08、2026-09 两个月份目录。' },
      ],
      verifications: [],
      deliverables: [],
    }),
  };
  return {
    sessionState: 'listening',
    callActive: true,
    turnPhase: 'idle',
    turnStartedAt: null,
    turnError: '',
    streamingReply: '',
    interimText: '',
    taskState: null,
    onTaskAction: () => {},
    contextState: { objects: [] },
    contextBusy: false,
    contextError: '',
    onAttachContext: () => {},
    onRefreshContext: () => {},
    onRemoveContext: () => {},
    errorMessage: '',
    onToggleCall: () => {},
    onRetryTurn: () => {},
    // 024 文字输入（默认空闲可发；场景里按需覆盖）。
    textDraft: '',
    onTextDraftChange: () => {},
    onTextSend: () => {},
    // 029：停止回应回调（生成中场景的主操作；默认 no-op）。
    onStopModelTurn: () => {},
    textModelBusy: false,
    textPendingSpeech: false,
    textModelReady: true,
    // 025：产物打开/定位回调（交付场景的成果 chips 需要；默认 no-op）。
    onOpenArtifact: () => {},
    onOpenSettings: () => {},
    onNewConversation: () => {},
    onOpenConversation: () => {},
    onConversationRemoved: () => {},
    // 024 重构：会话身份与顶栏标题。
    currentConversationId: null,
    conversationTitle: '新对话',
    // 024 Call Dock（默认：通话中、展开、未静音——场景按需覆盖）。
    elapsedSeconds: 245,
    callMuted: false,
    dockCollapsed: false,
    onToggleCallMute: () => {},
    onExpandDock: () => {},
    // 024 消息编辑（默认无编辑中消息）。
    editingMessageId: null,
    onStartEditMessage: () => {},
    onCancelEditMessage: () => {},
    onEditResendMessage: () => {},
    // 025：弹窗底栏「继续讨论」在 fixtures 里也要可见（视觉验收覆盖底部操作行）。
    onContinueDiscuss: () => {},
    // 033：工作区上下文栏默认态（新对话绑默认空间；场景按需覆盖绑定/失效）。
    workspaceState: fixtureWorkspaceState(),
    workspaceCurrent: { kind: 'view', view: fixtureWorkspaceState().default },
    workspaceSendBlocked: false,
    onWorkspaceSelect: () => {},
    onWorkspaceClear: () => {},
    onWorkspacePickFolder: () => {},
    onWorkspaceRemove: () => {},
    ...overrides,
    transcripts: fixtureTurns,
  };
}

const settingsProps = {
  onClose: () => {},
  // 037：设置成为壳内页面，图标栏「技能」入口（fixtures 不跳转）。
  onOpenSkills: () => {},
  saving: false,
  config: { apiKey: '', endpoint: '', hasApiKey: true },
  modelConfig: { model: 'deepseek-v4-flash', apiKey: '', baseUrl: 'https://api.deepseek.com/v1', hasApiKey: true, keyStoredSecurely: true, thinkingLevel: 'default', supportsVision: true, visionModel: '' },
  ttsConfig: { ttsEnabled: true, ttsVoice: '', ttsResourceId: '', hasApiKey: true },
  onOpenChange: () => {},
  onConfigChange: () => {},
  onModelConfigChange: () => {},
  onPreviewTts: () => {},
  onSaveTts: async () => {},
  onSaveAsrKey: async () => {},
} as unknown as Parameters<typeof SettingsScreen>[0];

/** 首启 fixtures；模型页复用供应商组件，读取 fixtures 的模型目录桥。 */
function onboardingScreen(overrides: Partial<Parameters<typeof SetupScreen>[0]> = {}) {
  return (
    <SetupScreen
      step="welcome"
      permissionChoice="pending"
      microphonePermission="not-determined"
      permissionBusy={false}
      saving={false}
      asrSaved={false}
      asrKeySuffix=""
      asrKeyDraft=""
      onAsrKeyChange={() => {}}
      modelSaved={false}
      errorMessage=""
      onRequestMicrophone={() => {}}
      onAdvance={() => {}}
      onSaveAsrKey={() => {}}
      onComplete={() => {}}
      onOpenExternal={() => {}}
      onOpenMicrophoneSettings={() => {}}
      {...overrides}
    />
  );
}

/** 056：弹窗 fixtures——先从桩里取目录再渲染（下拉选项来自同一份目录）。 */
function ModelRoutingDialogFixture({ error }: { error?: { slot: import('@/shared/types').RoleModelSlot; message: string } }) {
  const [directory, setDirectory] = useState<import('@/shared/types').ModelProfilesDirectory | null>(null);
  useEffect(() => {
    void window.hemiVoice.listModelProfiles().then(setDirectory);
  }, []);
  if (!directory) return null;
  return <ModelRoutingDialog onClose={() => {}} fixture={{ view: roleModelsFixture(), directory, error }} />;
}

/** 056：角色路由视图桩（main 已配＝可选「自动」；角色未配＝跟随 main）。 */
function roleModelsFixture(overrides: Record<string, Partial<import('@/shared/types').RoleModelSlotView>> = {}): import('@/shared/types').RoleModelsView {
  const slot = (modelKey: string | null, needsVision = false) => ({ modelKey, needsVision, ready: true, reason: null });
  const base: import('@/shared/types').RoleModelsView = {
    roles: [
      { name: 'explorer', title: '侦察', description: '只读侦察（本地文件＋网页查询），返回压缩后的地图', needsVision: false },
      { name: 'oracle', title: '顾问', description: '架构与决策顾问、疑难排错策略、交付前评审', needsVision: false },
      { name: 'fixer', title: '执行', description: '边界清楚的执行：多文件机械改动、跑命令、浏览器与桌面跑腿', needsVision: false },
      { name: 'designer', title: '设计', description: '负责一切 UI/UX：布局、层级、间距、动效、响应式手感，设计并实现', needsVision: true },
    ],
    slots: {
      main: slot('mp-qwen/m-max'),
      explorer: slot('mp-deep/m-chat'),
      oracle: slot(null),
      fixer: slot('mp-deep/m-chat'),
      designer: slot('mp-qwen/m-vl', true),
      fallback: slot(null),
    },
    ready: true,
  };
  for (const [key, value] of Object.entries(overrides)) {
    base.slots[key as import('@/shared/types').RoleModelSlot] = { ...base.slots[key as import('@/shared/types').RoleModelSlot], ...value };
  }
  base.ready = Boolean(base.slots.main.modelKey) && base.slots.main.ready;
  return base;
}

/** 037 模型页 v2 场景：稿件同款三家供应商（通义千问在用、DeepSeek、Ollama 连不上）。 */
function stubModelV2(
  state: Parameters<typeof setModelProfilesFixtureState>[0],
  roleModels: import('@/shared/types').RoleModelsView = roleModelsFixture(),
  directoryOverrides: Record<string, unknown> = {},
) {
  const entry = (id: string, model: string, extra: Record<string, unknown> = {}) => ({
    id,
    modelKey: '',
    model,
    thinkingLevel: 'default',
    supportsVision: false,
    visionModel: '',
    isDefault: false,
    ...extra,
  });
  const provider = (id: string, name: string, baseUrl: string, hasApiKey: boolean, models: ReturnType<typeof entry>[]) => ({
    id,
    name,
    baseUrl,
    api: 'openai-completions' as const,
    hasApiKey,
    keyStoredSecurely: hasApiKey,
    updatedAt: 0,
    models: models.map((model) => ({ ...model, modelKey: `${id}/${model.id}` })),
  });
  const directory = {
    version: 2,
    defaultModelId: 'mp-qwen/m-max',
    visionModelKey: 'mp-qwen/m-vl',
    roleModels: Object.fromEntries(Object.entries(roleModels.slots).map(([key, slot]) => [key, slot.modelKey])),
    ...directoryOverrides,
    providers: [
      provider('mp-qwen', '通义千问', 'https://dashscope.aliyuncs.com/compatible-mode/v1', true, [
        entry('m-max', 'qwen-max', { isDefault: true }),
        entry('m-vl', 'qwen-vl-max', { supportsVision: true }),
      ]),
      provider('mp-deep', 'DeepSeek', 'https://api.deepseek.com/v1', true, [
        entry('m-chat', 'deepseek-chat'),
        entry('m-reasoner', 'deepseek-reasoner', { thinkingLevel: 'high' }),
      ]),
      provider('mp-ollama', 'Ollama 本地', 'http://127.0.0.1:11434/v1', false, [entry('m-local', 'qwen2.5:14b')]),
    ],
  };
  setModelProfilesFixtureState({
    statuses: {
      'mp-qwen': { state: 'ok', latencyMs: 412 },
      'mp-deep': { state: 'ok', latencyMs: 286 },
      'mp-ollama': { state: 'fail', error: '连不上 127.0.0.1:11434：Ollama 没有在运行。' },
    },
    roleModels,
    ...(state ?? {}),
  });
  stubExecutor({
    listModelProfiles: async () => directory,
    getRoleModels: async () => roleModels,
    saveRoleModel: async () => ({ ok: true, ...roleModels }),
  });
}

/** 047 站点导入 fixtures：安全 DTO 的假状态（默认 can 全 false，场景按需覆盖）。 */
function importFixtureState(overrides: Record<string, unknown>): import('@/shared/types').ProviderImportState {
  return {
    operationId: 'pi-fixture-01',
    revision: 7,
    phase: 'login',
    control: 'user',
    siteOrigin: 'https://vvcode.top',
    apiBaseUrl: 'https://vvcode.top',
    siteLabel: 'VVCode',
    accountLabel: 'demo（#42）',
    tokenName: null,
    groups: [],
    candidates: [],
    candidatesGroup: null,
    selection: null,
    preview: null,
    progress: null,
    validation: null,
    error: null,
    result: null,
    cleanupPending: null,
    resumeHint: null,
    can: {
      checkLogin: true,
      setSelection: false,
      submit: false,
      pause: false,
      resume: false,
      retry: false,
      cancel: true,
      back: true,
    },
    ...overrides,
  } as import('@/shared/types').ProviderImportState;
}

/** 042 访问范围浮层的演示壳：盾牌贴底居中、浮层向上展开（compact-shell 提供浮层定位样式）。 */
const ScopePopoverDemo = ({ activeTaskIds = [] }: { activeTaskIds?: string[] }) => (
  <div className="compact-shell" style={{ height: '100dvh', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', background: 'var(--bg-canvas)', paddingBottom: 'var(--sp-64)' }}>
    <div style={{ display: 'flex', width: 'min(45rem, 100%)' }}>
      <div className="text-composer-tools">
        <ScopePopover demoOpen activeTaskIds={activeTaskIds} onManage={() => {}} />
      </div>
    </div>
  </div>
);

/** 042 访问授权桩：持续授权＋进行中任务的本次授权＋已结束任务的残留（浮层不应展示）。2026-10-15 起只有应用。 */
const accessStateDemo = () => ({
  health: 'ready',
  revision: 6,
  grants: [
    { grantId: 'g1', resourceId: 'app:com.tencent.xinWeChat', capability: 'access', lifetime: 'persistent' },
    { grantId: 'g2', resourceId: 'app:com.apple.Notes', capability: 'access', lifetime: 'persistent' },
    { grantId: 'g3', resourceId: 'app:com.tencent.xinWeChat', capability: 'access', lifetime: 'task', taskId: 'task-1-demo' },
    { grantId: 'g4', resourceId: 'app:com.apple.Safari', capability: 'access', lifetime: 'task', taskId: 'task-1-demo' },
    { grantId: 'g5', resourceId: 'app:com.apple.finder', capability: 'access', lifetime: 'task', taskId: 'task-0-ended' },
  ],
  resources: [
    { resourceId: 'app:com.tencent.xinWeChat', type: 'app', displayName: '微信' },
    { resourceId: 'app:com.apple.Notes', type: 'app', displayName: '备忘录' },
    { resourceId: 'app:com.apple.Safari', type: 'app', displayName: 'Safari 浏览器' },
    { resourceId: 'app:com.apple.finder', type: 'app', displayName: '访达' },
  ],
  writeFailure: null,
});

/** 设置页的桥桩（023：执行器已内置，无安装状态；只补设置页其余区块的桥面）。
 *  042：访问授权读面默认空表，场景按需用 overrides 覆盖 accessGetState。 */
function stubExecutor(overrides: Record<string, unknown> = {}) {
  (window as unknown as { hemiVoice: unknown }).hemiVoice = {
    // 034 v3：以 stubBridgeMethods 兜底再覆盖——SettingsScreen 的记忆区块
    // 常驻挂载（不随 tab 切换卸载），settings 场景挂载即读 getMemoryStatus，
    // 缺方法会 TypeError 炸 console（settings-model 曾因此过不了零错误门）。
    ...stubBridgeMethods,
    ...((window as unknown as { hemiVoice: object }).hemiVoice ?? {}),
    // 043：真桥恒有 platform 静态值；fixtures 默认 darwin，windows-* 场景经
    // stubPlatform 覆盖。缺了它平台分支组件会误走「检测中」路径。
    platform: 'darwin',
    // 042 访问授权读面（AccessSection／ScopePopover 挂载即读）
    accessGetState: async () => ({ health: 'ready', revision: 1, grants: [], resources: [], writeFailure: null }),
    ...overrides,
    accessListApplications: async () => [],
    accessPickDirectory: async () => null,
    // 006 电脑控制区块的桥面（桩数据，避免 VisionSection 崩）
    getComputerUse: async () => ({ enabled: true }),
    setComputerUse: async (next: { enabled?: boolean }) => ({ enabled: next?.enabled ?? true }),
    getVisionPermissions: async () => ({ screenRecording: true, accessibility: true }),
    openVisionPermissionPane: () => {},
  };
}

/** 悬浮窗组件的桥桩：让 useUiState/useTaskState 拿到场景数据。
 * 以 stubBridgeMethods 兜底再覆盖场景值——FloatingOrb 挂载即调用
 * onFloatingDragDetected 等方法，整窗替换式桩缺方法会白屏（floating-orb
 * 场景曾因此一直空渲染）。 */
function stubBridge(ui: Partial<UiState>, task: TaskStateSnapshot | null) {
  const full: UiState = {
    ...initialUiState,
    sessionState: 'listening',
    recentLines: [{ text: '好的，正在整理。你可以继续说。', author: 'hemi' }],
    ...ui,
  };
  (window as unknown as { hemiVoice: object }).hemiVoice = {
    ...stubBridgeMethods,
    ...((window as unknown as { hemiVoice: object }).hemiVoice ?? {}),
    getUiState: async () => full,
    onUiState: (cb: (v: UiState) => void) => {
      cb(full);
      // 行为验收钩子：模拟主窗口的 uiState 连续推送（2026-09-24 发送空窗
      // 回归用）——harness 用 window.__hemiTestUiStatePush 逐拍推完整状态。
      (window as unknown as { __hemiTestUiStatePush?: (next: UiState) => void }).__hemiTestUiStatePush =
        (next: UiState) => cb(next);
      return () => {};
    },
    getTaskState: async () => task,
    onTaskState: (cb: (v: TaskStateSnapshot) => void) => {
      if (task) cb(task);
      return () => {};
    },
    getFloatingCaptionLayout: async () => ({ anchorX: 220, maxWidth: 300, placement: 'above' }),
    onFloatingCaptionLayout: () => () => {},
    floatingTaskHover: () => {},
    taskAction: () => {},
  };
}

// 024 像素对照基准：内容态与设计稿默认场景一致（团队工作笔记本采购）。
const designParityDelivery: TaskDelivery = {
  schemaVersion: 1,
  form: 'report',
  kind: 'report',
  title: '采购建议报告',
  summary: '推荐组合、预算边界与验收要点',
  blocks: [
    { type: 'p', text: '按使用场景分配设备：均衡型覆盖固定办公，轻便型照顾外出需求，扩展型保留为备选。' },
    { type: 'section', title: '推荐组合', blocks: [{ type: 'p', text: '两台均衡型用于固定办公，一台轻便型用于外出；扩展型保留为备选。' }] },
    { type: 'section', title: '预算边界', blocks: [{ type: 'p', text: '每台 8000 元、合计 24000 元均为预算上限，不是商品报价。' }] },
  ],
  sources: [
    { id: 'src-1', title: '厂商官方规格页（三款候选机型）', url: 'https://example.com/spec' },
    { id: 'src-2', title: '第三方评测：便携与续航横评', url: 'https://example.com/review' },
    { id: 'src-3', title: '企业采购价格跟踪（本周）', url: 'https://example.com/price' },
  ],
  mainArtifacts: ['art-csv'],
  attachmentArtifacts: [],
  partial: null,
  degraded: [],
  presentationError: null,
  registeredAt: now - 138_000,
};
const designParityTask: TaskStateSnapshot = {
  ...deliveredTask(designParityDelivery, {
    taskText: '给团队选 3 台工作笔记本，每台预算 8000 元，做对比和采购建议。',
    log: [
      { at: now - 138_000, text: '已完成需求整理、方案比较与交付整理。' },
      { at: now - 60_000, text: '成果已登记：采购建议报告' },
    ],
  }),
  key: 't9-parity',
  taskId: 'task-9-parity',
  durationText: undefined,
  artifacts: [
    {
      id: 'art-csv',
      kind: 'file',
      name: '3 种方案对比.csv',
      path: '/Users/demo/Downloads/3 种方案对比.csv',
      role: 'main',
      registeredAt: now - 138_000,
    },
  ],
} as unknown as TaskStateSnapshot;

/**
 * 037 记忆页 fixtures：分域条目桩（内存里真改，dev 下可交互）＋截图预设。
 * 视觉基准 requirements/040-visual-system/designs/2026-10-03-memory（Hemi 项目 3 条、全局约定 2 条＋3 条待整理）。
 * Electron 里 contextBridge 的 hemiVoice 只读、已存在——跳过桩直接用真桥。
 */
function installMemoryFixture(options: { preset?: MemorySectionPreset; failScope?: string } = {}) {
  setMemorySectionPreset(options.preset ?? null);
  if (window.hemiVoice) return;
  const at = (hours: number, minutes: number, daysAgo = 0) => {
    const date = new Date();
    date.setDate(date.getDate() - daysAgo);
    date.setHours(hours, minutes, 0, 0);
    return date.getTime();
  };
  type Scope = MemoryEntryView['scope'];
  const scopeOfKey = (key: string): Scope =>
    key.startsWith('global/')
      ? { kind: 'global', target: key.slice(7) as 'user' | 'facts' }
      : { kind: 'workspace', workspaceId: key.slice(10) };
  const keyOf = (scope: Scope) => (scope.kind === 'global' ? `global/${scope.target}` : `workspace/${scope.workspaceId}`);
  let seq = 0;
  const entry = (key: string, title: string, body: string, kind: string, updatedAt: number, sourceRefs: string[] = []): MemoryEntryView => {
    seq += 1;
    return { id: `mem-fx${seq}`, version: 1, kind, title, body, sourceRefs, relatedEntryIds: [], createdAt: updatedAt, updatedAt, scope: scopeOfKey(key) };
  };
  const db: Record<string, MemoryEntryView[]> = {
    'global/user': [
      entry('global/user', '称呼我小周', '', 'profile', at(9, 12, 6)),
      entry('global/user', '喜欢简短的回答', '先给结论，细节按需展开。', 'profile', at(16, 40, 2)),
      entry('global/user', '默认用中文交流', '技术名词保留英文。', 'profile', at(10, 5, 9)),
    ],
    'global/facts': [
      entry('global/facts', '验收以真机为准', '截图与日志只作辅助证据。', 'fact', at(15, 30, 5)),
      entry('global/facts', '文件不直接删除，移到废纸篓', '', 'feedback', at(11, 8, 3)),
    ],
    'workspace/ws-hemi': [
      entry('workspace/ws-hemi', '周报使用英文', '这个项目的周报正文和标题都用英文写，专有名词保留原文。', 'fact', at(14, 2), ['10月3日对话「这个项目的周报都用英文」']),
      entry('workspace/ws-hemi', '排查快捷键前先检查辅助功能权限', '系统更新后辅助功能权限可能被重置，先去「隐私与安全性」确认 Hemi 仍被勾选。', 'experience', at(11, 40), ['task:排查快捷键无响应']),
      entry('workspace/ws-hemi', '构建并发数用 4', '打包时并发开到 8 会把内存吃满导致签名步骤超时，4 最稳。', 'experience', new Date(new Date().getFullYear(), 8, 28, 10, 0).getTime()),
    ],
    'workspace/default': [
      entry('workspace/default', '下载的发票按月份归档', '', 'fact', at(18, 20, 1)),
    ],
  };
  let revision = 3;
  const ok = (data: unknown) => ({ ok: true, data, operationId: `op-fixture-${Date.now()}` });
  const listeners = new Set<(event: unknown) => void>();
  const stub = {
    listMemoryEntries: async ({ scope, query = '', cursor = 0, limit = 50 }: { scope: Scope; query?: string; cursor?: number; limit?: number }) => {
      const key = keyOf(scope);
      if (options.failScope === key) return { ok: false, code: 'io_error', message: '记忆文件被别的程序占用' };
      const all = db[key] ?? [];
      const needle = query.trim().toLowerCase();
      const matched = needle ? all.filter((e) => `${e.title}\n${e.body}`.toLowerCase().includes(needle)) : all;
      const page = matched.slice(cursor, cursor + limit);
      return {
        ok: true,
        data: {
          scope, revision, epoch: 1,
          loose: { kind: key === 'global/user' ? 'profile' : 'unsorted', count: key === 'global/facts' ? 3 : 0, issues: [] },
          entries: page, total: matched.length, nextCursor: cursor + limit < matched.length ? cursor + limit : null,
        },
      };
    },
    mutateMemoryEntry: async (input: { scope: Scope; action: 'add' | 'replace'; entryId?: string; title?: string; body?: string; kind?: string }) => {
      const key = keyOf(input.scope);
      const list = (db[key] ??= []);
      revision += 1;
      if (input.action === 'add') {
        const added = entry(key, input.title ?? '', input.body ?? '', input.kind ?? 'fact', Date.now());
        list.unshift(added);
        return ok({ entry: added });
      }
      const index = list.findIndex((e) => e.id === input.entryId);
      if (index < 0) return { ok: false, code: 'not_found', message: '这条记忆已不存在' };
      list[index] = { ...list[index], title: input.title ?? list[index].title, body: input.body ?? list[index].body, version: list[index].version + 1, updatedAt: Date.now() };
      return ok({ entry: list[index] });
    },
    moveMemoryEntry: async ({ fromScope, entryId, toScope }: { fromScope: Scope; entryId: string; toScope: Scope }) => {
      const from = db[keyOf(fromScope)] ?? [];
      const index = from.findIndex((e) => e.id === entryId);
      if (index < 0) return { ok: false, code: 'not_found', message: '这条记忆已不存在' };
      const [moved] = from.splice(index, 1);
      const next = { ...moved, scope: toScope };
      (db[keyOf(toScope)] ??= []).unshift(next);
      revision += 1;
      return ok({ entry: next });
    },
    forgetMemoryEntry: async ({ scope, entryId }: { scope: Scope; entryId: string }) => {
      const list = db[keyOf(scope)] ?? [];
      const index = list.findIndex((e) => e.id === entryId);
      if (index >= 0) list.splice(index, 1);
      revision += 1;
      return ok({ removedEntryId: entryId, removedRecordIds: [] });
    },
    clearMemoryScope: async ({ scope }: { scope: Scope }) => {
      db[keyOf(scope)] = [];
      revision += 1;
      return ok({ cleared: true });
    },
    undoMemoryMutation: async () => ok({ undone: 'restored' }),
    onMemoryChanged: (cb: (event: unknown) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getMemoryState: async () => ({
      documents: {
        user: { text: '<!-- hemi:entry id=mem-fx1 v=1 kind=profile -->\n称呼我小周\n<!-- /hemi:entry -->\n', issue: null },
        memory: { text: '<!-- hemi:entry id=mem-fx4 v=1 kind=fact -->\n验收以真机为准\n截图与日志只作辅助证据。\n<!-- /hemi:entry -->\n\n项目 Hemi 的构建脚本在 scripts/ 下\n用户的打印机是 HP M227\n周会改到周二上午\n', issue: null },
      },
      limits: { user: 2000, memory: 4000 },
    }),
    saveMemoryDocument: async () => ({ ok: true }),
    openMemoryDirectory: async () => ({ ok: true }),
    getWorkspaceState: async () => ({
      default: { id: 'default', type: 'default', name: '默认空间', dir: '~', status: 'ok' },
      projects: [
        { id: 'ws-hemi', type: 'project', name: 'Hemi 项目', dir: '~/Projects/Hemi', status: 'ok' },
        { id: 'ws-atlas', type: 'project', name: 'Atlas', dir: '/Volumes/Projects/Atlas', status: 'ok' },
        { id: 'ws-kiwi', type: 'project', name: 'Kiwi 官网', dir: '~/Projects/kiwi-site', status: 'ok' },
        { id: 'ws-site', type: 'project', name: '旧官网', dir: '~/Projects/site', status: 'missing' },
      ],
    }),
    getMemoryStatus: async () => ({ exitSummaryEnabled: true, memoryDir: '~/Library/Application Support/hemi/memory' }),
    setMemoryExitSummary: async (next: { enabled: boolean }) => ({
      exitSummaryEnabled: next.enabled,
      memoryDir: '~/Library/Application Support/hemi/memory',
    }),
  };
  Object.defineProperty(window, 'hemiVoice', { value: { ...stubBridgeMethods, ...stub }, configurable: true });
}

function memoryScene(options: { preset?: MemorySectionPreset; failScope?: string } = {}) {
  installMemoryFixture(options);
  return <SettingsScreen {...settingsProps} initialPage="memory" />;
}

const MEMORY_WS = { tab: 'workspace', workspaceId: 'ws-hemi' } as const;

/** 037 对话内记忆提示场景：两轮对话 + 提示条（状态各一）。 */
function memoryChatScene(items: Array<Omit<MemoryNoticeItem, 'id'>>, lines: Array<[string, 'user' | 'hemi']>) {
  const noop = () => {};
  return (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: transcripts(lines),
        memoryNotice: (
          <MemoryNotices
            items={items.map((item, index) => ({ ...item, id: `fx-mn-${index}` }))}
            onView={noop}
            onUndo={noop}
            onRestore={noop}
            onToggleDetail={noop}
          />
        ),
      })}
    />
  );
}

/** 043：ApplicationChoice 桩——rowId 选择、appRef+catalogRevision 引用（宿主桩）。 */
let accessDemoRevision = 0;
const accessAppsDemo = (): ApplicationChoice[] => {
  accessDemoRevision += 1;
  const revision = accessDemoRevision;
  const row = (
    index: number,
    name: string,
    appRefKey: string,
    running: boolean,
    location: string,
    addedResourceId?: string,
  ) => ({
    rowId: `app-${revision}-${index}`,
    name,
    platform: 'darwin' as const,
    ref: { appRef: `hemi-appref-1:demo-${appRefKey}`, catalogRevision: revision },
    running,
    icon: null,
    source: { kind: 'bundle' as const, locationLabel: location },
    ...(addedResourceId ? { addedResourceId } : {}),
  });
  return [
    row(0, '微信', 'wechat', true, '/Applications/WeChat.app'),
    row(1, 'Safari浏览器', 'safari', true, '/Applications/Safari.app'),
    row(2, '访达', 'finder', true, '/System/Library/CoreServices/Finder.app', 'access-resource-finder'),
    row(3, '备忘录', 'notes', false, '/System/Applications/Notes.app'),
    row(4, '飞书', 'lark', false, '/Applications/Lark.app'),
    row(5, '计算器', 'calc', false, '/System/Applications/Calculator.app'),
    row(6, '日历', 'ical', false, '/System/Applications/Calendar.app'),
  ];
};

/**
 * 043：Windows 平台场景桩——覆盖桥的 platform 标识与能力快照读面。
 * 能力默认 unavailable（WP 探针未过），个别能力由场景覆写。
 */
function stubPlatform(
  platform: 'darwin' | 'win32',
  capabilities: Partial<Record<string, { state: string; reason?: string; supported: boolean; enabled: boolean; actions: string[] }>>,
) {
  const bridge = (window as unknown as { hemiVoice: Record<string, unknown> }).hemiVoice ?? {};
  const allIds = [
    'microphone', 'audioDuplex', 'pushToTalk', 'desktop', 'browser',
    'command', 'systemProxy', 'capture', 'currentPage', 'appCatalog',
  ];
  const caps = Object.fromEntries(
    allIds.map((id) => [
      id,
      capabilities[id] ?? { state: 'unavailable', reason: 'backend-not-verified', supported: false, enabled: false, actions: [] },
    ]),
  );
  bridge.platform = platform;
  bridge.platformGetState = async () => ({
    platform,
    sessionId: 'fixture-session',
    revision: 1,
    capabilities: caps,
    shortcuts: { pushToTalk: platform === 'darwin' ? { key: 'option', label: 'Option' } : null },
  });
  bridge.onPlatformStateChanged = () => () => {};
  bridge.platformRecheck = async () => {
    return await (bridge.platformGetState as () => Promise<unknown>)();
  };
  bridge.platformPerformAction = async () => ({ ok: false, error: 'UNSUPPORTED_ACTION' });
}

/** 043：win32 目录条目桩（同「备忘录」双来源＝app-ambiguous 场景）。 */
let windowsAccessDemoRevision = 0;
const windowsAccessAppsDemo = (): ApplicationChoice[] => {
  windowsAccessDemoRevision += 1;
  const revision = windowsAccessDemoRevision;
  const row = (index: number, name: string, key: string, running: boolean, location: string, addedResourceId?: string) => ({
    rowId: `win-app-${revision}-${index}`,
    name,
    platform: 'win32' as const,
    ref: { appRef: `hemi-appref-1:demo-${key}`, catalogRevision: revision },
    running,
    icon: null,
    source: { kind: 'executable' as const, locationLabel: location },
    ...(addedResourceId ? { addedResourceId } : {}),
  });
  return [
    row(0, '微信', 'wechat-win', true, 'C:\\Program Files\\Tencent\\WeChat\\WeChat.exe'),
    row(1, '备忘录', 'notes-1', false, 'C:\\Program Files\\Notes\\Notes.exe'),
    row(2, '备忘录', 'notes-2', false, 'C:\\Users\\demo\\AppData\\Local\\NotesPro\\Notes.exe', 'access-resource-notes-2'),
    row(3, '计算器', 'calc-win', false, 'C:\\Windows\\System32\\calc.exe'),
  ];
};

function AccessAddDialogDemo() {
  return (
    <AccessAddDialog
      apps={accessAppsDemo()}
      appsFailed={false}
      addedResourceIds={new Set(['access-resource-finder'])}
      busy={false}
      error={null}
      onClose={() => {}}
      onReloadApps={() => {}}
      onAddApplication={() => {}}
    />
  );
}

function auditSessionScene(processOpen: boolean) {
  const summary = [
    '已核对本轮请求型号、当前实例与会话身份；供应商实际后端型号仍无法仅凭本地记录确认。',
    ...Array.from({ length: 7 }, (_, index) => `${index + 1}. 核验记录：只使用当前开发实例、当前会话和本轮受理时间。请求型号与执行模型分别记录；旧实例的日志不能作为本会话证据。授权超时只表示该操作没有获准，已完成的查询仍需保留。`),
  ].join('\n\n');
  const snap = deliveredTask(partialDelivery, {
    taskText: '核对当前会话实际调用的模型', outcome: 'partial',
    delivery: null, outcomeReason: null, resultText: '本轮请求型号已确认，供应商实际后端型号尚未核实。',
    artifacts: [], approvals: { count: 2, totalWaitMs: 31_900 },
    startedAt: now - 251_500, endedAt: now,
    taskResult: { schemaVersion: 1, proposedVerdict: 'partial', summary,
      checks: [{ target: '本轮请求型号', status: 'satisfied', evidence: '宿主诊断' }],
      missing: ['供应商实际后端型号'], sideEffects: [],
    },
    log: [
      { at: now - 249_000, text: '已读取：本轮宿主诊断' },
      { at: now - 240_000, text: '已允许（持续）：Terminal' },
      { at: now - 209_900, text: '确认超时，本次操作未获授权。（等待 30.1 秒）' },
      { at: now - 51_000, text: '已提交：结构化核验结果' },
    ],
  });
  return <VoiceScreen {...screenProps({
    sessionState: 'idle', callActive: false,
    transcripts: taskThread(snap), taskSnaps: taskSnapsOf(snap), taskState: bundleOf(snap),
    ...(processOpen ? { initialProcessTaskKey: snap.taskId ?? undefined } : {}),
  })} />;
}

function SortableQueueFixture({ full = false, paused = false }: { full?: boolean; paused?: boolean }) {
    const [queue, setQueue] = useState<TurnQueueState>({ paused, items: [
      { queueItemId: 'sort-b', conversationId: 'conv-fixture', text: '先查一下天津明天的天气', revision: 1, dispatchState: 'pending', error: '', createdAt: now, attachmentIds: [], references: [] },
      { queueItemId: 'sort-c', conversationId: 'conv-fixture', text: '再看看高铁票，按出发时间整理', revision: 1, dispatchState: 'pending', error: '', createdAt: now, attachmentIds: [], references: [] },
      { queueItemId: 'sort-d', conversationId: 'conv-fixture', text: '把天气和出行建议汇总到一起', revision: 1, dispatchState: 'pending', error: '', createdAt: now, attachmentIds: [], references: [] },
      ...(full ? Array.from({ length: 5 }, (_, i): TurnQueueState['items'][number] => ({ queueItemId: `sort-extra-${i}`, conversationId: 'conv-fixture', text: `第 ${i + 4} 条待发送消息：继续整理出行安排`, revision: 1, dispatchState: 'pending', error: '', createdAt: now, attachmentIds: [], references: [] })) : []),
    ] });
    return <VoiceScreen {...screenProps({
      sessionState: 'idle', callActive: false, turnPhase: 'thinking', textModelBusy: true, queueState: queue,
      onReorderQueued: (id, overId) => setQueue((current) => {
        const items = [...current.items]; const from = items.findIndex((item) => item.queueItemId === id); const to = items.findIndex((item) => item.queueItemId === overId);
        if (from >= 0 && to >= 0) items.splice(to, 0, items.splice(from, 1)[0]);
        return { ...current, items };
      }),
      onPromoteQueued: (id) => setQueue((current) => ({ ...current, items: current.items.map((item) => item.queueItemId === id ? { ...item, dispatchState: 'promoting' } : item) })),
      onEditQueued: (id) => setQueue((current) => ({ ...current, items: current.items.map((item) => item.queueItemId === id ? { ...item, dispatchState: 'editing' } : item) })),
      onWithdrawQueued: (id) => setQueue((current) => ({ ...current, items: current.items.filter((item) => item.queueItemId !== id) })),
    })} />;
  }

/** 067: deterministic scale fixture. Product IPC/streaming is verified by verify-067 separately. */
function VirtualTranscriptFixture({ count, humanInput = false }: { count: number; humanInput?: boolean }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const transcripts = useState<TranscriptItem[]>(() => Array.from({ length: count }, (_, i) => ({
    id: `virtual-${i}`, author: i % 2 ? 'hemi' : 'user', createdAt: i, inputSource: 'text',
    text: i % 2 ? `第 ${i} 条完整回答 VIRTUAL_MARKER_${i}\n\n` + '保留完整内容，按可见范围渲染。**加粗**与行内代码 `const value = 1`。\n\n'.repeat(15) + '| 项目 | 数量 |\n| --- | --- |\n| 测量 | 42 |\n\n```ts\nconst data = [1, 2, 3];\n```' : `第 ${i} 条问题 VIRTUAL_MARKER_${i}`,
    ...(i % 2 ? { parts: [
      { type: 'thinking' as const, text: `思考内容 ${i}\n\n第二段思考。`, startedAt: 1, endedAt: 1001 },
      { type: 'tools' as const, calls: [{ id: `read-${i}`, tool: 'read', args: { path: '/tmp/example.txt' }, state: 'done' as const }] },
      { type: 'text' as const, text: `第 ${i} 条完整回答 VIRTUAL_MARKER_${i}\n\n` + '长正文，**加粗**与行内代码 `const value = 1`。\n\n'.repeat(15) + '| 项目 | 数量 |\n| --- | --- |\n| 测量 | 42 |\n\n```ts\nconst data = [1, 2, 3];\n```' },
    ] } : {}),
  } as TranscriptItem)))[0];
  if (humanInput) transcripts[3].parts = [{ type: 'workflow-card', card: {
    invocationId: 'virtual-input', title: '人工输入草稿', status: 'waiting', completedCount: 1, totalCount: 2,
    interaction: { interactionId: 'virtual-interaction', nodeId: 'input', title: '人工输入', status: 'open',
      content: '滚出屏幕后保留未保存输入。', contentIssues: [],
      fields: [{ fieldId: 'feedback', key: 'feedback', label: '反馈意见', type: 'text', required: false }],
      actions: [{ actionId: 'continue', label: '继续', primary: true, requiredKeys: [] }],
      hasTimeout: false, expiresAt: null, revision: 1, draft: null, response: null,
    },
  } }];
  return <VoiceScreen {...screenProps({ transcripts, currentConversationId: `virtual-fixture-${count}`, conversationTitle: '长对话虚拟列表', sessionState: 'idle', callActive: false, taskState: null, taskSnaps: {},
    textDraft: draft, onTextDraftChange: setDraft, editingMessageId: editing, onStartEditMessage: setEditing, onCancelEditMessage: () => setEditing(null),
  })} />;
}

/** 066：顶栏「打开工作区目录」场景（menu＝菜单初始展开；os＝平台文案对照）。 */
function topbarOpenWorkspaceScene({ menu = false, os = 'mac' }: { menu?: boolean; os?: 'mac' | 'win' } = {}) {
  const state = fixtureWorkspaceState();
  const view = state.projects[0];
  (window as unknown as { hemiVoice: Record<string, unknown> }).hemiVoice = {
    ...stubBridgeMethods,
    ...((window as unknown as { hemiVoice: object }).hemiVoice ?? {}),
    ...(os === 'win' ? { platform: 'win32' } : {}),
  };
  return <VoiceScreen {...screenProps({
    sessionState: 'idle', callActive: false,
    conversationTitle: 'Atlas 周报',
    workspaceCurrent: { kind: 'view', view },
    topbarOpenFixtureOpen: menu,
    transcripts: baseChat(),
  })} />;
}

function workflowCardVisualScene() {  // 仅渲染 fixture：不启动生产调用，不作为权限／工具执行链路证据。
  if (!window.hemiVoice) {
    Object.defineProperty(window, 'hemiVoice', {
      configurable: true,
      value: {
        ...stubBridgeMethods,
        workflowGetInvocation: async () => ({
          documentSnapshot: {
            nodes: [{ id: 'collect', data: {
              title: '整理本周经营数据',
              outputSchema: { properties: { report: { type: 'file' } } },
            } }],
          },
          run: { currentNodeId: 'collect' },
        }),
      },
    });
  }
  const status = new URLSearchParams(location.search).get('state') ?? 'completed';
  return (
    <div className="compact-shell" style={{ display: 'block', padding: 'var(--pad-page)', minHeight: '100dvh' }}>
      <div className="h59-result-content">
        <WorkflowCard card={{
          invocationId: 'inv-visual-059', cardId: 'card-visual-059',
          workflowRunId: 'wrun-visual-059', conversationId: 'conv-visual-059',
          title: '经营周报', status, currentNodeId: 'collect',
          completedCount: status === 'completed' ? 3 : ['preparing', 'queued'].includes(status) ? 0 : 1,
          totalCount: 3, values: { 日期: '2026-10-05 至 2026-10-11', 格式: '文字报告' }, ready: true,
          ...(status === 'completed' ? {
            outputs: { 报告: '/Users/demo/Documents/经营周报/2026-10-05-至-2026-10-11/经营周报.md' },
            fileOutputs: ['报告'],
          } : {}),
          ...(status === 'waiting' ? { waitingReason: '请完成登录后继续，已完成的步骤会保留。' } : {}),
          ...(status === 'failed' ? { error: '来源文件已被移动，请重新选择文件后继续。' } : {}),
        }} />
      </div>
    </div>
  );
}

/** 040：真实状态组件的动效与静音 / 挂断交互；桥和会话数据仅为 fixture。 */
function ActivityIndicatorsFixture({ collapsed = false }: { collapsed?: boolean }) {
  const [calling, setCalling] = useState(true);
  const [muted, setMuted] = useState(false);
  const [dockCollapsed, setDockCollapsed] = useState(collapsed);
  const [settings, setSettings] = useState(false);
  if (settings) return <SettingsScreen {...settingsProps}
    callStatus={calling ? { elapsedSeconds: 245, muted } : null}
    onClose={() => setSettings(false)}
    onCallExpand={() => setDockCollapsed(false)}
    onCallEnd={() => setCalling(false)}
  />;
  return <VoiceScreen {...screenProps({
    transcripts: baseChat(),
    currentConversationId: 'conv-activity-running',
    conversationTitle: '帮我整理今天的待办',
    callActive: calling,
    sessionState: calling ? 'listening' : 'idle',
    callMuted: muted,
    dockCollapsed,
    onToggleCall: () => { setCalling(value => !value); setMuted(false); },
    onToggleCallMute: () => setMuted(value => !value),
    onExpandDock: () => setDockCollapsed(false),
    onOpenSettings: () => setSettings(true),
  })} />;
}

function activityIndicatorsScene(collapsed = false) {
  Object.defineProperty(window, '__hemiFixtureSessions', { configurable: true, value: {
    sessions: [
      { id: 'conv-activity-running', title: '帮我整理今天的待办', createdAt: now, updatedAt: now, turnCount: 2, status: 'running' },
      { id: 'conv-activity-unread', title: '项目的开源准备', createdAt: now - 1000, updatedAt: now - 1000, turnCount: 2, status: 'running', unreadAt: now },
      { id: 'conv-activity-idle', title: '整理工作区文件', createdAt: now - 2000, updatedAt: now - 2000, turnCount: 2 },
    ], storageError: null,
  } });
  return <ActivityIndicatorsFixture collapsed={collapsed} />;
}

const scenes: Record<string, () => React.ReactElement> = {
  'activity-indicators': () => activityIndicatorsScene(),
  'activity-indicators-collapsed': () => activityIndicatorsScene(true),
  'conversation-virtual-human-input': () => <VirtualTranscriptFixture count={150} humanInput />,
  'conversation-virtual-150': () => <VirtualTranscriptFixture count={150} />,
  'conversation-virtual-1500': () => <VirtualTranscriptFixture count={1500} />,
  // 066：顶栏「打开工作区目录」split 按钮（本机项目才出现；菜单/平台文案变体另注册）。
  'topbar-open-workspace': () => topbarOpenWorkspaceScene(),
  'topbar-open-workspace-menu': () => topbarOpenWorkspaceScene({ menu: true }),
  'topbar-open-workspace-win': () => topbarOpenWorkspaceScene({ os: 'win' }),
  'conversation-status': () => {
    const states: (ConversationStatus | null)[] = ['running', null, 'running', null, null, null];
    const titles = ['正在核对最新视频数据', '后台已完成，等待查看', '有未读结果并继续运行', '已读的工作总结', '已停止的任务', '上次退出时中断的任务'];
    (window as unknown as { __hemiFixtureSessions: ReturnType<typeof fixtureSessionsOverride> }).__hemiFixtureSessions = {
      sessions: states.map((status, i) => ({ id: `status-${i}`, status, unreadAt: i === 1 || i === 2 ? now : null, title: titles[i], createdAt: now, updatedAt: now, turnCount: 2 })), storageError: null,
    };
    return <VoiceScreen {...screenProps({ sessionState: 'idle', callActive: false, currentConversationId: 'status-0', conversationTitle: titles[0], transcripts: baseChat() })} />;
  },
  'reply-copy': () => <ReplyCopyFixture />,
  'workflow-card-visual':workflowCardVisualScene,
  'workflow-preparation-parameters': () => <WorkflowParametersDialog
    mode="prepare"
    prepared={{ invocationId: 'inv-parameters', conversationId: 'conv-parameters', cardId: 'card-parameters', draftRevision: 1, values: { format: '文字报告' } }}
    parameters={[
      { key: 'idea', label: '这次想做什么（可选）', type: 'text', description: '留空时，执行节点按工作流规则寻找灵感。' },
      { key: 'format', label: '输出格式', type: 'enum', options: ['文字报告', '演示文稿'], required: true },
    ]}
    directory={null} currentModelKey={null} busy={false}
    onCancel={() => {}} onRun={async () => {}}
  />,
  // 059 人工输入（HI 通用节点）：挂起表单与已提交只读记录两形态。
  // 059 人工输入（HI 通用节点）：挂起表单与已提交只读记录两形态（文案对齐设计稿）。
  'workflow-card-human-input': () => {
    const state = new URLSearchParams(location.search).get('state') ?? 'form';
    return (
      <div className="bg-[var(--n-100)] py-8" style={{ width: '100%', maxWidth: 780, margin: '0 auto' }}>
        {state === 'record' ? (
          <WorkflowCard
            card={{
              invocationId: 'inv-hi2', title: '人工输入', status: 'completed', currentNodeId: 'confirm',
              completedCount: 3, totalCount: 4, values: { topic: '接口性能月报' },
              interaction: {
                interactionId: 'hi-fixture-2', nodeId: 'confirm', title: '确认处理结果',
                status: 'responded',
                content: '本月初稿已生成，请选择后续处理方式。', contentIssues: [],
                fields: [
                  { fieldId: 'f1', key: 'plan', label: '方案', type: 'choice', required: true, options: ['优化交付版', '精简摘要版', '原文不动版'] },
                  { fieldId: 'f2', key: 'feedback', label: '反馈意见', type: 'text', required: false, prefill: '' },
                ],
                actions: [
                  { actionId: 'continue', label: '继续', primary: true, requiredKeys: [], nextTitle: '定稿输出' },
                  { actionId: 'adjust', label: '按反馈调整', primary: false, requiredKeys: [], nextTitle: '调整内容' },
                ],
                timeoutNextTitle: '调整内容',
                hasTimeout: false, expiresAt: null, revision: 5,
                draft: null,
                response: {
                  actionId: 'continue', actionLabel: '继续',
                  values: { plan: '优化交付版', feedback: '补充并发对比数据。' },
                  submittedAt: Date.now() - 120_000, source: 'user',
                },
              },
            }}
          />
        ) : (
          <WorkflowCard
            card={{
              invocationId: 'inv-hi1', title: '人工输入', status: 'waiting', currentNodeId: 'confirm',
              completedCount: 1, totalCount: 4, values: { topic: '接口性能月报' },
              interaction: {
                interactionId: 'hi-fixture-1', nodeId: 'confirm', title: '确认处理结果',
                status: 'open',
                content: '本月初稿：\n接口平均耗时环比上升 12%，其中网关段占比过半。\n建议先看慢查询清单，再决定是否进入优化迭代。',
                contentIssues: [],
                fields: [
                  { fieldId: 'f1', key: 'plan', label: '方案', type: 'choice', required: true, options: ['优化交付版', '精简摘要版', '原文不动版'] },
                  { fieldId: 'f2', key: 'feedback', label: '反馈意见', type: 'text', required: false, prefill: '' },
                ],
                actions: [
                  { actionId: 'continue', label: '继续', primary: true, requiredKeys: [], nextTitle: '定稿输出' },
                  { actionId: 'adjust', label: '按反馈调整', primary: false, requiredKeys: [], nextTitle: '调整内容' },
                ],
                timeoutNextTitle: '调整内容',
                hasTimeout: true, expiresAt: Date.now() + 3600_000, revision: 3,
                draft: null, response: null,
              },
            }}
          />
        )}
      </div>
    );
  },
  // 045：共用品牌顶栏与小尺寸图标验收；欢迎页/关于页另用真实页面场景。
  'brand-icons': () => (
    <main className="setup-shell onboarding-page min-h-dvh overflow-hidden">
      <AppTopBar />
      <div className="onboarding-shell">
        <section className="onboarding-scene" data-center="true">
          <BrandIcon className="onboarding-brand-icon" width={64} height={64} />
          <h1 className="onboarding-title">Hemi</h1>
          <p className="onboarding-lead">声波 H · 共用品牌图标</p>
          <div className="flex items-end gap-4">
            {[16, 24, 32, 48, 128].map((size) => (
              <figure key={size} className="grid justify-items-center gap-2">
                <BrandIcon width={size} height={size} />
                <figcaption className="text-xs">{size}px</figcaption>
              </figure>
            ))}
          </div>
        </section>
      </div>
    </main>
  ),
  // 034：技能页默认 SkillsMP 发现（demo 预置一次搜索，产物为结果列表 + 缓存标注）。
  'skill-market': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        skillMarketOpen: true,
        onOpenSkillMarket: () => {},
        onCloseSkillMarket: () => {},
        skillMarketScene: 'mp-results',
      })}
    />
  ),
  // 034：SkillsMP 添加前确认（GitHub 固定提交 + 文件清单 + SKILL.md 原文）。
  'skill-mp-preview': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        skillMarketOpen: true,
        onOpenSkillMarket: () => {},
        onCloseSkillMarket: () => {},
        skillMarketScene: 'mp-preview',
      })}
    />
  ),
  // 034 v5：市场详情 idle 态（元数据秒开 + 安装流程说明 + 验看区入口，未拉来源）。
  'skill-mp-detail': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        skillMarketOpen: true,
        onOpenSkillMarket: () => {},
        onCloseSkillMarket: () => {},
        skillMarketScene: 'mp-detail',
      })}
    />
  ),
  // 034：已安装的 SkillsMP 技能详情（来源身份 + 检查更新）。
  'skill-mp-installed': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        skillMarketOpen: true,
        onOpenSkillMarket: () => {},
        onCloseSkillMarket: () => {},
        skillMarketScene: 'installed',
      })}
    />
  ),
  // 034：内置技能 Tab（无精选位，统一列表）。
  'skill-builtin': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        skillMarketOpen: true,
        onOpenSkillMarket: () => {},
        onCloseSkillMarket: () => {},
        skillMarketScene: 'builtin',
      })}
    />
  ),
  'skill-home-entry': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        skillMarketOpen: false,
        onOpenSkillMarket: () => {},
        onCloseSkillMarket: () => {},
      })}
    />
  ),
  'main-idle': () => (
    <VoiceScreen
      {...screenProps({ sessionState: 'idle', callActive: false })}
    />
  ),
  'dev-performance': () => (
    <VoiceScreen {...screenProps({ sessionState: 'idle', callActive: false })} />
  ),
  'main-running': () => (
    <VoiceScreen
      {...screenProps({
        transcripts: taskThread(runningTask),
        taskSnaps: taskSnapsOf(runningTask),
        taskState: bundleOf(runningTask),
      })}
    />
  ),

'grant-card': () => (
    <VoiceScreen
      {...screenProps({
        transcripts: taskThread(waitingTask),
        taskSnaps: taskSnapsOf(waitingTask),
        taskState: bundleOf(waitingTask),
        currentConversationId: 'conv-fixture',
      })}
    />
  ),
  'scope-popover': () => {
    stubExecutor({ accessGetState: async () => accessStateDemo() });
    return <ScopePopoverDemo activeTaskIds={['task-1-demo']} />;
  },
  'scope-popover-empty': () => {
    stubExecutor();
    return <ScopePopoverDemo />;
  },
  'risk-card': () => (
    <VoiceScreen
      {...screenProps({
        transcripts: taskThread(riskTask),
        taskSnaps: taskSnapsOf(riskTask),
        taskState: bundleOf(riskTask),
        currentConversationId: 'conv-fixture',
      })}
    />
  ),
  'main-waiting': () => (
    <VoiceScreen
      {...screenProps({
        transcripts: taskThread(waitingTask),
        taskSnaps: taskSnapsOf(waitingTask),
        taskState: bundleOf(waitingTask),
        currentConversationId: 'conv-fixture',
      })}
    />
  ),
  // 跨会话等待（2026-10-07 泄漏修复＋引路条）：等授权的任务属于别的会话——
  // 本会话不出确认卡不蒙磨砂（021 口径），但顶部出引路条直达原会话。
  'main-waiting-foreign': () => (
    <VoiceScreen
      {...screenProps({
        transcripts: taskThread(waitingTask),
        taskSnaps: taskSnapsOf(waitingTask),
        taskState: bundleOf({ ...waitingTask, conversationId: 'conv-other' }),
        currentConversationId: 'conv-fixture',
      })}
    />
  ),
  // 无会话身份的任务（新对话首轮链路未带 id）：跟着当前视图出卡（2026-10-07
  // 真机钓出的「没弹授权」盲区——过滤一刀切 null 会把无主任务全灭）。
  'main-waiting-unbound': () => (
    <VoiceScreen
      {...screenProps({
        transcripts: taskThread(waitingTask),
        taskSnaps: taskSnapsOf(waitingTask),
        taskState: bundleOf({ ...waitingTask, conversationId: null }),
        currentConversationId: null,
      })}
    />
  ),
  'main-complete': () => (
    <WalkthroughVoiceScreen
      {...screenProps({
        transcripts: [
          ...taskThread(completeTask),
          {
            id: 'result-line',
            text: '37 张图片整理好了，已经按月份放进文件夹。',
            createdAt: now + 30000,
            author: 'hemi' as const,
            taskId: completeTask.taskId ?? undefined, // 026 R-09：终态交代带任务身份
          },
        ],
        taskSnaps: taskSnapsOf(completeTask),
        taskState: bundleOf(completeTask),
      })}
    />
  ),
  'main-stopped': () => (
    <VoiceScreen
      {...screenProps({
        transcripts: taskThread(stoppedTask),
        taskSnaps: taskSnapsOf(stoppedTask),
        taskState: bundleOf(stoppedTask),
      })}
    />
  ),
  'main-denied': () => (
    <VoiceScreen
      {...screenProps({
        transcripts: taskThread(deniedTask),
        taskSnaps: taskSnapsOf(deniedTask),
        taskState: bundleOf(deniedTask),
      })}
    />
  ),
  'main-blocked': () => (
    <VoiceScreen
      {...screenProps({
        transcripts: taskThread(blockedTask),
        taskSnaps: taskSnapsOf(blockedTask),
        taskState: bundleOf(blockedTask),
      })}
    />
  ),
  'main-second': () => (
    <VoiceScreen
      {...screenProps({
        transcripts: taskThread(secondTask),
        taskSnaps: taskSnapsOf(secondTask),
        taskState: bundleOf(secondTask),
      })}
    />
  ),
  'main-parallel': () => (
    <VoiceScreen
      {...screenProps({
        transcripts: [
          ...taskThread(runningTask),
          {
            id: 'parallel-question',
            text: '再用浏览器查一下发布会消息。',
            createdAt: now + 15000,
            author: 'user' as const,
          },
          {
            id: 'parallel-ack',
            text: '编程的继续，浏览器的事我另开一个。',
            createdAt: now + 16000,
            author: 'hemi' as const,
          },
          taskItem(parallelTask),
        ],
        taskSnaps: taskSnapsOf(runningTask, parallelTask),
        taskState: bundleOf(runningTask, parallelTask),
      })}
    />
  ),
  'main-endcall': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: taskThread(runningTask),
        taskSnaps: taskSnapsOf(runningTask),
        taskState: bundleOf(runningTask),
      })}
    />
  ),
  'main-context': () => (
    <VoiceScreen
      {...screenProps({
        contextState: {
          objects: [
            {
              id: 'ctx-1',
              kind: 'web',
              source: '网页',
              title: '水牛奶参数对比页面',
              detail: 'https://example.com/milk-compare',
              scope: '正文前 3820 字',
              capturedAt: now - 120000,
            },
            {
              id: 'ctx-2',
              kind: 'image',
              source: '截图',
              title: '屏幕截图（1440×900）',
              detail: '',
              scope: '窗口/区域截图',
              capturedAt: now - 60000,
            },
          ],
        },
      })}
    />
  ),
  // —— 2026-10-05 会话行右键菜单（复制会话 ID / 重命名；2026-10-07 加删除）：
  // 真实交互在侧栏行上右键即出；静态场景把菜单按右键落点直接渲染，供三档
  // 截图与交互评审。-delete 变体挂载后自动点一次危险项，定格两步确认的
  // 武装态（「确认删除」浅红底）。 ——
  'sidebar-context-menu': () => {
    (window as unknown as { __hemiFixtureSessions?: unknown }).__hemiFixtureSessions = {
      sessions: [
        { id: 'conv-procurement', title: '团队工作笔记本采购', createdAt: now - 3600_000, updatedAt: now - 60_000, turnCount: 6 },
        { id: 'conv-files', title: '整理下载文件夹', createdAt: now - 86400_000, updatedAt: now - 7200_000, turnCount: 4 },
        { id: 'conv-research', title: '工作笔记本方案调研', createdAt: now - 172800_000, updatedAt: now - 90_000, turnCount: 9 },
      ],
      storageError: null,
    };
    return (
      <>
        <VoiceScreen
          {...screenProps({
            sessionState: 'idle',
            callActive: false,
            currentConversationId: 'conv-procurement',
          })}
        />
        <ConversationContextMenu
          session={{
            id: 'conv-procurement',
            title: '团队工作笔记本采购',
            createdAt: now - 3600_000,
            updatedAt: now - 60_000,
            turnCount: 6,
          }}
          point={{ x: 210, y: 196 }}
          onRename={() => {}}
          onDelete={() => {}}
          onClose={() => {}}
        />
      </>
    );
  },
  'sidebar-context-menu-delete': () => {
    (window as unknown as { __hemiFixtureSessions?: unknown }).__hemiFixtureSessions = {
      sessions: [
        { id: 'conv-procurement', title: '团队工作笔记本采购', createdAt: now - 3600_000, updatedAt: now - 60_000, turnCount: 6 },
        { id: 'conv-files', title: '整理下载文件夹', createdAt: now - 86400_000, updatedAt: now - 7200_000, turnCount: 4 },
      ],
      storageError: null,
    };
    return (
      <>
        <VoiceScreen
          {...screenProps({
            sessionState: 'idle',
            callActive: false,
            currentConversationId: 'conv-procurement',
          })}
        />
        <ConversationContextMenu
          session={{
            id: 'conv-procurement',
            title: '团队工作笔记本采购',
            createdAt: now - 3600_000,
            updatedAt: now - 60_000,
            turnCount: 6,
          }}
          point={{ x: 210, y: 196 }}
          onRename={() => {}}
          onDelete={() => {}}
          onClose={() => {}}
        />
        {/* 菜单走 portal 挂 body，武装态是组件内部 state——挂载后对
            document 里的危险项点一次来定格（本场景无其他打开的菜单）。 */}
        <ArmDangerConfirmOnce />
      </>
    );
  },
  // —— 024 文字输入（v2 inline-composer）：常态 45px／57px 口径与条件提示 ——
  'text-input-empty': () => (
    <VoiceScreen
      {...screenProps({ sessionState: 'idle', callActive: false, transcripts: [] })}
    />
  ),
  'text-input-draft': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: baseChat(),
        textDraft: '帮我把这份报告按章节拆开',
      })}
    />
  ),
  'text-input-multiline': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: baseChat(),
        textDraft: '第一行：核对发票\n第二行：按月份归档\n第三行：输出清单\n第四行：发我链接',
      })}
    />
  ),
  'text-input-sending': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: [...baseChat(), { id: 'q1', text: '帮我把下载文件夹整理一下', createdAt: now, author: 'user' as const }],
        turnPhase: 'thinking',
        streamingReply: '好，我先看一下下载文件夹里',
        textModelBusy: true,
      })}
    />
  ),
  // 048 续：请求已发出、尚无思考/正文事件——单行等待占位（2s 后带计时，≥15s 改口）。
  'text-input-waiting': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: [...baseChat(), { id: 'q1', text: '12 枚硬币里有一枚重量不同，只用天平称 3 次怎么找出来？', createdAt: now, author: 'user' as const }],
        turnPhase: 'thinking',
        textModelBusy: true,
      })}
    />
  ),
  // 055 派手中途的排布（2026-10-14 用户裁决）：思考在前、任务卡在后——本回合
  // 中途出生的卡渲染在流式元素之后（时间线＝先思考后派手），收口后回原位。
  'dispatch-midturn': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: [
          ...baseChat(),
          { id: 'q1', text: '拉一下最新代码', createdAt: now, author: 'user' as const },
          taskItem(runningTask),
        ],
        taskSnaps: taskSnapsOf(runningTask),
        taskState: bundleOf(runningTask),
        turnPhase: 'thinking',
        turnStartedAt: now,
        streamingThinking: { text: '用户要拉最新代码，我派手去仓库跑一遍 git pull。', startedAt: now, endedAt: null },
        textModelBusy: true,
      })}
    />
  ),
  // 056：子 agent 按发起它的 task 调用原地显示（用户反馈「顺序错位」的复现：思考→说明→派单→停止）。
  'orchestrator-inline-order': () => {
    const t = Date.now();
    const explorer = {
      ...runningTask, seq: 95, key: 't-o1', taskId: 'task-o1', agent: 'explorer', agentTitle: '侦察', background: false,
      phase: 'terminal' as const, outcome: 'stopped' as const, outcomeReason: '主 agent 被叫停', verifying: false,
      permission: null, artifacts: [], delivery: null, fileChanges: null, toolCallId: 'toolu_o1',
      taskText: '查 Kiro 订阅档位能出哪些模型', startedAt: t - 20_000, endedAt: t - 2_000, log: [],
    };
    return (
      <VoiceScreen
        {...screenProps({
          sessionState: 'idle',
          callActive: false,
          transcripts: [
            { id: 'u1', text: '再查查', createdAt: t - 30_000, author: 'user' as const },
            { ...taskItem(explorer), createdAt: t - 20_000 },
            {
              id: 'r1', author: 'hemi' as const, createdAt: t - 21_000, replyStatus: 'stopped' as const,
              text: '上次那个子 agent 是被上游 503 打断的（`service_unavailable_error`），不是查不到。我续上它，并另开一个并行推进。',
              parts: [
                { type: 'thinking' as const, text: '续用上次的 explorer。', startedAt: t - 29_000, endedAt: t - 24_000 },
                { type: 'text' as const, text: '上次那个子 agent 是被上游 503 打断的（`service_unavailable_error`），不是查不到。我续上它，并另开一个并行推进。' },
                { type: 'tools' as const, calls: [{ id: 'toolu_o1', tool: 'task', args: { agent: 'explorer', description: '查 Kiro 订阅档位能出哪些模型' }, state: 'error' as const }] },
              ],
            },
          ],
          taskSnaps: taskSnapsOf(explorer),
          taskState: bundleOf(explorer),
        })}
      />
    );
  },
  // 056 编排模式：小派活收成一行（完成的、刚开始的），后台任务仍是完整卡。
  'orchestrator-compact': () => {
    const t = Date.now();
    const done = {
      ...runningTask, seq: 91, key: 't-c1', taskId: 'task-c1', agent: 'explorer', agentTitle: '侦察', background: false,
      phase: 'terminal' as const, outcome: 'complete' as const, verifying: false, permission: null, artifacts: [], delivery: null, fileChanges: null,
      taskText: '读 liblib.tv 首页，确认是否支持 Seedance 2.5', startedAt: t - 9000, endedAt: t - 2000,
      log: [
        { at: t - 8000, text: '已完成：打开 https://www.liblib.tv/（2.1s）' },
        { at: t - 5000, text: '已完成：读取页面正文（1.4s）' },
      ],
    };
    const live = {
      ...runningTask, seq: 92, key: 't-c2', taskId: 'task-c2', agent: 'fixer', agentTitle: '执行', background: false,
      phase: 'running' as const, outcome: null, permission: null, artifacts: [], delivery: null, fileChanges: null,
      taskText: '在 liblib.tv 打开画布页', startedAt: t - 3000, endedAt: null, log: [{ at: t - 2000, text: '已完成：打开 https://www.liblib.tv/canvas' }],
    };
    const bg = { ...runningTask, seq: 93, key: 't-c3', taskId: 'task-c3', agent: 'explorer', agentTitle: '侦察', background: true, taskText: '对比 5 家中转站的价格', startedAt: t - 40_000 };
    return (
      <VoiceScreen
        {...screenProps({
          sessionState: 'idle',
          callActive: false,
          transcripts: [
            { id: 'u1', text: 'liblib 支持 seedance2.5 吗？顺便打开它的画布，再后台帮我比比价', createdAt: t - 12_000, author: 'user' as const },
            taskItem(done),
            taskItem(live),
            taskItem(bg),
          ],
          taskSnaps: taskSnapsOf(done, live, bg),
          taskState: bundleOf(done, live, bg),
          turnPhase: 'thinking',
          turnStartedAt: t - 12_000,
          streamingParts: [
            { type: 'text', text: '支持，LibTV 首页写着已接入 Seedance 2.5。我现在打开画布页，比价放到后台。' },
          ],
          textModelBusy: true,
        })}
      />
    );
  },
  // 056：主 agent 自己动手（工具折叠行）＋派出的子 agent 任务卡（角色徽标）。
  'agent-tools-midturn': () => {
    const explorerTask = { ...runningTask, agent: 'explorer', agentTitle: '侦察', background: false, taskText: '摸清 video 项目的发布脚本' };
    return (
      <VoiceScreen
        {...screenProps({
          sessionState: 'idle',
          callActive: false,
          transcripts: [
            ...baseChat(),
            { id: 'md0', text: '帮我从网上找一下中转站', createdAt: now - 60_000, author: 'user' as const },
            { id: 'md1', text: '渠道全部来自 **Bing 搜索**，有效 3 次。\n\n## 搜了什么、各搜出了哪些\n\n| # | 搜索词 | 渠道 |\n|---|---|---|\n| 1 | `Seedance 2.5 API` | **seevio.ai**、[apishu.com](https://apishu.com) |\n\n> 价格以官网为准。', createdAt: now - 50_000, author: 'hemi' as const },
            { id: 'q1', text: '你能读取到哪些 skill', createdAt: now, author: 'user' as const },
            taskItem(explorerTask),
          ],
          taskSnaps: taskSnapsOf(explorerTask),
          taskState: bundleOf(explorerTask),
          turnPhase: 'thinking',
          turnStartedAt: now,
          streamingThinking: { text: '先看项目里的 .claude/skills，再对照 Hemi 技能库。', startedAt: now - 4000, endedAt: now - 2500 },
          streamingParts: [
            { type: 'thinking', text: '先看项目里的 .claude/skills，再对照 Hemi 技能库。', startedAt: now - 4000, endedAt: now - 2500 },
            { type: 'text', text: '我先看一下项目里的技能目录。' },
            { type: 'tools', calls: [
              { id: 'c1', tool: 'ls', args: { path: '/Users/demo/Projects/video/.claude/skills' }, state: 'done' },
              { id: 'c2', tool: 'read', args: { path: '/Users/demo/Projects/video/.claude/skills/douyin-publish/SKILL.md' }, state: 'done' },
            ] },
            { type: 'text', text: '有 3 个项目技能。发布脚本比较长，交给侦察去摸清：' },
            { type: 'tools', calls: [
              { id: 'c3', tool: 'task', args: { agent: 'explorer', description: '摸清发布脚本' }, state: 'running' },
            ] },
          ],
          textModelBusy: true,
        })}
      />
    );
  },
  // 033：思考强度拨盘（工具行脑形 icon 显示「高」档的琥珀色；点开浮层交互
  // 由验收脚本驱动，静态场景先锁档位与图标颜色）。
  'text-input-effort': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: baseChat(),
        thinkingLevel: 'high',
      })}
    />
  ),
  'text-input-reply': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: [
          { id: 'q1', text: '帮我把下载文件夹整理一下', createdAt: now - 60000, author: 'user' as const },
          { id: 'a1', text: '整理好了：37 张图片按月份归档，3 个文档移到「文档」文件夹。', createdAt: now - 30000, author: 'hemi' as const },
        ],
        turnPhase: 'replying',
      })}
    />
  ),
  'text-input-error': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: [{ id: 'q1', text: '帮我把下载文件夹整理一下', createdAt: now, author: 'user' as const }],
        turnPhase: 'error',
        turnError: '这次没能回应，请重试。',
      })}
    />
  ),
  'text-input-call': () => (
    <VoiceScreen
      {...screenProps({
        transcripts: baseChat(),
        textDraft: '查一下明天的天气',
      })}
    />
  ),
  // 024 Call Dock：通话状态条的三种代表态。
  'call-dock-listening': () => (
    <VoiceScreen
      {...screenProps({
        transcripts: baseChat(),
        interimText: '帮我看看明天的安排',
      })}
    />
  ),
  'call-dock-muted': () => (
    <VoiceScreen
      {...screenProps({
        transcripts: baseChat(),
        callMuted: true,
      })}
    />
  ),
  'call-dock-collapsed': () => (
    <VoiceScreen
      {...screenProps({
        transcripts: baseChat(),
        dockCollapsed: true,
      })}
    />
  ),
  // 024 消息编辑：编辑中（message-edited 场景覆盖回卷后的代表态）。
  'message-edit-active': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: [
          { id: 'q1', text: '帮我调研一下团队笔记本的采购', createdAt: now - 120_000, author: 'user' as const, inputSource: 'text' as const },
          { id: 'a1', text: '好的，我已经整理了三款候选机型，见任务卡片。', createdAt: now - 110_000, author: 'hemi' as const },
          { id: 'q2', text: '预算上限是多少', createdAt: now - 100_000, author: 'user' as const, inputSource: 'text' as const },
        ],
        editingMessageId: 'q1',
      })}
    />
  ),
  // 2026-10-10 回卷语义改版（仿 zcode）：编辑重发后旧内容整段撤下，对话流
  // 止于编辑点——「编辑后」的代表态＝已编辑标记＋重跑的新回复；顺带覆盖
  // 排队撤回的「已撤回，未发送」状态（029 撤回不再复用旧编辑标记）。
  'message-edited': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: [
          { id: 'q1', text: '帮我调研一下团队笔记本的采购（预算 8 千）', createdAt: now - 120_000, author: 'user' as const, inputSource: 'text' as const, editedAt: now - 60_000 },
          { id: 'a1', text: '好的，预算 8 千内我整理了三款候选机型。', createdAt: now - 50_000, author: 'hemi' as const },
          { id: 'q2', text: '重点看轻薄本', createdAt: now - 40_000, author: 'user' as const, inputSource: 'text' as const, withdrawn: true },
        ],
      })}
    />
  ),
  // 2026-10-07 会话审计：回合失败留痕（kind='error'）——提问后不再是凭空断篇。
  'turn-error-trace': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: [
          { id: 'q1', text: '你是谁', createdAt: now - 120_000, author: 'user' as const, inputSource: 'text' as const },
          {
            id: 'e1',
            text: '文本模型请求失败（HTTP 400）：claude-sonnet-5-5 requires adaptive thinking or thinking.type=between_tools; omit thinking or use one of those modes',
            createdAt: now - 118_000,
            author: 'hemi' as const,
            kind: 'error' as const,
          },
          { id: 'q2', text: '1', createdAt: now - 30_000, author: 'user' as const, inputSource: 'text' as const },
          { id: 'a2', text: '我是 Hemi，常驻在你 Mac 桌面的语音助手，可以陪你聊天，也能帮你整理文件、打开应用、查资料。', createdAt: now - 25_000, author: 'hemi' as const },
        ],
      })}
    />
  ),
  'design-parity': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: [
          { id: 'dp-q1', text: '给团队选 3 台工作笔记本，每台预算 8000 元。主要是办公、视频会议和轻量开发，帮我做一份对比和采购建议。', createdAt: now - 300_000, author: 'user' as const },
          { id: 'dp-a1', text: '**建议采用 2 台均衡型 + 1 台轻便型。**\n\n固定办公兼顾日常性能与软件兼容，外出使用优先考虑便携。每台以 8000 元为预算上限，采购前再核实实际配置与报价。', createdAt: now - 240_000, author: 'hemi' as const },
          { ...taskItem(designParityTask) },
          { id: 'dp-q2', text: '外出用的那台，再把重量和续航列为优先核对项。', createdAt: now - 120_000, author: 'user' as const },
          { id: 'dp-a2', text: '收到。外出机型会重点核对重量、实际续航和必要接口；已有采购建议报告与对比表继续保留。', createdAt: now - 60_000, author: 'hemi' as const },
        ],
        taskSnaps: taskSnapsOf(designParityTask),
        taskState: bundleOf(designParityTask),
        currentConversationId: 'conv-procurement',
        conversationTitle: '团队工作笔记本采购',
      })}
    />
  ),
  // 024 连续 Hemi 消息分组：受理/简报/终态各自入流时只保留首个头像行。
  'hemi-grouped': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: [
          { id: 'g-q', text: '今天北京的天气怎么样？', createdAt: now - 200_000, author: 'user' as const },
          { id: 'g-a1', text: '好，并进那个任务。', createdAt: now - 180_000, author: 'hemi' as const },
          { id: 'g-a2', text: '已从中国天气网读回北京今日天气（18:00 更新）', createdAt: now - 120_000, author: 'hemi' as const },
          { id: 'g-a3', text: '北京今天多云、不下雨，当前 18 度，晚上到夜里基本在 18 到 19 度、风不大，穿件薄外套就够。', createdAt: now - 60_000, author: 'hemi' as const },
        ],
      })}
    />
  ),
  // 阶段简报成组：运行中（复刻 conv-mv0nx45i 截图）／收尾后（插话＋折叠）。
  'task-stage-briefs': () => stageBriefScene(false),
  'task-stage-briefs-done': () => stageBriefScene(true),
  // 024 语音来源消息的编辑入口（2026-09-25 用户反馈：语音为主的消息也要能编辑）。
  'voice-message-editable': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: [
          ...baseChat(),
          { id: 'v1', text: '顺便看一下明天的天气', createdAt: now - 80_000, author: 'user' as const, inputSource: 'voice' as const },
          { id: 'va1', text: '明天杭州晴，26 度。', createdAt: now - 70_000, author: 'hemi' as const },
        ],
      })}
    />
  ),
  // 2026-10-09：新对话里一开口——实时识别气泡出现即收起空态引导，输入框沉底（原先气泡飘在空态上方）。
  'empty-interim': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: [],
        interimText: '你觉得，你觉得',
        turnPhase: 'listening',
        textPendingSpeech: true,
      })}
    />
  ),
  'text-input-speech': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: [...baseChat(), { id: 'q1', text: '帮我把下载文件夹整理', createdAt: now, author: 'user' as const }],
        turnPhase: 'listening',
        textPendingSpeech: true,
      })}
    />
  ),
  'text-input-model': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: baseChat(),
        textModelReady: false,
        textDraft: '先记着这句话',
      })}
    />
  ),
  'text-input-collapsed': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: baseChat(),
        textDraft: '收起时草稿仍在',
      })}
    />
  ),
  // —— 050 像素 parity：逐字复刻稿件场景数据，snapshot-compare 对 0.5% 门 ——
  'parity-done-research': () => { paritySessions(); return (<><ParityAnchor selector=".h24-user-message" /><VoiceScreen {...parityScreen(parityResearch, '好，交给我。')} /></>); },
  'parity-followup': () => {
    paritySessions();
    const snap = parityResearch;
    return (
      <VoiceScreen
        {...parityScreen(snap, '好，交给我。', {
          transcripts: [
            ...parityThread(snap, '好，交给我。'),
            { id: 'pu2', text: P_FOLLOW_Q, createdAt: now - 30_000, author: 'user' },
            {
              id: 'ph2',
              text: `${P_FOLLOW_A}\n\n依据上面「调研中转站生图生视频平台」的结果整理，未重新查询`,
              createdAt: now - 28_000,
              author: 'hemi',
            },
          ],
        })}
      />
    );
  },
  'parity-recheck': () => {
    paritySessions();
    const snap = parityResearch;
    return (
      <>
        <ParityAnchor selector=".h24-user-message" index={2} />
        <VoiceScreen
          {...parityScreen(snap, '好，交给我。', {
            transcripts: [
              ...parityThread(snap, '好，交给我。'),
              { id: 'pu2', text: P_FOLLOW_Q, createdAt: now - 60_000, author: 'user' },
              {
                id: 'ph2',
                text: `${P_FOLLOW_A}\n\n依据上面「调研中转站生图生视频平台」的结果整理，未重新查询`,
                createdAt: now - 58_000,
                author: 'hemi',
              },
              { id: 'pu3', text: P_RECHECK_Q, createdAt: now - 30_000, author: 'user' },
              { id: 'ph3', text: '好，我在上一轮结果基础上补查这两家。', createdAt: now - 29_000, author: 'hemi' },
              taskItem(parityRecheck),
            ],
            // 两个任务都要进快照表——只放第一个时补查任务的卡静默缺失。
            taskSnaps: { ...taskSnapsOf(snap), ...taskSnapsOf(parityRecheck) },
            taskState: bundleOf(snap, parityRecheck),
          })}
        />
      </>
    );
  },
  'parity-done-code': () => { paritySessions(); return (<><ParityAnchor selector=".h24-user-message" /><VoiceScreen {...parityScreen(parityCode, '好，我来改。', {}, '导出日志按钮', P_CODE_Q)} /></>); },
  'parity-short-answer': () => { paritySessions(); return (<><ParityAnchor selector=".h24-user-message" /><VoiceScreen {...parityScreen(parityShort, '好。', {}, '整理桌面截图', P_SHORT_Q)} /></>); },
  'parity-failed': () => { paritySessions(); return (<><ParityAnchor selector=".h24-user-message" /><VoiceScreen {...parityScreen(parityFail, '好，我去看看。', {}, '周末去杭州的安排', P_FAIL_Q)} /></>); },
  'parity-stopped': () => { paritySessions(); return (<><ParityAnchor selector=".h24-user-message" /><VoiceScreen {...parityScreen(parityStopped, '好，开始转。', {}, '旅行视频转 GIF', P_STOP_Q)} /></>); },
  'parity-image-partial': () => { paritySessions(); return (<><ParityAnchor selector=".h24-user-message" /><VoiceScreen {...parityScreen(parityImage, '好，画好发你。', {}, '秋天主题壁纸', P_IMAGE_Q)} /></>); },
  'parity-files-missing': () => { paritySessions(); return (<><ParityAnchor selector=".h50-actions" /><VoiceScreen {...parityScreen(parityFilesMissing, '好，交给我。')} /></>); },
  'parity-multi-task': () => {
    paritySessions();
    return (
      <>
        <ParityAnchor selector=".h24-user-message" />
        <VoiceScreen
          {...screenProps({
            sessionState: 'idle',
            callActive: false,
            transcripts: [
              { id: 'mu1', text: P_WX_Q1, createdAt: now - 60_000, author: 'user' },
              { id: 'mh1', text: '我查一下。', createdAt: now - 59_000, author: 'hemi' },
              taskItem(parityWxDone),
              { id: 'mu2', text: P_WX_Q2, createdAt: now - 9000, author: 'user' },
              { id: 'mh2', text: '我查一下上海。', createdAt: now - 8800, author: 'hemi' },
              taskItem(parityWxRunning),
            ],
            taskSnaps: { ...taskSnapsOf(parityWxDone), ...taskSnapsOf(parityWxRunning) },
            taskState: bundleOf(parityWxRunning, parityWxDone),
            currentConversationId: 'conv-parity',
            conversationTitle: '周末去杭州的安排',
          })}
        />
      </>
    );
  },
  // —— 050 任务结果交付（对照 designs/2026-10-10-result-delivery 候选稿）——
  'result-research': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: taskThread(resultResearchTask),
        taskSnaps: taskSnapsOf(resultResearchTask),
        taskState: bundleOf(resultResearchTask),
      })}
    />
  ),
  'result-code': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: taskThread(resultCodeTask),
        taskSnaps: taskSnapsOf(resultCodeTask),
        taskState: bundleOf(resultCodeTask),
      })}
    />
  ),
  'result-short': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: taskThread(resultShortTask),
        taskSnaps: taskSnapsOf(resultShortTask),
        taskState: bundleOf(resultShortTask),
      })}
    />
  ),
  'result-failed': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: taskThread(resultFailedTask),
        taskSnaps: taskSnapsOf(resultFailedTask),
        taskState: bundleOf(resultFailedTask),
      })}
    />
  ),
  'result-stopped': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: taskThread(resultStoppedTask),
        taskSnaps: taskSnapsOf(resultStoppedTask),
        taskState: bundleOf(resultStoppedTask),
      })}
    />
  ),
  'result-files-missing': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: taskThread(resultFilesMissingTask),
        taskSnaps: taskSnapsOf(resultFilesMissingTask),
        taskState: bundleOf(resultFilesMissingTask),
      })}
    />
  ),
  'result-legacy': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: taskThread(resultLegacyTask),
        taskSnaps: taskSnapsOf(resultLegacyTask),
        taskState: bundleOf(resultLegacyTask),
      })}
    />
  ),
  'result-image-partial': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: taskThread(resultImagePartialTask),
        taskSnaps: taskSnapsOf(resultImagePartialTask),
        taskState: bundleOf(resultImagePartialTask),
      })}
    />
  ),
  'result-recheck': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: taskThread(resultRecheckTask),
        taskSnaps: taskSnapsOf(resultRecheckTask),
        taskState: bundleOf(resultRecheckTask),
      })}
    />
  ),
  'result-followup': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: [
          ...taskThread(resultResearchTask),
          {
            id: 't-followup',
            text: '这些平台的域名分别是：即梦 jimeng.jianying.com、可灵 klingai.com、Vidu vidu.cn、通义万相 tongyi.aliyun.com、智谱清言 chatglm.cn、LiblibAI liblib.art、海螺 hailuoai.com、腾讯混元 hunyuan.tencent.com。\n\n依据上面「调研生图生视频平台」的结果整理，未重新查询',
            createdAt: now - 30000,
            author: 'hemi',
          },
        ],
        taskSnaps: taskSnapsOf(resultResearchTask),
        taskState: bundleOf(resultResearchTask),
      })}
    />
  ),
  'result-multi': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: [
          { id: 'multi-u1', text: `${resultShortTask.taskText}。`, createdAt: now - 300000, author: 'user' },
          { id: 'multi-h1', text: '好，交给我。', createdAt: now - 295000, author: 'hemi' },
          taskItem(resultShortTask),
          { id: 'multi-u2', text: `${resultRunningTask.taskText}。`, createdAt: now - 90000, author: 'user' },
          { id: 'multi-h2', text: '好的，正在查。', createdAt: now - 88000, author: 'hemi' },
          taskItem(resultRunningTask),
        ],
        taskSnaps: { ...taskSnapsOf(resultShortTask), ...taskSnapsOf(resultRunningTask) },
        taskState: bundleOf(resultRunningTask, resultShortTask),
      })}
    />
  ),
  'result-preview': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: taskThread(resultResearchTask),
        taskSnaps: taskSnapsOf(resultResearchTask),
        taskState: bundleOf(resultResearchTask),
        initialPreviewTabs: [{ kind: 'artifact', taskId: 'task-6-result', artifactId: null }],
      })}
    />
  ),
  // —— 025 交付（对照 designs/2026-09-23-adaptive-deliverables 候选稿）——
  'delivery-summary': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: taskThread(deliveredTask(summaryDelivery)),
        taskSnaps: taskSnapsOf(deliveredTask(summaryDelivery)),
        taskState: bundleOf(deliveredTask(summaryDelivery)),
      })}
    />
  ),
  // 结果卡卡内直读＋卡后回炉气泡去重（气泡文本＝resultText，应被对话流隐藏）。
  'delivery-card-inline': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: [
          ...taskThread(weekWeatherTask()),
          { id: 't-result', text: weekWeatherTask().resultText ?? '', createdAt: now, author: 'hemi' },
          { id: 't-next', text: '周六要出门的话记得带伞。', createdAt: now, author: 'hemi' },
        ],
        taskSnaps: taskSnapsOf(weekWeatherTask()),
        taskState: bundleOf(weekWeatherTask()),
      })}
    />
  ),
  'delivery-comparison': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: taskThread(deliveredTask(comparisonDelivery)),
        taskSnaps: taskSnapsOf(deliveredTask(comparisonDelivery)),
        taskState: bundleOf(deliveredTask(comparisonDelivery)),
      })}
    />
  ),
  'delivery-checklist': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: taskThread(deliveredTask(checklistDelivery)),
        taskSnaps: taskSnapsOf(deliveredTask(checklistDelivery)),
        taskState: bundleOf(deliveredTask(checklistDelivery)),
      })}
    />
  ),
  'delivery-receipt': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: taskThread(deliveredTask(receiptDelivery)),
        taskSnaps: taskSnapsOf(deliveredTask(receiptDelivery)),
        taskState: bundleOf(deliveredTask(receiptDelivery)),
      })}
    />
  ),
  'delivery-partial': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: taskThread(deliveredTask(partialDelivery)),
        taskSnaps: taskSnapsOf(deliveredTask(partialDelivery)),
        taskState: bundleOf(deliveredTask(partialDelivery)),
      })}
    />
  ),
  'audit-session-partial': () => auditSessionScene(false),
  'audit-session-process': () => auditSessionScene(true),
  'delivery-fallback': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: taskThread(deliveredTask(fallbackDelivery)),
        taskSnaps: taskSnapsOf(deliveredTask(fallbackDelivery)),
        taskState: bundleOf(deliveredTask(fallbackDelivery)),
      })}
    />
  ),
  'delivery-report': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: taskThread(deliveredTask(reportDelivery)),
        taskSnaps: taskSnapsOf(deliveredTask(reportDelivery)),
        taskState: bundleOf(deliveredTask(reportDelivery)),
      })}
    />
  ),
  'delivery-report-reader': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: taskThread(deliveredTask(reportDelivery)),
        taskSnaps: taskSnapsOf(deliveredTask(reportDelivery)),
        taskState: bundleOf(deliveredTask(reportDelivery)),
        initialPreviewTabs: [{ kind: 'artifact', taskId: 'task-5-delivery', artifactId: null }],
      })}
    />
  ),
  'delivery-report-reader-narrow': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: taskThread(deliveredTask(reportDelivery)),
        taskSnaps: taskSnapsOf(deliveredTask(reportDelivery)),
        taskState: bundleOf(deliveredTask(reportDelivery)),
        initialPreviewTabs: [{ kind: 'artifact', taskId: 'task-5-delivery', artifactId: null }],
      })}
    />
  ),
  // 025 → 056：执行中子 agent 的执行过程（第三栏预览 Tab 的一页；运行中自动跟随最新一步）。
  'process-running': () => {
    const t = Date.now();
    const explorer = {
      ...runningTask, seq: 96, key: 't-p1', taskId: 'task-p1', agent: 'explorer', agentTitle: '侦察', background: false,
      taskText: '摸清 video 项目的发布脚本', progressText: '正在搜索内容（已 3 秒）', readOnly: true,
      log: [
        { at: t - 42_000, text: '已完成：查看目录 ~/Projects/video（90ms）' },
        { at: t - 36_000, text: '已完成：读取 ~/Projects/video/package.json（45ms）' },
        { at: t - 28_000, text: '已完成：搜索「deploy\\|publish\\|release」（1.2s）' },
        { at: t - 16_000, text: '已完成：读取 ~/Projects/video/scripts/deploy.sh（120ms）' },
      ],
    };
    return (
      <VoiceScreen
        {...screenProps({
          sessionState: 'idle',
          callActive: false,
          transcripts: taskThread(explorer),
          taskSnaps: taskSnapsOf(explorer),
          taskState: bundleOf(explorer),
          initialProcessTaskKey: 'task-p1',
        })}
      />
    );
  },
  // 026 R-05：应用内文件预览——宽窗右侧面板阅读 Markdown（窄窗覆盖主列）。
  'preview-file': () => (
    <WalkthroughVoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: taskThread(deliveredTask(reportDelivery)),
        taskSnaps: taskSnapsOf(deliveredTask(reportDelivery)),
        taskState: bundleOf(deliveredTask(reportDelivery)),
        initialPreviewTaskKey: 'task-5-delivery',
      })}
    />
  ),
  // 062：本机视频复用既有预览结构；静态媒体只作 UI 样片，不计生产交付证据。
  'preview-video': () => (
    <WalkthroughVoiceScreen
      {...screenProps({
        sessionState: 'idle', callActive: false, currentConversationId: 'conv-demo',
        initialPreviewTabs: [{ kind: 'deliverable', conversationId: 'conv-demo', artifactId: 'fixture-video', linkName: '预览样片.webm' }],
        flowDeliverables: { conversationId: 'conv-demo', generation: 1, items: [{
          artifactId: 'fixture-video', kind: 'file', name: '预览样片.webm', path: '/Users/demo/Movies/预览样片.webm', previewKind: 'video',
        }] },
      })}
    />
  ),
  // 062：Markdown 图片语法复用本地链接入口，点击在右侧读取；无需子任务身份。
  'preview-local-image': () => (
    <WalkthroughVoiceScreen
      {...screenProps({
        sessionState: 'idle', callActive: false, currentConversationId: 'conv-demo',
        transcripts: transcripts([
          ['查看发布后的截图。', 'user'],
          ['截图已保存。\n\n![发布后的作品管理页](</Users/demo/Pictures/发布 截图.png>)', 'hemi'],
        ]),
      })}
    />
  ),
  // 027 R-04/05：多 Tab 预览——报告 + Markdown 两个 Tab，当前在文件（第二行
  // 显示可点击路径与重读）。未支持格式（PDF）不出预览入口，走系统打开。
  'preview-tabs': () => (
    <WalkthroughVoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: taskThread(previewTask),
        taskSnaps: taskSnapsOf(previewTask),
        taskState: bundleOf(previewTask),
        initialPreviewTabs: [
          { kind: 'artifact', taskId: 'task-5-delivery', artifactId: null},
          { kind: 'artifact', taskId: 'task-5-delivery', artifactId: 'art-md' },
        ],
      })}
    />
  ),
  // 027：报告为当前 Tab——第二行只放继续讨论／保存 HTML 图标（无障碍名）。
  'preview-tabs-report': () => (
    <WalkthroughVoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: taskThread(previewTask),
        taskSnaps: taskSnapsOf(previewTask),
        taskState: bundleOf(previewTask),
        initialPreviewTabs: [
          { kind: 'artifact', taskId: 'task-5-delivery', artifactId: 'art-md' },
          { kind: 'artifact', taskId: 'task-5-delivery', artifactId: null},
        ],
      })}
    />
  ),
  // 027：图片 Tab——保持比例居中，工具行仍是路径与重读。
  'preview-tabs-image': () => (
    <WalkthroughVoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: taskThread(previewTask),
        taskSnaps: taskSnapsOf(previewTask),
        taskState: bundleOf(previewTask),
        initialPreviewTabs: [
          { kind: 'artifact', taskId: 'task-5-delivery', artifactId: null},
          { kind: 'artifact', taskId: 'task-5-delivery', artifactId: 'art-img' },
        ],
      })}
    />
  ),
  // 027 R-05：Tab 溢出——超出预览列宽度后出现左右滚动按钮（边界禁用），
  // 当前项自动滚入可见区域。
  'preview-tabs-overflow': () => (
    <WalkthroughVoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: taskThread(overflowTask),
        taskSnaps: taskSnapsOf(overflowTask),
        taskState: bundleOf(overflowTask),
        initialPreviewTabs: [
          { kind: 'artifact', taskId: 'task-5-delivery', artifactId: null},
          ...overflowTask.artifacts!.map((artifact) => ({ kind: 'artifact' as const, taskId: 'task-5-delivery', artifactId: artifact.id })),
        ],
      })}
    />
  ),
  // 028 R-03：附件准备区——文本＋图片两张卡（名称/来源/体积）、附加按钮、
  // 历史消息的附件 chips（已发送形态，右对齐气泡下方）。
  'composer-attachments': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        textDraft: '这两份资料帮我归档到对应项目里',
        draftAttachments: [
          {
            attachmentId: 'att-1', conversationId: 'conv-fixture', name: '项目笔记.md',
            kind: 'text', sizeBytes: 2048, status: 'ready', source: 'picker',
            originPath: '/Users/demo/Documents/项目笔记.md', registeredAt: now - 120_000,
          },
          {
            attachmentId: 'att-2', conversationId: 'conv-fixture', name: `粘贴图片 ${new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(now - 60_000)}`,
            kind: 'image', sizeBytes: 384 * 1024, status: 'ready', source: 'paste',
            originPath: '', registeredAt: now - 60_000,
            thumbnailUrl: FIXTURE_IMAGE_DATA_URL, stagedPath: '/fixtures/staging/att-2.png',
          },
        ],
        transcripts: [
          {
            id: 'm1', text: '上次的对比表帮我留着，稍后要用', createdAt: now - 300_000,
            author: 'user' as const, inputSource: 'text' as const,
            attachments: [
              {
                attachmentId: 'att-0', conversationId: 'conv-fixture', name: '对比表.md',
                kind: 'text', sizeBytes: 4096, status: 'ready', source: 'picker',
                originPath: '/Users/demo/Documents/对比表.md', registeredAt: now - 300_000,
              },
              {
                attachmentId: 'att-img-0', conversationId: 'conv-fixture', name: '粘贴图片 14:32',
                kind: 'image', sizeBytes: 512 * 1024, status: 'ready', source: 'paste',
                originPath: '', registeredAt: now - 300_000,
                thumbnailUrl: FIXTURE_IMAGE_DATA_URL, stagedPath: '/fixtures/staging/att-img-0.png',
              },
            ],
          },
          {
            id: 'm2', text: '好的，文件我收着了；要调整随时说。', createdAt: now - 299_000,
            author: 'hemi' as const,
          },
        ],
      })}
    />
  ),
  // 028 R-03/AC-08：附件与成果同队列——附件 Tab 为当前项（第二行是来源路径），
  // 报告 Tab 保留（去重与切换按真实身份）。
  'preview-attachment': () => (
    <WalkthroughVoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: taskThread(previewTask),
        taskSnaps: taskSnapsOf(previewTask),
        taskState: bundleOf(previewTask),
        attachments: [
          {
            attachmentId: 'att-1', conversationId: 'conv-fixture', name: '项目笔记.md',
            kind: 'text', sizeBytes: 2048, status: 'ready', source: 'picker',
            originPath: '/Users/demo/Documents/项目笔记.md', registeredAt: now - 120_000,
          },
          {
            attachmentId: 'att-img-1', conversationId: 'conv-fixture', name: '粘贴图片 15:07',
            kind: 'image', sizeBytes: 512 * 1024, status: 'ready', source: 'paste',
            originPath: '', registeredAt: now - 90_000,
            thumbnailUrl: FIXTURE_IMAGE_DATA_URL, stagedPath: '/fixtures/staging/att-img-1.png',
          },
        ],
        initialPreviewTabs: [
          { kind: 'artifact', taskId: 'task-5-delivery', artifactId: null },
          { kind: 'attachment', conversationId: 'conv-fixture', attachmentId: 'att-1' },
          { kind: 'attachment', conversationId: 'conv-fixture', attachmentId: 'att-img-1' },
        ],
      })}
    />
  ),
  // 029 R-01：生成中——主操作切换为「停止回应」（方形红棕键），输入仍可编辑。
  'composer-generating': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        turnPhase: 'thinking',
        streamingReply: '已经找到三份相关资料，正在整理它们的共同点：第一份来自官方文档，提到',
        textModelBusy: true,
        textDraft: '',
        modelProfiles: {
          version: 2,
          defaultModelId: 'mp-a/m-chat',
          providers: [
            {
              id: 'mp-a', name: 'DeepSeek 日常', baseUrl: 'https://api.deepseek.com/v1', api: 'openai-completions',
              hasApiKey: true, keyStoredSecurely: true, updatedAt: now - 86_400_000,
              models: [
                { id: 'm-chat', modelKey: 'mp-a/m-chat', model: 'deepseek-chat', thinkingLevel: 'default', supportsVision: false, visionModel: '', isDefault: true },
                { id: 'm-reasoner', modelKey: 'mp-a/m-reasoner', model: 'deepseek-reasoner', thinkingLevel: 'high', supportsVision: true, visionModel: '', isDefault: false },
              ],
            },
          ],
        },
        currentProfileId: 'mp-a/m-chat',
        onSelectModelProfile: () => {},
      })}
    />
  ),
  // 029 R-02：已停止——增量原位保留并标注「未完成 · 已停止」，草稿保留。
  'composer-stopped': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        turnPhase: 'idle',
        textDraft: '换个角度再说说',
        transcripts: [
          {
            id: 'm1', text: '这三份资料的共同点是什么', createdAt: now - 120_000,
            author: 'user' as const, inputSource: 'text' as const,
          },
          {
            id: 'm2', text: '已经找到三份相关资料，正在整理它们的共同点：第一份来自官方文档，提到',
            createdAt: now - 119_000, author: 'hemi' as const, replyStatus: 'stopped' as const,
          },
        ],
      })}
    />
  ),
  // 029 R-03：任务在跑时停止回应——停止键提示「任务继续运行」，任务卡照常。
  'composer-stopped-tasks': () => {
    const runningTask: TaskStateSnapshot = {
      ...baseTask,
      seq: 6,
      key: 't6-running',
      taskId: 'task-6-running',
      phase: 'running',
      progressText: '正在整理下载文件夹（12/42 张）',
    };
    return (
      <VoiceScreen
        {...screenProps({
          sessionState: 'idle',
          callActive: false,
          turnPhase: 'thinking',
          streamingReply: '整理进展我看了一下：',
          textModelBusy: true,
          taskState: bundleOf(runningTask),
          taskSnaps: taskSnapsOf(runningTask),
          transcripts: taskThread(runningTask),
        })}
      />
    );
  },
  // 056 修订：模型在途的追加消息直接入队（无菜单）；排队条目可「并入当前任务」。
  'composer-send-method': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        turnPhase: 'thinking',
        textModelBusy: true,
        streamingReply: '正在整理三份资料的共同点……',
        queueState: {
          paused: false,
          items: [
            {
              queueItemId: 'q-1', conversationId: 'conv-fixture', text: '顺便把结论也存成 md 文件',
              revision: 1, dispatchState: 'pending', error: '', attachmentIds: [], references: [],
              inputSource: 'text', createdAt: now - 8_000,
            },
          ],
        },
      })}
    />
  ),
  // 029 P2：队列托盘——两条待发（一条失败原因）、暂停态带继续发送。
  'composer-queue': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        queueState: {
          paused: true,
          items: [
            {
              queueItemId: 'q-1', conversationId: 'conv-fixture', text: '第一条排队消息：\n带换行的正文',
              revision: 1, dispatchState: 'pending', error: '', attachmentIds: [], references: [],
              inputSource: 'text', createdAt: now - 30_000,
            },
            {
              queueItemId: 'q-2', conversationId: 'conv-fixture', text: '第二条：上次发送失败，改完再试',
              revision: 3, dispatchState: 'pending', error: '网络断了，条目已保留',
              attachmentIds: [], references: [], inputSource: 'voice', createdAt: now - 12_000,
            },
          ],
        },
        inputHistory: ['把下载的图片按月份整理好。', '这三份资料的共同点是什么'],
        onWithdrawQueued: () => {},
        onResumeQueue: () => {},
        onEditQueued: () => {},
      })}
    />
  ),
  // 060 S4：执行中排队托盘——忙碌＋三条待发（文字／语音待核对／长文），行内含
  // 「让这条优先」（060 R-21）与并入、编辑、撤回全动作；验收三档视觉与 AC-12。
  'composer-queue-promote': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        turnPhase: 'thinking',
        textModelBusy: true,
        streamingReply: '',
        queueState: {
          paused: false,
          items: [
            {
              queueItemId: 'q-1', conversationId: 'conv-fixture', text: '队列一号：顺便看看天津的天气',
              revision: 1, dispatchState: 'pending', error: '', attachmentIds: [], references: [],
              inputSource: 'text', createdAt: now - 40_000,
            },
            {
              queueItemId: 'q-2', conversationId: 'conv-fixture', text: '还有高铁票吗，帮我查一下',
              revision: 1, dispatchState: 'pending', error: '投递结果不明，待核对', attachmentIds: [], references: [],
              inputSource: 'voice', createdAt: now - 25_000,
            },
            {
              queueItemId: 'q-3', conversationId: 'conv-fixture', text: '队列三号：把上面两步的结论整理成一份对比清单，发到我的邮箱，主题写「天气与出行」',
              revision: 2, dispatchState: 'pending', error: '', attachmentIds: [], references: [],
              inputSource: 'text', createdAt: now - 10_000,
            },
          ],
        },
        onPromoteQueued: () => {},
        onWithdrawQueued: () => {},
        onEditQueued: () => {},
      })}
    />
  ),
  'composer-queue-sortable': () => <SortableQueueFixture />,
  'composer-queue-full': () => <SortableQueueFixture full />,
  'composer-queue-full-paused': () => <SortableQueueFixture full paused />,
  // ---- 057：对话流统一状态与时间线（AC-24 混合回合／AC-29 同角色并发／停止与待核对）----
  'conversation-flow-mixed': () => {
    const t = Date.now();
    const scout: TaskStateSnapshot = {
      ...runningTask, seq: 71, key: 't-f1', taskId: 'task-f1', agent: 'explorer', agentTitle: '侦察', background: false,
      phase: 'terminal' as const, outcome: 'complete' as const, verifying: false, permission: null, delivery: null, fileChanges: null,
      taskText: '查项目根目录有哪些构建脚本', startedAt: t - 50_000, endedAt: t - 20_000, toolCallId: 'toolu_f1',
      log: [
        { at: t - 48_000, text: '已完成：查看目录 ~/Projects/demo（0.3s）' },
        { at: t - 30_000, text: '已完成：搜索「scripts」（0.2s）' },
      ],
      artifacts: [
        { id: 'art-f1', kind: 'file' as const, name: '构建脚本清单.md', path: '/Users/demo/Projects/demo/构建脚本清单.md', role: 'main', registeredAt: t - 19_000 },
      ],
    };
    return (
      <VoiceScreen
        {...screenProps({
          sessionState: 'idle',
          callActive: false,
          transcripts: [
            {
              id: 'u1', text: '整理一下这个项目的构建方式，出一份清单文件', createdAt: t - 60_000, author: 'user' as const, inputSource: 'text' as const,
              attachments: [{ attachmentId: 'at1', conversationId: 'conv-fixture', name: '项目说明.md', kind: 'text', sizeBytes: 2048, status: 'ready', source: 'picker', registeredAt: t - 61_000 }],
            },
            {
              id: 'r1', author: 'hemi' as const, createdAt: t - 18_000,
              text: '构建脚本都在 scripts/ 目录下，清单已生成。',
              thinking: { text: '先看目录结构，再确认构建入口，最后派侦察核对。', durationMs: 4200 },
              parts: [
                { type: 'thinking' as const, text: '先看目录结构，再确认构建入口，最后派侦察核对。', startedAt: t - 59_000, endedAt: t - 55_000 },
                { type: 'text' as const, text: '构建脚本都在 scripts/ 目录下，清单已生成。' },
                { type: 'tools' as const, calls: [
                  { id: 'toolu_f1', tool: 'task', args: { agent: 'explorer', description: '查项目根目录有哪些构建脚本' }, state: 'done' as const },
                  { id: 'toolu_f2', tool: 'write', args: { path: '~/Projects/demo/构建脚本清单.md' }, state: 'done' as const },
                ] },
              ],
            },
          ],
          taskSnaps: taskSnapsOf(scout),
          taskState: bundleOf(scout),
          queueState: {
            paused: true,
            items: [
              { queueItemId: 'q-1', conversationId: 'conv-fixture', text: '顺便把清单也发我邮箱', revision: 1, dispatchState: 'pending', error: '', attachmentIds: [], references: [], inputSource: 'text', createdAt: t - 9_000 },
              { queueItemId: 'q-2', conversationId: 'conv-fixture', text: '再对比一下隔壁仓库', revision: 1, dispatchState: 'pending', error: '投递结果不明，待核对', attachmentIds: [], references: [], inputSource: 'voice', createdAt: t - 4_000 },
            ],
          },
          onWithdrawQueued: () => {}, onResumeQueue: () => {}, onEditQueued: () => {},
        })}
      />
    );
  },
  // AC-29：同角色并发（相似长标题）＋一次续用——窄窗/长名称仍能定位正确对象。
  // AC-28：四角色共享的全状态样本（准备/运行/等待授权/停止中/已停止/未获授权/已阻止/
  // 部分完成/结果待核实/未能启动/总结失败/已完成）＋后台标记变体——对话行与过程页同词汇。
  'conversation-flow-states': () => {
    const t = Date.now();
    let stSeq = 0;
    const mk = (over: Partial<TaskStateSnapshot>): TaskStateSnapshot => ({
      ...runningTask, seq: (stSeq += 1), key: over.key, taskId: over.taskId,
      agent: 'fixer', agentTitle: '执行', background: false,
      phase: 'terminal' as const, outcome: 'complete' as const, verifying: false,
      permission: null, delivery: null, fileChanges: null, artifacts: [],
      taskText: over.taskText ?? '状态样本', startedAt: t - 60_000, endedAt: t - 30_000, toolCallId: 'toolu_s0',
      log: [{ at: t - 50_000, text: '任务开始。' }],
      ...over,
    } as TaskStateSnapshot);
    const snaps: TaskStateSnapshot[] = [
      mk({ key: 'st-preparing', taskId: 'task-st-preparing', phase: 'preparing', outcome: null, endedAt: null, taskText: '准备中样本' }),
      mk({ key: 'st-running', taskId: 'task-st-running', phase: 'running', outcome: null, endedAt: null, taskText: '运行中样本', progressText: '正在处理第 3 步' }),
      mk({ key: 'st-waiting', taskId: 'task-st-waiting', phase: 'waiting', outcome: null, endedAt: null, taskText: '等待授权样本', permission: { id: 'p1', kind: 'grant', summary: '访问「访达」', options: ['本任务允许', '拒绝'] } as never }),
      mk({ key: 'st-stopping', taskId: 'task-st-stopping', phase: 'stopping', outcome: null, endedAt: null, taskText: '停止中样本' }),
      mk({ key: 'st-stopped', taskId: 'task-st-stopped', outcome: 'stopped', taskText: '已停止样本', outcomeReason: '' }),
      mk({ key: 'st-denied', taskId: 'task-st-denied', outcome: 'denied', taskText: '未获授权样本' }),
      mk({ key: 'st-blocked', taskId: 'task-st-blocked', outcome: 'blocked', taskText: '已阻止样本', outcomeReason: '命令命中禁止规则' }),
      mk({ key: 'st-partial', taskId: 'task-st-partial', outcome: 'partial', taskText: '部分完成样本' }),
      mk({ key: 'st-unknown', taskId: 'task-st-unknown', outcome: 'unknown', taskText: '结果待核实样本' }),
      mk({ key: 'st-startfailed', taskId: 'task-st-startfailed', outcome: 'startfailed', taskText: '未能启动样本', outcomeReason: '工作区目录已失效' }),
      mk({ key: 'st-reportfailed', taskId: 'task-st-reportfailed', outcome: 'reportfailed', taskText: '总结失败样本' }),
      mk({ key: 'st-complete', taskId: 'task-st-complete', outcome: 'complete', taskText: '已完成样本' }),
      mk({ key: 'st-bg-running', taskId: 'task-st-bg-running', phase: 'running', outcome: null, endedAt: null, background: true, taskText: '后台运行样本' }),
      mk({ key: 'st-bg-stopped', taskId: 'task-st-bg-stopped', outcome: 'stopped', background: true, taskText: '后台已停止样本' }),
    ];
    return (
      <VoiceScreen
        {...screenProps({
          sessionState: 'idle',
          callActive: false,
          transcripts: [
            { id: 'u1', text: '把这批状态样本各跑一遍', createdAt: t - 70_000, author: 'user' as const },
            ...snaps.map((snap) => taskItem(snap)),
          ],
          taskSnaps: taskSnapsOf(...snaps),
          taskState: bundleOf(snaps[1]),
        })}
      />
    );
  },
  // AC-30：报告返回＋主 agent 汇总中＋部分文件已可用同时发生——各自状态与成果来源
  // 清楚（卡片态/流式回复/预览 Tab），子报告全文只在过程页不进对话流（不冒充不重复）。
  'conversation-flow-parallel': () => {
    const t = Date.now();
    const scout: TaskStateSnapshot = {
      ...runningTask, seq: 61, key: 't-p1', taskId: 'task-p1', agent: 'explorer', agentTitle: '侦察', background: false,
      phase: 'terminal' as const, outcome: 'complete' as const, verifying: false, permission: null, delivery: null, fileChanges: null,
      taskText: '核对两份季度数据报表的差异', startedAt: t - 90_000, endedAt: t - 40_000, toolCallId: 'toolu_p1',
      resultText: '报表差异结论：Q3 与 Q2 相比，收入列多了两行明细、备注列少了一列；明细数据共 1280 行一致。完整对照清单见交付文件。',
      log: [{ at: t - 80_000, text: '已完成：读取 q3.csv（0.5s）' }, { at: t - 60_000, text: '已完成：读取 q2.csv（0.4s）' }],
      artifacts: [
        { id: 'art-p1', kind: 'file' as const, name: '季度差异对照.md', path: '/Users/demo/Reports/季度差异对照.md', role: 'main', registeredAt: t - 39_000 },
      ],
    };
    const worker: TaskStateSnapshot = {
      ...runningTask, seq: 62, key: 't-p2', taskId: 'task-p2', agent: 'fixer', agentTitle: '执行', background: false,
      phase: 'running' as const, outcome: null, permission: null, artifacts: [], delivery: null, fileChanges: null,
      taskText: '把差异说明补进周报草稿', startedAt: t - 25_000, endedAt: null, toolCallId: 'toolu_p2',
      progressText: '正在编辑 周报草稿.md · 第 3 处',
      log: [{ at: t - 20_000, text: '已完成：读取 周报草稿.md（0.3s）' }],
    };
    return (
      <VoiceScreen
        {...screenProps({
          sessionState: 'idle',
          callActive: false,
          turnPhase: 'replying',
          streamingReply: '两边的进展我先汇总一下：差异核对已经出了结论，对照清单在预览里；周报补写还在进行——',
          transcripts: [
            { id: 'u1', text: '对比两份季度报表并更新周报，结论给我', createdAt: t - 100_000, author: 'user' as const },
            taskItem(scout),
            taskItem(worker),
          ],
          taskSnaps: taskSnapsOf(scout, worker),
          taskState: bundleOf(worker),
          initialPreviewTabs: [{ kind: 'artifact', taskId: 'task-p1', artifactId: 'art-p1' }],
        })}
      />
    );
  },
  'conversation-flow-roles': () => {
    const t = Date.now();
    const first: TaskStateSnapshot = {
      ...runningTask, seq: 81, key: 't-r1', taskId: 'task-r1', agent: 'explorer', agentTitle: '侦察', background: false,
      phase: 'terminal' as const, outcome: 'complete' as const, verifying: false, permission: null, artifacts: [], delivery: null, fileChanges: null, runs: 2,
      taskText: '核对两个 json 配置的差异并把结论写进对照表', startedAt: t - 120_000, endedAt: t - 60_000, toolCallId: 'toolu_r1',
      log: [{ at: t - 100_000, text: '已完成：读取 config.dev.json（0.4s）' }, { at: t - 70_000, text: '已完成：读取 config.prod.json（0.3s）' }],
    };
    const second: TaskStateSnapshot = {
      ...runningTask, seq: 82, key: 't-r2', taskId: 'task-r2', agent: 'explorer', agentTitle: '侦察', background: false,
      phase: 'running' as const, outcome: null, permission: null, artifacts: [], delivery: null, fileChanges: null,
      taskText: '核对两个 json 配置的键名是否与文档一致', startedAt: t - 25_000, endedAt: null, toolCallId: 'toolu_r2',
      progressText: '正在搜索「键名」 · 已查 8 个',
      log: [{ at: t - 20_000, text: '已完成：搜索「键名」（0.6s）' }],
    };
    return (
      <VoiceScreen
        {...screenProps({
          sessionState: 'idle',
          callActive: false,
          transcripts: [
            { id: 'u1', text: '两个配置文件都核对一下：先差异，再跟文档对键名', createdAt: t - 130_000, author: 'user' as const },
            taskItem(first),
            taskItem(second),
          ],
          taskSnaps: taskSnapsOf(first, second),
          taskState: bundleOf(second),
        })}
      />
    );
  },
  // 停止与待核对（1440 额外状态）：部分回复原位「已停止」＋队列暂停＋needs-review。
  'conversation-flow-stopped': () => {
    const t = Date.now();
    return (
      <VoiceScreen
        {...screenProps({
          sessionState: 'idle',
          callActive: false,
          transcripts: [
            { id: 'u1', text: '从 1 数到 100，慢慢来', createdAt: t - 30_000, author: 'user' as const },
            {
              id: 'r1', author: 'hemi' as const, createdAt: t - 12_000, replyStatus: 'stopped' as const,
              text: '1\n2\n3\n4\n5',
              thinking: { text: '用户要慢慢数，直接顺序输出。', durationMs: 1200, interrupted: true },
            },
          ],
          queueState: {
            paused: true,
            items: [
              { queueItemId: 'q-1', conversationId: 'conv-fixture', text: '停了就行，先别数了', revision: 1, dispatchState: 'pending', error: '', attachmentIds: [], references: [], inputSource: 'text', createdAt: t - 5_000 },
            ],
          },
          onWithdrawQueued: () => {}, onResumeQueue: () => {}, onEditQueued: () => {},
        })}
      />
    );
  },
  // 041：语音与通话页（通话偏好＋播报＋识别服务，保存按钮留在页底）。
  'settings-model-voice': () => {
    stubExecutor();
    return <SettingsScreen {...settingsProps} initialPage="voice" />;
  },
  // 026 R-06 / 027：预览失效态——文件被移走，原位说明 + 重试，路径链接禁用。
  'preview-file-missing': () => {
    const missingTask = deliveredTask(reportDelivery, { artifacts: [
      { id: 'art-gone', kind: 'file', name: '整理结果.md', path: '/Users/demo/Documents/整理结果.md', role: 'main', registeredAt: now - 60000 },
    ] });
    return (
      <WalkthroughVoiceScreen
        {...screenProps({
          sessionState: 'idle',
          callActive: false,
          transcripts: taskThread(missingTask),
          taskSnaps: taskSnapsOf(missingTask),
          taskState: bundleOf(missingTask),
          initialPreviewTabs: [{ kind: 'artifact', taskId: 'task-5-delivery', artifactId: 'art-gone' }],
        })}
      />
    );
  },
  // 026 像素 parity：内容逐字段对齐候选稿 prototype 的 complete 态（办公椅报价），
  // 与 designs/…/exports/main-complete-1440.png 做 0.5% 同页对比。
  'design-parity-026': () => {
    const t0 = now - 60_000;
    const parityTask: TaskStateSnapshot = {
      ...baseTask,
      seq: 8,
      key: 't8-parity',
      taskId: 'task-8-parity',
      phase: 'terminal',
      outcome: 'complete',
      readOnly: false,
      taskText: '办公椅采购报价对比',
      progressText: '已完成',
      startedAt: t0,
      log: [
        { at: t0, text: '已读取三份报价。' },
        { at: t0 + 42_000, text: '已核对 3 份报价。' },
      ],
      resultText: '已核对三份报价，含运费总价最低的是青木办公。',
      artifacts: [
        { id: 'p-md', kind: 'file', name: '办公椅核对说明.md', path: '/Users/demo/Desktop/办公椅核对说明.md', role: 'main', registeredAt: t0 + 40_000 },
        { id: 'p-csv', kind: 'file', name: '办公椅报价对比.csv', path: '/Users/demo/Desktop/办公椅报价对比.csv', role: 'main', registeredAt: t0 + 41_000 },
      ],
      delivery: {
        schemaVersion: 1,
        form: 'report',
        kind: 'report',
        title: '办公椅采购比较',
        summary: '包含三家报价、比较依据与待核实项',
        blocks: [{ type: 'p', text: '按单价加运费的同一口径计算，青木办公总价最低；博远办公保修更长。' }],
        sources: [
          { id: 'ps-1', title: '办公椅报价 A.pdf' },
          { id: 'ps-2', title: '办公椅报价 B.pdf' },
          { id: 'ps-3', title: '办公椅报价 C.xlsx' },
        ],
        mainArtifacts: ['p-md', 'p-csv'],
        attachmentArtifacts: [],
        registeredAt: t0 + 42_000,
      } as TaskDelivery,
      lastAction: null,
    };
    (window as unknown as { __hemiFixtureSessions?: unknown }).__hemiFixtureSessions = {
      sessions: [
        { id: 'conv-quote', title: '办公椅采购报价对比', createdAt: t0 - 300_000, updatedAt: t0, turnCount: 4 },
        { id: 'conv-other', title: '报价核对建议', createdAt: t0 - 900_000, updatedAt: t0 - 600_000, turnCount: 2 },
      ],
      storageError: null,
    };
    return (
      <VoiceScreen
        {...screenProps({
          sessionState: 'idle',
          callActive: false,
          transcripts: [
            {
              id: 'p26-u1',
              text: '把桌面上的三份办公椅报价整理成一张表，找出含运费总价最低的一家，并保存对比结果。',
              createdAt: t0 - 120_000,
              author: 'user' as const,
            },
            taskItem(parityTask),
            {
              id: 'p26-a1',
              text: '**已核对三份报价。**含运费总价最低的是青木办公：单价 ¥1,280，运费 ¥80，合计 **¥1,360**。博远办公提供 3 年保修，但总价高 ¥170。',
              createdAt: t0 + 42_000,
              author: 'hemi' as const,
              taskId: parityTask.taskId ?? undefined,
            },
          ],
          taskSnaps: taskSnapsOf(parityTask),
          taskState: bundleOf(parityTask),
          currentConversationId: 'conv-quote',
          conversationTitle: '办公椅采购报价对比',
        })}
      />
    );
  },
  // 027 像素 parity：对齐 027 候选稿 preview-tabs 导出（办公椅故事）——
  // 报告 + md 两 Tab、当前在 md、路径条 ~/桌面/办公椅/办公椅核对说明.md，
  // 与 designs/…/exports/preview-tabs-1440.png 做 0.5% 同页对比。
  'design-parity-027': () => {
    const t0 = now - 60_000;
    const parityTask: TaskStateSnapshot = {
      ...baseTask,
      seq: 9,
      key: 't9-parity',
      taskId: 'task-9-parity',
      phase: 'terminal',
      outcome: 'complete',
      readOnly: false,
      taskText: '办公椅采购报价对比',
      progressText: '已完成',
      startedAt: t0,
      log: [
        { at: t0, text: '已读取三份报价。' },
        { at: t0 + 42_000, text: '已核对 3 份报价。' },
      ],
      resultText: '已核对三份报价，含运费总价最低的是青木办公。',
      artifacts: [
        { id: 'p-md', kind: 'file', name: '办公椅核对说明.md', path: '~/桌面/办公椅/办公椅核对说明.md', role: 'main', registeredAt: t0 + 40_000 },
        { id: 'p-img', kind: 'file', name: '报价对比图.png', path: '~/桌面/办公椅/报价对比图.png', role: 'main', registeredAt: t0 + 41_000 },
        { id: 'p-txt', kind: 'file', name: '核对记录.txt', path: '~/桌面/办公椅/核对记录.txt', role: 'main', registeredAt: t0 + 41_500 },
      ],
      delivery: {
        schemaVersion: 1,
        form: 'report',
        kind: 'report',
        title: '办公椅采购报价对比',
        summary: '结论、逐项报价与待核实事项',
        blocks: [{ type: 'p', text: '按单价加运费的同一口径计算，青木办公总价最低；博远办公保修更长。' }],
        sources: [],
        mainArtifacts: ['p-md'],
        attachmentArtifacts: [],
        registeredAt: t0 + 42_000,
      } as TaskDelivery,
      lastAction: null,
    };
    (window as unknown as { __hemiFixtureSessions?: unknown }).__hemiFixtureSessions = {
      sessions: [
        { id: 'conv-quote', title: '办公椅采购报价对比', createdAt: t0 - 300_000, updatedAt: t0, turnCount: 4 },
      ],
      storageError: null,
    };
    return (
      <WalkthroughVoiceScreen
        {...screenProps({
          sessionState: 'idle',
          callActive: false,
          transcripts: [
            {
              id: 'p27-u1',
              text: '把桌面上的三份办公椅报价整理成一张表，找出含运费总价最低的一家，并保存对比结果。',
              createdAt: t0 - 120_000,
              author: 'user' as const,
            },
            taskItem(parityTask),
            {
              id: 'p27-a1',
              text: '**已核对三份报价。**含运费总价最低的是青木办公：单价 ¥1,280，运费 ¥80，合计 **¥1,360**。博远办公提供 3 年保修，但总价高 ¥170。',
              createdAt: t0 + 42_000,
              author: 'hemi' as const,
              taskId: parityTask.taskId ?? undefined,
            },
          ],
          taskSnaps: taskSnapsOf(parityTask),
          taskState: bundleOf(parityTask),
          currentConversationId: 'conv-quote',
          conversationTitle: '办公椅采购报价对比',
          initialPreviewTabs: [
            { kind: 'artifact', taskId: 'task-9-parity', artifactId: null},
            { kind: 'artifact', taskId: 'task-9-parity', artifactId: 'p-md' },
          ],
        })}
      />
    );
  },
  // 024 执行过程页（设计稿 execution-timeline：摘要行＋步骤时间轴）。
  'delivery-process': () => {
    const processTask = deliveredTask(reportDelivery, {
      taskText: '给团队选 3 台工作笔记本，每台预算 8000 元，做对比和采购建议。',
      log: [
        { at: now - 138_000, text: '已理解任务：按每台 8000 元预算挑选 3 台工作笔记本，输出对比与采购建议。' },
        { at: now - 116_000, text: '已完成：检索厂商官方规格页' },
        { at: now - 92_000, text: '已完成：核对第三方评测的续航与便携数据' },
        { at: now - 64_000, text: '已完成：整理三款候选机型参数对比表' },
        { at: now - 38_000, text: '已完成：撰写采购建议报告并交叉核对预算边界' },
        { at: now - 20_000, text: '成果已登记：「工作笔记本采购建议报告」' },
      ],
    });
    return (
      <VoiceScreen
        {...screenProps({
          sessionState: 'idle',
          callActive: false,
          transcripts: taskThread(processTask),
          taskSnaps: taskSnapsOf(processTask),
          taskState: bundleOf(processTask),
          initialProcessTaskKey: 'task-5-delivery',
        })}
      />
    );
  },
  // 037 记忆页：桩与预设见 installMemoryFixture；视觉基准 designs/2026-10-03-memory。
  'settings-memory': () => memoryScene({ preset: { ...MEMORY_WS, expanded: ['周报使用英文'] } }),
  'settings-memory-edit': () =>
    memoryScene({
      preset: {
        ...MEMORY_WS,
        external: true,
        editor: {
          title: '构建并发数用 4',
          draftBody: '打包时并发开到 8 会把内存吃满导致签名步骤超时，4 最稳。CI 上也用 4。',
          conflict: { title: '构建并发数用 6', body: '换到 M4 Pro 后并发 6 也稳定，签名不再超时。' },
        },
      },
    }),
  'settings-memory-add': () => memoryScene({ preset: { ...MEMORY_WS, editor: { add: true, draftTitle: '发版前先跑 typecheck' } } }),
  'settings-memory-menu': () => memoryScene({ preset: { ...MEMORY_WS, menu: { entry: '构建并发数用 4' } } }),
  'settings-memory-page-menu': () => memoryScene({ preset: { ...MEMORY_WS, menu: 'page' } }),
  'settings-memory-ws': () => memoryScene({ preset: { ...MEMORY_WS, menu: 'ws' } }),
  'settings-memory-user': () => memoryScene({ preset: { tab: 'user' } }),
  'settings-memory-loose': () => memoryScene({ preset: { tab: 'facts' } }),
  'settings-memory-search': () => memoryScene({ preset: { ...MEMORY_WS, query: '并发' } }),
  'settings-memory-empty': () => memoryScene({ preset: { tab: 'workspace', workspaceId: 'ws-atlas' } }),
  'settings-memory-error': () =>
    memoryScene({ preset: { tab: 'workspace', workspaceId: 'ws-kiwi' }, failScope: 'workspace/ws-kiwi' }),
  'settings-memory-clear': () => memoryScene({ preset: { ...MEMORY_WS, dialog: 'clear' } }),
  'settings-memory-delete': () => memoryScene({ preset: { ...MEMORY_WS, dialog: { delete: '构建并发数用 4' } } }),
  'settings-memory-move': () => memoryScene({ preset: { ...MEMORY_WS, dialog: { move: '周报使用英文', to: 'global/facts' } } }),
  'settings-memory-leave': () =>
    memoryScene({
      preset: {
        ...MEMORY_WS,
        editor: { title: '周报使用英文', draftBody: '这个项目的周报正文和标题都用英文写，专有名词保留原文；会议纪要仍用中文。' },
        dialog: 'leave',
      },
    }),
  'settings-memory-toast': () =>
    memoryScene({ preset: { ...MEMORY_WS, toast: { text: '已删除「构建并发数用 4」', undo: true } } }),
  'settings-memory-raw': () => memoryScene({ preset: { tab: 'facts', raw: true } }),
  'settings-memory-switch-error': () => memoryScene({ preset: { ...MEMORY_WS, switchError: '没能保存，请重试' } }),
  // 037 对话内的记忆提示：记住 / 任务经验 / 撤销后 / 冲突 / 失败。
  'chat-memory-record': () =>
    memoryChatScene(
      [
        { state: 'ok', verb: '记住了', title: '周报使用英文', scopeKey: 'workspace/ws-hemi', scopeLabel: 'Hemi 项目', operationId: 'op-1' },
        { state: 'ok', verb: '记下一条任务经验', title: '排查快捷键前先检查辅助功能权限', scopeKey: 'workspace/ws-hemi', scopeLabel: 'Hemi 项目', operationId: 'op-2' },
      ],
      [
        ['这个项目的周报都用英文写吧。', 'user'],
        ['好的，之后 Hemi 项目的周报正文和标题都用英文，专有名词保留原文。', 'hemi'],
      ],
    ),
  'chat-memory-forget': () =>
    memoryChatScene(
      [
        { state: 'forgot', title: '构建并发数用 4', scopeKey: 'workspace/ws-hemi', scopeLabel: 'Hemi 项目', operationId: 'op-3' },
      ],
      [
        ['把「构建并发数用 4」这条忘掉吧，现在用 6 了。', 'user'],
        ['已经忘掉了。以后打包时我会按你当时说的来。', 'hemi'],
      ],
    ),
  'chat-memory-states': () =>
    memoryChatScene(
      [
        { state: 'undone', title: '周报使用英文', scopeKey: 'workspace/ws-hemi', scopeLabel: 'Hemi 项目', operationId: null, snapshot: { title: '周报使用英文', body: '', kind: 'fact', sourceRefs: [] } },
        { state: 'conflict', title: '构建并发数用 4', scopeKey: 'workspace/ws-hemi', scopeLabel: 'Hemi 项目', operationId: null },
        { state: 'err', title: '默认用中文交流', scopeKey: 'global/user', scopeLabel: '关于你', operationId: null, reason: '记忆文件被占用' },
      ],
      [
        ['以后都默认用中文交流。', 'user'],
        ['好的。', 'hemi'],
      ],
    ),
  // 037 模型页 v2：正在使用 / 供应商摘要（surfaces 稿 settings-model）。
  'settings-model': () => {
    stubModelV2(null);
    return <SettingsScreen {...settingsProps} initialPage='models' />;
  },
  // 037 模型页 v2：下钻到供应商详情（稿 settings-model-provider）。
  'settings-model-provider': () => {
    stubModelV2({ view: { kind: 'provider', id: 'mp-qwen' } });
    return <SettingsScreen {...settingsProps} initialPage='models' />;
  },
  // 037 模型页 v2：添加供应商（预设已选通义、Key 已粘贴且测试通过；稿 settings-model-add）。
  'settings-model-add': () => {
    stubModelV2({
      view: { kind: 'add' },
      add: { presetId: 'qwen', apiKey: 'sk-example-000000000000000000', status: { state: 'ok', latencyMs: 398 } },
    });
    return <SettingsScreen {...settingsProps} initialPage='models' />;
  },
  // 047 添加页方式选择：默认 New API 站点登录（未开始，地址输入）。
  'settings-model-add-newapi': () => {
    stubModelV2({ view: { kind: 'add' } });
    setProviderImportFixtureState(null);
    return <SettingsScreen {...settingsProps} initialPage='models' />;
  },
  // 047 站点导入：登录阶段（浏览器里站点登录页，控制区「我已登录，继续」）。
  'settings-import-login': () => {
    stubModelV2({ view: { kind: 'add' } });
    setProviderImportFixtureState(importFixtureState({
      phase: 'login',
      control: 'user',
    }));
    return <SettingsScreen {...settingsProps} initialPage='models' />;
  },
  'settings-import-login-memory-error': () => {
    stubModelV2({ view: { kind: 'add' } });
    setProviderImportFixtureState(importFixtureState({
      phase: 'login', control: 'user',
      loginMemoryError: '账号密码或登录状态未能加密保存，请检查本机钥匙串和存储权限',
    }));
    return <SettingsScreen {...settingsProps} initialPage='models' />;
  },
  // 047 站点导入：分组与模型选择（含混合协议预览＋提交按钮）。
  'settings-import-selecting': () => {
    stubModelV2({ view: { kind: 'add' } });
    setProviderImportFixtureState(importFixtureState({
      phase: 'selecting',
      control: 'user',
      groups: [
        { name: 'default', desc: '默认分组' },
        { name: 'vip', desc: '高价直连' },
      ],
      candidates: [
        { modelName: 'gpt-5.2', apis: ['openai-completions'], unsupported: [] },
        { modelName: 'claude-opus-4.6', apis: ['anthropic-messages', 'openai-completions'], unsupported: [] },
        { modelName: 'gemini-3-pro', apis: [], unsupported: ['gemini'] },
      ],
      selection: {
        group: 'default',
        budgetMode: 'unlimited',
        expiryMode: 'never',
        models: [
          { modelName: 'gpt-5.2', api: 'openai-completions' },
          { modelName: 'claude-opus-4.6', api: 'anthropic-messages' },
        ],
        firstDefaultModelKey: null,
      },
      preview: {
        planHash: 'fixture-hash',
        firstDefaultModelKey: null,
        providers: [
          { name: 'VVCode · default · Anthropic', api: 'anthropic-messages', baseUrl: 'https://vvcode.top', models: ['claude-opus-4.6'] },
          { name: 'VVCode · default', api: 'openai-completions', baseUrl: 'https://vvcode.top/v1', models: ['gpt-5.2'] },
        ],
      },
    }));
    return <SettingsScreen {...settingsProps} initialPage='models' />;
  },
  // 047 站点导入：自动执行中（验证模型，带逐型号结果）。
  'settings-import-progress': () => {
    stubModelV2({ view: { kind: 'add' } });
    setProviderImportFixtureState(importFixtureState({
      phase: 'validating',
      control: 'hemi',
      validation: [
        { modelName: 'gpt-5.2', api: 'openai-completions', ok: true, code: null },
        { modelName: 'claude-opus-4.6', api: 'anthropic-messages', ok: false, code: 'timeout' },
      ],
    }));
    return <SettingsScreen {...settingsProps} initialPage='models' />;
  },
  // 047 站点导入：成功回执（混合协议拆两条供应商，Key 不回显）。
  'settings-import-success': () => {
    stubModelV2({ view: { kind: 'add' } });
    setProviderImportFixtureState(importFixtureState({
      phase: 'success',
      control: 'user',
      result: {
        providerIds: ['mpi-fixture-0', 'mpi-fixture-1'],
        modelKeys: ['mpi-fixture-0/gpt-5.2', 'mpi-fixture-1/claude-opus-4.6'],
        providers: [
          { id: 'mpi-fixture-0', name: 'VVCode · default', api: 'openai-completions', baseUrl: 'https://vvcode.top/v1', modelCount: 1 },
          { id: 'mpi-fixture-1', name: 'VVCode · default · Anthropic', api: 'anthropic-messages', baseUrl: 'https://vvcode.top', modelCount: 1 },
        ],
        encrypted: true,
      },
    }));
    return <SettingsScreen {...settingsProps} initialPage='models' />;
  },
  // 047 站点导入：验证失败（Key 已创建；逐型号失败原因＋断点重试/撤销退出）。
  'settings-import-failed': () => {
    stubModelV2({ view: { kind: 'add' } });
    setProviderImportFixtureState(importFixtureState({
      phase: 'failed',
      control: 'user',
      tokenName: 'Hemi-20261008-a1b2',
      error: { code: 'VERIFY_FAILED', message: '有型号没通过验证', retryTarget: 'validating' },
      validation: [
        { modelName: 'gpt-5.2', api: 'openai-completions', ok: true, code: null },
        { modelName: 'claude-opus-4.6', api: 'anthropic-messages', ok: false, code: 'not-visible' },
      ],
    }));
    return <SettingsScreen {...settingsProps} initialPage='models' />;
  },
  // 056 角色路由：已配置（主 agent qwen-max，顾问跟随主 agent，备用未配）。
  'settings-role-models': () => {
    stubModelV2(null);
    return <SettingsScreen {...settingsProps} initialPage='models' />;
  },
  // 056：未配置（主 agent 空 → 脚注提示先配主 agent，四个角色显示「同主 agent」）。
  'settings-role-models-empty': () => {
    stubModelV2(null, roleModelsFixture({
      main: { modelKey: null }, explorer: { modelKey: null }, fixer: { modelKey: null }, designer: { modelKey: null },
    }));
    return <SettingsScreen {...settingsProps} initialPage='models' />;
  },
  // 056：失效（顾问配了已删除的模型、设计配了不看图的模型）。
  'settings-role-models-invalid': () => {
    stubModelV2(null, roleModelsFixture({
      oracle: { modelKey: 'mp-gone/m1', ready: false, reason: 'missing' },
      designer: { modelKey: 'mp-deep/m-chat', ready: false, reason: 'no-vision' },
      fallback: { modelKey: 'mp-deep/m-reasoner' },
    }));
    return <SettingsScreen {...settingsProps} initialPage='models' />;
  },
  // 056：模型路由弹窗（设置卡「配置…」与模型菜单齿轮共用）——已配置态。
  'model-routing-dialog': () => {
    stubModelV2(null);
    return (
      <main className="min-h-dvh">
        <ModelRoutingDialogFixture />
      </main>
    );
  },
  // 056：模型路由弹窗——保存失败态（失败说明独立成行＋重试）。
  'model-routing-dialog-error': () => {
    stubModelV2(null);
    return (
      <main className="min-h-dvh">
        <ModelRoutingDialogFixture error={{ slot: 'fixer', message: '没保存上：主进程没有确认模型路由' }} />
      </main>
    );
  },

  // 031 R-01/02：多组模型配置——列表（默认星标/未配 Key 徽标）＋详情编辑与逐组测试。
  'settings-model-profiles': () => {
    stubExecutor();
    return (
      <SettingsScreen
        {...settingsProps}
        initialPage="models"
        modelProfilesFixture={{
          version: 2,
          defaultModelId: 'mp-deep/m-chat',
          providers: [
            {
              id: 'mp-deep', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', api: 'openai-completions',
              hasApiKey: true, keyStoredSecurely: true, updatedAt: now - 86_400_000,
              models: [
                { id: 'm-chat', modelKey: 'mp-deep/m-chat', model: 'deepseek-chat', thinkingLevel: 'default', supportsVision: false, visionModel: '', isDefault: true },
                { id: 'm-reasoner', modelKey: 'mp-deep/m-reasoner', model: 'deepseek-reasoner', thinkingLevel: 'high', supportsVision: true, visionModel: '', isDefault: false },
                { id: 'm-coder', modelKey: 'mp-deep/m-coder', model: 'deepseek-coder', thinkingLevel: 'off', supportsVision: false, visionModel: '', isDefault: false },
              ],
            },
            {
              id: 'mp-local', name: '本地模型', baseUrl: 'http://127.0.0.1:11434/v1', api: 'openai-completions',
              hasApiKey: false, keyStoredSecurely: false, updatedAt: now - 3_600_000,
              models: [
                { id: 'm-qwen', modelKey: 'mp-local/m-qwen', model: 'qwen3:14b', thinkingLevel: 'off', supportsVision: false, visionModel: '', isDefault: false },
              ],
            },
          ],
        }}
      />
    );
  },
  // 031 R-03：输入区模型选择器——chip 触发器常驻工具行（下拉为交互态，另走真机走查）。
  // ---- 033 工作区：默认态 / 菜单 / 项目指定+成果路径 / 目录失效 ----
  // 新对话首屏：上下文栏只显示一个「默认空间」入口（v2 用户裁决的默认态）。
  'workspace-default': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        textDraft: '',
      })}
    />
  ),
  // 工作区菜单展开：搜索 + 默认空间（带路径）+ 项目列表 + 打开文件夹…。
  'workspace-menu': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        workspaceFixtureOpen: true,
      })}
    />
  ),
  // 项目已指定：chip 显示项目名 + ×，任务卡带工作区归属，成果显示真实绝对路径。
  'workspace-project': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        textDraft: '',
        workspaceCurrent: {
          kind: 'view',
          view: { id: 'ws-atlas', type: 'project', name: 'Atlas', dir: '/Volumes/Projects/Atlas', status: 'ok' },
        },
        taskSnaps: taskSnapsOf(deliveredWorkspaceTask),
        taskState: bundleOf(deliveredWorkspaceTask),
        transcripts: [
          {
            id: 'w1', text: '把三个供应商的报价整理成对比文件', createdAt: now - 240_000,
            author: 'user' as const, inputSource: 'text' as const,
          },
          taskItem(deliveredWorkspaceTask),
        ],
      })}
    />
  ),
  // 目录失效：琥珀条解释 + 重新选择；发送禁用、草稿保留（不静默改道）。
  'workspace-missing': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        textDraft: '把竞品分析放进这个项目里',
        workspaceState: fixtureWorkspaceState({
          projects: [
            { id: 'ws-atlas', type: 'project', name: 'Atlas', dir: '/Volumes/Projects/Atlas', status: 'missing', message: '目录不存在或已移走' },
            { id: 'ws-studio', type: 'project', name: 'Studio', dir: '/Users/demo/Projects/Studio', status: 'ok' },
          ],
        }),
        workspaceCurrent: {
          kind: 'view',
          view: { id: 'ws-atlas', type: 'project', name: 'Atlas', dir: '/Volumes/Projects/Atlas', status: 'missing', message: '目录不存在或已移走' },
        },
        workspaceSendBlocked: true,
        transcripts: [
          {
            id: 'w0', text: '帮我盯着这个项目的文档', createdAt: now - 600_000,
            author: 'user' as const, inputSource: 'text' as const,
          },
          { id: 'w0r', text: '好的，项目文档我看着。', createdAt: now - 599_000, author: 'hemi' as const },
        ],
      })}
    />
  ),
  // ---- 049 远端工作区：菜单 / 绑定 / 连接不可用 / 添加对话框（像素对照交互稿 v2） ----
  'h49-remote-menu': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        workspaceState: fixtureRemoteWorkspaceState(),
        workspaceCurrent: { kind: 'view', view: fixtureRemoteWorkspaceState().default },
        workspaceFixtureOpen: true,
      })}
    />
  ),
  'h49-remote-bound': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        textDraft: '',
        workspaceState: fixtureRemoteWorkspaceState(),
        workspaceCurrent: {
          kind: 'view',
          view: {
            id: 'ws-remote-atlas', type: 'project', name: 'atlas', dir: '/home/dev/projects/atlas',
            status: 'ok', host: 'devbox', remoteHome: '/home/dev',
          },
        },
      })}
    />
  ),
  'h49-remote-offline': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        textDraft: '修一下失败的测试',
        workspaceState: fixtureRemoteWorkspaceState({
          projects: [
            {
              id: 'ws-remote-atlas', type: 'project', name: 'atlas', dir: '/home/dev/projects/atlas',
              status: 'missing', message: '连接超时', host: 'devbox', remoteHome: '/home/dev',
            },
            { id: 'ws-atlas', type: 'project', name: 'Atlas', dir: '/Volumes/Projects/Atlas', status: 'ok' },
          ],
        }),
        workspaceCurrent: {
          kind: 'view',
          view: {
            id: 'ws-remote-atlas', type: 'project', name: 'atlas', dir: '/home/dev/projects/atlas',
            status: 'missing', message: '连接超时', host: 'devbox', remoteHome: '/home/dev',
          },
        },
        workspaceSendBlocked: true,
      })}
    />
  ),
  'h49-dialog-empty': () => (
    <main className="min-h-dvh">
      <RemoteFolderDialog onClose={() => {}} />
    </main>
  ),
  'h49-dialog-checking': () => (
    <main className="min-h-dvh">
      <RemoteFolderDialog
        onClose={() => {}}
        fixture={{ host: 'devbox', dir: '~/projects/atlas', phase: 'checking' }}
      />
    </main>
  ),
  'h49-dialog-error-auth': () => (
    <main className="min-h-dvh">
      <RemoteFolderDialog
        onClose={() => {}}
        fixture={{
          host: 'devbox',
          dir: '~/projects/atlas',
          phase: 'error',
          error: {
            field: 'host',
            text: 'devbox 拒绝了登录（Permission denied）。先在终端运行 ssh devbox 确认能免密登录，再回来添加。',
          },
        }}
      />
    </main>
  ),
  // 049：远端任务执行中（任务卡归属带主机，进度行/日志写 devbox 操作）。
  'h49-dialog-error-hostkey': () => (
    <main className="min-h-dvh">
      <RemoteFolderDialog
        onClose={() => {}}
        fixture={{
          host: 'devbox',
          dir: '~/projects/atlas',
          phase: 'error',
          error: {
            field: 'host',
            text: '还没确认过 devbox 的主机指纹。先在终端运行一次 ssh devbox 并确认指纹，再回来添加。',
          },
        }}
      />
    </main>
  ),
  'h49-remote-running': () => {
    const running: TaskStateSnapshot = {
      ...baseTask,
      taskText: '给 atlas 加一个 /healthz 健康检查接口，跑一遍测试',
      progressText: '正在 devbox 上跑测试 · 已改 2 个文件',
      workspace: { id: 'ws-remote-atlas', type: 'project', name: 'atlas', dir: '/home/dev/projects/atlas', host: 'devbox', remoteHome: '/home/dev' },
      log: [
        { at: now - 70000, text: '读了 devbox:~/projects/atlas 的 AGENTS.md 和路由目录。' },
        { at: now - 40000, text: '新增 src/routes/health.ts，在 src/app.ts 注册路由。' },
        { at: now - 5000, text: '在 devbox 上运行 npm test。' },
      ],
      lastAction: { tool: 'bash', args: { command: 'npm test' } },
    };
    return (
      <VoiceScreen
        {...screenProps({
          sessionState: 'idle',
          callActive: false,
          textDraft: '',
          workspaceState: fixtureRemoteWorkspaceState(),
          workspaceCurrent: {
            kind: 'view',
            view: {
              id: 'ws-remote-atlas', type: 'project', name: 'atlas', dir: '/home/dev/projects/atlas',
              status: 'ok', host: 'devbox', remoteHome: '/home/dev',
            },
          },
          transcripts: taskThread(running),
          taskSnaps: taskSnapsOf(running),
          taskState: bundleOf(running),
        })}
      />
    );
  },
  // 049：远端审批卡（风险确认：命令在 devbox 上执行，卡面写明服务器与路径）。
  'h49-remote-approval': () => {
    const waiting: TaskStateSnapshot = {
      ...baseTask,
      taskText: '给 atlas 加一个 /healthz 健康检查接口，跑一遍测试',
      progressText: '等待确认删除 · 尚未改动',
      readOnly: true,
      workspace: { id: 'ws-remote-atlas', type: 'project', name: 'atlas', dir: '/home/dev/projects/atlas', host: 'devbox', remoteHome: '/home/dev' },
      permission: {
        id: 'h49-u1',
        kind: 'action',
        summary: "在 devbox 上删除「dist」文件夹？",
        tool: 'bash',
        args: { command: "rm -rf -- '/home/dev/projects/atlas/dist'" },
        note: '服务器 devbox · 项目 ~/projects/atlas。删除后需要重新构建。',
        options: ['本任务允许', '拒绝'],
        remainingMs: 21000,
      },
    };
    return (
      <VoiceScreen
        {...screenProps({
          sessionState: 'idle',
          callActive: false,
          textDraft: '',
          workspaceState: fixtureRemoteWorkspaceState(),
          workspaceCurrent: {
            kind: 'view',
            view: {
              id: 'ws-remote-atlas', type: 'project', name: 'atlas', dir: '/home/dev/projects/atlas',
              status: 'ok', host: 'devbox', remoteHome: '/home/dev',
            },
          },
          transcripts: taskThread(waiting),
          taskSnaps: taskSnapsOf(waiting),
          taskState: bundleOf(waiting),
        })}
      />
    );
  },
  'h49-dialog-error-dir': () => (
    <main className="min-h-dvh">
      <RemoteFolderDialog
        onClose={() => {}}
        fixture={{
          host: 'devbox',
          dir: '~/projects/nope',
          phase: 'error',
          error: { field: 'dir', text: '服务器上没有这个文件夹：~/projects/nope' },
        }}
      />
    </main>
  ),
  'composer-model-selector': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        textDraft: '',
        modelProfiles: {
          version: 2,
          defaultModelId: 'mp-a/m-chat',
          providers: [
            {
              id: 'mp-a', name: 'DeepSeek 日常', baseUrl: 'https://api.deepseek.com/v1', api: 'openai-completions',
              hasApiKey: true, keyStoredSecurely: true, updatedAt: now - 86_400_000,
              models: [
                { id: 'm-chat', modelKey: 'mp-a/m-chat', model: 'deepseek-chat', thinkingLevel: 'default', supportsVision: false, visionModel: '', isDefault: true },
                { id: 'm-reasoner', modelKey: 'mp-a/m-reasoner', model: 'deepseek-reasoner', thinkingLevel: 'high', supportsVision: true, visionModel: '', isDefault: false },
              ],
            },
          ],
        },
        currentProfileId: 'mp-a/m-reasoner',
        onSelectModelProfile: () => {},
        onOpenAutoRoutingSettings: () => {},
        modelSelectorFixtureOpen: true,
      })}
    />
  ),
  // 056：已配角色路由时选中「自动（角色路由）」——chip 显示「自动」，菜单首项带主 agent 模型。
  'composer-model-auto': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        textDraft: '',
        modelProfiles: {
          version: 2,
          defaultModelId: 'mp-a/m-chat',
          roleModels: { main: 'mp-a/m-reasoner', explorer: 'mp-a/m-chat' },
          providers: [
            {
              id: 'mp-a', name: 'DeepSeek 日常', baseUrl: 'https://api.deepseek.com/v1', api: 'openai-completions',
              hasApiKey: true, keyStoredSecurely: true, updatedAt: now - 86_400_000,
              models: [
                { id: 'm-chat', modelKey: 'mp-a/m-chat', model: 'deepseek-chat', thinkingLevel: 'default', supportsVision: false, visionModel: '', isDefault: true },
                { id: 'm-reasoner', modelKey: 'mp-a/m-reasoner', model: 'deepseek-reasoner', thinkingLevel: 'high', supportsVision: true, visionModel: '', isDefault: false },
              ],
            },
          ],
        },
        currentProfileId: 'auto',
        onSelectModelProfile: () => {},
        onOpenAutoRoutingSettings: () => {},
        modelSelectorFixtureOpen: true,
      })}
    />
  ),
  // 2026-09-20 视觉模型裁决：主脑模型不带视觉时，模型页露出单独的视觉模型输入。
  'settings-model-no-vision': () => {
    stubExecutor();
    return (
      <SettingsScreen
        {...settingsProps}
        initialPage="models"
        modelConfig={{ ...settingsProps.modelConfig, supportsVision: false, visionModel: 'qwen-vl-max' }}
      />
    );
  },
  'settings-executor': () => {
    stubExecutor({
      accessGetState: async () => ({
        health: 'ready',
        revision: 4,
        grants: [
          { grantId: 'g1', resourceId: 'app:com.tencent.xinWeChat', capability: 'access', lifetime: 'persistent' },
          { grantId: 'g2', resourceId: 'app:com.apple.Notes', capability: 'access', lifetime: 'persistent' },
        ],
        resources: [
          { resourceId: 'app:com.tencent.xinWeChat', type: 'app', displayName: '微信' },
          { resourceId: 'app:com.apple.Notes', type: 'app', displayName: '备忘录' },
        ],
        writeFailure: null,
      }),
    });
    return <SettingsScreen {...settingsProps} initialPage="control" />;
  },
  'settings-access': () => {
    stubExecutor({ accessGetState: async () => accessStateDemo() });
    return <SettingsScreen {...settingsProps} initialPage="control" initialSection="access" />;
  },
  'access-add-dialog': () => {
    stubExecutor({ accessGetState: async () => accessStateDemo() });
    return (
      <>
        <SettingsScreen {...settingsProps} initialPage="control" initialSection="access" />
        <AccessAddDialogDemo />
      </>
    );
  },
  'settings-access-corrupt': () => {
    stubExecutor({
      accessGetState: async () => ({ health: 'corrupt', revision: 0, grants: [], resources: [], writeFailure: null }),
    });
    return <SettingsScreen {...settingsProps} initialPage="control" initialSection="access" />;
  },
  'settings-executor-compact': () => {
    stubExecutor();
    return <SettingsScreen {...settingsProps} initialPage="control" />;
  },
  // 037：设置分页的静态取证——浏览器控制（桥已连 + Jev 已配）、联网搜索（开着缺 Key）、
  // 模型页「其他」组在 macOS 下的长按 Option 待授权态。
  'settings-browser': () => {
    stubExecutor({
      getBrowserControl: async () => ({ enabled: true }),
      getBrowserBridge: async () => ({ state: 'ready', detail: null, port: 47219, updatedAt: now, extVersion: '0.4.2' }),
      getBrowserAct: async () => ({ enabled: true, baseUrl: 'https://api.typesafe.ai', model: 'typesafe-ai/jev', hasApiKey: true }),
    });
    return <SettingsScreen {...settingsProps} initialPage="control" />;
  },
  'settings-web': () => {
    stubExecutor({
      getWebSearch: async () => ({ enabled: true, hasApiKey: false, provider: 'tavily' }),
    });
    return <SettingsScreen {...settingsProps} initialPage="web" />;
  },
  // 041：六分类新页——通用（唤起与显示）、模型页 Jev 组展开（深层定位目标态）、
  // 电脑与浏览器整页（桌面操控＋浏览器控制＋空允许列表）。
  'settings-general': () => {
    stubExecutor();
    return <SettingsScreen {...settingsProps} initialPage="general" />;
  },
  // 043 Windows 平台变体：win32 平台标识 + 能力快照桩（WP 探针未过＝
  // unavailable），生产组件与真机共用同一 hook，不用第二套 UI。
  'windows-settings-general': () => {
    stubExecutor();
    stubPlatform('win32', { pushToTalk: { state: 'unavailable', reason: 'backend-not-verified', supported: false, enabled: false, actions: [] } });
    return <SettingsScreen {...settingsProps} initialPage="general" />;
  },
  'windows-settings-control': () => {
    stubExecutor();
    stubPlatform('win32', { desktop: { state: 'unavailable', reason: 'backend-not-verified', supported: false, enabled: true, actions: [] } });
    return <SettingsScreen {...settingsProps} initialPage="control" />;
  },
  // 同名不同来源（app-ambiguous）：两行独立 rowId/ref，用户必须选一项。
  'windows-access-add': () => {
    stubExecutor();
    stubPlatform('win32', {});
    const apps = windowsAccessAppsDemo();
    return (
      <>
        <SettingsScreen {...settingsProps} initialPage="control" initialSection="access" />
        <AccessAddDialog
          apps={apps}
          appsFailed={false}
          addedResourceIds={new Set(['access-resource-notes-2'])}
          busy={false}
          error={null}
          onClose={() => {}}
          onReloadApps={() => {}}
          onAddApplication={() => {}}
        />
      </>
    );
  },
  // 044 关于与更新：发现新版本 / 已下载待装（多状态只在 1440 档拍）。
  'settings-about-update': () => {
    stubExecutor({
      updaterGetState: async () => ({
        supported: true,
        phase: 'available',
        currentVersion: '0.3.0',
        availableVersion: '0.4.0',
        progressPercent: null,
        errorMessage: null,
      }),
    });
    return <SettingsScreen {...settingsProps} initialPage="general" />;
  },
  'settings-about-downloaded': () => {
    stubExecutor({
      updaterGetState: async () => ({
        supported: true,
        phase: 'downloaded',
        currentVersion: '0.3.0',
        availableVersion: '0.4.0',
        progressPercent: 100,
        errorMessage: null,
      }),
    });
    return <SettingsScreen {...settingsProps} initialPage="general" />;
  },
  'settings-jev': () => {
    stubExecutor({
      getBrowserAct: async () => ({ enabled: true, baseUrl: 'https://api.typesafe.ai', model: 'typesafe-ai/jev', hasApiKey: true }),
    });
    return <SettingsScreen {...settingsProps} initialPage="models" initialSection="browser-decision" />;
  },
  'settings-control': () => {
    stubExecutor({
      getBrowserControl: async () => ({ enabled: true }),
      getBrowserBridge: async () => ({ state: 'ready', detail: null, port: 47219, updatedAt: now, extVersion: '0.4.2' }),
      getBrowserAct: async () => ({ enabled: true, baseUrl: 'https://api.typesafe.ai', model: 'typesafe-ai/jev', hasApiKey: true }),
    });
    return <SettingsScreen {...settingsProps} initialPage="control" />;
  },
  'settings-model-voice-mac': () => {
    stubExecutor({
      platform: 'darwin',
      getUiPreferences: async () => ({
        floatingOrbEnabled: true,
        primarySpeakerEnabled: false,
        globalPushToTalkEnabled: true,
        globalPushToTalkReady: false,
        globalPushToTalkListening: false,
        globalPushToTalkStartError: '',
      }),
    });
    return <SettingsScreen {...settingsProps} initialPage="voice" />;
  },
  'caption-running': () => {
    stubBridge({}, runningTask);
    return <FloatingCaption />;
  },
  'caption-waiting': () => {
    stubBridge({}, waitingTask);
    return <FloatingCaption />;
  },
  'caption-read': () => {
    stubBridge({
      turnPhase: 'replying',
      recentLines: [{ id: 'read:reply', text: '已经在主窗口读过的回复', author: 'hemi', captionRead: true }],
    }, runningTask);
    return <FloatingCaption />;
  },
  // 挂载回放抑制（2026-09-24）：切到浮球模式时字幕窗首帧读到的往往是
  // 上一轮的回答＋已落定的空闲态——旧答案不该重播，应收敛成状态药丸。
  // 任务快照给终态（不在跑）：任务行不该把卡片顶回来。
  'caption-stale': () => {
    stubBridge(
      {
        sessionState: 'idle',
        turnPhase: 'idle',
        isSpeaking: false,
        ttsActive: false,
        interimText: '',
        recentLines: [{ text: '今天杭州晴，26 度，适合出门。', author: 'hemi' }],
      },
      completeTask,
    );
    return <FloatingCaption />;
  },
  // 按 Option 转聆听但还没开口（2026-09-24）：recentLines 是上一轮残留，
  // 聆听相位不算内容新鲜——卡片不亮，该亮的是「我在听」状态药丸。
  'caption-stale-listening': () => {
    stubBridge(
      {
        sessionState: 'listening',
        turnPhase: 'listening',
        isSpeaking: false,
        ttsActive: false,
        interimText: '',
        recentLines: [
          { text: '帮我查下明天的天气', author: 'user' },
          { text: '明天杭州晴，26 度。报告已生成。', author: 'hemi' },
        ],
      },
      completeTask,
    );
    return <FloatingCaption />;
  },
  'floating-orb': () => {
    stubBridge({}, runningTask);
    return <FloatingOrb />;
  },
  // 037 悬浮球各视觉态（思考 / 说话·通话中 / 出错）
  'floating-orb-thinking': () => {
    stubBridge({ turnPhase: 'thinking' }, { ...baseTask, phase: 'idle' });
    return <FloatingOrb />;
  },
  'floating-orb-speaking': () => {
    stubBridge({ turnPhase: 'speaking', isSpeaking: true, callActive: true }, { ...baseTask, phase: 'idle' });
    return <FloatingOrb />;
  },
  'floating-orb-error': () => {
    stubBridge({ sessionState: 'error' }, waitingTask);
    return <FloatingOrb />;
  },
  'task-popover': () => {
    stubBridge({}, runningTask);
    return <TaskPopover />;
  },
  'task-popover-waiting': () => {
    stubBridge({}, waitingTask);
    return <TaskPopover />;
  },
  'task-popover-complete': () => {
    stubBridge({}, {
      ...completeTask,
      taskText: '用 Chrome 浏览器搜索并比较水牛奶和其他品牌纯牛奶的蛋白质、钙含量',
    });
    return <TaskPopover />;
  },
  'task-popover-error': () => {
    stubBridge({}, {
      ...baseTask,
      phase: 'terminal',
      outcome: 'startfailed',
      outcomeReason: '执行器启动失败。请检查模型服务连接和执行器设置，确认配置正确后再试。'.repeat(4),
    });
    return <TaskPopover />;
  },
  // —— 032 首启五屏引导（对照 designs/2026-09-30-fullscreen-onboarding 确认稿）——
  'onboarding-welcome': () => onboardingScreen(),
  'onboarding-permission': () => onboardingScreen({ step: 'microphone' }),
  'onboarding-permission-denied': () =>
    onboardingScreen({ step: 'microphone', microphonePermission: 'denied', permissionChoice: 'skipped' }),
  'onboarding-asr': () => onboardingScreen({ step: 'asr' }),
  'onboarding-asr-saved': () =>
    onboardingScreen({ step: 'asr', asrSaved: true, asrKeySuffix: '6G9Q' }),
  'onboarding-model': () => onboardingScreen({ step: 'model' }),
  'onboarding-capabilities': () => onboardingScreen({ step: 'capabilities', modelSaved: true }),
  'onboarding-complete': () => onboardingScreen({ step: 'done', modelSaved: true }),
  // 032：主界面修复条（完成后配置出错的就近修复，不回首启）。
  'onboarding-repair': () => (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        textDraft: '',
        repairHint: {
          key: 'asr',
          title: '语音服务密钥需要更新',
          detail: '语音暂不可用，文字对话仍可继续。',
          actionLabel: '去设置',
          onAction: () => {},
        },
      })}
    />
  ),

  // 048：长思考放在产品对话列表中，验五行上限与内外层滚轮分发。
  'thinking-scroll': () => {
    const text = Array.from({ length: 12 }, (_, index) =>
      `第 ${index + 1} 步：核对用户需求、已有实现和验证结果，保留完整思考内容供展开后滚动查看。`,
    ).join('\n\n');
    return (
      <VoiceScreen
        {...screenProps({
          sessionState: 'idle', callActive: false,
          transcripts: [
            { id: 'thinking-scroll-user', author: 'user', createdAt: now - 30_000, text: '检查长思考展开后是否只占三五行，并能在区内滚动。' },
            { id: 'thinking-scroll-done', author: 'hemi', createdAt: now - 20_000,
              text: '检查完成，全文可以在思考区内滚动查看。', thinking: { text, durationMs: 12_000 } },
            { id: 'thinking-scroll-interrupted', author: 'hemi', createdAt: now - 15_000,
              text: '已停止，保留收到的思考。', thinking: { text, durationMs: 8_000, interrupted: true } },
            { id: 'thinking-scroll-short', author: 'hemi', createdAt: now - 10_000,
              text: '短思考按内容高度显示。', thinking: { text: '先核对需求，再验证结果。', durationMs: 1_000 } },
          ],
          turnPhase: 'thinking', textModelBusy: true,
          streamingThinking: { text, startedAt: now - 4_000, endedAt: null },
        })}
      />
    );
  },
  // —— 048 思考折叠头与会话用量（对照 designs/2026-10-08-thinking-display v3）——
  // 思考头三态：思考中（计时＋最新一行）、已思考（折叠）、思考已中断＋展开区。
  'thinking-states': () => (
    <main className="compact-shell min-h-dvh" style={{ padding: '32px 48px', maxWidth: 820 }}>
      <h2 className="text-sm mb-4">思考折叠头 · 三态</h2>
      <article className="h24-hemi-message">
        <ThinkingBlock
          state="streaming"
          text={'设鸡 x 只、兔 y 只。\n\n列方程：2x + 4y = 94，先消元，把 x 用 y 表达。代入后核对脚数。'}
          startedAt={Date.now() - 12_000}
        />
      </article>
      <article className="h24-hemi-message" style={{ marginTop: 24 }}>
        <ThinkingBlock
          state="done"
          text={'用户要建文件。文件名是 hello.txt，内容是「自测」。'}
          durationMs={13_000}
        />
        <div className="chat-copy assistant-copy">好，文件建好了。</div>
      </article>
      <article className="h24-hemi-message" style={{ marginTop: 24 }}>
        <ThinkingBlock
          state="interrupted"
          initialExpanded
          text={'先想第一步：用户要查天气，得联网。\n\n第二步：调 execute_task，任务描述用原话。后续还没想完就停了。'}
          durationMs={8_000}
        />
        <div className="chat-copy assistant-copy">（未完成 · 已停止）</div>
      </article>
    </main>
  ),
  // 会话用量：入口（安静行＋运行点）与面板（总计/筛选/按模型表）。
  'usage-entry': () => {
    // 截图确定性：呼吸动画停在满相位（运行点不透明），像素比对才稳定。
    requestAnimationFrame(() => {
      document.getAnimations().forEach((animation) => {
        animation.pause();
        animation.currentTime = 0;
      });
    });
    return (
    <VoiceScreen
      {...screenProps({
        sessionState: 'idle',
        callActive: false,
        transcripts: [
          { id: 'usage-demo-user', author: 'user', text: '帮我整理一下今天的工作。', createdAt: now - 60000 },
          { id: 'usage-demo-reply', author: 'hemi', text: '已整理好，接下来可以继续补充。', createdAt: now - 30000 },
        ],
        usageRecords: [
          { source: 'chat', role: 'main', modelKey: 'vvcode/claude-opus-5-5', modelName: 'vvcode', input: 8_000, output: 3_000, cacheRead: 20_000, cacheWrite: 0, genMs: 90_000, at: 1 },
          { source: 'task', role: 'explorer', modelKey: 'zai/glm-5.3-flash', modelName: '智谱', input: 30_000, output: 12_000, cacheRead: 10_000, cacheWrite: 2_000, genMs: 400_000, at: 2, calls: 7 },
          { source: 'title', role: 'auxiliary', modelKey: 'vvcode/claude-opus-5-5', modelName: 'vvcode', input: 500, output: 30, cacheRead: 0, cacheWrite: 0, genMs: 4_000, at: 3 },
        ] satisfies UsageRecord[],
        usageRunning: true,
      })}
    />
    );
  },
  'usage-panel': () => {
    const variant = new URLSearchParams(window.location.search).get('variant');
    const records: UsageRecord[] = [
      { source: 'task', role: 'fixer', modelKey: 'ds/deepseek-flash', modelName: 'DeepSeek', input: 1_040_000, output: 548_000, cacheRead: 50_960_000, cacheWrite: 0, genMs: 3_886_000, at: 1, calls: 1211 },
      { source: 'chat', role: 'main', modelKey: 'vv/daily-codex-pro', modelName: 'VVCode', input: 97_940, output: 10_500, cacheRead: 68_060, cacheWrite: 0, genMs: 218_750, at: 2, calls: 11 },
      { source: 'task', role: 'oracle', modelKey: 'vv/deepseek-full-context-preview', modelName: 'VVCode', input: 29_000, output: 0, cacheRead: 14_300, cacheWrite: 0, genMs: 0, at: 3, calls: 27, missing: 4 },
      { source: 'task', role: 'designer', modelKey: 'unknown', modelName: '未返回模型', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, genMs: 0, at: 4, calls: 1, missing: 1 },
    ];
    const designRecords: UsageRecord[] = [
      { source: 'chat', role: 'main', modelKey: 'vv/daily-codex-pro', modelName: 'VVCode', input: 97_940, output: 10_500, cacheRead: 68_060, cacheWrite: 0, genMs: 218_750, at: 1, calls: 40 },
      { source: 'task', role: 'explorer', modelKey: 'ds/deepseek-flash', modelName: 'DeepSeek', input: 780_000, output: 270_000, cacheRead: 25_220_000, cacheWrite: 0, genMs: 1_928_571, at: 2, calls: 600 },
      { source: 'task', role: 'oracle', modelKey: 'vv/deepseek-full-context-preview', modelName: 'VVCode', input: 29_011, output: 1_000, cacheRead: 14_289, cacheWrite: 0, genMs: 18_182, at: 3, calls: 27 },
      { source: 'task', role: 'fixer', modelKey: 'zai/glm-5.3-flash', modelName: '智谱', input: 504_000, output: 274_000, cacheRead: 24_696_000, cacheWrite: 0, genMs: 1_889_655, at: 4, calls: 570 },
      { source: 'task', role: 'designer', modelKey: 'anthropic/claude-opus-5-5', modelName: 'Anthropic', input: 138_740, output: 2_500, cacheRead: 852_260, cacheWrite: 0, genMs: 27_778, at: 5, calls: 13 },
    ];
    const sample = variant === 'design' ? designRecords : variant === 'unknown'
      ? [{ ...records[3], calls: 31, missing: 31 }]
      : variant === 'many'
        ? Array.from({ length: 24 }, (_, index) => ({ ...records[index % 3], role: (['main', 'explorer', 'oracle', 'fixer', 'designer', 'auxiliary'] as const)[index % 6], modelKey: `test/provider-long-model-name-with-context-${index}`, requestedModel: `provider-long-model-name-with-context-${index}`, at: index }))
        : variant === 'error' || variant === 'empty' ? [] : records;
    return (
      <main className="compact-shell min-h-dvh" style={{ padding: '32px 16px', display: 'flex', alignItems: 'flex-end' }}>
        <div style={{ width: '100%', maxWidth: 560, position: 'relative' }}>
          <SessionUsage initialOpen running={false} records={sample} loadError={variant === 'error' ? 'fixture-error' : ''} />
        </div>
      </main>
    );
  },
  // 字幕窗思考计时：Hemi 行「思考中 · Ns」，不出思考文字。
  'caption-thinking': () => {
    stubBridge(
      {
        sessionState: 'listening',
        turnPhase: 'thinking',
        isSpeaking: false,
        ttsActive: false,
        interimText: '',
        thinkingSince: Date.now() - 12_000,
        recentLines: [{ text: '帮我查一下明天北京的天气', author: 'user' }],
      },
      // 字幕组件直读 taskState.phase——传终态快照表达「本轮还没有任务」。
      completeTask,
    );
    return <FloatingCaption />;
  },
};

const scene = new URLSearchParams(window.location.search).get('scene') ?? 'main-running';
const isTaskPopover = scene.startsWith('task-popover');
// 037：悬浮球 / 字幕窗同样按真实窗口挂 data-window（透明根、定高），
// 外面垫一层中性「桌面」底，截图时半透明卡与球体轮廓看得清。
const floatingWindow = scene.startsWith('floating-orb')
  ? 'orb'
  : scene.startsWith('caption-')
    ? 'caption'
    : null;
// 悬浮菜单沿用真实窗口的透明根节点，避免普通页面的 fixture 底色掩盖问题。
document.documentElement.dataset.window = isTaskPopover
  ? 'task-popover'
  : (floatingWindow ?? 'main');

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      {isTaskPopover ? scenes[scene]?.() : floatingWindow ? (
        <div style={{ height: '100dvh', background: 'var(--n-150)' }}>{scenes[scene]?.() ?? null}</div>
      ) : (
        <div className="min-h-dvh bg-[var(--bg-canvas)]">{scenes[scene]?.() ?? null}</div>
      )}
    </StrictMode>,
  );
}
