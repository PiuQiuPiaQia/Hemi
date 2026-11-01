import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSkillStore, readSkillDirectory } from './skill-store.mjs';
import {
  createLocalSkillScanner,
  importLocalAgentSkills,
  scanLocalAgentSkills,
} from './local-agent-skills.mjs';

const offline = async () => { throw new Error('offline'); };

async function withStore(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hemi-local-skill-store-'));
  try { await callback(createSkillStore({ root, fetchImpl: offline }), root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function makeSkill(dir, { name, description = '演示技能', body = '' } = {}) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`);
  return dir;
}

async function withHome(callback) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'hemi-local-skill-home-'));
  try { await callback(home); }
  finally { await rm(home, { recursive: true, force: true }); }
}

test('扫描发现用户级目录：一层/两层组形态、软链按 realpath 合并 sources、失效项进 warnings', async () => {
  await withHome(async (home) => {
    const alpha = await makeSkill(path.join(home, '.agents/skills/alpha'), { name: 'alpha' });
    const beta = await makeSkill(path.join(home, '.claude/skills/beta'), { name: 'beta', description: '另一个技能' });
    await symlink(alpha, path.join(home, '.claude/skills/alpha-link'));
    await symlink(path.join(home, 'nowhere'), path.join(home, '.claude/skills/broken'));
    // frontmatter 无效 → 跳过并给 warning。
    await mkdir(path.join(home, '.codex/skills/gamma'), { recursive: true });
    await writeFile(path.join(home, '.codex/skills/gamma/SKILL.md'), '不是 frontmatter 的内容');
    // 普通文件与 ._ 垃圾不算候选；两层组形态（组目录自身无 SKILL.md）收一层下钻。
    await mkdir(path.join(home, '.cursor/skills'), { recursive: true });
    await writeFile(path.join(home, '.cursor/skills/notes.md'), '笔记');
    const nested = await makeSkill(path.join(home, '.cursor/skills/group/nested-skill'), { name: 'nested-skill' });
    await makeSkill(path.join(home, '.gemini/skills/._junk'), { name: 'junk' });

    const result = await scanLocalAgentSkills({ home: () => home, listWorkspaceDirs: () => [], getInstalled: () => [] });
    assert.equal(result.ok, true);
    const byName = new Map(result.candidates.map((item) => [item.name, item]));
    assert.deepEqual([...byName.keys()].sort(), ['alpha', 'beta', 'nested-skill']);
    assert.deepEqual(byName.get('alpha').sources, ['~/.agents/skills/alpha', '~/.claude/skills/alpha-link']);
    assert.equal(byName.get('nested-skill').path, await realpath(nested));
    assert.equal(byName.get('alpha').installed, false);
    assert.equal(result.candidates.every((item) => path.isAbsolute(item.path)), true);
    const joined = result.warnings.join('\n');
    assert.match(joined, /broken/);
    assert.match(joined, /gamma/);
    assert.doesNotMatch(joined, /notes\.md/);
    assert.doesNotMatch(joined, /junk/);
    assert.ok(beta);
  });
});

test('项目来源：本机工作区的 .agents/.claude/skills 进扫描，sources 带项目名', async () => {
  await withHome(async (home) => {
    const raw = await mkdtemp(path.join(os.tmpdir(), 'hemi-local-skill-ws-'));
    const ws = await realpath(raw); // 生产上 workspace-store 的本机 ok 视图 dir 已是 realpath。
    try {
      const skill = await makeSkill(path.join(ws, '.claude/skills/proj-skill'), { name: 'proj-skill' });
      const result = await scanLocalAgentSkills({
        home: () => home,
        listWorkspaceDirs: () => [{ dir: ws, name: '演示项目' }],
        getInstalled: () => [],
      });
      const found = result.candidates.find((item) => item.name === 'proj-skill');
      assert.equal(found.path, skill);
      assert.deepEqual(found.sources, [`演示项目/${path.relative(ws, skill).split(path.sep).join('/')}`]);
      // 远端工作区（host）不应出现在本机扫描里（由 IPC 层过滤，这里只验证 dir 形态）。
      assert.equal(result.warnings.length, 0);
    } finally { await rm(ws, { recursive: true, force: true }); }
  });
});

test('installed 语义：metadata 同名（库内全局唯一）或本地来源 sourcePath realpath 相同', async () => {
  await withStore(async (store, storeRoot) => {
    await withHome(async (home) => {
      await store.installMarket('source-check'); // 库里已有同名技能（任何来源都占名）。
      const alpha = await makeSkill(path.join(home, '.claude/skills/alpha'), { name: 'source-check' });
      const beta = await makeSkill(path.join(home, '.claude/skills/beta'), { name: 'beta-skill' });
      const first = await scanLocalAgentSkills({
        home: () => home, listWorkspaceDirs: () => [], getInstalled: () => store.state().installed,
      });
      const byName = new Map(first.candidates.map((item) => [item.name, item]));
      assert.equal(byName.get('source-check').installed, true, '同名即已装（再导入必被同名冲突拒绝）');
      assert.equal(byName.get('beta-skill').installed, false);

      const imported = await store.importDirectory(beta);
      assert.equal(imported.ok, true);
      const second = await scanLocalAgentSkills({
        home: () => home, listWorkspaceDirs: () => [], getInstalled: () => store.state().installed,
      });
      const after = new Map(second.candidates.map((item) => [item.name, item]));
      assert.equal(after.get('beta-skill').installed, true, '导入后 sourcePath realpath 命中');
      assert.equal(after.get('source-check').installed, true);
      const entry = store.state().installed.find((item) => item.name === 'beta-skill');
      assert.equal(entry.sourcePath, await realpath(beta));
      assert.equal(entry.origin, 'local');
      assert.ok(storeRoot && alpha); // alpha 未导入，仅用于占名冲突场景。
    });
  });
});

test('真实 store 批量导入：勾选导入→安装状态；库外路径逐项失败；再导入复用同一 id', async () => {
  await withStore(async (store) => {
    await withHome(async (home) => {
      const alpha = await makeSkill(path.join(home, '.claude/skills/alpha'), { name: 'alpha-skill' });
      const beta = await makeSkill(path.join(home, '.agents/skills/beta'), { name: 'beta-skill' });
      const scanner = createLocalSkillScanner({
        home: () => home,
        listWorkspaceDirs: () => [],
        getInstalled: () => store.state().installed,
        importOne: (dir) => store.importDirectory(dir),
        state: () => store.state(),
      });
      const scan = await scanner.scan();
      assert.equal(scan.ok, true);
      assert.equal(scan.acceptedPaths, undefined, 'acceptedPaths 是主进程内部事实，不外发');
      const byName = new Map(scan.candidates.map((item) => [item.name, item]));
      const foreign = path.join(os.tmpdir(), 'hemi-not-scanned');
      const result = await scanner.import([byName.get('alpha-skill').path, byName.get('beta-skill').path, foreign]);
      assert.equal(result.ok, false, '含库外路径时不谎报全成');
      assert.equal(result.imported, 2);
      assert.deepEqual(result.failed, [{ path: foreign, reason: '路径不在扫描结果中，请重新扫描后再导入' }]);
      assert.equal(result.state.installed.some((item) => item.name === 'alpha-skill'), true);
      assert.equal(result.state.installed.some((item) => item.name === 'beta-skill'), true);

      // 受控链接真实落地（默认 importDirectory 的链接与校验链路）。
      const managed = store.managedPath(result.state.installed.find((item) => item.name === 'alpha-skill').id);
      assert.equal((await stat(path.join(managed, 'SKILL.md'))).isFile(), true);

      // 未扫描先导入：默认全拒（接口不能变成任意路径读取器）。
      const cold = createLocalSkillScanner({
        home: () => home, listWorkspaceDirs: () => [], getInstalled: () => [],
        importOne: (dir) => store.importDirectory(dir),
      });
      const coldResult = await cold.import([byName.get('alpha-skill').path]);
      assert.equal(coldResult.ok, false);
      assert.equal(coldResult.imported, 0);

      // 全量再导入：同一 sourcePath 复用同一 id（store 版本管理），失败为空。
      const again = await scanner.import([byName.get('alpha-skill').path, byName.get('beta-skill').path]);
      assert.equal(again.ok, true);
      assert.equal(again.imported, 2);
      assert.deepEqual(again.failed, []);
      const ids = new Set(store.state().installed.filter((item) => item.origin === 'local').map((item) => item.id));
      assert.equal(ids.size, 2);
    });
  });
});

test('同名冲突是逐项失败，不拖垮同批其他项；空勾选是无害 no-op', async () => {
  await withStore(async (store) => {
    await withHome(async (home) => {
      await store.installMarket('meeting-notes');
      const clash = await makeSkill(path.join(home, '.claude/skills/clash'), { name: 'meeting-notes' });
      const other = await makeSkill(path.join(home, '.claude/skills/other'), { name: 'other-skill' });
      const scanner = createLocalSkillScanner({
        home: () => home, listWorkspaceDirs: () => [], getInstalled: () => store.state().installed,
        importOne: (dir) => store.importDirectory(dir), state: () => store.state(),
      });
      const scan = await scanner.scan();
      const picked = new Map(scan.candidates.map((item) => [item.name, item.path]));
      const result = await scanner.import([picked.get('meeting-notes'), picked.get('other-skill')]);
      assert.equal(result.ok, false);
      assert.equal(result.imported, 1);
      assert.equal(result.failed.length, 1);
      assert.equal(result.failed[0].path, picked.get('meeting-notes'));
      assert.match(result.failed[0].reason, /同名/);
      assert.equal(result.state.installed.find((item) => item.name === 'other-skill')?.origin, 'local');

      const empty = await scanner.import([]);
      assert.equal(empty.ok, true);
      assert.equal(empty.imported, 0);
      assert.deepEqual(empty.failed, []);
    });
  });
});

test('批量上限与截断上限：超 50 个整体拒绝；超 100 候选截断并给 warning', async () => {
  await withHome(async (home) => {
    const root = path.join(home, '.claude/skills');
    for (let index = 0; index < 104; index += 1) {
      await makeSkill(path.join(root, `bulk-${String(index).padStart(3, '0')}`), { name: `bulk-${String(index).padStart(3, '0')}` });
    }
    const result = await scanLocalAgentSkills({ home: () => home, listWorkspaceDirs: () => [], getInstalled: () => [] });
    assert.equal(result.ok, true);
    assert.equal(result.candidates.length, 100);
    assert.match(result.warnings.join('\n'), /截断/);

    const cap = await importLocalAgentSkills({
      importOne: async () => { throw new Error('不应被调用'); },
      paths: Array.from({ length: 51 }, (_, index) => `/tmp/bulk-${index}`),
      acceptedPaths: new Set(),
    });
    assert.equal(cap.ok, false);
    assert.equal(cap.imported, 0);
    assert.match(cap.reason, /最多导入 50/);
  });
});

test('Bot 形态：readSkillDirectory 本地读文件 + importFiles 远传，逐项聚合不落路径', async () => {
  await withStore(async (hostStore) => {
    await withHome(async (home) => {
      const alpha = await makeSkill(path.join(home, '.claude/skills/alpha'), { name: 'alpha-skill' });
      const invalid = path.join(home, '.claude/skills/invalid');
      await mkdir(invalid, { recursive: true });
      await writeFile(path.join(invalid, 'SKILL.md'), '---\nname: INVALID_NAME\ndescription: 名字不合法\n---\n');
      const scanner = createLocalSkillScanner({
        home: () => home, listWorkspaceDirs: () => [], getInstalled: () => hostStore.state().installed,
        importOne: async (dir) => hostStore.importFiles({ files: await readSkillDirectory(dir) }),
        state: () => hostStore.state(),
      });
      const scan = await scanner.scan();
      assert.equal(scan.candidates.some((item) => item.name === 'alpha-skill'), true);
      assert.equal(scan.candidates.some((item) => item.path === invalid), false, '元数据不合法的目录不进候选');
      const picked = new Map(scan.candidates.map((item) => [item.name, item.path]));
      const result = await scanner.import([picked.get('alpha-skill'), invalid]);
      assert.equal(result.ok, false);
      assert.equal(result.imported, 1);
      assert.match(result.failed[0].reason, /扫描结果/, '元数据不合法被剔除后，该路径默认拒绝导入');
      const entry = hostStore.state().installed.find((item) => item.name === 'alpha-skill');
      assert.equal(entry?.origin, 'local');
      assert.equal(entry?.sourcePath, null, '远传通道不记录本机路径（远端从未见过来源路径）');
      const rescan = await scanner.scan();
      assert.equal(rescan.candidates.find((item) => item.name === 'alpha-skill')?.installed, true, '重扫按 metadata 同名命中已装');
    });
  });
});

test('不可读目录进 warnings，不阻塞同根其他候选', { skip: process.platform === 'win32' }, async () => {
  if (process.getuid?.() === 0) return; // root 不受权限位约束，跳过。
  await withHome(async (home) => {
    const secret = path.join(home, '.claude/skills/secret');
    await makeSkill(secret, { name: 'secret-skill' });
    const open = await makeSkill(path.join(home, '.claude/skills/open'), { name: 'open-skill' });
    await chmod(secret, 0o000);
    try {
      const result = await scanLocalAgentSkills({ home: () => home, listWorkspaceDirs: () => [], getInstalled: () => [] });
      assert.deepEqual(result.candidates.map((item) => item.name), ['open-skill']);
      assert.match(result.warnings.join('\n'), /secret/);
      assert.equal(result.candidates[0].path, await realpath(open));
    } finally {
      await chmod(secret, 0o700).catch(() => {});
    }
  });
});
