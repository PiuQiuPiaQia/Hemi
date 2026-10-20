// 主窗口尺寸/位置保留（2026-10-19）：resize/move 防抖落盘＋真退出补存；启动恢复并夹回
// 可见工作区。纯模块不 import electron（显示器信息由调用方传入），node --test 直接跑。
import fs from 'node:fs';
import path from 'node:path';

export const WINDOW_STATE_VERSION = 1;

/** 防抖窗口：拖拽/缩放期间不逐事件写盘，停止 800ms 后落一次。 */
export const SAVE_DEBOUNCE_MS = 800;

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

const intersectionArea = (a, b) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/**
 * 校验保存值并夹回可见工作区：显示器拔掉、分辨率变化后旧 bounds 不能直接用。
 * 与显示器的归属按相交面积取最大；完全离屏时取中心最近的一块。
 * 尺寸超工作区贴上限，位置保证窗口完整落在该工作区内。
 * 不可用（缺字段/非数字/小于下限/没有可用显示器）返回 null，调用方落默认尺寸。
 */
export function restoreBounds(saved, { displays, min = { width: 560, height: 620 } } = {}) {
  const areas = (Array.isArray(displays) ? displays : []).filter(
    (r) => r && isFiniteNumber(r.x) && isFiniteNumber(r.y) && isFiniteNumber(r.width) && isFiniteNumber(r.height) && r.width > 0 && r.height > 0,
  );
  if (!areas.length || !saved || typeof saved !== 'object') return null;
  if (![saved.x, saved.y, saved.width, saved.height].every(isFiniteNumber)) return null;
  if (saved.width < min.width || saved.height < min.height) return null;

  let target = null;
  let bestOverlap = -1;
  for (const area of areas) {
    const overlap = intersectionArea(saved, area);
    if (overlap > bestOverlap) { bestOverlap = overlap; target = area; }
  }
  if (!target || bestOverlap <= 0) {
    const cx = saved.x + saved.width / 2;
    const cy = saved.y + saved.height / 2;
    let bestDistance = Infinity;
    for (const area of areas) {
      const dx = Math.max(area.x - cx, 0, cx - (area.x + area.width));
      const dy = Math.max(area.y - cy, 0, cy - (area.y + area.height));
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) { bestDistance = distance; target = area; }
    }
  }

  const width = Math.min(Math.round(saved.width), target.width);
  const height = Math.min(Math.round(saved.height), target.height);
  return {
    width,
    height,
    x: Math.round(Math.min(target.x + target.width - width, Math.max(target.x, saved.x))),
    y: Math.round(Math.min(target.y + target.height - height, Math.max(target.y, saved.y))),
  };
}

/**
 * userData/window-state.json 读写。损坏或读失败按无记录起步（warn，不抛）；
 * 写入 tmp＋同目录 rename 原子替换，失败只记录——保留功能不让窗口功能受损。
 */
export function createWindowStateStore({ filePath, io = fs, log = null } = {}) {
  if (!filePath) throw new Error('window-state-store 缺少文件路径');

  function load() {
    let raw;
    try {
      raw = io.readFileSync(filePath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') log?.warn?.(`[window-state] 读取失败，按无记录起步：${error?.message ?? error}`);
      return null;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || parsed.version !== WINDOW_STATE_VERSION) throw new Error('结构或版本不识别');
      const bounds = parsed.bounds;
      if (!bounds || typeof bounds !== 'object' || ![bounds.x, bounds.y, bounds.width, bounds.height].every(isFiniteNumber)) {
        throw new Error('bounds 字段不完整');
      }
      return { bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }, maximized: parsed.maximized === true };
    } catch (error) {
      log?.warn?.(`[window-state] 记录不可用，按无记录起步：${error?.message ?? error}`);
      return null;
    }
  }

  function save({ bounds, maximized }) {
    try {
      const tmp = `${filePath}.tmp-${process.pid}`;
      io.mkdirSync(path.dirname(filePath), { recursive: true });
      io.writeFileSync(tmp, JSON.stringify({ version: WINDOW_STATE_VERSION, bounds, maximized: maximized === true }, null, 2), 'utf8');
      io.renameSync(tmp, filePath);
      return { ok: true };
    } catch (error) {
      log?.warn?.(`[window-state] 保存失败（下次启动用更早的记录或默认尺寸）：${error?.message ?? error}`);
      return { ok: false };
    }
  }

  return { load, save };
}
