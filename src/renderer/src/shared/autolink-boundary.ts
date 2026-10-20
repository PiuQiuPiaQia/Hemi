/**
 * 自动链接的全角标点边界（2026-10-10 会话审查 P1，2026-10-11 审计 A2）：
 * 中文句子里裸 URL 后面紧跟「）」等收尾标点时，GFM 自动链接会把标点一并吞进
 * 目标——真实预览里出现过 https://kie.ai/zh-CN%EF%BC%89（尾巴是中文右括号）。
 * 只修「显示文本就是网址本身」的自动链接：文本尾部是全角收尾标点、且 href 解码
 * 后带着同一段尾巴时，两边同步剥掉；显式 [文字](url) 链接尊重作者写法，一律不动。
 * 纯函数、不依赖 React/Electron，node --test 直接测。
 */

const TRAILING_PUNCT = '）」』】〕〉》”’！？，、。；：…';

function stripTrailingPunct(value: string): { core: string; cut: string } {
  let end = value.length;
  while (end > 0 && TRAILING_PUNCT.includes(value[end - 1])) end -= 1;
  return { core: value.slice(0, end), cut: value.slice(end) };
}

export function boundAutolink(href: string, text: string): { href: string; text: string } {
  if (!href || !text) return { href, text };
  let decoded = href;
  try {
    decoded = decodeURIComponent(href);
  } catch {
    /* 非 percent-encoded，按原文处理 */
  }
  const fromText = stripTrailingPunct(text);
  if (!fromText.cut) return { href, text }; // 文本不带尾部标点＝显式链接，照原样
  const fromHref = stripTrailingPunct(decoded);
  if (!fromHref.cut) return { href, text }; // href 没有同款尾巴，不一致不动
  // 自动链接判定：剥掉尾巴后两者相等，或 href 是补了协议前缀的同一网址（www 变体）。
  if (fromText.core !== fromHref.core && !fromHref.core.endsWith(fromText.core)) {
    return { href, text };
  }
  return { href: fromHref.core, text: fromText.core };
}
