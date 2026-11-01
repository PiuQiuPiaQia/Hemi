import { app, ipcMain, BrowserWindow, dialog, shell } from 'electron';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBotDesktopService } from '../bot/desktop-service.mjs';
import { createSshRunner } from '../remote/ssh-runner.mjs';
import { getRemoteService } from '../remote/remote-service.mjs';
import { getProfiles } from '../lib/profiles-holder.mjs';
import { errorView } from '../bot/storage.mjs';
import { randomUUID } from 'node:crypto';
import { state } from '../state.mjs';
import { stopDuplexHost } from './audio.ipc.mjs';
import { stopAsrForBot } from './asr.ipc.mjs';
import { publishUiState } from './ui.ipc.mjs';
import { closeActiveTtsPlayback } from './tts.ipc.mjs';
import { readSkillDirectory } from '../skills/skill-store.mjs';
import { createLocalSkillScanner } from '../skills/local-agent-skills.mjs';
import { getWorkspaceService } from './workspace.ipc.mjs';
let service = null;
export const getBotService = () => service;

/** Bot 设置页的本地 agent 技能扫描/批量导入：扫描与读文件都在本机（与
 *  skills.import-local 的「本机选目录→读文件→远传」同一信任边界），仍走
 *  skills.import 把文件传给 Bot 主机，Bot 主机侧无需新方法。 */
function localWorkspaceDirs() {
  const workspaceService = getWorkspaceService();
  if (!workspaceService) return [];
  const workspaceState = workspaceService.getState();
  return [workspaceState.default, ...workspaceState.projects]
    .filter((view) => view && !view.host && view.status === 'ok' && typeof view.dir === 'string')
    .map((view) => ({ dir: view.dir, name: view.name }));
}

export function registerBotIpc({onConversationResult=()=>{}}={}) {
  const remote = getRemoteService(),
    archivePath = path.join(app.getAppPath(), 'build/hemi-bot-runtime.tgz');
  const runner = createSshRunner({
    controlDir: path.join(app.getPath('userData'), 'bot/ssh'),
    sshBin: process.env.HEMI_SSH_BIN || 'ssh',
    strictHostKeyChecking: true,
    passwordProvider: remote.passwordForHost,
  });
  service = createBotDesktopService({
    userDataDir: app.getPath('userData'),
    runner: { ...runner, rememberPassword: remote.rememberPassword },
    profiles: getProfiles(),
    archivePath,
    autoComponentUpdates: process.env.HEMI_BOT_AUTO_UPDATE !== '0',
    openExternal: url => shell.openExternal(url),
    ensureArchive: async () => {
      if (app.isPackaged) {
        await fs.access(archivePath);
        return;
      }
      const { buildBotRuntime } = await import(
        '../../../scripts/build-bot-runtime.mjs'
      );
      await buildBotRuntime({ root: app.getAppPath(), output: archivePath });
    },
    onConversationResult,
    onChanged: (value) => {
      for (const win of [state.mainWindow])
        if (win && !win.isDestroyed())
          win.webContents.send('bot:changed', value);
    },
  });
  const mainOnly = (event) => {
    if (!state.mainWindow || event.sender !== state.mainWindow.webContents)
      throw new Error('Bot 仅允许主窗口操作');
  };
  // Bot 设置页的扫描/批量导入网关：installed 名单来自 Bot 主机技能库（metadata 同名命中），
  // 导入＝本机 readSkillDirectory 校验读文件 + skills.import 远传（远端不接触本机路径）。
  const botLocalSkillScanner = createLocalSkillScanner({
    home: () => os.homedir(),
    listWorkspaceDirs: localWorkspaceDirs,
    getInstalled: async () => {
      const identity = service.getState().binding?.instanceId;
      if (!identity) return [];
      const hostState = await service.command('skills.state');
      return Array.isArray(hostState?.installed) ? hostState.installed : [];
    },
    importOne: async (dir) => service.command('skills.import', { files: await readSkillDirectory(dir) }),
  });
  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (event, payload) => {
      mainOnly(event);
      try {
        return { ok: true, result: await fn(payload ?? {}, event) };
      } catch (error) {
        return errorView(error);
      }
    });
  handle('bot:state', () => service.getState());
  handle('bot:connect', (p) => service.connect(p));
  handle('bot:initialize', (p) => service.initialize(p));
  handle('bot:models', () => service.modelCandidates());
  handle('bot:directory', (p) =>
    service.candidatesDirectory(p.candidateId, p.path),
  );
  handle('bot:command', async (p) => {
    const requireBoundIdentity = () => {
      const identity = service.getState().binding?.instanceId;
      if (!identity || p.params?.expectedInstanceId !== identity) throw new Error('Bot 连接已变化，请重新打开技能中心。');
      return identity;
    };
    if (p.method === 'skills.scan-local') {
      requireBoundIdentity();
      return botLocalSkillScanner.scan();
    }
    if (p.method === 'skills.import-local-batch') {
      requireBoundIdentity();
      if (p.params?.mode != null && p.params.mode !== 'copy') throw Object.assign(new Error('Bot 跨机器导入仅支持复制文件，不支持本机软链接'), { code: 'unsupported' });
      return botLocalSkillScanner.import(Array.isArray(p.params?.paths) ? p.params.paths.map(String) : [], { mode: 'copy' });
    }
    if (p.method === 'skills.import-local') {
      requireBoundIdentity();
      if (p.params?.mode != null && p.params.mode !== 'copy') throw Object.assign(new Error('Bot 跨机器导入仅支持复制文件，不支持本机软链接'), { code: 'unsupported' });
      const picked = await dialog.showOpenDialog(state.mainWindow, {title: '选择要导入 Bot 的技能文件夹', properties: ['openDirectory']});
      if (picked.canceled || !picked.filePaths?.length) return {ok: true, cancelled: true};
      const files = await readSkillDirectory(picked.filePaths[0]).catch(error => {
        throw Object.assign(new Error(`Bot 复制导入失败：${error.message}`), { code: 'invalid' });
      });
      return service.command('skills.import', { ...(p.params?.id ? { id: p.params.id } : {}), files });
    }
    if (p.method !== 'diagnostics.export')
      return service.command(p.method, p.params);
    const local = service.getState(),
      cloud = local.online ? await service.command('diagnostics') : null;
    const report = {
      exportedAt: new Date().toISOString(),
      desktopVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      protocol: local.binding?.protocol,
      componentVersion: local.binding?.version,
      online: local.online,
      lastConnectedAt: local.lastConnectedAt,
      stage: local.busy || null,
      cloud,
      diagnostics: service.diagnostics(),
    };
    const choice = await dialog.showSaveDialog(state.mainWindow, {
      defaultPath: 'hemi-bot-diagnostics.json',
      filters: [{ name: '诊断信息', extensions: ['json'] }],
    });
    if (choice.canceled || !choice.filePath) return { cancelled: true };
    await fs.writeFile(choice.filePath, JSON.stringify(report, null, 2), {
      mode: 0o600,
    });
    return { ok: true };
  });
  handle('bot:upload', async (p) => {
    if (p.dataUrl) {
      const match =
        /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(
          String(p.dataUrl),
        );
      if (!match)
        throw Object.assign(new Error('粘贴图片格式不支持。'), {
          code: 'invalid',
        });
      const result = await service.upload({
        id: p.id,
        name: '粘贴的图片.' + (match[1] === 'jpeg' ? 'jpg' : match[1]),
        bytes: Buffer.from(match[2], 'base64'),
        source: 'paste',
        requestId: p.requestId,
      });
      return { attachments: [result.attachment] };
    }
    let files = p.filePath ? [p.filePath] : null;
    if (!files) {
      const choice = await dialog.showOpenDialog(state.mainWindow, {
        properties: ['openFile', 'multiSelections'],
        filters: [
          {
            name: '消息附件',
            extensions: [
              'txt',
              'md',
              'markdown',
              'png',
              'jpg',
              'jpeg',
              'webp',
              'gif',
              'pdf',
              'docx',
              'xlsx',
              'pptx',
            ],
          },
        ],
      });
      if (choice.canceled) return { cancelled: true, attachments: [] };
      files = choice.filePaths;
    }
    const base = p.requestId ?? 'upload-' + randomUUID();
    let index = 0;
    const attachments = [];
    for (const file of files.slice(0, 3)) {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 20 * 1024 * 1024)
        throw Object.assign(new Error('附件超过 20 MB 或不是文件。'), {
          code: 'invalid',
        });
      const result = await service.upload({
        id: p.id,
        name: path.basename(file),
        bytes: await fs.readFile(file),
        source: p.filePath ? 'drop' : 'picker',
        requestId: base + '-' + index++,
        baseRequestId: base,
      });
      attachments.push(result.attachment);
    }
    return { attachments };
  });
  handle('bot:download', async (p) => {
    const file = await service.download(p.id, p.artifactId);
    const choice = await dialog.showSaveDialog(state.mainWindow, {
      defaultPath: path.basename(file.name),
    });
    if (choice.canceled || !choice.filePath)
      return { ok: false, cancelled: true };
    await fs.writeFile(choice.filePath, Buffer.from(file.base64, 'base64'));
    return { ok: true, path: choice.filePath };
  });
  handle('bot:environment', async (p) => {
    const next = p.environment === 'bot' ? 'bot' : 'local';
    state.conversationEnvironment = next;
    if (next === 'bot') {
      // Returning to Bot refreshes its connection immediately; it never starts
      // an explicitly stopped Bot or overrides an intentional disconnect.
      void service.refresh();
      closeActiveTtsPlayback();
      await stopAsrForBot();
      await stopDuplexHost();
      publishUiState({
        sessionState: 'idle',
        isSpeaking: false,
        interimText: '',
        recentLines: [],
        errorText: '',
        turnPhase: 'idle',
        elapsedSeconds: 0,
        callActive: false,
        callMuted: false,
        ttsActive: false,
        thinkingSince: null,
      });
    }
    return { environment: next };
  });
}
