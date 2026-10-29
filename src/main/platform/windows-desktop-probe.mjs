/** 本地 Windows App 与工具共用驱动及安装目录；探测不发送输入。 */
export function createWindowsDesktopProbes({ apps, cua, report = () => {} }) {
  return {
    async desktop() {
      try {
        report('desktop: session probe started');
        const status = await apps.status({ refresh: true });
        report(`desktop: session probe complete (${status.sessionId}, connected=${status.sessionConnected}, input=${status.inputDesktopAccessible})`);
        if (!status.available || !status.sessionConnected || !status.inputDesktopAccessible) return { state: 'blocked', reason: 'desktop-session-unavailable', supported: true, actions: ['recheck'] };
        // 枚举经同一个 cua 实例，原生库加载失败不能误报 ready。
        await cua.listAppWindows();
        report('desktop: driver probe complete');
        return { state: 'ready', supported: true, actions: ['recheck'] };
      } catch (error) {
        report(`desktop: ${error.message}`);
        return { state: 'error', reason: 'driver-load-failed', supported: true, actions: ['recheck'] };
      }
    },
    async appCatalog() {
      try {
        report('appCatalog: probe started');
        await apps.list();
        report('appCatalog: probe complete');
        return { state: 'ready', supported: true, actions: ['recheck'] };
      } catch {
        return { state: 'error', reason: 'app-catalog-unavailable', supported: true, actions: ['recheck'] };
      }
    },
  };
}
