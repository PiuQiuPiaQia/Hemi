// 隔离 fixture：真实 SkillMarket + 导入本地技能弹窗，桥接口全部为内存假实现。
// 场景用 ?scene= 选择；所有调用记在 window.__calls，供验证脚本断言。
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  LocalSkillBatchImportResult, LocalSkillCandidate, LocalSkillImportMode, LocalSkillScanResult, SkillActionResult, SkillMarketState, InstalledSkill,
} from '@shared/protocol';
import { SkillMarket, type SkillMarketApi } from '@/windows/voice/skill-market';
import { installNativeInput } from '@/lib/native-input';
import '@/globals.css';
import '@/styles/index.css';
import '@/appearance/appearance.css';
import { initializeAppearance } from '@/appearance/runtime';

const params = new URLSearchParams(location.search);
const scene = params.get('scene') || 'list';
const calls: Array<{ name: string; args: unknown[] }> = [];
(window as unknown as { __calls: typeof calls }).__calls = calls;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const HOME = '/Users/demo';
const base: LocalSkillCandidate[] = [
  { path: `${HOME}/.claude/skills/pdf-tools`, name: 'pdf-tools', description: '合并、拆分、加水印和提取 PDF 文本；处理前先确认输入与输出路径。', sources: ['Claude Code'], installed: false },
  { path: `${HOME}/.codex/skills/git-review`, name: 'git-review', description: 'Review staged git changes against team conventions and draft a commit message.', sources: ['Codex', 'Claude Code'], installed: false },
  { path: `${HOME}/.cursor/skills/meeting-notes`, name: 'meeting-notes', description: '把会议录音转写整理成纪要：议题、结论、待办与负责人。', sources: ['Cursor'], installed: true },
  { path: `${HOME}/.agents/skills/excel-helper`, name: 'excel-helper', description: '生成与核对 Excel 公式、透视表和数据清洗步骤。', sources: ['Agents'], installed: false },
  { path: '/Volumes/Work/Projects/acme-web/.agents/skills/release-checklist', name: 'release-checklist', description: '发版前逐项核对：版本号、变更日志、构建产物与回滚方案。', sources: ['当前项目'], installed: false },
  { path: `${HOME}/.claude/skills/web-scraper`, name: 'web-scraper', description: '', sources: ['Claude Code'], installed: true },
];
const long: LocalSkillCandidate[] = [
  ...base,
  ...Array.from({ length: 9 }, (_, index) => ({
    path: `${HOME}/Library/Application Support/SomeVeryLongAgentName/workspace-${index}/skills/a-skill-with-a-really-long-directory-name-${index}`,
    name: index === 0 ? 'an-unusually-long-skill-name-that-should-truncate-cleanly-in-the-row' : `batch-skill-${index + 1}`,
    description: index === 0
      ? '这条说明特意写得很长，用来检查两行截断：它描述了一个会读取多个目录、汇总结果、再按团队约定输出报告的技能，第三行之后的内容应当被省略号截断而不撑高整行。'
      : `示例技能 ${index + 1} 的说明。`,
    sources: index === 0 ? ['Claude Code', 'Codex', 'Cursor', 'Windsurf', 'Gemini CLI'] : ['Codex'],
    installed: index % 4 === 3,
  })),
];

const many: LocalSkillCandidate[] = Array.from({ length: 60 }, (_, index) => ({
  path: `${HOME}/.codex/skills/skill-${String(index + 1).padStart(2, '0')}`, name: `skill-${String(index + 1).padStart(2, '0')}`,
  description: `批量示例技能 ${index + 1}。`, sources: ['Codex'], installed: false,
}));
let candidates = scene === 'long' ? long : scene === 'many' ? many : base;
let installed: InstalledSkill[] = [];
const skillOf = (item: LocalSkillCandidate, importMode?: LocalSkillImportMode): InstalledSkill => ({
  id: `local:${item.name}`, name: item.name, title: item.name, description: item.description,
  version: importMode === 'symlink' ? '随源更新' : '本地导入', sha256: importMode === 'symlink' ? null : '0'.repeat(64),
  origin: 'local', author: '', enabled: true, files: ['SKILL.md'], sourcePath: item.path, github: null, updateAvailable: false, sourceWithdrawn: false,
  ...(importMode ? { importMode, ...(importMode === 'symlink' ? { sourceAvailable: true } : {}) } : {}),
});
if (scene === 'installed') {
  installed = [
    skillOf(base[0], 'symlink'),
    { ...skillOf(base[1], 'symlink'), sourceAvailable: false, sourceError: '源目录已移动或删除，无法读取 /Users/demo/.codex/skills/git-review。' },
    skillOf(base[2], 'copy'),
    skillOf(base[3]), // 旧记录不带 importMode，不应被描述成软链接。
  ];
}
const state = (): SkillMarketState => ({
  installed, catalog: [], catalogSource: 'built-in', catalogError: '', storageError: '', checkedAt: null, publishedAt: '', mpSearch: null,
});

const scanDelay = scene === 'slow' ? 1800 : 450;
const api: SkillMarketApi = {
  getSkillState: async () => state(),
  refreshSkillCatalog: async () => ({ ok: true, state: state() }),
  importLocalSkill: async (options?: { mode?: LocalSkillImportMode }): Promise<SkillActionResult> => {
    calls.push({ name: 'importLocalSkill', args: [options] });
    await wait(400);
    // 模拟用户在原生对话框里点了取消。
    return { ok: false, cancelled: true };
  },
  scanLocalSkills: async (): Promise<LocalSkillScanResult> => {
    calls.push({ name: 'scanLocalSkills', args: [] });
    await wait(scanDelay);
    if (scene === 'scan-failed') return { ok: false, reason: '没有读取用户目录的权限' };
    if (scene === 'empty') return { ok: true, candidates: [], warnings: [] };
    return {
      ok: true,
      candidates: candidates.map((item) => ({ ...item })),
      warnings: [`${HOME}/.windsurf/skills：没有读取权限`, `${HOME}/.gemini/skills/broken：SKILL.md 缺少 name 字段`],
    };
  },
  importLocalSkills: async (paths: string[], options?: { mode?: LocalSkillImportMode }): Promise<LocalSkillBatchImportResult> => {
    calls.push({ name: 'importLocalSkills', args: [paths, options] });
    if (scene === 'importing') return new Promise(() => {});
    await wait(700);
    if (scene === 'rejected') return { ok: false, imported: 0, failed: [], reason: '无法创建软链接：没有写入权限。', state: state() };
    const failed = scene === 'partial'
      ? paths.filter((_, index) => index % 2 === 1).map((path) => ({ path, reason: '同名技能已存在，内容不同。先卸载旧版本再导入。' }))
      : [];
    const done = paths.filter((path) => !failed.some((item) => item.path === path));
    candidates = candidates.map((item) => done.includes(item.path) ? { ...item, installed: true } : item);
    installed = [...installed, ...candidates.filter((item) => done.includes(item.path)).map((item) => skillOf(item, options?.mode ?? 'symlink'))];
    return { ok: failed.length === 0, imported: done.length, failed, state: state() };
  },
  installMarketSkill: async () => ({ ok: true, state: state() }),
  setSkillEnabled: async () => ({ ok: true, state: state() }),
  removeSkill: async (id: string) => {
    calls.push({ name: 'removeSkill', args: [id] });
    installed = installed.filter((item) => item.id !== id);
    return { ok: true, state: state() };
  },
  readSkill: async () => ({ ok: true, text: '' }),
  revealSkill: async () => ({ ok: true }),
  searchSkillsMp: async () => ({ ok: false, reason: 'fixture 不联网' }),
  previewSkillsMp: async () => ({ ok: false, reason: 'fixture 不联网' }),
  installSkillsMp: async () => ({ ok: false, reason: 'fixture 不联网' }),
  checkSkillsMpUpdate: async () => ({ ok: false, reason: 'fixture 不联网' }),
} as unknown as SkillMarketApi;

installNativeInput();
void initializeAppearance({ fixtureSkin: 'classic' }).then(() => createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div style={{ height: '100dvh', overflow: 'auto' }}>
      <SkillMarket api={api} inline remote={scene === 'remote'} initialTab={scene === 'installed' ? 'installed' : 'builtin'} onBack={() => {}} />
      <div style={{ height: '150vh' }} aria-hidden="true" />
    </div>
  </StrictMode>,
));
