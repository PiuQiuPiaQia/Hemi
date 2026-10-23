import {
  createNativeHost,
  type NativeResponse,
  type NativeRequest,
} from "@hemi/conversation-flow/native-host";

declare global {
  interface Window {
    webkit?: {
      messageHandlers: {
        conversationFlow?: { postMessage: (request: NativeRequest) => void };
      };
    };
    HemiNative?: { postMessage: (json: string) => void };
    hemiNativeReceive?: (response: NativeResponse) => void;
  }
}
export function connectNative() {
  const listeners = new Set<(response: NativeResponse) => void>();
  window.hemiNativeReceive = (response) => {
    for (const listener of listeners) listener(response);
  };
  return createNativeHost({
    capabilities: {
      copyText: true,
      openLink: true,
      resolveResource: false,
      readResource: false,
      resourceActions: false,
    },
    transport: {
      send(request) {
        if (window.webkit?.messageHandlers.conversationFlow)
          window.webkit.messageHandlers.conversationFlow.postMessage(request);
        else if (window.HemiNative)
          window.HemiNative.postMessage(JSON.stringify(request));
        else throw new Error("Native bridge is unavailable");
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  });
}
