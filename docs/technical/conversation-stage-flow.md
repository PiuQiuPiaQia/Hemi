# 以 text 划分的对话阶段

正文继续使用现有 `text` part，不增加「阶段发现」协议，也不判断某段正文是否为最终答复。
模型在工具之间输出的说明直接作为阶段内容展示；没有中途正文时，界面也不生成额外总结。

`TurnParts` 调用 `buildTurnDisplayBlocks`，将相邻的思考和普通工具投影成一个默认收起的过程组。
每个正文段、子任务、工作流卡或文件交付入口都会划开过程组；它们仍占据原来位置。
同一个工具 part 中，子任务前后的普通工具也分别成组。展开详情时，思考和工具按原始顺序显示。
这层分组只影响 UI，不修改 flow、存储记录或模型上下文。

过程组收起时显示操作摘要、操作次数和失败／停止数量。文件路径在活动行中收为文件名，
悬停保留路径描述；命令维持单行省略。思考仅通过组内的思考详情展开，不在收起的过程组中滚动预览。
工具状态以调用状态为准；思考的动态状态仅属于当前流式尾段。

组身份来自首个原始 part／调用的稳定身份，后续追加内容和收到新正文时保持不变。
展开状态由现有 `TranscriptRowState` 保存，虚拟列表卸载再挂载也能恢复；旧记录缺少 partId 时使用
现有段类型和索引。无 parts 的旧档仍使用原来的兼容展示。

## 验证

针对性测试：

```sh
node --test src/renderer/src/windows/voice/lib/turn-display-blocks.test.mjs src/renderer/src/windows/voice/lib/flow-timeline-view.test.mjs src/main/services/flow-parts-projection.test.mjs src/shared/turn-parts.test.mjs
npm run build
node scripts/check-spacing.mjs
VITE_DEV_SERVER_URL=http://127.0.0.1:5191 node scripts/verify-turn-stage-flow.mjs
node scripts/verify-turn-stage-flow.mjs
```

最后两条分别覆盖 Vite 开发渲染器与构建渲染器。脚本创建独立 `HEMI_USER_DATA_DIR`，仅将外部模型
替换为本机可控 provider，经生产 IPC/Pi SDK 执行真实文件读取、Shell 命令和读取失败，再检查
阶段顺序、键盘展开、流式追加、重载、停止、150 条历史的虚拟列表卸载恢复，以及 375/768/1440 布局。
退出时关闭应用、provider 并删除临时数据。

每次运行的 commit、Node/平台、renderer URL、检查结果和截图记录于
`.visual/workflow/vision/turn-stage-flow/{dev,built}/report.json`。
当前外观仅支持浅色，深色系统偏好验证仍采用浅色外观；没有创建独立深色主题。
可控 provider 验证传递和展示，不证明真实模型输出进度说明的频率；本次不调整提示词。
