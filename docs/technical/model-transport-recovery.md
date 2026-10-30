# 模型连接错误与发送阶段

2026-10-30（Asia/Shanghai）。桌面与 Bot 共用模型请求恢复器；GLM Coding Plan 的预检与推理仍经过同一受控 fetch 边界。

## 故障与行为

GLM 适配层曾把本地网络异常包装为 HTTP 503，而恢复分类遗漏 `EPIPE`。请求账本虽然留下了底层错误码，但最终判为 unknown、不可重试。路由预检的 HTTP 200 还可能残留到后续失败的推理请求，影响分类与超时阶段。

现在区分本地传输错误与上游 HTTP 响应：GLM 网络异常只传递受控错误消息和底层错误码，不包含原始异常正文或凭据，不再将有错误码的本地断线伪装为上游 503。恢复器识别 `EPIPE`、连接重置和 Undici socket 错误，并把发送状态写入故障记录。

恢复规则：

- 已观测到请求创建、尚未开始写 HTTP 头的连接故障，可以进入现有恢复/备用流程。
- DNS 失败、连接拒绝等明确发生在连接建立前的错误，未获得发送事件时也可以恢复。
- 已开始写入、已完成写入或发送状态未知，且未收到上游响应的推理请求，不自动重发。错误消息说明请求可能已经发送，用户可稍后继续。
- GLM 路由、签名握手等预检失败没有提交模型推理，允许恢复。预检不启动推理首输出计时，其独立取消与超时信号保留。
- 已收到响应的现有流恢复、真实 HTTP 错误、登录/额度/取消处理继续由原恢复规则负责。

`src/main/lib/model-transport.mjs` 使用 AsyncLocalStorage 和 Undici diagnostics channel 观测现有 fetch，不替换全局 dispatcher，不增加独立重试循环。各请求通过 WeakMap 关联，仅保存阶段，不保存请求头、正文或 socket 地址。发送头事件发布于写入前，因此对可能发送的情况采取保守判断。未提供诊断事件的自定义 fetch 保持 unknown。

参照项目 [zcode-api 的连接重试](https://github.com/TriDefender/zcode-api/blob/0e0968abe7385560e044a8f1ea6c1c536495edc0/src/proxy/handler.ts#L557-L589)及其[避免写出后重复提交的修复](https://github.com/TriDefender/zcode-api/commit/7dd6818fedecd208cd0cdb8e5a4c4bde7c28e485)，Hemi 独立实现发送阶段观测，继续使用既有代理与恢复器，没有引入该项目源码或手写 TCP 传输。

## 验证记录

基线提交 `de447c7f603b1e4cda00fa50a833cafe1b717532` 加本次未提交改动；macOS arm64，Node.js 22.22.3，Pi SDK 1.3.0；另使用当前依赖的 Electron 44 内置 Node 运行定向测试。

执行：

```sh
node --test src/main/lib/model-transport.test.mjs src/main/agent-runtime/model-failure.test.mjs src/main/agent-runtime/model-recovery.test.mjs src/main/agent-runtime/usage-ledger.test.mjs src/main/agent/model-recovery.test.mjs src/main/services/bigmodel-coding.test.mjs
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --test src/main/lib/model-transport.test.mjs src/main/agent-runtime/model-failure.test.mjs src/main/services/bigmodel-coding.test.mjs
HEMI_USER_DATA_DIR=<新的临时目录> npm test
git diff --check
```

定向测试 33 项通过；Electron 内置 Node 定向测试 20 项通过。覆盖 Node 内置 fetch 和已安装 Undici、并发请求隔离、真实 HTTP 连接拒绝、服务端收完请求后不返回响应就断开，以及生产 GLM Provider/SDK/恢复器/账本链路中的连接恢复、EPIPE 保真、预检成功后推理断线、签名预检恢复和错误脱敏。`EPIPE` 码使用定点故障注入；真实断开产生 `UND_ERR_SOCKET`，未将 mock 结果视为真实上游稳定性证明。

完整 `npm test` 通过：2161 项中 2140 项通过、21 项跳过、0 项失败；`git diff --check` 通过。日志保存在 `.visual/workflow/model-transport-recovery/`。验证未使用个人会话或模型账号，未更新已安装应用或生产 Bot；不涉及 IPC、渲染器或 UI 生命周期，未进行 Vite/构建渲染器或设备回归。
