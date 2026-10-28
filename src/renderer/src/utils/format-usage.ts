/**
 * 使用记录数字格式化工具：紧凑K/M/B单位，舍入后升级，避免1000K。
 */

/**
 * 格式化数字：tokens、计数等。
 * 舍入后升级单位，避免1000K、1000M。
 * @example formatNumber(999) => "999"
 * @example formatNumber(999.9) => "1K"
 * @example formatNumber(999999) => "1M"
 * @example formatNumber(999950) => "1M"
 * @example formatNumber(null) => "—"
 * @example formatNumber(0) => "0"
 */
export function formatNumber(n: number | null): string {
  if (n === null) return '—';
  if (n === 0) return '0';

  // 小于1000直接显示
  if (n < 1000) return Math.round(n) >= 1000 ? '1K' : Math.round(n).toLocaleString();

  // K: 1000 - 999,999
  if (n < 1000000) {
    const k = n / 1000;
    const rounded = k < 10 ? Math.round(k * 10) / 10 : Math.round(k);
    // 999.95K 舍入后会变成1000K，应升级为1M
    if (rounded >= 1000) return '1M';
    return `${rounded}K`;
  }

  // M: 1,000,000 - 999,999,999
  if (n < 1000000000) {
    const m = n / 1000000;
    const rounded = m < 10 ? Math.round(m * 10) / 10 : Math.round(m);
    if (rounded >= 1000) return '1B';
    return `${rounded}M`;
  }

  // B: >= 1,000,000,000
  const b = n / 1000000000;
  const rounded = b < 10 ? Math.round(b * 10) / 10 : Math.round(b);
  return `${rounded}B`;
}

/**
 * 格式化时长：毫秒。
 * @example formatDuration(0) => "0ms"
 * @example formatDuration(500) => "500ms"
 * @example formatDuration(2500) => "2.5s"
 * @example formatDuration(65000) => "1.1min"
 * @example formatDuration(null) => "—"
 */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms === 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) {
    const s = ms / 1000;
    const rounded = Math.round(s * 10) / 10;
    return rounded < 10 ? `${rounded.toFixed(1)}s` : `${Math.round(s)}s`;
  }
  const min = ms / 60000;
  const rounded = Math.round(min * 10) / 10;
  return rounded < 10 ? `${rounded.toFixed(1)}min` : `${Math.round(min)}min`;
}

/**
 * 格式化TPS：每秒tokens数。
 * @example formatTPS(0) => "0"
 * @example formatTPS(3.456) => "3.5"
 * @example formatTPS(12.8) => "13"
 * @example formatTPS(null) => "—"
 */
export function formatTPS(tps: number | null): string {
  if (tps === null) return '—';
  if (tps === 0) return '0';
  if (tps < 10) return (Math.round(tps * 10) / 10).toFixed(1);
  return Math.round(tps).toFixed(0);
}
