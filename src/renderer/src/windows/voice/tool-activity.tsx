import { Check, ChevronRight, X, Square } from 'lucide-react';
import { useTranscriptRowState } from './transcript-row-state';

import type { TurnToolCall } from '@/shared/types';

/**
 * 056 · 主 agent 自己的工具调用（对话流内折叠展示）。
 *
 * 056 起 Hemi 自己能动手：读文件、跑命令、开网页……这些步骤不再是「任务卡」，
 * 而是这一轮回答的一部分（与 Claude Code / ZCode 的对话流同形）。一组是两段文字
 * 之间连续的那几次调用（`TurnParts` 按到达顺序穿插思考／正文／工具组）；单个调用
 * 直接显示那一步，多个折叠成「用了 N 个工具」＋当前一步，点开看每一步。
 */
export type StreamingToolCall = TurnToolCall;

const TOOL_LABELS: Record<string, string> = {
  read: '读取文件',
  write: '写入文件',
  edit: '修改文件',
  ls: '查看目录',
  grep: '搜索内容',
  glob: '查找文件',
  bash: '执行命令',
  web_search: '联网搜索',
  web_extract: '读取网页',
  browser_navigate: '打开网页',
  browser_extract: '读取页面',
  browser_tabs: '查看标签页',
  browser_screenshot: '截取页面',
  browser_click: '点击网页',
  browser_type: '填写网页',
  browser_act: '操作浏览器',
  screen_view: '查看屏幕',
  ui_list: '查看窗口',
  ui_tree: '读取界面',
  ui_act: '操作界面',
  ui_click: '点击界面',
  ui_type: '输入文字',
  ui_key: '按键',
  ui_scroll: '滚动界面',
  app_open: '打开应用',
  task: '派给子 agent',
  task_status: '查看子 agent',
  task_message: '补充指令',
  task_cancel: '停止子 agent',
  memory_write: '写记忆',
  get_runtime_diagnostics: '查看诊断',
};

/** 一步的人话描述：工具名＋最关键的那个参数（路径/命令/网址/角色）。 */
export function describeToolCall(call: Pick<StreamingToolCall, 'tool' | 'args'>): string {
  const label = TOOL_LABELS[call.tool] ?? call.tool;
  const args = call.args ?? {};
  const pick = (key: string) => (typeof args[key] === 'string' ? String(args[key]) : '');
  const detail =
    call.tool === 'task'
      ? `@${pick('agent')}${pick('description') ? `：${pick('description')}` : ''}`
      : pick('command') || pick('path') || pick('url') || pick('query') || pick('app') || pick('pattern') || pick('id');
  const shortDetail = detail.replace(/^\/Users\/[^/]+\//, '~/');
  return shortDetail ? `${label} · ${shortDetail.length > 80 ? `${shortDetail.slice(0, 80)}…` : shortDetail}` : label;
}

export function ToolActivity({ calls }: { calls: StreamingToolCall[] }) {
  const [open, setOpen] = useTranscriptRowState<boolean>("tools-expanded", false);
  if (!calls.length) return null;
  const running = calls.find((call) => call.state === 'running');
  const failed = calls.filter((call) => call.state === 'error').length;
  const stopped = calls.filter((call) => call.state === 'stopped').length;
  const headline = running
    ? describeToolCall(running)
    : calls.length === 1
      ? describeToolCall(calls[0]) + (stopped ? '（已停止）' : failed ? '（没成功）' : '')
      : `用了 ${calls.length} 个工具${stopped ? `（${stopped} 个已停止）` : failed ? `（${failed} 个没成功）` : ''}`;
  return (
    <div className="h56-tools" data-tool-states={JSON.stringify(calls.map((call) => ({ id: call.id, state: call.state })))} data-open={open ? 'true' : undefined}>
      <button
        type="button"
        className="h56-tools-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {running ? <i className="h37-spinner" aria-hidden="true" /> : <ChevronRight className="h56-tools-chev" aria-hidden="true" />}
        <span className="h56-tools-label">{headline}</span>
        {running && calls.length > 1 ? <span className="h56-tools-count">第 {calls.length} 步</span> : null}
      </button>
      {open ? (
        <ol className="h56-tools-list">
          {calls.map((call) => (
            <li key={call.id} data-state={call.state}>
              {call.state === 'running' ? (
                <i className="h37-spinner" aria-hidden="true" />
              ) : call.state === 'stopped' ? (
                <Square aria-label="已停止" />
              ) : call.state === 'error' ? (
                <X aria-hidden="true" />
              ) : (
                <Check aria-hidden="true" />
              )}
              <span className="selectable">{describeToolCall(call)}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
