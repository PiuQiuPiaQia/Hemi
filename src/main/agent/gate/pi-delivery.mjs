// 025 → 050 交付登记扩展 —— 与 pi-web 同款 InlineExtension 形态（023 起由
// hemi-session 在主进程内注册）。只注册一个 `register_delivery` 工具：050 起
// 收敛为「正式交付文件声明」（files＋sources），宿主侧经会话
// 的 delivery 事件接收（工具本身无副作用，只做结构反馈，不碰文件系统与网络）。
//
// 为什么工具在这里、落地在宿主：工具 execute 拿得到模型参数、能立即把结构
// 错误回给模型（technical-plan「结构校验错误在任务收束前反馈，允许有界修正」），
// 但任务归属/档案写放必须由宿主做——适配器监听 tool_execution_end 转发，
// 宿主用同一份 validateDelivery 再校验一次后才落档。工具名保留不改：门控
// 免问清单、access-policy、测试都按名字识别。
import { validateDelivery } from '../../delivery/delivery.mjs';

export const DELIVERY_TOOL_NAME = 'register_delivery';

/** 工具参数 schema（模型可见的说明面；错误反馈走 execute 返回的 isError 文本）。 */
const PARAMETERS = {
  type: 'object',
  properties: {
    files: {
      type: 'array',
      description:
        '正式交付文件 [{path, description?}]：只在产出用户要打开、保存或继续使用的文件时声明（用户要求导出的报告/表格/图片、任务生成的主成果文件）。write/edit 修改的源码与文档不声明（改动清单由宿主统计）；path 须在任务工作目录或家目录内；description 一句话说这是什么',
    },
    sources: {
      type: 'array',
      description:
        '外部依据来源 [{title, url}]：本任务结论依据的网页/搜索结果，能给 https 链接就给，不编造。本地文件与本次生成的成果不是来源；正文里引用的链接不受条数限制',
    },
  },
  required: ['files'],
};

const TOOL_GUIDE =
  '声明任务的正式交付文件与外部来源，让用户拿到可打开的成果入口和可追溯的依据（无副作用，纯声明；宿主会核实路径后才登记）。' +
  '只在产出用户要打开、保存或继续使用的文件时声明文件；纯调研任务没有交付文件时可只声明来源（sources）。' +
  '纯文字答案直接回复，不额外生成同内容文件；用户要求文件交付时，正文按用户要求提供文件链接和必要说明，不重复文件内容或核对过程。' +
  '同一文件内容更新后可以再次声明（同路径覆盖更新，同一回合不重复出卡）；中间阶段产出的可打开成果应及时声明，用户随时可查看。';

/**
 * 交付登记工具工厂。config.enabled 由宿主按会话模式注入
 * （verify 只读复核不注册）；validateImpl 可注入（测试）。
 */
export default function hemiDelivery(pi, { config = {}, validateImpl = validateDelivery } = {}) {
  if (config.enabled !== true) return;

  pi.registerTool({
    name: DELIVERY_TOOL_NAME,
    label: '声明交付文件',
    description: TOOL_GUIDE,
    promptSnippet: 'register_delivery：声明正式交付文件与来源（可选）',
    promptGuidelines: [
      '用户指定了文件形式（「做成报告文件」「导出表格」）时必须提供真实文件并声明；环境做不到的格式不要用改后缀冒充，如实说明缺口并给可用替代。',
      '生成用户要看的图片、封面或其他成果文件后，及时调用 register_delivery 提供完整文件路径。read 图片只是供你查看，不会将图片展示给用户；不要只说「已生成」或只给目录，正文需要引用时给具体文件链接。',
      '来源只列实际依据（https 链接）；本次生成的文件不算来源。数字必须带单位与时间口径，查不到的写「未查到」，绝不补造。',
      '被提示格式错误时修正后最多再试一次，仍失败就跳过声明、正常输出正文。文件更新后可再次声明同一路径（覆盖更新），但不要为同一内容反复声明。',
    ],
    parameters: PARAMETERS,
    async execute(_id, params) {
      const verdict = validateImpl(params);
      if (!verdict.ok) {
        return {
          content: [{
            type: 'text',
            text: `声明未成功：${verdict.reason}。请修正后重试一次；无法修正就跳过声明，正常输出正文。`,
          }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: `交付文件已声明（${verdict.value.files.length} 个）。按用户要求回复文件链接与必要说明。` }],
        details: { deliveryAccepted: true, files: verdict.value.files.length },
      };
    },
  });
}
