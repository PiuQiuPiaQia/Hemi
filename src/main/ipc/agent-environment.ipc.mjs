import { app, ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels.mjs';
import { agentEnvironmentPaths } from '../agent-runtime/process-environment.mjs';
import { listRuntimeFiles, readRuntimeFile } from '../services/runtime-files.mjs';
export function registerAgentEnvironmentIpc() {
  const paths = agentEnvironmentPaths(app.getPath('userData'));
  ipcMain.handle(IPC.agentEnvironment.inspect, async () => {
    return {
      owner: '此桌面', memoryDir: paths.memoryDir,
      files: await listRuntimeFiles(paths.memoryDir),
      summaryUsageIncluded: false,
    };
  });
  ipcMain.handle(IPC.agentEnvironment.readFile, (_event, payload) => readRuntimeFile(paths.memoryDir, payload?.path));
}
