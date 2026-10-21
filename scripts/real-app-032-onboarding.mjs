#!/usr/bin/env node
/** 旧命令兼容入口。五屏引导已退役，验收改用四步流程与可选能力。 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const phase = process.argv[2] ?? 'fresh-full';
const modes = { 'fresh-full': 'manual', partial: 'partial', 'resume-check': 'resume', 'return-check': 'return' };
const mode = modes[phase];
if (!mode) throw new Error(`旧阶段 ${phase} 不再适用于四步引导。请使用 scripts/verify-onboarding.mjs；悬浮入口与配置修复需从完整应用单独验证。`);
if (!process.env.HEMI_USER_DATA_DIR) throw new Error('请指定隔离 HEMI_USER_DATA_DIR，首次完整验收需全新目录');
const electron = createRequire(import.meta.url)('electron');
console.log(`首启验收转到 verify-onboarding.mjs ${mode}；不连接旧 CDP 会话。`);
const child = spawn(electron, [fileURLToPath(new URL('./verify-onboarding.mjs', import.meta.url)), mode], {
  stdio: 'inherit', env: { ...process.env, HEMI_SMOKE_TEST: '1' },
});
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
