import { execFile } from 'node:child_process';
import path from 'node:path';
import { commonFileApplications, discoverFileApplications } from './file-application-discovery.mjs';

/** Only receives host-verified paths. Native launch arguments never pass through a shell. */
export function createLocalFileActions({ platform = process.platform, revealPath, openDirectory, chooseApplication,
  discoverApplications = target => discoverFileApplications(target, { platform }), getApplicationIcon = null, execFileFn = execFile } = {}) {
  const run = (command, args) => new Promise(resolve => {
    execFileFn(command, args, { timeout: 15000 }, error => resolve(error
      ? { ok: false, message: `打开文件失败：${error.message}` } : { ok: true }));
  });
  return {
    async listApplications(filePath) {
      try {
        const applications = commonFileApplications(filePath, await discoverApplications(filePath));
        return { ok: true, applications: await Promise.all(applications.map(async application => ({
          id: application.id, name: application.name, isDefault: application.isDefault,
          icon: getApplicationIcon ? await getApplicationIcon(application.path).catch(() => null) : null,
        }))) };
      } catch { return { ok: false, message: '暂时无法读取可用程序，请稍后重试', applications: [] }; }
    },
    async perform(intent, filePath, applicationId = null) {
    try {
      if (intent === 'reveal') { revealPath(filePath); return { ok: true }; }
      if (intent === 'directory') {
        const error = await openDirectory(path.dirname(filePath));
        return error ? { ok: false, message: `目录打开失败：${error}` } : { ok: true };
      }
      if (intent === 'application') {
        const application = (await discoverApplications(filePath)).find(item => item.id === applicationId);
        if (!application) return { ok: false, message: '这个程序已不可用，请重新打开菜单选择' };
        return run('/usr/bin/open', ['-a', application.path, '--', filePath]);
      }
      if (intent !== 'choose-app') return { ok: false, message: '不支持的文件操作' };
      if (platform === 'darwin') {
        const result = await chooseApplication();
        if (result.canceled || !result.filePaths?.[0]) return { ok: true, canceled: true };
        const application = result.filePaths[0];
        if (path.extname(application).toLowerCase() !== '.app') return { ok: false, message: '请选择一个应用程序' };
        return run('/usr/bin/open', ['-a', application, '--', filePath]);
      }
      if (platform === 'win32') return run('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', filePath]);
      return { ok: false, message: '当前系统暂不支持选择应用程序' };
    } catch (error) { return { ok: false, message: `文件操作失败：${error.message}` }; }
  } };
}
