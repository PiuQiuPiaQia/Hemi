import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadProjectContextFiles } from '@earendil-works/pi-coding-agent';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** 续用必须保持实际工具开关、扩展闭包、Skill 正文与项目规范；只比较路径会复用过期上下文。 */
export async function sessionLoadoutRevision({ caps, placement, skills, agentDir, memoryEnabled }) {
  const skillRevisions = await Promise.all(skills.map(async item => ({
    path: item.path,
    contentHash: hash(await readFile(path.join(item.path, 'SKILL.md'), 'utf8')),
  })));
  const context = placement.loadContextFiles && !placement.remote
    ? loadProjectContextFiles({cwd: placement.cwd, agentDir}) : [];
  return hash({ features: caps.features, extensionConfig: caps.extensionConfig, memoryEnabled,
    skills: skillRevisions, context,
    remote: placement.remote ? {host: placement.remote.host, dir: placement.remote.dir, contextText: placement.remote.contextText} : null });
}

export function roleSessionRevision(role, modelPlan) {
  return hash([role.mode, role.tools, role.systemPrompt, modelPlan?.interactiveOwner ?? null, modelPlan?.loadoutRevision ?? null]);
}
