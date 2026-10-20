/**
 * 017 环境块：模型对「现在」的全部认知都来自这里。
 *
 * 2026-09-20 真机教训：全链路没有任何地方注入日期，主脑模型把「今年的亚运会」
 * 答成了「下一届定于 2026 年举行」——模型自身的时间记忆不可信，必须显式给定。
 *
 * 定位取舍：零感知——位置这类用户事实只来自用户
 * 明说（经长期记忆延续），不做任何环境定位；本模块因此只装日期时间。
 * 纯函数、时钟与时区可注入，离线可测；不 import Electron。
 */

const WEEKDAY_OPTIONS = {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  weekday: 'long',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
};

/** formatter 按时区缓存（构造有成本；时区集合极小）。 */
const formatterCache = new Map();

function formatterFor(timeZone) {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('zh-CN', { ...WEEKDAY_OPTIONS, timeZone });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** IANA 时区 → UTC 偏移标签（如 Asia/Shanghai → UTC+08:00）。 */
function zoneOffsetLabel(now, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(now);
    const raw = parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
    return raw.replace(/^GMT/, 'UTC') || 'UTC+00:00';
  } catch {
    return 'UTC+00:00';
  }
}

/**
 * 环境块（单行）：「【环境】今天是2026年9月20日，星期日（Asia/Shanghai，UTC+08:00），现在 19:32。」
 * 时区缺省用宿主本地；now/timeZone 均可注入以便测试。
 * 时间格式化失败（如非法时区）返回空串——宁可不带，不给模型错误时间。
 */
export function buildAmbientBlock({ now = new Date(), timeZone } = {}) {
  const zone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  let parts;
  try {
    parts = Object.fromEntries(
      formatterFor(zone).formatToParts(now).map((part) => [part.type, part.value]),
    );
  } catch {
    return '';
  }
  // zh-CN 的 day 分片带「日」后缀（'20日'）、month 是裸数字（'9'）——数字面自拼。
  const day = String(parts.day).replace(/\D/g, '') || parts.day;
  const offset = zoneOffsetLabel(now, zone);
  return `【环境】今天是${parts.year}年${parts.month}月${day}日，${parts.weekday}（${zone}，${offset}），现在 ${parts.hour}:${parts.minute}。`;
}
