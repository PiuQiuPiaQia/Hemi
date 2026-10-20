/** 059 工作流定义共享类型（实现见 workflow.mjs）。 */

export type WorkflowParameterType =
  | 'string'
  | 'text'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'date'
  | 'file'
  | 'files'
  | 'directory'

export interface WorkflowInputParameter {
  key: string
  label?: string
  type: WorkflowParameterType
  required?: boolean
  options?: Array<string>
  defaultValue?: unknown
  /** 相对日期规则（如 'last-week'），启动时按工作区时区冻结为具体值。 */
  defaultRule?: string
  description?: string
}

export type WorkflowBinding =
  | { kind: 'parameter'; key: string; type?: string; acceptType?: string }
  | { kind: 'node-output'; nodeId: string; key: string; type?: string; acceptType?: string }

export type WorkflowNodeType =
  | 'hemi-input'
  | 'hemi-agent'
  | 'hemi-skill'
  | 'hemi-browser'
  | 'hemi-desktop'
  | 'hemi-condition'
  | 'hemi-human-input'
  | 'hemi-deliver'

/** 人工输入（HI 通用节点）四类字段。 */
export type HumanInputFieldType = 'text' | 'choice' | 'file' | 'files'

export interface HumanInputField {
  /** 稳定字段身份（改 key 不换 fieldId）。 */
  fieldId?: string
  key: string
  label?: string
  type: HumanInputFieldType
  required?: boolean
  config?: {
    /** text：自定义预填文本。 */
    prefillText?: string
    /** text：上游正文预填绑定。 */
    prefillBinding?: WorkflowBinding
    /** choice：手动选项。 */
    options?: Array<string>
    /** choice：上游 array[string] 选项来源（运行时冻结列表）。 */
    optionsBinding?: WorkflowBinding
  }
}

export interface HumanInputAction {
  actionId: string
  label: string
  /** 至多一个主按钮。 */
  primary?: boolean
  /** 该操作额外必填的字段 key（与字段自身 required 取并集）。 */
  requiredKeys?: Array<string>
}

export type HumanInputWait = { mode: 'forever' } | { mode: 'timeout'; timeoutMs: number }

export interface WorkflowNode {
  id: string
  type: WorkflowNodeType
  meta: { position: { x: number; y: number } }
  data: {
    title?: string
    /** 画布展示摘要；执行仍以 goal 为准。 */
    description?: string
    /** agent/skill/browser/desktop 必填任务目标。 */
    goal?: string
    acceptance?: string
    /** hemi-input：参数 schema 单源。 */
    parameters?: Array<WorkflowInputParameter>
    /** hemi-skill：引用的 Skill（name＋version 快照核对）。 */
    skillRefs?: Array<{ name: string; version?: string }>
    /** hemi-browser：目标 URL 或 URL 绑定。 */
    targetUrl?: string
    targetBinding?: WorkflowBinding
    /** hemi-desktop：应用身份。 */
    applicationRef?: string
    /** hemi-condition：比较配置。 */
    condition?: { fieldRef: WorkflowBinding; operator: string; value?: unknown }
    /** hemi-human-input：内容（{{nodeId.key}} 变量）、字段、操作与等待。 */
    content?: string
    fields?: Array<HumanInputField>
    actions?: Array<HumanInputAction>
    wait?: HumanInputWait
    /** 任务节点输入绑定。 */
    inputBindings?: Array<WorkflowBinding>
    /** 任务节点输出声明。 */
    outputSchema?: { type: 'object'; properties: Record<string, { type: string; description?: string; default?: unknown }> }
    /** hemi-deliver：展示说明与产物绑定。 */
    summary?: string
    artifacts?: Array<{ label?: string; binding: WorkflowBinding }>
  }
}

export interface WorkflowEdge {
  sourceNodeID: string
  targetNodeID: string
  /** 条件节点为 'yes' | 'else'，其余节点省略。 */
  sourcePortID?: string
}

export interface WorkflowDocument {
  nodes: Array<WorkflowNode>
  edges: Array<WorkflowEdge>
}

export interface WorkflowIssue {
  code: string
  message: string
  nodeId?: string
}

export declare function validateWorkflowDocument(document: WorkflowDocument): { valid: boolean; errors: Array<WorkflowIssue> }

export declare const WORKFLOW_NODE_TYPES: Record<
  WorkflowNodeType,
  { label: string; requiresGoal: boolean; hasOutput: boolean }
>
export declare const CONDITION_PORTS: Array<'yes' | 'else'>
export declare const WORKFLOW_PARAMETER_TYPES: Array<WorkflowParameterType>
export declare const HUMAN_INPUT_FIELD_TYPES: Record<HumanInputFieldType, string>
export declare const HUMAN_INPUT_RESERVED_OUTPUTS: Record<string, string>
export declare const HUMAN_INPUT_TIMEOUT_PORT: 'timeout'
export declare const HUMAN_INPUT_CONTENT_VAR_RE: RegExp
export declare function parseHumanInputContentVars(content: string | null | undefined): Array<{ nodeId: string; key: string }>
export declare function humanInputPorts(node: WorkflowNode): Array<string>
