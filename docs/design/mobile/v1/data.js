export const scenes = [
  {id:'pair-share',group:'开始使用',title:'生成配对二维码',description:'已连接设备为自己的新设备创建短时邀请。二维码本身不授予 Bot 访问权限。',points:['新设备通过流量或 Wi-Fi 连接云端 Bot，无需同网。','两分钟有效，只完成一次配对；扫码不直接授权。','扫码后在原设备核对验证码并明确允许。']},
  {id:'pair-scan',group:'开始使用',title:'扫码连接 Bot',description:'新设备识别配对码，核对 Bot 与原设备信息，再发起请求。',points:['不在二维码中复制 SSH 私钥或长期令牌。','等待原设备确认前，不读取历史、不执行任务。','本稿可在右侧模拟识别、允许、拒绝与无效码。']},
  {id:'pair-confirm',group:'开始使用',title:'确认新设备',description:'扫码只产生待确认请求。原设备必须核对双方屏幕验证码。',points:['名称由对方提供，不能作为身份依据。','勾选两端验证码一致后才可允许连接。','同意绑定到这次请求的设备公钥，不自动批准后来请求。']},
  {id:'devices',group:'连接与异常',title:'已连接设备',description:'每台设备使用独立身份，可分别撤销访问。',points:['首版只用于自己的设备，不提供多人共享入口。','撤销在 Bot 生效，不能只删除本地列表。','已缓存的数据无法远程收回，云端任务不因撤销而停止。']},
  {id:'connect',group:'开始使用',title:'连接已有 Bot',description:'移动端只连接已初始化的 Bot。地址、端口、账号与认证分开填写；不增加账号系统。',points:['导入私钥后才可继续，预览使用演示认证。','尚未绑定时不显示无法使用的输入框。','手机端不部署服务，不同步模型密钥。']},
  {id:'trust',group:'开始使用',title:'核对主机身份',description:'首次连接由用户核对 SSH 指纹；信任完成后再读取 Bot 状态。',points:['展示完整指纹，允许返回修改连接。','已有指纹发生变化时阻断连接。','认证信息由原生安全存储承载。']},
  {id:'history',group:'开始使用',title:'会话列表',description:'左侧抽屉收纳对话，主页面始终以对话流为中心。',points:['按置顶与最近分组，可搜索标题、新建或切换。','主页面向右让出位置；点遮罩、左滑或 Escape 收起。','切换保留各会话的草稿、模型与目录。']},
  {id:'conversation',group:'对话与任务',title:'对话与交付',description:'复用真实 SDK 的消息、思考与工具过程、文件卡和编辑操作。',points:['回复正文直接阅读，过程默认折叠。','文件留在交付它的那条回复中。','顶部快捷按钮用于新建、切换模型、选择目录和查看连接。']},
  {id:'running',group:'对话与任务',title:'执行中的任务',description:'任务在云端执行，手机保持可输入；发送下一条会进入队列。',points:['发送与停止分开，正在运行时仍可发送下一条。','折叠的执行过程持续显示真实状态。','打开左侧抽屉切换会话，云端任务继续执行。']},
  {id:'queued',group:'对话与任务',title:'继续输入与排队',description:'队列并入输入区上方，条目紧凑排列；内容多时只滚动队列，不挤走输入框。',points:['可编辑或撤回尚未派发的输入。','停止当前任务后，队列暂停并等待明确继续。','这里使用 SDK 的同一个 TurnQueueTray。']},
  {id:'permission',group:'对话与任务',title:'等待你的确认',description:'需要决定时展开底部确认面板，保留会话上下文和执行位置。',points:['完整命令可以展开查看，危险原因可见。','拒绝与允许这次均为明确操作，不默认放行。','Bot 等待确认不使用手机端倒计时。']},
  {id:'offline',group:'恢复与文件',title:'断线与本机待发送',description:'断线保留缓存与草稿；新输入先保存在手机，不假装已经被云端受理。',points:['连接状态与任务是否运行分别表达。','重连先核对实例、历史与回执，再发送本机等待项。','断线时不能提交停止、编辑与授权。']},
  {id:'unknown',group:'恢复与文件',title:'提交结果待核对',description:'有副作用的操作结果不明确时，先核对，避免把同一条消息再发送一次。',points:['保留原稿和待核对条目。','不提供会导致重复投递的一键重发。','核对成功后显示已受理，用户后来输入的草稿仍保留。']},
  {id:'file',group:'恢复与文件',title:'文件预览与保存',description:'文件用独立预览页承载。收起后回到原回复和滚动位置。',points:['查看、保存和分享是不同操作。','保存使用系统文件能力，云端路径不当成本机路径。','本稿文件为内置示例，可下载查看。']},
  {id:'settings',group:'连接与异常',title:'Bot 连接设置',description:'移动端提供连接信息与重新连接，不承担首版的部署维护和模型同步。',points:['明确当前服务器和连接状态。','断开手机连接前说明对云端任务的影响。','保留缓存和草稿，返回时仍能查看。']},
  {id:'identity',group:'连接与异常',title:'主机身份发生变化',description:'发现指纹变化时停止自动重连，明确引导核对服务器身份。',points:['不提供跳过身份检查的便捷按钮。','不把这次连接误报成普通网络错误。','回到连接设置处理，已有缓存保留。']},
];

export const fileText = '# 移动端首版发布说明\n\n## 这次完成\n\n- 抽离多端共用的对话 SDK。\n- 草稿、排队和断线恢复使用同一份前端逻辑。\n- 初始化 iOS 与 Android 工程。\n\n## 发布前还需要\n\n- 接入原生 SSH 与安全存储。\n- 验证后台恢复与真机文件分享。\n- 完成签名与商店资料。\n\n以上为交互稿内置示例，不是实际项目的发布结论。\n';

export const conversations = [
  {id:'release',title:'发布前检查',summary:'发布说明已经整理好了。',time:'14:32',pinned:true},
  {id:'audit',title:'检查服务器磁盘',summary:'正在核对日志和构建缓存…',time:'13:56',running:true},
  {id:'notes',title:'整理项目文档',summary:'已整理目录和后续事项。',time:'昨天'},
  {id:'tests',title:'核对测试结果',summary:'测试结果已经核对完成。',time:'昨天'},
  {id:'deploy',title:'准备部署清单',summary:'部署前的核对事项已列出。',time:'周三'},
  {id:'logs',title:'分析构建日志',summary:'已整理日志中的关键记录。',time:'周三'},
  {id:'structure',title:'了解项目结构',summary:'已整理项目的主要目录。',time:'周二'},
  {id:'cleanup',title:'清理旧的构建产物',summary:'先确认范围，再处理旧产物。',time:'周二'},
  {id:'weekly',title:'整理本周工作记录',summary:'本周记录已经整理好了。',time:'周一'},
];

export function seedSnapshot(id='release', mode='conversation') {
  const now=Date.now()-16000, runId=`${id}-run`;
  const empty=id.startsWith('new-');
  const running=!empty&&['running','queued','offline','permission','unknown'].includes(mode);
  if(id!=='release'&&!empty)return {schemaVersion:1,conversationId:id,revision:1,generation:1,phase:running?'running':'idle',activeRunId:running?runId:null,queuePaused:false,pending:[],tasks:{},permissions:{},pendingReports:[],artifacts:{},runs:{[runId]:{startedAt:now,closedAt:running?null:now+8000,inputIds:[`${id}-user`]}},timeline:[{kind:'user',id:`${id}-user`,runId,text:conversations.find(item=>item.id===id)?.title??'继续这个任务。',inputSource:'text',attachmentIds:[],acceptedAt:now,deliveredAt:now},{kind:'assistant',itemId:`${id}-answer`,runId,afterInputId:`${id}-user`,parts:[{partId:'answer',kind:'text',content:id==='audit'?'我正在核对磁盘使用情况，任务会在云端继续。':conversations.find(item=>item.id===id)?.summary??'可以继续处理了。'}]}]};
  return {schemaVersion:1,conversationId:id,revision:1,generation:1,phase:running?'running':'idle',activeRunId:running?runId:null,
    queuePaused:false,pending:mode==='queued'?[
      {inputId:'queued-one',text:'再补充一份发布检查清单。',state:'pending',inputSource:'text',attachmentIds:[],editRevision:0},
      {inputId:'queued-two',text:'最后把说明保存为 Markdown。',state:'pending',inputSource:'text',attachmentIds:[],editRevision:0},
    ]:mode==='unknown'?[{inputId:'unknown-one',text:'把发布说明发给我。',state:'needs-review',inputSource:'text',attachmentIds:[],editRevision:0}]:[],
    tasks:{},permissions:{},pendingReports:[],
    runs:empty?{}:{[runId]:{startedAt:now,closedAt:running?null:now+8000,inputIds:[`${id}-user`]}},
    artifacts:running||empty?{}:{releaseFile:{artifactId:'release-file',name:'发布说明.md',path:'/home/ubuntu/hemi-workspace/发布说明.md',kind:'file',previewKind:'text',producerRunId:runId,contentVersion:1,size:824,host:'cloud.example.com'}},
    timeline:empty?[]:[
      {kind:'user',id:`${id}-user`,runId,text:id==='audit'?'帮我看看服务器磁盘空间够不够。':'检查今天的改动，整理一份发布说明。',inputSource:'text',attachmentIds:[],acceptedAt:now,deliveredAt:now},
      {kind:'assistant',itemId:`${id}-answer`,runId,afterInputId:`${id}-user`,parts:[
        {partId:'intro',kind:'text',content:running?'我先检查变更和测试结果，再整理给你。':'检查完了。今天的改动主要集中在移动端与对话能力。'},
        {partId:'thinking',kind:'thinking',content:'先核对变更范围，再检查依赖与测试结果，最后整理发布前还需要完成的事项。',startedAt:now+1000,endedAt:running?null:now+5000},
        {partId:'tool',kind:'tool',toolCallId:'diff-check',tool:'bash',args:{command:'git diff --stat',description:'检查改动范围'},status:running?'running':'done'},
        ...running?[]:[{partId:'answer',kind:'text',content:'**可以确认的变化**\n\n- 对话、草稿与队列已经抽到共用 SDK。\n- iOS 和安卓工程都已初始化。\n- 桌面端与移动端共用相同的消息展示。\n\n原生连接和真机体验还需要继续验证。我把要点整理成了文件：'},
          {partId:'delivery',kind:'deliverable',artifactId:'release-file'}],
      ]},
    ]};
}
