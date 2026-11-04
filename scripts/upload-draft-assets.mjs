#!/usr/bin/env node
/**
 * 草稿资产上挂入口（mac bash 与 win pwsh 共用，逻辑在 lib/release-asset-upload.mjs）。
 *
 * 用法：node scripts/upload-draft-assets.mjs <tag> <asset-file> [asset-file ...]
 *
 * 只用于 release.yml「已存在草稿 → gh release upload --clobber」分支：确认的
 * HTTP 500/502/503/504 才有界重试（最多 3 次、同一批文件）；每次上挂前重新
 * 核实仍是草稿，非草稿或核实失败立即停止。其余失败（403/ENOENT/超时/信号等）
 * 退出真实非 0，由调用 shell 决定后续。参数原样数组传递，路径含空格不拆分。
 *
 * 环境变量（测试钩子，正常流程不需要）：
 * - HEMI_UPLOAD_RETRY_DELAYS_MS：逗号分隔的重试延迟毫秒数，覆盖默认 5000,15000。
 */
import { statSync } from 'node:fs';
import process from 'node:process';
import { runGh, uploadDraftAssetsWithRetry } from './lib/release-asset-upload.mjs';

const [tag, ...files] = process.argv.slice(2);
if (!tag || tag.startsWith('-') || files.length === 0) {
  console.error('用法：node scripts/upload-draft-assets.mjs <tag> <asset-file> [asset-file ...]');
  process.exit(2);
}
// 先核实文件都在：重试始终用同一批已生成且不变的文件，缺文件直接失败，不进 gh。
for (const file of files) {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    console.error(`资产文件不存在：${file}`);
    process.exit(2);
  }
  if (!stat.isFile()) {
    console.error(`资产不是常规文件：${file}`);
    process.exit(2);
  }
}

const retryDelaysEnv = process.env.HEMI_UPLOAD_RETRY_DELAYS_MS;
const retryDelaysMs = retryDelaysEnv
  ? retryDelaysEnv.split(',').map((value) => Number(value.trim())).filter((value) => Number.isFinite(value))
  : undefined;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

try {
  const exitCode = await uploadDraftAssetsWithRetry({
    tag,
    files,
    run: runGh,
    sleep,
    ...(retryDelaysMs && retryDelaysMs.length > 0 ? { retryDelaysMs } : {}),
  });
  process.exit(exitCode);
} catch (error) {
  console.error(`参数无效：${error.message}`);
  process.exit(2);
}
