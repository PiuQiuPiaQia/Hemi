import { Capacitor } from '@capacitor/core';
import { Clipboard } from '@capacitor/clipboard';
import { Browser } from '@capacitor/browser';
import { createWebHost } from '@hemi/conversation-flow/web-host';
import type { ConversationFlowHost, FlowResult } from '@hemi/conversation-flow';

const cancelled: FlowResult<void> = {
  ok: false, error: { code: 'cancelled', message: '操作已取消' },
};

/** This is the mobile host boundary; the shared UI never imports Capacitor. */
export function createMobileHost(): ConversationFlowHost {
  return createWebHost({
    copyText: Capacitor.isNativePlatform() ? async ({ text }, { signal }) => {
      if (signal.aborted) return cancelled;
      try {
        await Clipboard.write({ string: text });
        return { ok: true, value: undefined };
      } catch {
        return { ok: false, error: { code: 'denied', message: '未能写入剪贴板，请重试' } };
      }
    } : undefined,
    async openLink({ url }, { signal }) {
      if (signal.aborted) return cancelled;
      let target: URL;
      try { target = new URL(url); }
      catch { return { ok: false, error: { code: 'denied', message: '链接地址无效' } }; }
      if (!['https:', 'http:'].includes(target.protocol)) {
        return { ok: false, error: { code: 'denied', message: '仅支持打开网页链接' } };
      }
      try {
        if (Capacitor.isNativePlatform()) await Browser.open({ url: target.href });
        else {
          const opened = window.open('about:blank', '_blank');
          if (!opened) return { ok: false, error: { code: 'denied', message: '浏览器已阻止打开链接' } };
          opened.opener = null;
          opened.location.href = target.href;
        }
        return { ok: true, value: undefined };
      } catch {
        return { ok: false, error: { code: 'failed', message: '未能打开链接，请重试' } };
      }
    },
    // File capabilities stay unavailable until a Bot resource adapter is wired.
  });
}
