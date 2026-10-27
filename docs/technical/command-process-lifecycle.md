# 命令退出、取消与交接

2026-10-27 修复，基线提交 `67fb7a70849a4bb11cebf59a709118b57c1932cb` 加当前未提交工作区。修复验收阶段未更新生产 Bot；同日经用户明确授权完成的生产更新见文末。没有提交、推送或发布桌面版本，既有移动端改动保留。

## 问题与行为

旧 Windows 实现只在 Node 子进程的 `close` 事件完成命令。启动器退出后，`Start-Process` 子孙或遗留输出句柄可以继续存活；取消又等待同一个命令 Promise，导致会话永久停在 `stopping`，排队输入无法交接。实机隔离基线在 15 秒内没有终态；修复后的同形命令通过。

现在 `exit`、启动失败、取消和硬超时均进入一次性收口，输出 EOF 不再决定命令是否结束。清理最多等待 8 秒，之后再给输出管道 250 毫秒排空；登记与命令结果持久化各有 10 秒期限，命令作用域的取消屏障为 20 秒。会话层保留 8 秒 SDK abort 宽限；dispose 也释放外层 prompt 等待，不再被不响应取消的工具拖住。初始化和 settle 的计时器会在成功后撤销。

无法证明清理完成或持久化状态不明时，返回 `cleanup-unconfirmed`：运行以失败关闭、队列暂停，撤销旧交接的提升标记，已受理的回卷替换保留为待核对项。旧运行的迟到事实被身份检查丢弃；不会把不明状态写成停止成功。该运行时的后续副作用被隔离，重启也不会自动清除持久化的未知归属。

## Windows 守卫

`windows-command-job.cs` 是本项目 MIT 源码，调用系统 Job API。启动器收到宿主持久登记后的 `start` 才能创建命令；通过 `STARTUPINFOEX / PROC_THREAD_ATTRIBUTE_JOB_LIST` 在创建时加入随机命名的 Job，随后恢复线程。Job 不允许 breakaway，并启用 `KILL_ON_JOB_CLOSE`。正常退出或取消均终止 Job，再查询 `ActiveProcesses == 0`；守卫死亡也由内核回收成员。恢复按随机 Job 名查找，不向可复用的父 PID 猜测发信号。`Global` 命名空间支持后续登录会话查找。

实现依据：[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)、[进程创建属性及 JOB_LIST](https://learn.microsoft.com/en-us/windows/desktop/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)。JOB_LIST 要求 Windows 10 或 Windows Server 2016 及以后；此组件仅提供 Windows x64 版本，使用系统 .NET Framework 4 运行时。

源码、预编译的 `windows-command-job.exe` 和 `windows-command-job.json` 一起分发。Bot 和桌面只校验、解出并运行程序，不在目标机调用编译器、安装 SDK 或下载原生依赖。校验覆盖规范化换行的源码 SHA-256 与程序 SHA-256；打包前和解出前都核对，源码改了而程序未重建时拒绝打包。

开发者修改守卫后，在 Windows 构建环境运行：

```sh
node scripts/build-windows-command-job.mjs
```

将更新后的 `.cs`、`.exe`、`.json` 一起审查和保存。这个开发步骤使用 Windows 自带 .NET Framework `csc.exe`，无需另装 Visual Studio 或 .NET SDK；部署后的执行路径没有编译步骤。没有增加第三方二进制或 npm 依赖。

旧版 Windows 记录没有 Job 归属。无论父 PID 是否仍在，自动恢复都不能证明脱离启动器的子孙已退出，因此不会调用 `taskkill /T` 猜测清理，而是保留未知记录并阻止恢复执行，等待人工核对。新 Job 记录可以按 Job 身份回收。POSIX 沿用独立进程组；组已空但输出仍被组外进程持有时同样报告清理未确认。

命令的子孙属于当前目标，`Start-Process`、detached 或 `&` 不再意味着永久后台服务。长期服务应单独交给已授权的系统服务或计划任务管理；对话命令只做有界启动回执和就绪检查。

## 验证

环境：macOS 26.5.1 arm64、Node 22.22.3；Windows Server 2025 Datacenter x64（10.0.26100）、Node 22.22.3；Linux 为无网络 Docker `node:22.22.3-bookworm`，仓库只读挂载。桌面集成为 Electron 44.0.0（内置 Node 24.18.1）。所有数据目录均为隔离临时目录，只模拟本地模型回复，不使用真实模型凭据。

- `HEMI_USER_DATA_DIR=<fresh-temp> npm test`：1882 项，1870 通过、0 失败、12 跳过。
- Linux 命令、后台会话、主 agent、归属恢复、Host、队列和组件打包定向回归：62 项，61 通过、0 失败、1 项 Windows 专属跳过。命令清单见下方证据报告。
- `node scripts/verify-command-lifecycle-windows.mjs`：8 项实际命令生命周期测试、2 项既有嵌套引号与登记门禁回归通过；实际 Host / Pi SDK 正常结束及停止交接 2 项通过，2 项 POSIX 专属跳过；从实际 Bot tgz 解出的守卫成功执行。覆盖启动器退出、取消、超时、登记失败/迟到、后台状态保存超时、守卫死亡、过期 PID 不误杀另一个 Job、原 PID 丢失后的 Job 恢复，以及旧版归属不明确时保留现存进程。目标机 `dotnet.exe` 和 `csc.exe` 均不在 PATH；部署执行路径不依赖它们。
- `node scripts/verify-command-lifecycle-desktop.mjs`：Vite 开发和构建 renderer 均经真实 preload / IPC / SDK / OS 命令验证正常结束、停止后派发一次，以及逃逸输出持有者失败后关闭停止态、暂停队列并保留输入；两种模式各 3 条路径通过，renderer 无运行错误。
- `npm run build`、`node scripts/check-spacing.mjs`、`git diff --check` 和新增脚本语法检查通过。构建保留既有 chunk 大小警告。组件包包含守卫的源码、程序、清单，旧 `windows-command-entry.mjs` 已移除；缺少或损坏守卫时的拒绝打包由测试覆盖。

证据位于忽略目录 `.visual/workflow/command-lifecycle/`：`report.json` 汇总修复验收时的测试命令、源码哈希及组件版本；`windows-report.json`、`desktop-report.json` 是实机与桌面结果，`full-test.log` / `linux.log` 是完整计数，`windows-baseline.log` 是旧版失败复现。`build/hemi-bot-runtime.tgz` 保留为原验收产物；生产包只独立推进组件版本元数据，代码指纹保持一致。

## 生产接入与未验范围

实机验证只使用独立临时目录和合成模型。测试前后生产 Host 与现存 DSH 的 PID 和创建时间一致；DSH 仍监听原端口。生产旧命令及其排队输入没有被清理、重跑或派发，旧挂起状态仍需维护处理。

接入步骤应在独立的、明确授权的维护操作中完成：

1. 等其他用户任务结束，暂停新输入，保存当前组件指针、会话状态和运行日志备份；记录现存 DSH 的 PID、创建时间及监听端口。
2. 人工核对旧启动命令与 DSH 的归属。对确认需要保留的 DSH，明确记录为外部保留服务，不能把仍存活的进程伪写成已清理。核对并收口旧目标为失败/中断，保留全部排队输入，维持暂停/待核对状态；新恢复逻辑不会自动越过这一步。
3. 通过现有组件更新/回滚机制切换到验收包，仅重启 Host。此操作会短暂中断 Bot 控制连接；不能在仍有用户任务时强行执行。继续核对 DSH 的同一进程身份和端口。保留旧组件以便回滚；不能只回滚二进制而丢弃包含新 Job 元数据的运行日志。
4. 在独立测试会话确认连接、正常结束、取消与一次性队列交接，再由用户明确处理原待核对输入。长期 DSH 服务的计划任务/系统服务管理属于另一个维护动作，不能借此自动停止或重启它。

尚未验证 Windows 10/11 其他版本、受 AppLocker/杀毒策略限制的宿主、真实主机重启或跨登录恢复；只在当前 Server 2025 主机验证了原生 Job 恢复。没有做高并发资源基准。Linux/macOS 的进程组不是安全沙箱，不能完整约束主动脱离进程组并关闭继承管道的守护程序；这类长期服务需要独立的系统服务归属。本轮没有改造 Linux cgroup 或系统服务管理。

## 已授权的生产更新

2026-10-27，用户明确要求“修复完更新 bot”。生产已切换到组件 **0.2.20**，代码 build 为 `35f01128f69930bd8dedd86773264e914607632360dba37e4f2b9514df386601`，与上述验收代码一致。独立组件版本用于防止正式版桌面 0.2.19 按“同版本、不同指纹”规则覆盖修复；没有修改桌面版本或关闭组件维护。`buildBotRuntime({componentVersion})` 仅覆盖组件清单的版本，保留应用包版本、锁文件及代码指纹；新增元数据路径的 3 项打包/版本定向测试通过。

切换前核实其他 npm 任务已结束，唯一活动目标为旧 DSH 启动命令。Windows Job 只读审计确认 Host 属于 Job，而现存 DSH 主进程和包装进程均在其外。先通过服务接口暂停受理，再停止 Host 的计划任务，完整备份并逐文件核验 727 个数据文件，以及当前/上一组件指针、原任务 XML、启动器和网络环境文件；目录沿用仅账号和 SYSTEM 可访问的 ACL。

旧命令按人工归属核对转为 `transferred / retained-service`，明确保留 `cleanupConfirmed:false` 和 DSH 的 PID/出生信息、监听端口，不伪写“全部已清理”。旧根目标记为维护中断，对话以失败收口至 idle。原排队输入的 inputId、原文和其他载荷保留；初步迁移置为待核对，随后根据原 pending 状态、时间线和全部运行的 inputIds 证明确实从未派发，恢复为 pending、清除提升标记并保持 queuePaused。为使这项状态迁移不被旧内存覆盖，在受理暂停且无任务时又重启一次 Host。正式版已验证“继续发送、直接运行、编辑、撤回”恢复可操作，未点击任何会派发原输入的操作。其他原有会话、草稿、附件、交付和模型目录核验保持一致。

新组件先在未启用目录通过锁文件核验并复制现有 234 个依赖包，原生守卫 canary 和 Host 导入通过后才切换指针。没有运行新的 npm 安装、替换 Node、重配 OAuth/模型/代理，稳定启动器与原计划任务参数保持原值。只重启 Host，实例身份保持一致，bootId 更新；控制握手、快照、reset/ready 及实时 flow patch 均通过。正式版桌面缓存已同步新 bootId，原会话不再显示运行中。

使用生产 Host 和现有模型配置创建专用测试会话，真实后台命令正常结束、取消后交接均通过：命令记录为 `windows-job-v1 / finished / cleanupConfirmed:true`，子进程退出，排队输入只派发一次。测试会话和临时目录已清理，全部 4 条原有会话和 727 个原有数据文件仍在，原排队输入未执行。DSH 的两个原进程及创建时间不变，原端口继续监听，直接 HTTP 返回 401；没有验证需鉴权的 DSH 页面或 QQ 桥接。

上线证据在忽略目录 `.visual/workflow/bot-command-update/`。其中 `deployment-report.json` 汇总实际版本、迁移、生产测试、正式版重连和回滚路径；远端私有维护目录保留完整备份、旧组件及带“受理必须暂停”保护的 `rollback.ps1`。回滚脚本经过语法检查，未在健康生产实例上实际切回旧版；后续回滚不得用旧数据快照直接覆盖维护后新增的用户输入。后续组件发布应继续使用不低于 0.2.20 的组件版本，避免较新的云端组件被旧桌面维护覆盖。
