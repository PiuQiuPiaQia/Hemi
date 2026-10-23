import SwiftUI
import WebKit
import UIKit

// Add dist/standalone.html to the app bundle as conversation-flow.html.
struct ConversationFlowView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.userContentController.add(context.coordinator, name: "conversationFlow")
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        if let file = Bundle.main.url(forResource: "conversation-flow", withExtension: "html"),
           let url = URL(string: file.absoluteString + "?native=1") {
            view.loadFileURL(url, allowingReadAccessTo: file.deletingLastPathComponent())
        }
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) {}
    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: "conversationFlow")
        view.stopLoading()
    }
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        func webView(_ view: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            decisionHandler(action.request.url?.isFileURL == true ? .allow : .cancel)
        }
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.frameInfo.isMainFrame, message.webView?.url?.isFileURL == true,
                  let request = message.body as? [String: Any], request["version"] as? Int == 1,
                  let method = request["method"] as? String, let requestID = request["requestId"] as? String,
                  let scope = request["scope"] as? [String: Any] else { return }
            let payload = request["payload"] as? [String: Any] ?? [:]
            let reply: ([String: Any]) -> Void = { result in
                let response: [String: Any] = ["version": 1, "scope": scope, "requestId": requestID, "result": result]
                guard let data = try? JSONSerialization.data(withJSONObject: response), let json = String(data: data, encoding: .utf8) else { return }
                message.webView?.evaluateJavaScript("window.hemiNativeReceive?.(\(json))", completionHandler: nil)
            }
            if method == "copyText", let text = payload["text"] as? String {
                UIPasteboard.general.string = text
                reply(["ok": true, "value": NSNull()])
            } else if method == "openLink", let text = payload["url"] as? String,
                      let url = URL(string: text), ["https", "http"].contains(url.scheme?.lowercased() ?? "") {
                UIApplication.shared.open(url, options: [:]) { opened in
                    reply(opened ? ["ok": true, "value": NSNull()] : ["ok": false, "error": ["code": "failed", "message": "链接打不开"]])
                }
            } else if method != "cancel" && method != "resources.release" {
                reply(["ok": false, "error": ["code": "unsupported", "message": "当前原生示例未提供此能力"]])
            }
        }
    }
}
