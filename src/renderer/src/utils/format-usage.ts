/**
 * 使用记录数字格式化工具：中文单位（万/亿），舍入后升级，避免10000万。
 */

/**
 * 格式化数字：tokens、计数等，采用中文单位。
 * 万到亿之间只用「万」；舍入后升级单位，避免10000万。
 * @example formatNumber(999) => "999"
 * @example formatNumber(9999.9) => "1万"
 * @example formatNumber(15000) => "1.5万"
 * @example formatNumber(999999) => "100万"
 * @example formatNumber(1500000) => "150万"
 * @example formatNumber(99999999) => "1亿"
 * @example formatNumber(999999999) => "10亿"
 * @example formatNumber(null) => "—"
 * @example formatNumber(0) => "0"
 */
export function formatNumber(n: number | null): string {
  if (n === null) return '—';
  if (n === 0) return '0';

  // 小于一万直接显示
  if (n < 10000) return Math.round(n) >= 10000 ? '1万' : Math.round(n).toLocaleString();

  // 万: 10,000 - 99,999,999
  if (n < 100000000) {
    const w = n / 10000;
    const rounded = w < 10 ? Math.round(w * 10) / 10 : Math.round(w);
    // 9999.995万舍入后变成10000万，应升级为1亿
    if (rounded >= 10000) return '1亿';
    return `${rounded}万`;
  }

  // 亿: >= 100,000,000
  const b = n / 100000000;
  const rounded = b < 10 ? Math.round(b * 10) / 10 : Math.round(b);
  return `${rounded}亿`;
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
