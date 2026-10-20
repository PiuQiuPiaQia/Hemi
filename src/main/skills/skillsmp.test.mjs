import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SKILLSMP_ENDPOINT, createSkillsmpClient } from './skillsmp.mjs';
import { createSkillStore } from './skill-store.mjs';
import { createSkillsmpService } from './skillsmp-service.mjs';
import { fetchGithubSnapshot, parseGithubTreeUrl } from './github-source.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const gitBlobSha = (bytes) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const COMMIT = '1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a';
const OTHER_COMMIT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const SKILL_MD = '---\nname: demo-pdf\ntitle: demo PDF\ndescription: 演示用的 PDF 技能\n---\n\n# 用法\n先确认路径。\n';
const REFERENCE = '# 参考\n- 核对页码。\n';

function githubBlob(body) {
  const bytes = Buffer.from(body);
  return { sha: gitBlobSha(bytes), size: bytes.length };
}

/** 构造一个假 GitHub：git/ref、逐目录非递归树、raw 三类端点（与产品请求形态一致）。 */
function fakeGithub({ commit = COMMIT, files = null, symlink = false, repo = 'demo-org/skills', dirPath = 'skills/demo-pdf' } = {}) {
  const blobs = files ?? {
    'SKILL.md': SKILL_MD,
    'references/checklist.md': REFERENCE,
  };
  const trees = new Map();
  let seq = 0;
  const mkTree = (entries) => {
    const sha = `t${String(++seq).padStart(39, '0')}`;
    trees.set(sha, entries);
    return sha;
  };
  const buildDir = (dirFiles, withSymlink = false) => {
    const entries = [];
    const subdirs = new Map();
    for (const [name, body] of Object.entries(dirFiles)) {
      const slash = name.indexOf('/');
      if (slash < 0) {
        entries.push({ path: name, type: 'blob', mode: '100644', ...githubBlob(body) });
      } else {
        const dir = name.slice(0, slash);
        if (!subdirs.has(dir)) subdirs.set(dir, {});
        subdirs.get(dir)[name.slice(slash + 1)] = body;
      }
    }
    if (withSymlink) entries.push({ path: 'link.md', type: 'blob', mode: '120000', sha: '0'.repeat(40), size: 4 });
    for (const [dir, sub] of subdirs) entries.push({ path: dir, type: 'tree', sha: buildDir(sub, withSymlink) });
    return mkTree(entries);
  };
  const rootFiles = { ...blobs, 'README.md': 'readme' };
  let rootSha;
  if (dirPath) {
    // 叶目录树是匿名内容；除首段（由根条目命名）外，其余各段倒序逐层向上包。
    let inner = buildDir(blobs, symlink);
    for (const segment of dirPath.split('/').slice(1).reverse()) {
      inner = mkTree([{ path: segment, type: 'tree', sha: inner }]);
    }
    rootSha = mkTree([
      { path: 'README.md', type: 'blob', mode: '100644', ...githubBlob('readme') },
      { path: dirPath.split('/')[0], type: 'tree', sha: inner },
    ]);
  } else {
    rootSha = buildDir(rootFiles, symlink);
  }
  // walker 从 commit 树起步：把根树也登记在 commit 名下。
  trees.set(commit, trees.get(rootSha));
  const raw = new Map();
  for (const [name, body] of Object.entries(blobs)) {
    raw.set(`https://raw.githubusercontent.com/${repo}/${commit}/${dirPath ? `${dirPath}/` : ''}${name}`, Buffer.from(body));
  }
  return async (url) => {
    if (url === `https://api.github.com/repos/${repo}/git/ref/heads/main`) {
      return Response.json({ ref: 'refs/heads/main', object: { sha: commit, type: 'commit' } });
    }
    const recMatch = url.match(new RegExp(`^https://api\\.github\\.com/repos/${repo}/git/trees/([^?]+)\\?recursive=1$`));
    if (recMatch && trees.has(recMatch[1])) {
      const flat = [];
      const walk = (sha, prefix) => {
        for (const entry of trees.get(sha)) {
          const full = prefix ? `${prefix}/${entry.path}` : entry.path;
          if (entry.type === 'tree') walk(entry.sha, full);
          else flat.push({ ...entry, path: full });
        }
      };
      walk(recMatch[1], '');
      return Response.json({ sha: recMatch[1], tree: flat, truncated: false });
    }
    const treeMatch = url.match(new RegExp(`^https://api\\.github\\.com/repos/${repo}/git/trees/([^?]+)$`));
    if (treeMatch && trees.has(treeMatch[1])) {
      return Response.json({ sha: treeMatch[1], tree: trees.get(treeMatch[1]), truncated: false });
    }
    if (raw.has(url)) return new Response(raw.get(url));
    if (url.startsWith('https://raw.githubusercontent.com/')) return new Response('not found', { status: 404 });
    return new Response('not found', { status: 404 });
  };
}

function fakeMcp({ searchPayload = null, detailPayload = null, status = 200 } = {}) {
  const searches = [];
  const fetchImpl = async (url, init) => {
    assert.equal(url, SKILLSMP_ENDPOINT);
    const body = JSON.parse(init.body);
    if (body.method === 'tools/call' && body.params.name === 'search_skills') {
      searches.push(body.params.arguments);
      if (status !== 200) return new Response('limit', { status, headers: { 'retry-after': '17' } });
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(searchPayload) }] } });
    }
    if (body.method === 'tools/call' && body.params.name === 'get_skill') {
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(detailPayload) }] } });
    }
    return Response.json({ jsonrpc: '2.0', id: body.id, result: {} });
  };
  fetchImpl.searches = searches;
  return fetchImpl;
}

const SEARCH_RESULT = {
  skills: [{
    id: 'demo-org-skills-demo-pdf-skill-md', name: 'demo-pdf', author: 'demo-org',
    description: '演示技能', contentLanguage: 'zh',
    githubUrl: 'https://github.com/demo-org/skills/tree/main/skills/demo-pdf',
    skillUrl: 'https://skillsmp.com/creators/demo-org/skills-demo-pdf',
    stars: 1200, updatedAt: 1779015027,
  }],
  pagination: { page: 1, limit: 20, total: 1, totalPages: 1, hasNext: false, hasPrev: false },
  total: 1,
};

const DETAIL = { skill: SEARCH_RESULT.skills[0] };

test('仓库被下架（451）与改名转移（3xx）给用户能懂的原因，不再是裸状态码', async () => {
  const statusImpl = (status) => async (url) => new Response('blocked', { status });
  await assert.rejects(
    () => fetchGithubSnapshot({ githubUrl: DETAIL.skill.githubUrl }, { fetchImpl: statusImpl(451) }),
    /已被 GitHub 下架/,
  );
  await assert.rejects(
    () => fetchGithubSnapshot({ githubUrl: DETAIL.skill.githubUrl }, { fetchImpl: statusImpl(301) }),
    /改名或转移/,
  );
});

test('parseGithubTreeUrl 接受 tree/blob/根目录，拒绝其他形态', () => {
  assert.deepEqual(
    parseGithubTreeUrl('https://github.com/demo-org/skills/tree/main/skills/demo-pdf'),
    { owner: 'demo-org', repo: 'skills', ref: 'main', dirPath: 'skills/demo-pdf' },
  );
  assert.equal(
    parseGithubTreeUrl('https://github.com/demo-org/skills/blob/main/skills/demo-pdf/SKILL.md').dirPath,
    'skills/demo-pdf',
  );
  assert.deepEqual(
    parseGithubTreeUrl('https://github.com/demo-org/skills'),
    { owner: 'demo-org', repo: 'skills', ref: 'HEAD', dirPath: '' },
  );
  assert.equal(parseGithubTreeUrl('https://gitlab.com/a/b/tree/main/c'), null);
  // URL 构造器会先折叠 /../（不可能存活穿越段），解析结果退化为浅层 tree。
  const collapsed = parseGithubTreeUrl('https://github.com/a/b/tree/main/../escape');
  assert.deepEqual(collapsed, { owner: 'a', repo: 'b', ref: 'escape', dirPath: '' });
  assert.equal(parseGithubTreeUrl('https://github.com/a/b/wiki'), null);
  assert.equal(parseGithubTreeUrl('https://github.com/a/b/blob/main/other.md'), null);
});

test('fetchGithubSnapshot 按固定提交取文件并核对 blob 摘要', async () => {
  const snapshot = await fetchGithubSnapshot(
    { githubUrl: DETAIL.skill.githubUrl },
    { fetchImpl: fakeGithub() },
  );
  assert.equal(snapshot.commit, COMMIT);
  assert.equal(snapshot.repo, 'demo-org/skills');
  assert.equal(snapshot.dirPath, 'skills/demo-pdf');
  assert.deepEqual(snapshot.files.map((file) => file.path).sort(), ['SKILL.md', 'references/checklist.md']);
  assert.equal(snapshot.metadata.name, 'demo-pdf');
  assert.equal(typeof snapshot.bundleSha256, 'string');
});

test('fetchGithubSnapshot 完整收录来源目录（.gitignore/LICENSE/无扩展名一并安装）', async () => {
  const files = {
    'SKILL.md': SKILL_MD,
    '.gitignore': 'node_modules\n',
    'LICENSE': 'MIT License\n',
    'NOTICE': '本项目仅供演示\n',
    'references/checklist.md': REFERENCE,
  };
  const snapshot = await fetchGithubSnapshot(
    { githubUrl: DETAIL.skill.githubUrl },
    { fetchImpl: fakeGithub({ files }) },
  );
  assert.deepEqual(
    snapshot.files.map((file) => file.path).sort(),
    ['.gitignore', 'LICENSE', 'NOTICE', 'SKILL.md', 'references/checklist.md'],
  );
});

test('fetchGithubSnapshot 按魔数拒绝可执行内容，扩展名伪装无效', async () => {
  const macho = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x00, 0x00, 0x00, 0x01]);
  await assert.rejects(
    () => fetchGithubSnapshot(
      { githubUrl: DETAIL.skill.githubUrl },
      { fetchImpl: fakeGithub({ files: { 'SKILL.md': SKILL_MD, 'assets/lib.txt': macho } }) },
    ),
    /可执行内容/,
  );
});

test('fetchGithubSnapshot 拒绝符号链接、目录缺失、未 pin 时的越权改动与 404', async () => {
  await assert.rejects(
    () => fetchGithubSnapshot({ githubUrl: DETAIL.skill.githubUrl }, { fetchImpl: fakeGithub({ symlink: true }) }),
    /符号链接/,
  );
  await assert.rejects(
    () => fetchGithubSnapshot(
      { githubUrl: 'https://github.com/demo-org/skills/tree/main/skills/none' },
      { fetchImpl: fakeGithub() },
    ),
    /目录不存在/,
  );
  // 固定提交后内容被换掉（raw 与 tree blob 摘要不符）→ 拒绝。
  const tampered = fakeGithub();
  const tamperedImpl = async (url, init) => {
    const response = await tampered(url, init);
    if (url.endsWith('/SKILL.md')) return new Response(Buffer.from('tampered'));
    return response;
  };
  await assert.rejects(
    () => fetchGithubSnapshot({ githubUrl: DETAIL.skill.githubUrl, commit: COMMIT }, { fetchImpl: tamperedImpl }),
    /摘要不符/,
  );
  await assert.rejects(
    () => fetchGithubSnapshot({ githubUrl: 'https://github.com/gone/repo/tree/main/x' }, { fetchImpl: fakeGithub() }),
    /不存在/,
  );
});

test('fetchGithubSnapshot raw 网络抖动重试可恢复（单发超时不再整次失败）', async () => {
  const stable = fakeGithub();
  let flaked = false;
  const flaky = async (url, init) => {
    if (url.endsWith('/SKILL.md') && !flaked) {
      flaked = true;
      throw new Error('网络中断');
    }
    return stable(url, init);
  };
  const snapshot = await fetchGithubSnapshot({ githubUrl: DETAIL.skill.githubUrl }, { fetchImpl: flaky });
  assert.equal(snapshot.files.length, 2);
  assert.ok(flaked);
});

test('fetchGithubSnapshot 收录 65+ 文件技能（上限 256，2026-10-09 自 64 上调）', async () => {
  const files = { 'SKILL.md': SKILL_MD };
  for (let index = 0; index < 70; index += 1) files[`references/p${String(index).padStart(3, '0')}.md`] = `# ${index}\n`;
  const snapshot = await fetchGithubSnapshot(
    { githubUrl: DETAIL.skill.githubUrl },
    { fetchImpl: fakeGithub({ files }) },
  );
  assert.equal(snapshot.files.length, 71);
  assert.ok(snapshot.bundleSha256);
});

/** 测试用 tar 构造器：512 字节头 + 数据块对齐；校验和字段不参与解析（完整性锚是 blob SHA）。 */
function tarEntry(name, data, { typeflag = '0', prefix = '' } = {}) {
  const header = Buffer.alloc(512);
  const nameBytes = Buffer.from(name, 'utf8');
  if (nameBytes.length > 100) throw new Error('测试条目名过长，请用 L 长名模拟');
  nameBytes.copy(header, 0);
  header.write((data.length).toString(8).padStart(11, '0') + '\0', 124);
  header.write(typeflag, 156, 'ascii');
  header.write('ustar  \0', 257, 'ascii'); // GNU magic
  Buffer.from(prefix, 'utf8').copy(header, 345);
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  Buffer.from(data).copy(padded, 0);
  return Buffer.concat([header, padded]);
}

test('parseTarArchive 登记 ustar/GNU/pax 长名的普通文件，剥根目录段并忽略目录/链接', async () => {
  const { parseTarArchive } = await import('./github-source.mjs');
  const longName = `references/${'d'.repeat(110)}/deep.md`;
  const paxName = `references/${'p'.repeat(110)}/pax.md`;
  const paxRecord = Buffer.from(`${paxName.length + 24} path=skills-main/${paxName}\n`, 'utf8');
  const tar = Buffer.concat([
    tarEntry('skills-main/', Buffer.alloc(0), { typeflag: '5' }),
    tarEntry('skills-main/.gitignore', Buffer.from('node_modules\n')),
    tarEntry('skills-main/references/checklist.md', Buffer.from('# 核对\n')),
    // GNU 长名：L 记录携带真实全路径，下一条占位名被覆盖
    tarEntry('././@LongLink', Buffer.from(`skills-main/${longName}\0`), { typeflag: 'L' }),
    tarEntry('skills-main/truncated-name', Buffer.from('via-L')),
    // pax 扩展头：path= 记录覆盖下一条目名
    tarEntry('skills-main/PaxHeaders/x', paxRecord, { typeflag: 'x' }),
    tarEntry('skills-main/truncated-pax', Buffer.from('via-pax')),
    tarEntry('skills-main/link.md', Buffer.from('references/checklist.md'), { typeflag: '2' }),
    tarEntry('skills-main/sub', Buffer.alloc(0), { typeflag: '5' }),
    Buffer.alloc(1024), // 结束块
  ]);
  const parsed = parseTarArchive(tar);
  assert.equal(parsed.get('.gitignore')?.toString('utf8'), 'node_modules\n');
  assert.equal(parsed.get('references/checklist.md')?.toString('utf8'), '# 核对\n');
  assert.equal(parsed.get(longName)?.toString('utf8'), 'via-L');
  assert.equal(parsed.get(paxName)?.toString('utf8'), 'via-pax');
  assert.equal(parsed.get('link.md'), undefined, '符号链接不登记');
  assert.equal(parsed.get('sub'), undefined, '目录不登记');
  assert.equal(parsed.get('truncated-name'), undefined, '被长名覆盖的占位条目不得残留');
});

test('fetchGithubSnapshot 主链路走 codeload 整包（raw 全程不触碰），blob SHA 逐文件校验', async () => {
  const { gzipSync } = await import('node:zlib');
  const files = { 'SKILL.md': SKILL_MD, 'references/a.md': REFERENCE };
  const base = fakeGithub({ files });
  let rawHits = 0;
  const archiveFirst = async (url, init) => {
    if (url.startsWith('https://raw.githubusercontent.com/')) {
      rawHits += 1;
      return new Response('not found', { status: 404 });
    }
    if (url.startsWith('https://codeload.github.com/')) {
      const entries = [tarEntry('skills-main/', Buffer.alloc(0), { typeflag: '5' })];
      for (const [name, body] of Object.entries(files)) {
        entries.push(tarEntry(`skills-main/skills/demo-pdf/${name}`, Buffer.from(body)));
      }
      entries.push(tarEntry('skills-main/README.md', Buffer.from('readme')));
      entries.push(Buffer.alloc(1024));
      return new Response(gzipSync(Buffer.concat(entries)));
    }
    return base(url, init);
  };
  const snapshot = await fetchGithubSnapshot({ githubUrl: DETAIL.skill.githubUrl }, { fetchImpl: archiveFirst });
  assert.equal(snapshot.files.length, 2);
  assert.equal(rawHits, 0, '归档命中时不得回落 raw');
});

test('raw 也断时走第三级 Blobs API（api.github.com）救回——被墙时段的 monorepo 缺口', async () => {
  const files = { 'SKILL.md': SKILL_MD, 'references/a.md': REFERENCE };
  const base = fakeGithub({ files });
  const bySha = new Map(Object.entries(files).map(([name, body]) => [gitBlobSha(Buffer.from(body)), body]));
  const ladder = async (url, init) => {
    if (url.startsWith('https://codeload.github.com/')) return new Response('boom', { status: 502 });
    if (url.startsWith('https://raw.githubusercontent.com/')) throw new Error('fetch failed');
    const blobMatch = url.match(/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/git\/blobs\/([0-9a-f]{40})$/);
    if (blobMatch && bySha.has(blobMatch[1])) {
      // GitHub Blobs API 的 base64 带 60 列换行——解析须剥空白。
      const base64 = Buffer.from(bySha.get(blobMatch[1])).toString('base64').replace(/(.{60})/g, '$1\n');
      return Response.json({ sha: blobMatch[1], encoding: 'base64', content: base64 });
    }
    return base(url, init);
  };
  const snapshot = await fetchGithubSnapshot({ githubUrl: DETAIL.skill.githubUrl }, { fetchImpl: ladder });
  assert.equal(snapshot.files.length, 2);
  assert.ok(snapshot.bundleSha256);
});

test('三级全断时报 raw 的网络错误（对用户最有解释力）', async () => {
  const base = fakeGithub({ files: { 'SKILL.md': SKILL_MD } });
  const allDown = async (url, init) => {
    if (url.startsWith('https://codeload.github.com/')) return new Response('boom', { status: 502 });
    if (url.startsWith('https://raw.githubusercontent.com/')) throw new Error('fetch failed');
    return base(url, init);
  };
  await assert.rejects(
    () => fetchGithubSnapshot({ githubUrl: DETAIL.skill.githubUrl }, { fetchImpl: allDown }),
    /下载 .*SKILL\.md 失败/,
  );
});

test('归档任何失败（缺文件/篡改/5xx/超时）都回落 raw 逐文件救回', async () => {
  const { gzipSync } = await import('node:zlib');
  const base = fakeGithub({ files: { 'SKILL.md': SKILL_MD, 'references/a.md': REFERENCE } });
  const withArchive = (entries) => async (url, init) => {
    if (url.startsWith('https://codeload.github.com/')) {
      return entries ? new Response(gzipSync(Buffer.concat(entries))) : new Response('boom', { status: 502 });
    }
    return base(url, init);
  };
  // 缺声明的文件 → 回落 raw 成功（归档可能是流中断/格式边角，树清单仍是权威）。
  const missing = [tarEntry('skills-main/skills/demo-pdf/SKILL.md', Buffer.from(SKILL_MD)), Buffer.alloc(1024)];
  const missingSnapshot = await fetchGithubSnapshot(
    { githubUrl: DETAIL.skill.githubUrl },
    { fetchImpl: withArchive(missing) },
  );
  assert.equal(missingSnapshot.files.length, 2);
  // 内容与树摘要不符（归档被换）→ 回落 raw，树+raw 仍是完整信任链。
  const tampered = [
    tarEntry('skills-main/skills/demo-pdf/SKILL.md', Buffer.from(SKILL_MD)),
    tarEntry('skills-main/skills/demo-pdf/references/a.md', Buffer.from('被换掉')),
    Buffer.alloc(1024),
  ];
  const tamperedSnapshot = await fetchGithubSnapshot(
    { githubUrl: DETAIL.skill.githubUrl },
    { fetchImpl: withArchive(tampered) },
  );
  assert.equal(tamperedSnapshot.files.length, 2);
  // 归档 5xx（网络/服务抖动）→ 回落 raw 逐文件并成功。
  const snapshot = await fetchGithubSnapshot({ githubUrl: DETAIL.skill.githubUrl }, { fetchImpl: withArchive(null) });
  assert.equal(snapshot.files.length, 2);
});

test('listBlobs 优先一次 recursive 树，多目录技能只花常数次 API（60 次/小时配额）', async () => {
  const files = { 'SKILL.md': SKILL_MD, 'references/a.md': REFERENCE, 'references/deep/b.md': REFERENCE };
  const base = fakeGithub({ files });
  let apiCalls = 0;
  const counting = async (url, init) => {
    if (url.startsWith('https://api.github.com/')) apiCalls += 1;
    return base(url, init);
  };
  const snapshot = await fetchGithubSnapshot({ githubUrl: DETAIL.skill.githubUrl }, { fetchImpl: counting });
  assert.equal(snapshot.files.length, 3);
  // git/ref 1 + 下钻 2 段 + recursive 1 = 4；逐目录路径是 1+2+1+1+1 = 6。
  assert.equal(apiCalls, 4);
});

test('recursive 树被 GitHub 截断时回落逐目录收集', async () => {
  const base = fakeGithub({ files: { 'SKILL.md': SKILL_MD, 'references/a.md': REFERENCE } });
  const truncated = async (url, init) => {
    if (url.includes('?recursive=1')) return Response.json({ sha: 'x', tree: [], truncated: true });
    return base(url, init);
  };
  const snapshot = await fetchGithubSnapshot({ githubUrl: DETAIL.skill.githubUrl }, { fetchImpl: truncated });
  assert.equal(snapshot.files.length, 2);
});

async function withService(callback, { github = fakeGithub(), mcp = fakeMcp({ searchPayload: SEARCH_RESULT, detailPayload: DETAIL }) } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hemi-skillsmp-test-'));
  const fetchImpl = async (url, init) => (url === SKILLSMP_ENDPOINT ? mcp(url, init) : github(url, init));
  const store = createSkillStore({ root, fetchImpl, log: null });
  const service = createSkillsmpService({ store, fetchImpl, cacheFile: path.join(root, 'skillsmp-cache.json'), log: null });
  try {
    await callback({ store, service, root, fetchImpl });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('搜索：成功落缓存（含时间），限流给明确 reason 且缓存仍在', async () => {
  await withService(async ({ service, root }) => {
    const first = await service.search({ query: 'pdf' });
    assert.equal(first.ok, true);
    assert.equal(first.skills.length, 1);
    assert.equal(first.skills[0].name, 'demo-pdf');
    assert.ok(Number.isFinite(first.checkedAt));
    assert.ok(existsSync(path.join(root, 'skillsmp-cache.json')));
    const limited = await createSkillsmpService({
      store: createSkillStore({ root }),
      fetchImpl: fakeMcp({ status: 429 }),
      cacheFile: path.join(root, 'skillsmp-cache.json'),
    }).search({ query: 'pdf' });
    assert.equal(limited.ok, false);
    assert.match(limited.reason, /限流/);
    assert.match(limited.reason, /17 秒/);
    assert.equal(limited.cached.skills[0].id, 'demo-org-skills-demo-pdf-skill-md');
    // 空关键词在客户端即拒绝，不产生请求。
    const empty = await service.search({ query: '  ' });
    assert.equal(empty.ok, false);
    assert.match(empty.reason, /关键词/);
  });
});

test('预览→确认安装：固定提交、摘要一致才落地；登记可追溯，重启一致', async () => {
  await withService(async ({ service, store, root }) => {
    const preview = await service.preview({ id: DETAIL.skill.id });
    assert.equal(preview.ok, true);
    assert.equal(preview.preview.commit, COMMIT);
    assert.equal(preview.preview.name, 'demo-pdf');
    assert.match(preview.preview.skillMd, /确认路径/);
    assert.equal(store.state().installed.length, 0);
    const installed = await service.install({
      skillsmpId: DETAIL.skill.id, commit: COMMIT,
      bundleSha256: preview.preview.bundleSha256,
      githubUrl: DETAIL.skill.githubUrl, author: 'demo-org', skillUrl: DETAIL.skill.skillUrl,
    });
    assert.equal(installed.ok, true);
    assert.equal(installed.skill.origin, 'skillsmp');
    assert.equal(installed.skill.version, COMMIT.slice(0, 7));
    assert.equal(installed.skill.github.repo, 'demo-org/skills');
    assert.equal(installed.skill.github.commit, COMMIT);
    assert.equal((await store.readSkill(installed.skill.id)).includes('确认路径'), true);
    const lease = store.snapshot(installed.skill.id);
    assert.equal(lease.selectedId, installed.skill.id);
    lease.release();
    const reopened = createSkillStore({ root });
    const view = reopened.state().installed[0];
    assert.equal(view.github.entryId, DETAIL.skill.id);
    assert.equal(view.enabled, true);
    // 预览后来源内容变化（同 commit 摘要不符）→ 拒绝，旧登记不动。
    const drifted = await service.install({
      skillsmpId: DETAIL.skill.id, commit: COMMIT,
      bundleSha256: 'f'.repeat(64),
      githubUrl: DETAIL.skill.githubUrl, author: 'demo-org', skillUrl: DETAIL.skill.skillUrl,
    }).catch((error) => ({ ok: false, reason: error.message }));
    assert.equal(drifted.ok, false);
    assert.match(drifted.reason, /不一致/);
    assert.equal(reopened.state().installed.length, 1);
  });
});

test('同名不同来源报冲突并指明双方来源；快照保持旧版直到终态释放', async () => {
  await withService(async ({ service, store }) => {
    const preview = await service.preview({ id: DETAIL.skill.id });
    const installed = await service.install({
      skillsmpId: DETAIL.skill.id, commit: COMMIT,
      bundleSha256: preview.preview.bundleSha256,
      githubUrl: DETAIL.skill.githubUrl, author: 'demo-org', skillUrl: DETAIL.skill.skillUrl,
    });
    assert.equal(installed.ok, true);
    // 另一个 SkillsMP 条目落到同名 frontmatter → 冲突，指明已装来源。
    const otherUrl = 'https://github.com/other-org/repo/tree/main/skills/demo-pdf';
    const other = fakeGithub({ repo: 'other-org/repo' });
    const otherService = createSkillsmpService({ store, fetchImpl: other });
    const otherSnapshot = await fetchGithubSnapshot({ githubUrl: otherUrl }, { fetchImpl: other });
    await assert.rejects(
      () => store.installFromSnapshot({
        skillsmpId: 'other-org-repo-demo-pdf-skill-md', githubUrl: otherUrl,
        repo: 'other-org/repo', dirPath: 'skills/demo-pdf', commit: COMMIT,
        files: otherSnapshot.files, metadata: otherSnapshot.metadata,
      }),
      /同名 Skill 已安装：demo-pdf（来自SkillsMP 市场 demo-org\/skills）/,
    );
    // 在途任务持有旧版目录；「更新」发布新版后旧目录仍在，释放后回收。
    const lease = store.snapshot(installed.skill.id);
    const oldPath = lease.items.find((item) => item.id === installed.skill.id).path;
    const moved = fakeGithub({
      files: { 'SKILL.md': SKILL_MD.replace('确认路径', '确认路径（新版）'), 'references/checklist.md': REFERENCE },
    });
    const movedPreview = await fetchGithubSnapshot({ githubUrl: DETAIL.skill.githubUrl }, { fetchImpl: moved });
    const updated = await createSkillsmpService({ store, fetchImpl: moved }).install({
      skillsmpId: DETAIL.skill.id, commit: COMMIT,
      bundleSha256: movedPreview.bundleSha256,
      githubUrl: DETAIL.skill.githubUrl, author: 'demo-org', skillUrl: DETAIL.skill.skillUrl,
    });
    assert.equal(updated.ok, true);
    assert.notEqual(updated.skill.sha256, installed.skill.sha256);
    assert.equal(existsSync(oldPath), true);
    lease.release();
    await store.prune();
    assert.equal(existsSync(oldPath), false);
  });
});

test('检查更新：最新/有新版/来源变化/撤架各有准确状态，不自动安装', async () => {
  await withService(async ({ service, store }) => {
    const preview = await service.preview({ id: DETAIL.skill.id });
    const installed = await service.install({
      skillsmpId: DETAIL.skill.id, commit: COMMIT,
      bundleSha256: preview.preview.bundleSha256,
      githubUrl: DETAIL.skill.githubUrl, author: 'demo-org', skillUrl: DETAIL.skill.skillUrl,
    });
    const same = await service.checkUpdate({ id: installed.skill.id });
    assert.equal(same.status, 'up-to-date');
    assert.equal(same.commit, COMMIT);
    // 仓库前进到新提交：MCP 返回同一条目（同 repo/path），GitHub ref 解析出新 commit。
    const aheadGithub = fakeGithub({ commit: OTHER_COMMIT });
    const aheadService = createSkillsmpService({
      store,
      fetchImpl: async (url, init) => (url === SKILLSMP_ENDPOINT
        ? fakeMcp({ searchPayload: SEARCH_RESULT, detailPayload: DETAIL })(url, init)
        : aheadGithub(url, init)),
    });
    const fresh = await aheadService.checkUpdate({ id: installed.skill.id });
    assert.equal(fresh.status, 'update-available');
    assert.equal(fresh.commit, OTHER_COMMIT);
    const relocated = createSkillsmpService({
      store,
      fetchImpl: fakeMcp({
        detailPayload: {
          skill: { ...DETAIL.skill, githubUrl: 'https://github.com/demo-org/skills/tree/main/skills/moved-pdf' },
        },
      }),
    });
    const changed = await relocated.checkUpdate({ id: installed.skill.id });
    assert.equal(changed.status, 'source-changed');
    assert.match(changed.reason, /moved-pdf/);
    const withdrawn = createSkillsmpService({
      store,
      fetchImpl: fakeMcp({ detailPayload: { skill: null } }),
    });
    const gone = await withdrawn.checkUpdate({ id: installed.skill.id });
    assert.equal(gone.status, 'unavailable');
    assert.equal(store.state().installed[0].sha256, installed.skill.sha256);
  });
});

test('缓存文件损坏时静默忽略，搜索仍可用', async () => {
  await withService(async ({ root }) => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(root, 'skillsmp-cache.json'), '{ broken');
    const client = createSkillsmpClient({
      fetchImpl: fakeMcp({ searchPayload: SEARCH_RESULT }),
      cacheFile: path.join(root, 'skillsmp-cache.json'),
    });
    assert.equal(client.cachedSearch(), null);
    const entry = await client.search({ query: 'pdf' });
    assert.equal(entry.skills.length, 1);
    const persisted = JSON.parse(await readFile(path.join(root, 'skillsmp-cache.json'), 'utf8'));
    assert.equal(persisted.query, 'pdf');
    assert.ok(Number.isFinite(persisted.checkedAt));
  });
});
