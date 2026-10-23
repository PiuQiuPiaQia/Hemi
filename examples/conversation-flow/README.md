# 独立对话流示例

此目录不引用 `src/renderer` 或其他 Hemi 应用源码，不需要 `window.hemiVoice`、Bot、凭据或模型服务。演示的业务和文件来自内存，文件操作只显示宿主回执。

先在仓库根目录运行 `npm ci && npm run build:sdk`，再在本目录运行：

```sh
npm ci
npm run build
npm run dev
```

`dist/standalone.html` 内嵌脚本、样式、图标和图片，可直接用浏览器打开；无需启动任何服务。`npm run dev` 仅用于开发热更新。正式应用可改为导入 npm pack 的 tarball，替换 package.json 中的本地 file 依赖。

页面覆盖 Markdown、思考/工具、子任务、文件图片、工作流人工输入、错误重试、编辑、前插 150 条历史和定位表单。按钮只向模拟宿主发送请求；权威状态仍通过 props 更新。

移动原生接入：把构建的 standalone.html 打包到应用内，加载时加 `?native=1`。`native-entry.ts` 将 iOS messageHandlers 或 Android JavascriptInterface 接到相同 JSON 契约。`native/ios/ConversationFlowView.swift` 和 `native/android/ConversationFlowView.kt` 可放进现有原生工程；它们只声明复制和外部链接能力，文件分享/保存与 Bot 连接继续由实际应用接入。安全区、键盘避让、系统返回和前后台状态由壳负责。

这些代码为最小宿主示例，本次未在真机编译或验收。iOS 使用 [WKScriptMessageHandler](https://developer.apple.com/documentation/webkit/wkscriptmessagehandler)，Android 本地资源使用 [WebViewAssetLoader](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content)，桥接使用 [addJavascriptInterface](https://developer.android.com/reference/android/webkit/WebView#addJavascriptInterface(java.lang.Object,%20java.lang.String))。仅给受控的本地页面安装原生桥，业务服务不得信任页面传来的权限或路径。
