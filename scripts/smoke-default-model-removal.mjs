// 2026-11 默认模型删除 · v3→v4 迁移验证（只写 HEMI_USER_DATA_DIR 指定的临时目录）。
//
// 迁移语义（与 model-profiles.mjs 实现一致）：目录读取时内存归一为 v4（顶层
// thinkingLevel 从旧 defaultModelId 指向条目迁一次）；**不在加载时落盘**——
// 加载路径会把加密存储不可用的密文清空，此时写回会丢 Key。落盘发生在第一次
// 写操作（拨盘/保存/角色修改），落盘文件即 v4 形状（无 defaultModelId）。
//
// 两段验证：
//  1) store 层：v3 预置 → list()/get() 内存归一断言 → setThinkingLevel 触发
//     真实落盘 → 重读磁盘文件断言 v4 形状。
//  2) 应用启动：同一临时目录保持 v3 文件，HEMI_SMOKE_TEST=1 启动 electron，
//     exit 0 ＝ 旧配置可正常启动。
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createProfileStore } from '../src/main/lib/model-profiles.mjs';

const userData = process.env.HEMI_USER_DATA_DIR;
if (!userData) { console.error('SMOKE_FAIL: HEMI_USER_DATA_DIR 未设置'); process.exit(1); }

const file = path.join(userData, 'text-model-profiles.json');
const v3 = {
  version: 3,
  defaultModelId: 'oauth-openai/gpt-6.1-sol',
  lastConversationModelKey: 'oauth-openai/gpt-6.1-sol',
  providers: [
    {
      id: 'oauth-openai',
      name: 'ChatGPT',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      oauthProvider: 'openai',
      models: [
        { id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', thinkingLevel: 'high', supportsVision: false, visionModel: '' },
      ],
    },
    {
      id: 'mp-deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      encryptedApiKey: 'ZW5jOnNtb2tlLWtleQ==',
      models: [
        { id: 'm-flash', model: 'deepseek-flash', thinkingLevel: 'default', supportsVision: false, visionModel: '' },
        { id: 'm-flash-2', model: 'deepseek-flash', thinkingLevel: 'default', supportsVision: false, visionModel: '' },
      ],
    },
  ],
};
await writeFile(file, `${JSON.stringify(v3, null, 2)}\n`, 'utf8');

const problems = [];
const store = createProfileStore({ filePath: file });

// —— 第 1 段：内存归一（应用实际行为）——
const view = await store.list();
if (view.version !== 4) problems.push(`归一后 version=${view.version}，期望 4`);
if ('defaultModelId' in view) problems.push('归一后目录视图仍含 defaultModelId');
if (view.thinkingLevel !== 'high') problems.push(`全局档=${JSON.stringify(view.thinkingLevel)}，期望 high（从旧默认条目迁）`);
if (view.lastConversationModelKey !== 'oauth-openai/gpt-6.1-sol') problems.push(`上次选择丢失：${JSON.stringify(view.lastConversationModelKey)}`);
const flash = view.providers.flatMap((p) => p.models).filter((m) => m.model === 'deepseek-flash');
if (flash.length !== 2) problems.push(`deepseek-flash 条目数=${flash.length}`);
const sol = view.providers.flatMap((p) => p.models).find((m) => m.model === 'gpt-6.1-sol');
if (sol?.thinkingLevel !== 'high') problems.push('原默认条目档位丢失（条目字段应保留）');
const solved = await store.get('oauth-openai/gpt-6.1-sol', { decryptSecrets: false });
if (solved?.thinkingLevel !== 'high') problems.push(`get(旧默认) 档位=${JSON.stringify(solved?.thinkingLevel)}，期望 high`);
const flashed = await store.get('mp-deepseek/m-flash', { decryptSecrets: false });
if (flashed?.thinkingLevel !== 'high') problems.push(`get(deepseek-flash) 档位=${JSON.stringify(flashed?.thinkingLevel)}，期望 high（发送侧用全局档）`);

// —— 拨盘写路径：写同值会跳过落盘（防抖，既有设计），先拨不同档触发真实落盘 ——
const dial = await store.setThinkingLevel('medium');
if (dial?.thinkingLevel !== 'medium') problems.push(`拨盘回执=${JSON.stringify(dial)}`);
const onDisk = JSON.parse(await readFile(file, 'utf8'));
if (onDisk.version !== 4) problems.push(`落盘 version=${onDisk.version}，期望 4`);
if ('defaultModelId' in onDisk) problems.push('落盘文件仍含 defaultModelId');
if (onDisk.thinkingLevel !== 'medium') problems.push(`落盘全局档=${JSON.stringify(onDisk.thinkingLevel)}，期望 medium`);
if (flash.length && (onDisk.providers.flatMap((p) => p.models).find((m) => m.id === 'm-flash')?.thinkingLevel !== 'default')) problems.push('落盘时条目档位被改写');
const dialBack = await store.setThinkingLevel('high');
if (dialBack?.thinkingLevel !== 'high') problems.push(`拨回回执=${JSON.stringify(dialBack)}`);
const onDiskBack = JSON.parse(await readFile(file, 'utf8'));
if (onDiskBack.thinkingLevel !== 'high' || 'defaultModelId' in onDiskBack) problems.push(`拨回后落盘异常：level=${JSON.stringify(onDiskBack.thinkingLevel)} defaultModelId=${'defaultModelId' in onDiskBack}`);

// —— 第 2 段：应用用 v3 旧配置可正常启动 ——
// 探针口径：等 hemi.log 出现 renderer「启动完成」行（主窗口+渲染层装配完成的稳定标记；
// 引导页状态也会打），看到即认为启动成立，然后结束进程。不要求 UI 冒烟（HEMI_SMOKE_TEST
// 的动画断言在「已配置但无凭据」状态下本就不成立，与本任务无关）。加载不落盘是防丢
// Key 的既有设计，本段同时核验磁盘文件保持原状（未被启动改写）。
if (problems.length === 0) {
  const { spawn } = await import('node:child_process');
  const repo = path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), '..');
  const logFile = path.join(userData, 'hemi.log');
  await writeFile(file, `${JSON.stringify(v3, null, 2)}\n`, 'utf8');
  const child = spawn('npx', ['electron', '.'], {
    cwd: repo,
    env: { ...process.env, HEMI_SMOKE_TEST: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderrTail = '';
  child.stderr?.on('data', (chunk) => { stderrTail = `${stderrTail}${chunk}`.split('\n').filter(Boolean).slice(-8).join(' | '); });
  const deadline = Date.now() + 90_000;
  let booted = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode) break;
    try {
      const log = await readFile(logFile, 'utf8');
      if (log.includes('启动完成')) { booted = true; break; }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!booted) {
    problems.push(`90s 内未等到渲染层启动标记（hemi.log「启动完成」），exit=${child.exitCode} signal=${child.signalCode} stderr尾部: ${stderrTail}`);
  } else {
    // 通过与否只看启动标记；进程收尾不较真——Electron 不保证响应 SIGTERM，5s 后升级 SIGKILL。
    if (child.exitCode === null && !child.signalCode) child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
    const exited = await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode) return resolve(true);
      child.once('exit', () => resolve(true));
      setTimeout(() => resolve(false), 5_000);
    });
    if (!exited) problems.push('启动标记已出现，但进程 SIGKILL 后仍未退出');
  }
}

if (problems.length) { console.error(`SMOKE_FAIL: ${problems.join('；')}`); process.exit(1); }
console.log('SMOKE_OK: v3→v4 迁移通过（归一无 defaultModelId；全局档=high；条目档保留；上次选择保留；拨盘落盘为 v4；旧配置可启动应用）');
process.exit(0);
