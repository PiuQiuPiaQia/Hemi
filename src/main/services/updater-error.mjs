/** electron-updater 的 URL、响应头和堆栈只进日志，IPC 与界面只传简短说明。 */
export function formatUpdateError(error, operation = '检查更新') {
  const code = String(error?.code ?? '');
  const message = String(error?.message ?? error ?? '');
  // 只检查错误首行，避免把响应头、响应体或 URL 中的数字误当成 HTTP 状态。
  const firstLine = message.split(/\r?\n/, 1)[0];
  const status = error?.statusCode ?? /^\s*(\d{3})\b/.exec(firstLine)?.[1];
  const detail = `${code} ${firstLine}`;
  let reason;
  if (/ENOSPC/.test(detail)) {
    reason = '磁盘空间不足，请清理后重试。';
  } else if (/EACCES|EPERM/.test(detail)) {
    reason = '没有写入权限，请从发布页下载安装。';
  } else if (/ERR_(?:UPDATER_)?CHECKSUM_MISMATCH|sha512 checksum mismatch|sha2 checksum mismatch/i.test(detail)) {
    reason = '安装包校验失败，请重新下载。';
  } else if (Number(status) === 429 || /rate limit exceeded/i.test(message)) {
    reason = '请求过于频繁，请稍后重试。';
  } else if (Number(status) === 403 || Number(status) >= 500) {
    reason = '更新服务暂时不可用，请稍后重试。';
  } else if (Number(status) === 404 || /ERR_UPDATER_CHANNEL_FILE_NOT_FOUND|ERR_UPDATER_NO_FILES_PROVIDED|ERR_UPDATER_INVALID_UPDATE_INFO|ERR_UPDATER_ASSET_NOT_FOUND/.test(code)) {
    reason = '更新文件暂不可用，请稍后重试或前往发布页下载。';
  } else if (/ERR_(?:NETWORK|INTERNET|CONNECTION|NAME_NOT_RESOLVED|PROXY|TUNNEL|TIMED_OUT)|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed/i.test(detail)) {
    reason = '网络连接失败，请检查网络或代理后重试。';
  } else {
    reason = '请稍后重试或前往发布页下载。';
  }
  return `${operation}失败：${reason}`;
}
