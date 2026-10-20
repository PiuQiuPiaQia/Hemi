import { ipcMain, shell } from 'electron';

import { IPC } from '../../shared/ipc-channels.mjs';
import { getPlatformService } from '../services/platform-instance.mjs';

/**
 * 043 起：麦克风状态从平台服务投影（platform-instance 同一探测），不再保留
 * 第二套平台分支——Windows 读真实隐私设置（unknown/denied 都不显示已授权，
 * AC-03 反例），mac 保留 TCC 弹窗流程。
 *
 * 测试缝隙（与 HEMI_SMOKE_TEST / HEMI_AEC_ENFORCE 同款约定）：dev 二进制缺
 * NSMicrophoneUsageDescription 时 TCC 弹窗不会出现（specs 024 AC-09 已知限制），
 * 真机 UI 验证无法过 setup 门。设 HEMI_TEST_MIC_GRANT=1 视麦克风已授权——
 * 只影响这两个查询，不碰真实采集链路（ASR 起会话仍走系统授权/失败路径）。
 * 该覆盖在 platform-instance 组装 deps 时注入 darwin 后端。
 */
export function registerPermissionsIpc() {
  const service = () => getPlatformService();

  ipcMain.handle(IPC.permissions.microphone, async () => {
    return service().requestMicrophoneAccess();
  });

  ipcMain.handle(IPC.permissions.microphoneStatus, () => {
    return service().microphoneStatus();
  });

  // 直达系统麦克风隐私设置：mac → 隐私面板；Windows → ms-settings URI。
  // 打开设置≠已授权，返回后由渲染层重新探测（setup 流程已有轮询）。
  ipcMain.handle(IPC.permissions.openMicSettings, async () => {
    if (process.platform === 'win32') {
      await shell.openExternal('ms-settings:privacy-microphone');
    } else {
      await shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
      );
    }
    return true;
  });
}
