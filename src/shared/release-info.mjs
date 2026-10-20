/**
 * 044 · 发布与更新：产物托管位置的唯一事实来源。
 * 主进程 update-bridge（拉清单/资产）与设置页「关于与更新」（更新内容链接）
 * 共用；改仓库名时只动这里。
 */
export const UPDATE_OWNER = 'PiuQiuPiaQia';
export const UPDATE_REPO = 'Hemi';

/** 用户浏览器里打开发布页（浏览器带登录态，私有仓可达）。 */
export const RELEASES_PAGE_URL = `https://github.com/${UPDATE_OWNER}/${UPDATE_REPO}/releases`;
