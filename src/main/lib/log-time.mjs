/**
 * 日志时间戳格式化：本地时区 + 日期（2026-09-29 会话审计：原实现用
 * toISOString().slice(11,23) 只有 UTC 时间没日期，比用户本地慢 8 小时，
 * 跨天取证不可行——三起「受理无响应」事故全卡在这）。纯函数可单测。
 */
export function formatLogTime(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}
