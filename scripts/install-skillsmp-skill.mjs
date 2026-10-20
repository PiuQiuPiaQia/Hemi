#!/usr/bin/env node
/**
 * 034 验证工具：用**产品同款模块**（skillsmp-service + skill-store）走真实网络，
 * 把一个 SkillsMP 条目安装进指定 userData 的技能库（发现 → 固定提交快照 → 确认安装）。
 * 供隔离 userData 的自驱动任务使用；不改任何 UI 状态。
 *
 *   node scripts/install-skillsmp-skill.mjs <userDataDir> [关键词] [条目序号=0]
 */
import path from 'node:path';
import process from 'node:process';

const [, , userDataDir, query = 'pdf', pickIndex = '0'] = process.argv;
if (!userDataDir) {
  console.error('用法: node scripts/install-skillsmp-skill.mjs <userDataDir> [关键词] [条目序号]');
  process.exit(2);
}

const { createSkillStore } = await import('../src/main/skills/skill-store.mjs');
const { createSkillsmpService } = await import('../src/main/skills/skillsmp-service.mjs');

const store = createSkillStore({ root: path.join(userDataDir, 'skills') });
const service = createSkillsmpService({
  store,
  cacheFile: path.join(userDataDir, 'skills', 'skillsmp-cache.json'),
});

const search = await service.search({ query });
if (!search.ok) throw new Error(`搜索失败：${search.reason}`);
const candidate = search.skills[Number(pickIndex)] ?? search.skills.find((skill) => skill.githubUrl);
if (!candidate) throw new Error('没有可添加的条目（无 GitHub 来源）');
console.log(`选中：${candidate.id} · ${candidate.name} · ${candidate.githubUrl}`);

const { preview } = await service.preview({ id: candidate.id });
console.log(`预览：${preview.repo}@${preview.commit.slice(0, 12)} · ${preview.files.length} 文件 · SKILL.md ${preview.skillMd.length} 字`);

const installed = await service.install({
  skillsmpId: preview.skillsmpId,
  commit: preview.commit,
  bundleSha256: preview.bundleSha256,
  githubUrl: preview.githubUrl,
  author: preview.author,
  skillUrl: preview.skillUrl,
});
if (!installed.ok) throw new Error(`安装失败：${installed.reason}`);
console.log(`已安装：${installed.skill.id} @${installed.skill.version}（${installed.skill.github.repo}）`);
console.log(`受控目录内容：${installed.skill.files.join(', ')}`);
