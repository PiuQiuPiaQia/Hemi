import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createSyntheticSourceInfo, parseFrontmatter } from '@earendil-works/pi-coding-agent';

/** Hemi 的唯一 Skill 元数据校验；安装、目录发现和会话装配使用同一规则。 */
export function parseSkillMetadata(content) {
  const text = String(content).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const header = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!header) throw new Error('SKILL.md 缺少完整的 YAML frontmatter');
  if (Buffer.byteLength(header[1]) > 8192) throw new Error('SKILL.md frontmatter 超过 8 KiB');
  let frontmatter;
  try { ({ frontmatter } = parseFrontmatter(header[0])); }
  catch (error) { throw new Error(`YAML 格式错误：${error.message.split('\n')[0]}`); }
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) throw new Error('Skill frontmatter 必须是键值对象');
  const { name, description } = frontmatter;
  const title = frontmatter.title ?? name;
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error('Skill name 必须是小写英文、数字或连字符');
  if (typeof description !== 'string' || !description.trim() || description.length > 1024) throw new Error('Skill description 缺失或超过 1024 字');
  if (typeof title !== 'string' || !title.trim() || title.length > 80) throw new Error('Skill title 为空或超过 80 字');
  const invocation = frontmatter['disable-model-invocation'];
  if (invocation !== undefined && typeof invocation !== 'boolean') throw new Error('Skill disable-model-invocation 必须是布尔值');
  return { name, title, description: description.trim(), disableModelInvocation: invocation === true };
}

/** 每个文件独立处理；Hemi 保留诊断，只把校验后的定义交给 Pi。 */
export function prepareSkills(candidates, { diagnostics = [] } = {}) {
  const items = [];
  for (const candidate of candidates) {
    const filePath = path.join(candidate.path, 'SKILL.md');
    try {
      const content = readFileSync(filePath, 'utf8');
      const metadata = parseSkillMetadata(content);
      if (candidate.source === 'library' && candidate.name !== metadata.name) throw new Error('Skill name 与安装登记不一致');
      const skill = {
        name: metadata.name, description: metadata.description,
        filePath, baseDir: candidate.path, disableModelInvocation: metadata.disableModelInvocation,
        sourceInfo: createSyntheticSourceInfo(filePath, {
          source: 'hemi', scope: candidate.source === 'project' ? 'project' : 'user', baseDir: candidate.path,
        }),
      };
      items.push({ ...candidate, ...metadata, revision: createHash('sha256').update(content).digest('hex'), skill });
    } catch (error) {
      diagnostics.push({ type: 'warning', path: filePath, skillId: candidate.id, name: candidate.name,
        source: candidate.source, message: String(error.message ?? error).split('\n')[0] });
    }
  }
  return { items, diagnostics };
}

export function skillDiagnosticsMessage(diagnostics = []) {
  if (!diagnostics.length) return '';
  return `已跳过 ${diagnostics.length} 个不可用技能：${diagnostics.slice(0, 3).map(item => `${item.name ?? '技能库'}（${item.message}；${item.path ?? ''}）`).join('；')}`;
}

export function reportSkillDiagnostics(log, diagnostics) {
  for (const item of diagnostics) log?.warn?.(`Skill 不可用：${item.path ?? item.name ?? '技能库'}：${item.message}`);
}
