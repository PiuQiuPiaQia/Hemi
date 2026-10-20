import { shell } from 'electron';

import { isOpenableContentLink } from './content-link.mjs';

// 允许用系统浏览器打开的外部站点（渲染进程只能请求这些域名的链接）。
const EXTERNAL_LINK_HOSTS = new Set([
  'console.volcengine.com',
  'www.volcengine.com',
  // 037 模型页「去 X 获取 Key」：各家预设的 Key 管理页（provider-presets.ts 的 keyUrl）
  'platform.deepseek.com',
  'bailian.console.aliyun.com',
  'platform.moonshot.cn',
  'open.bigmodel.cn',
  'platform.openai.com',
  'openrouter.ai',
  // 044「关于与更新」的「去发布页看」＋ 034 技能市场的 GitHub 链接（仓库/固定提交树）。
  'github.com',
  // web 检索设置页「去 Tavily 获取 Key」；技能市场详情的 SkillsMP 页面。
  'app.tavily.com',
  'skillsmp.com',
]);

/**
 * Opens a URL in the user's default browser. Only https links on a small
 * allowlist of vendor sites are accepted, everything else is silently dropped
 * so a compromised renderer cannot hand arbitrary URLs to the OS.
 */
export async function openExternalIfAllowed(url) {
  if (typeof url !== 'string' || !url) return false;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:' || !EXTERNAL_LINK_HOSTS.has(parsed.hostname)) {
    return false;
  }

  await shell.openExternal(parsed.toString());
  return true;
}

export async function openContentLink(url) {
  if (!isOpenableContentLink(url)) return false;
  await shell.openExternal(new URL(url).toString());
  return true;
}
