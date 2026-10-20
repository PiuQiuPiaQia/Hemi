/** 064：角色决定职责与工具面；固定／路由均由主 agent 按需执行或委派。 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseFrontmatter } from '@earendil-works/pi-coding-agent';

export const ROLE_NAMES = ['explorer', 'oracle', 'fixer', 'designer'];
/** 前台工具结果与后台完成通知使用同一交接口径。 */
export const SUBAGENT_RESULT_GUIDANCE = '这是供你验收的内部交接，不是直接给用户的答复。按用户目标审查结果、证据和缺口，需要补证时按当前工具模式继续处理；读过报告不等于亲自重跑或独立复核，描述已做的检查要有对应工具证据。验收后用自己的话回应用户，日常进度或完成通知通常一个短段落足够，保留关键缺口和真实成果入口，不沿用子报告的章节或逐条复述命令与检查过程；用户明确要求的完整报告、详细内容和成果必须保留。';
const ROLE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'roles');
const MODES = new Set(['run', 'verify']);

function toolList(value) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return raw.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
}

/** 解析一份角色定义（纯函数，便于单测）。缺字段或非法值直接抛错——内置角色写错要在启动时现形。 */
export function parseRoleDefinition(text, { source = 'role' } = {}) {
  const { frontmatter, body } = parseFrontmatter(String(text ?? ''));
  const name = String(frontmatter?.name ?? '').trim();
  if (!name) throw new Error(`${source}：缺少 name`);
  const mode = String(frontmatter.mode ?? 'verify');
  if (!MODES.has(mode)) throw new Error(`${source}：mode 只能是 run 或 verify`);
  const tools = toolList(frontmatter.tools);
  if (!tools.length) throw new Error(`${source}：tools 不能为空`);
  // 子 agent 不能再派单（防递归，PI-Desktop/ZCode 同口径）。
  if (tools.some((tool) => ['task','task_status','task_message','task_cancel'].includes(tool))) throw new Error(`${source}：子 agent 不能持有派单工具`);
  const routing = String(frontmatter.routing ?? '').trim();
  if (!routing) throw new Error(`${source}：缺少 routing 路由卡`);
  const systemPrompt = String(body ?? '').trim();
  if (!systemPrompt) throw new Error(`${source}：缺少角色提示词正文`);
  return {
    name,
    title: String(frontmatter.title ?? name),
    description: String(frontmatter.description ?? '').trim(),
    mode,
    tools,
    routing,
    systemPrompt,
  };
}

let cached = null;

/** 内置四个角色（启动后缓存；文件随包分发，运行期不变）。 */
export function loadRoles() {
  if (cached) return cached;
  const roles = new Map();
  for (const name of ROLE_NAMES) {
    const file = path.join(ROLE_DIR, `${name}.md`);
    const role = parseRoleDefinition(readFileSync(file, 'utf8'), { source: file });
    if (role.name !== name) throw new Error(`${file}：name 与文件名不一致`);
    roles.set(name, role);
  }
  cached = roles;
  return roles;
}

/**
 * 主 agent 系统提示词里的「子 agent 与路由」段。只渲染可用的角色——没有可用模型
 * 或被禁用的角色连同它的卡一起不出现（会话建立时定格，保证提示词逐字节稳定）。
 */
export function buildRoutingSection(roles, { available = null } = {}) {
  const list = [...roles.values()].filter((role) => !available || available.has(role.name));
  if (!list.length) return '';
  return [
    '［子 agent · 按需派活］',
    '你可以用 task 工具把一部分工作交给专门的子 agent。子 agent 在独立的上下文里工作，看不到你和用户的对话，只看到你写的 prompt；它最后一条消息会作为工具结果回到你这里。',
    'agent 选择角色和工具边界；自动路由使用用户为该角色配置的模型，未配置则跟随主 agent，共用已配置的备用模型。requirements 声明图像、工具或上下文要求，宿主检查冻结计划中的模型能力；能力不足时明确返回原因，不借用其他角色模型。具体模型模式下主／子都保持同一个准确模型，不切备用。不按型号名猜能力或价格。',
    '',
    ...list.map((role) => role.routing),
    '',
    '派单门槛：',
    '- 派出去不是免费的：子 agent 冷启动要重新加载上下文，你还要交代和验收。你手上已有上下文、改动小而清楚时，自己直接做。',
    '- 需要你没有、且会撑大你上下文的信息（大范围摸底、外部调研）、可以并行、耗时长、需要专家判断时才派。',
    '- 需要设计判断、连续视觉或较多界面上下文时交给 @designer；已知且轻量的操作可以直接完成。',
    '- 互相独立的部分，在同一条消息里发出多个 task 调用并行执行；有依赖的按顺序来。',
    '- 不要因为某个角色存在就派给它；也不要因为每一步看着都简单，就把整块实质工作全揽在自己手里。',
    '- 已有子 agent 会话持有相关上下文时，传它的 session_id 续用，而不是新开。',
    '- prompt 要自包含：目标、范围、用户的关键要求、已知路径或网址、完成标准；只索取验收需要的结果、证据位置与缺口，不例行要求完整命令、提示词全文或逐步日志。',
    '- 需要交付文件时，要求执行角色用 register_delivery 登记真实成果并返回文件链接；不要把路径字符串当作已交付。',
    '- 用户明确要求后台时传 background: true；否则结果马上要用的放前台（默认），独立工作可放后台；后台只释放工具等待，当前用户目标仍需等必要结果收口。',
    `- ${SUBAGENT_RESULT_GUIDANCE}`,
  ].join('\n');
}

/**
 * 编排者保留的工具（主 agent 的控制工具子集，固定／路由均同时保有执行工具）：派单族、记忆写入（记忆只有主
 * agent 一个写入口——子 agent 值得记的写进报告由主 agent 决定）、宿主诊断。
 */
export const MAIN_CONTROL_TOOLS = Object.freeze(['task', 'task_status', 'task_message', 'task_cancel', 'memory_write', 'get_runtime_diagnostics', 'workflow_preparation', 'conversation_read']);

/** 动手工具＝给定角色白名单的并集（子角色不持有主控制工具）。 */
export function actionToolsOf(roles, { available = null } = {}) {
  const out = new Set();
  for (const role of roles.values()) {
    if (available && !available.has(role.name)) continue;
    for (const tool of role.tools) out.add(tool);
  }
  for (const tool of MAIN_CONTROL_TOOLS) out.delete(tool);
  return out;
}
