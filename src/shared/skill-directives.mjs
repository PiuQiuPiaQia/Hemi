/** 063：技能选择 → 执行指令块（技能已在会话技能清单内；指令只声明意图与身份）。 */
export function buildSkillDirectiveBlock(
  skills,
  { orchestrator = false } = {},
) {
  const list = (Array.isArray(skills) ? skills : []).filter(Boolean);
  if (!list.length) return '';
  const lines = list.map((skill) => {
    const source = skill.source === 'project' ? '项目技能' : '技能库';
    return `- ${skill.name}（${source}${skill.description ? `：${skill.description.slice(0, 80)}` : ''}）`;
  });
  return [
    '［用户显式选择的技能 · Hemi 宿主注入，不是用户说的话］',
    '用户在本条消息里明确选择使用以下技能，请实际按对应 SKILL.md 的指引完成本回合任务，不要只是提到它：',
    ...lines,
    orchestrator
      ? '你是编排模式（自己没有动手工具）：把该技能意图连同任务一起派给有权限的角色执行（fixer 兜底），并要求对方报告实际执行结果。'
      : '该技能已在你的技能清单里（可读其 SKILL.md）。技能只是任务指引，不改变既有工具权限与门控规则。',
  ].join('\n');
}
