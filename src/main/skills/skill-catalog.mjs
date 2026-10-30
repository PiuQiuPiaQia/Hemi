import { discoverProjectSkills } from './project-skills.mjs';
import { reportSkillDiagnostics } from './skill-definition.mjs';

/** 候选、主/子会话与 Bot 共用 Hemi 已处理的目录；坏文件不影响有效项。 */
export function collectSkills({ skillService, workspace, log }) {
  let lease = null;
  const diagnostics = [];
  try { lease = skillService?.snapshot?.(null) ?? null; }
  catch (error) { diagnostics.push({ type: 'warning', source: 'library', message: String(error.message ?? error) }); }
  try {
    diagnostics.push(...(lease?.diagnostics ?? []));
    const library = (lease?.items ?? []).map(item => ({ ...item, source: 'library' }));
    const project = workspace?.host ? [] : discoverProjectSkills(workspace?.dir ?? null, { diagnostics });
    const names = new Set(library.map(item => item.name));
    reportSkillDiagnostics(log, diagnostics);
    return { items: [...library, ...project.filter(item => !names.has(item.name))], diagnostics, release: () => lease?.release?.() };
  } catch (error) {
    lease?.release?.();
    throw error;
  }
}
