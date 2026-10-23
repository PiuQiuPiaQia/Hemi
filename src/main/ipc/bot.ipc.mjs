import { app, ipcMain, BrowserWindow, dialog } from 'electron';
import fs from 'node:fs/promises';
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
let service = null;
export const getBotService = () => service;
export function registerBotIpc() {
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
