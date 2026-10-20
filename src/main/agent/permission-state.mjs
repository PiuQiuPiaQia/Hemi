import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * 023 · 宿主运行态与资产（pi-environment.mjs 内置化后仅存的部分）。
 *
 * Pi 已是随包生产依赖：检测、安装、运行时解析、扩展复制（ensureGateAssets）
 * 全部随 RPC 形态一起删除。这里只留仍然有用的东西：浏览器桥状态文件路径、
 * 旧执行器目录清理、Chrome 扩展导出（014）。005 的权限模式运行态文件与 reviewer
 * 资产已随 042 退役（授权事实源＝access-grants.json）。
 */

/** 浏览器桥状态文件直接放 userData 根（Hemi 自有运行态，与 Pi 无关）。 */
export function browserBridgeStatePathFor(userDataDir) {
  return path.join(userDataDir, 'browser-bridge-state.json');
}

/** 旧 RPC 形态的安装目录（Pi 装置、扩展副本、runner、marker 都在其中）。 */
export function legacyExecutorDirFor(userDataDir) {
  return path.join(userDataDir, 'executor');
}

/**
 * 023 R-12（用户裁决 2026-09-22）：升级启动时删除可确认的旧安装残留——
 * `<userData>/executor` 整目录（新运行态文件已迁到 userData 根，旧目录里只剩
 * 安装器产物）。删除失败仅记日志、不影响任务；目录不存在时静默返回。
 */
export async function cleanupLegacyExecutorInstall({ userDataDir, log }) {
  const legacyDir = legacyExecutorDirFor(userDataDir);
  try {
    const st = await stat(legacyDir).catch(() => null);
    if (!st || !st.isDirectory()) return false;
    await rmSync(legacyDir, { recursive: true, force: true });
    log?.info(`已清理旧执行器安装目录：${legacyDir}`);
    return true;
  } catch (error) {
    log?.warn(`旧执行器残留清理失败（忽略，不影响使用）：${error?.message ?? error}`);
    return false;
  }
}

/**
 * 014：把 Chrome 扩展导出到用户指定的位置（2026-09-20 裁决——导出去哪由用户
 * 在系统目录选择窗里定，不替用户决定）。在 targetRoot 下建 folderName 子目录、
 * 覆盖式复制源目录里的文件；过滤 ._* AppleDouble 垃圾（exFAT 盘会生成，
 * Chrome 加载未打包扩展时是杂质）。返回实际导出目录。
 */
export function exportBrowserExtensionFiles({
  sourceDir,
  targetRoot,
  folderName = 'Hemi 浏览器控制',
  readdir = readdirSync,
  mkdir = mkdirSync,
  copy = copyFileSync,
  stat = statSync,
  unlink = unlinkSync,
}) {
  const exportDir = path.join(targetRoot, folderName);
  mkdir(exportDir, { recursive: true });
  for (const entry of readdir(sourceDir)) {
    if (entry.startsWith('.')) continue;
    const source = path.join(sourceDir, entry);
    if (!stat(source).isFile()) continue;
    copy(source, path.join(exportDir, entry));
  }
  for (const entry of readdir(exportDir)) {
    if (entry.startsWith('.')) {
      try {
        unlink(path.join(exportDir, entry));
      } catch {
        /* 清不掉不影响使用 */
      }
    }
  }
  return exportDir;
}
