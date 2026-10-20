/**
 * 059 工作流定义的共享类型与纯校验（S1，契约 §2）。
 * 图文档是唯一持久编辑文档：八种 hemi-* 具体类型节点＋边；输入 schema 单源在
 * hemi-input 节点的 data.parameters。本模块只做纯函数校验与常量，不碰 IO／Electron；
 * 主进程保存可运行版本（publish）与启动前都必须重新过 validateWorkflowDocument。
 *
 * 图语义与 vendored 引擎（vendor/flowgram-engine）对齐：
 * - 条件节点固定 'yes'/'else' 两个输出端口（转换器映射到 Runtime conditions[0].key／else）；
 * - 人工输入节点（hemi-human-input，HI 通用节点）按 actionId 动态输出端口，可选
 *   独立 'timeout' 超时端口——运行时由挂起／提交／超时裁决，输出含字段值＋保留
 *   `__action_id`／`__action_value`，引擎按 executor 返回的 branch 走选中端口；
 * - 互斥分支汇合安全规则（保守首期）：条件两支／人工输入全部分支后继闭包内，
 *   节点的每个直接前驱要么也在闭包内，要么必经（支配该节点）——禁止第三方路径
 *   半途汇入分支控制域，否则上游 skipped 语义下会死锁或竞争；被误拒的图可改写
 *   为顺序结构；
 * - skipped/等待等状态引擎不表达，由宿主状态模型投影（契约 §7）。
 */

/** 八种具体节点类型。hasOutput：可被下游绑定引用输出字段。 */
export const WORKFLOW_NODE_TYPES = {
  'hemi-input': { label: '输入', requiresGoal: false, hasOutput: true },
  'hemi-agent': { label: '普通执行', requiresGoal: true, hasOutput: true },
  'hemi-skill': { label: 'Skill', requiresGoal: true, hasOutput: true },
  'hemi-browser': { label: '浏览器操作', requiresGoal: true, hasOutput: true },
  'hemi-desktop': { label: '桌面操作', requiresGoal: true, hasOutput: true },
  'hemi-condition': { label: '条件', requiresGoal: false, hasOutput: false },
  'hemi-human-input': { label: '人工输入', requiresGoal: false, hasOutput: true },
  'hemi-deliver': { label: '交付', requiresGoal: false, hasOutput: false },
}

export const CONDITION_PORTS = ['yes', 'else']

/** 人工输入（HI 通用节点）：四类字段类型 → 输出字段类型。 */
export const HUMAN_INPUT_FIELD_TYPES = {
  text: 'string',
  choice: 'string',
  file: 'file',
  files: 'files',
}
/** 人工输入保留输出（同 __summary 的保留前缀约定）。 */
export const HUMAN_INPUT_RESERVED_OUTPUTS = {
  __action_id: 'string',
  __action_value: 'string',
}
/** 超时端口号（wait.mode==='timeout' 时的独立出口；actionId 不得占用）。 */
export const HUMAN_INPUT_TIMEOUT_PORT = 'timeout'

/** 内容模板变量 `{{nodeId.key}}` 的合法形状。 */
export const HUMAN_INPUT_CONTENT_VAR_RE = /\{\{\s*([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.([A-Za-z0-9][A-Za-z0-9_-]{0,63})\s*\}\}/g

/** 解析人工输入展示内容里的全部 `{{nodeId.key}}` 引用（去重保序）。 */
export function parseHumanInputContentVars(content) {
  const out = []
  const seen = new Set()
  const re = new RegExp(HUMAN_INPUT_CONTENT_VAR_RE.source, 'g')
  let match
  while ((match = re.exec(String(content ?? ''))) !== null) {
    const ref = `${match[1]}.${match[2]}`
    if (!seen.has(ref)) {
      seen.add(ref)
      out.push({ nodeId: match[1], key: match[2] })
    }
  }
  return out
}

/** 人工输入节点的全部输出端口：每个 actionId＋（超时模式下）timeout。 */
export function humanInputPorts(node) {
  const actions = Array.isArray(node?.data?.actions) ? node.data.actions : []
  const ports = actions.map((a) => a?.actionId).filter(Boolean)
  if (node?.data?.wait?.mode === 'timeout') ports.push(HUMAN_INPUT_TIMEOUT_PORT)
  return ports
}

/** 输入参数首批业务类型（契约 §2：日期／文件是业务类型，运行前由宿主解析）。 */
export const WORKFLOW_PARAMETER_TYPES = ['string', 'text', 'number', 'boolean', 'enum', 'date', 'file', 'files', 'directory']

const CONDITION_OPERATORS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'is_not_empty']

/** 绑定类型兼容表（`${上游类型}:${需要类型}`；enum 参数按 string 供给）。 */
const COMPATIBLE = new Set([
  'string:string',
  'string:text',
  'enum:string',
  'enum:text',
  'enum:enum',
  'text:string',
  'text:text',
  'number:number',
  'object:object',
  'array:array',
  'boolean:boolean',
  'date:date',
  'file:file',
  'files:files',
  'directory:directory',
])

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/**
 * 校验工作流图文档（可运行版本的完整业务校验）。
 * @returns {{ valid: boolean, errors: Array<{code: string, message: string, nodeId?: string}> }}
 */
export function validateWorkflowDocument(document) {
  const errors = []
  const fail = (code, message, nodeId) => errors.push(nodeId ? { code, message, nodeId } : { code, message })

  if (!document || typeof document !== 'object') {
    return { valid: false, errors: [{ code: 'invalid-graph', message: '图文档缺失' }] }
  }
  const nodes = Array.isArray(document.nodes) ? document.nodes : []
  const edges = Array.isArray(document.edges) ? document.edges : []
  if (nodes.length === 0) {
    fail('invalid-graph', '图没有节点')
    return { valid: false, errors }
  }

  // ── 节点基础：id 唯一、类型合法、必填字段 ──
  const byId = new Map()
  for (const node of nodes) {
    if (!node || typeof node !== 'object') {
      fail('invalid-graph', '存在非法节点（非对象）')
      continue
    }
    if (!ID_RE.test(String(node.id ?? ''))) {
      fail('invalid-graph', `节点 id 非法：${JSON.stringify(node.id ?? null)}`, node.id)
      continue
    }
    if (byId.has(node.id)) {
      fail('duplicate-node', `节点 id 重复：${node.id}`, node.id)
      continue
    }
    byId.set(node.id, node)
    const meta = WORKFLOW_NODE_TYPES[node.type]
    if (!meta) {
      fail('unknown-node-type', `未知节点类型：${node.type}`, node.id)
      continue
    }
    const data = node.data ?? {}
    if (meta.requiresGoal && (!isNonEmptyString(data.goal))) {
      fail('missing-goal', `节点「${titleOf(node)}」缺少任务目标`, node.id)
    }
    if (node.type === 'hemi-agent' && (!data.outputSchema?.properties || Object.keys(data.outputSchema.properties).length===0)) {
      fail('missing-output', `节点「${titleOf(node)}」需声明至少一个预期输出`, node.id)
    }
    if (node.type !== 'hemi-input' && data.outputSchema) {
      const schema=data.outputSchema
      if(schema.type!=='object'||!schema.properties||typeof schema.properties!=='object'||Array.isArray(schema.properties)||Object.entries(schema.properties).some(([key,prop])=>!ID_RE.test(key)||!['string','number','boolean','object','array','file','files'].includes(prop?.type))) {
        fail('invalid-output', `节点「${titleOf(node)}」输出字段或类型无效`, node.id)
      }
    }
    if (node.type === 'hemi-input') validateInputParameters(node, fail)
    if (node.type === 'hemi-skill') {
      const refs = data.skillRefs
      if (!Array.isArray(refs) || refs.length === 0 || refs.some((r) => !isNonEmptyString(r?.name))) {
        fail('missing-skill-ref', `Skill 节点「${titleOf(node)}」未选择 Skill`, node.id)
      }
    }
    if (node.type === 'hemi-browser' && !isNonEmptyString(data.targetUrl) && !data.targetBinding) {
      fail('missing-browser-target', `浏览器节点「${titleOf(node)}」缺少目标 URL 或 URL 绑定`, node.id)
    }
    if (node.type === 'hemi-desktop' && !isNonEmptyString(data.applicationRef)) {
      fail('missing-desktop-app', `桌面节点「${titleOf(node)}」未指定应用身份`, node.id)
    }
    if (node.type === 'hemi-condition') {
      const cond = data.condition
      if (!cond || typeof cond.fieldRef !== 'object' || cond.fieldRef == null) {
        fail('missing-condition', `条件节点「${titleOf(node)}」未配置比较字段`, node.id)
      } else if (!CONDITION_OPERATORS.includes(cond.operator)) {
        fail('invalid-condition', `条件节点「${titleOf(node)}」比较方式非法：${cond.operator}`, node.id)
      }
    }
    if (node.type === 'hemi-deliver' && !isNonEmptyString(data.summary)) {
      fail('missing-delivery-summary', `交付节点「${titleOf(node)}」缺少展示说明`, node.id)
    }
    if (node.type === 'hemi-human-input') validateHumanInputNode(node, fail)
  }

  // ── 边：端点存在、自连、重复、端口合法、方向约束 ──
  const seenEdges = new Set()
  /** @type {Map<string, Array<{sourceNodeID: string, targetNodeID: string, sourcePortID?: string}>>} */
  const outEdges = new Map()
  for (const node of byId.values()) outEdges.set(node.id, [])
  for (const edge of edges) {
    if (!edge || !byId.has(edge.sourceNodeID) || !byId.has(edge.targetNodeID)) {
      fail('invalid-edge', `边端点不存在：${edge?.sourceNodeID} → ${edge?.targetNodeID}`)
      continue
    }
    if (edge.sourceNodeID === edge.targetNodeID) {
      fail('self-edge', `节点不能自连：${edge.sourceNodeID}`, edge.sourceNodeID)
      continue
    }
    const key = `${edge.sourceNodeID}|${edge.sourcePortID ?? ''}|${edge.targetNodeID}`
    if (seenEdges.has(key)) {
      fail('duplicate-edge', `重复连线：${edge.sourceNodeID} → ${edge.targetNodeID}`, edge.sourceNodeID)
      continue
    }
    seenEdges.add(key)
    const source = byId.get(edge.sourceNodeID)
    const target = byId.get(edge.targetNodeID)
    let portOk
    if (source.type === 'hemi-condition') portOk = CONDITION_PORTS.includes(edge.sourcePortID)
    else if (source.type === 'hemi-human-input') portOk = humanInputPorts(source).includes(edge.sourcePortID)
    else portOk = edge.sourcePortID == null
    if (!portOk) {
      fail('invalid-port', `节点「${titleOf(source)}」没有输出端口 ${edge.sourcePortID ?? '(默认)'}`, source.id)
      continue
    }
    if (target.type === 'hemi-input') {
      fail('input-in-edge', `输入节点「${titleOf(target)}」不能有入边`, target.id)
      continue
    }
    if (source.type === 'hemi-deliver') {
      fail('deliver-out-edge', `交付节点「${titleOf(source)}」不能有出边`, source.id)
      continue
    }
    outEdges.get(source.id).push(edge)
  }

  // ── 正向图、环、可达性 ──
  const graph = new Map([...outEdges.entries()].map(([id, list]) => [id, list.map((e) => e.targetNodeID)]))
  const cyclic = findCycle(graph)
  if (cyclic) fail('cycle', `图存在环：${cyclic.join(' → ')}`)

  const inputs = nodes.filter((n) => n.type === 'hemi-input' && byId.has(n.id))
  if (inputs.length !== 1) {
    fail('input-cardinality', inputs.length === 0 ? '图缺少输入节点' : `输入节点只能有一个（当前 ${inputs.length} 个）`)
  }
  const delivers = nodes.filter((n) => n.type === 'hemi-deliver' && byId.has(n.id))
  if (delivers.length === 0) fail('no-delivery', '图至少要有一个交付节点')

  if (delivers.length > 0 && !cyclic) {
    for (const node of byId.values()) {
      if (node.type === 'hemi-deliver') continue
      if (!reachesDeliver(node.id, graph, new Set(delivers.map((d) => d.id)))) {
        fail('unreachable-delivery', `节点「${titleOf(node)}」无法到达任何交付节点`, node.id)
      }
    }
  }

  // ── 条件双出口；人工输入动作／超时出口 ──
  for (const node of byId.values()) {
    if (node.type !== 'hemi-condition') continue
    const ports = new Set((outEdges.get(node.id) ?? []).map((e) => e.sourcePortID))
    for (const port of CONDITION_PORTS) {
      if (!ports.has(port)) {
        fail('condition-port-missing', `条件节点「${titleOf(node)}」缺少「${port === 'yes' ? '符合' : '不符合'}」分支连线`, node.id)
      }
    }
  }
  for (const node of byId.values()) {
    if (node.type !== 'hemi-human-input') continue
    const wired = new Set((outEdges.get(node.id) ?? []).map((e) => e.sourcePortID))
    for (const action of node.data?.actions ?? []) {
      if (action?.actionId && !wired.has(action.actionId)) {
        fail(
          'human-input-port-missing',
          `人工输入节点「${titleOf(node)}」的操作「${action.label || action.actionId}」还没有后续连线`,
          node.id,
        )
      }
    }
    if (
      node.data?.wait?.mode === 'timeout' &&
      !wired.has(HUMAN_INPUT_TIMEOUT_PORT)
    ) {
      fail(
        'human-input-port-missing',
        `人工输入节点「${titleOf(node)}」设置了等待时限，但「超时」出口还没有连线`,
        node.id,
      )
    }
  }

  // ── 互斥分支汇合安全（保守支配规则；人工输入按全部出口端口同一规则）──
  if (!cyclic) {
    const preds = computePredecessors(graph)
    for (const node of byId.values()) {
      if (node.type === 'hemi-condition') {
        validateBranchMerge(node, byId, outEdges, graph, preds, fail)
      } else if (node.type === 'hemi-human-input') {
        validateHumanInputMerge(node, byId, outEdges, graph, preds, fail)
      }
    }
  }

  // ── 数据绑定可达与类型 ──
  if (!cyclic) {
    const ancestors = computeAncestors(graph)
    for (const node of byId.values()) validateBindings(node, byId, ancestors, fail)
  }

  return { valid: errors.length === 0, errors }
}

function titleOf(node) {
  return node.data?.title || node.id
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0
}

function validateInputParameters(node, fail) {
  const params = node.data?.parameters
  if (!Array.isArray(params)) {
    fail('input-no-parameters', `输入节点「${titleOf(node)}」的参数须为数组（无需输入时使用空数组）`, node.id)
    return
  }
  const seen = new Set()
  for (const p of params) {
    if (!p || !ID_RE.test(String(p.key ?? ''))) {
      fail('invalid-parameter', `输入节点「${titleOf(node)}」参数 key 非法`, node.id)
      continue
    }
    if (seen.has(p.key)) {
      fail('duplicate-parameter', `输入参数 key 重复：${p.key}`, node.id)
      continue
    }
    seen.add(p.key)
    if (!WORKFLOW_PARAMETER_TYPES.includes(p.type)) {
      fail('invalid-parameter-type', `输入参数 ${p.key} 类型非法：${p.type}`, node.id)
    }
    if (p.type === 'enum' && (!Array.isArray(p.options) || p.options.length === 0)) {
      fail('enum-no-options', `枚举参数 ${p.key} 没有可选项`, node.id)
    }
  }
}

function findCycle(graph) {
  const state = new Map() // 0=未访问 1=在栈 2=完成
  const stack = []
  let cycle = null
  const visit = (id) => {
    state.set(id, 1)
    stack.push(id)
    for (const next of graph.get(id) ?? []) {
      const s = state.get(next) ?? 0
      if (s === 1) {
        cycle = [...stack.slice(stack.indexOf(next)), next]
        return true
      }
      if (s === 0 && visit(next)) return true
    }
    stack.pop()
    state.set(id, 2)
    return false
  }
  for (const id of graph.keys()) {
    if ((state.get(id) ?? 0) === 0 && visit(id)) break
  }
  return cycle
}

function reachesDeliver(startId, graph, deliverIds) {
  const seen = new Set([startId])
  const queue = [startId]
  while (queue.length > 0) {
    const id = queue.shift()
    if (deliverIds.has(id)) return true
    for (const next of graph.get(id) ?? []) {
      if (!seen.has(next)) {
        seen.add(next)
        queue.push(next)
      }
    }
  }
  return false
}

/** 节点 → 直接前驱集合。 */
function computePredecessors(graph) {
  const preds = new Map()
  for (const id of graph.keys()) preds.set(id, new Set())
  for (const [from, targets] of graph.entries()) {
    for (const t of targets) preds.get(t).add(from)
  }
  return preds
}

/** 节点 → 全部上游祖先集合（含自己）。调用方保证无环。 */
function computeAncestors(graph) {
  const memo = new Map()
  const compute = (id) => {
    if (memo.has(id)) return memo.get(id)
    const set = new Set([id])
    memo.set(id, set) // 先占位防环
    for (const pred of computePredecessors(graph).get(id) ?? []) {
      for (const a of compute(pred)) set.add(a)
    }
    memo.set(id, set)
    return set
  }
  for (const id of graph.keys()) compute(id)
  return memo
}

/** 支配集：start 到 n 的每条路径都经过的节点。O(n²) 迭代，图很小。 */
function computeDominators(graph, startId) {
  const ids = [...graph.keys()]
  const all = new Set(ids)
  const dom = new Map(ids.map((id) => [id, id === startId ? new Set([startId]) : new Set(all)]))
  let changed = true
  while (changed) {
    changed = false
    for (const id of ids) {
      if (id === startId) continue
      const preds = [...graph.keys()].filter((from) => graph.get(from).includes(id))
      let intersection = preds.length > 0 ? new Set(dom.get(preds[0])) : new Set()
      for (const p of preds.slice(1)) {
        intersection = new Set([...intersection].filter((x) => dom.get(p).has(x)))
      }
      const next = new Set([id, ...intersection])
      const prev = dom.get(id)
      if (prev.size !== next.size || [...next].some((x) => !prev.has(x))) {
        dom.set(id, next)
        changed = true
      }
    }
  }
  return dom
}

/**
 * 保守汇合规则：条件两支后继闭包 A∪B 内的节点 n，其直接前驱要么 ∈ A∪B，要么支配 n（必经）。
 */
function validateBranchMerge(condNode, byId, outEdges, graph, preds, fail) {
  const branchTargets = CONDITION_PORTS.map((port) =>
    (outEdges.get(condNode.id) ?? []).filter((e) => e.sourcePortID === port).map((e) => e.targetNodeID)
  )
  if (branchTargets.some((targets) => targets.length === 0)) return // 双出口缺失已单独报错
  checkMergeDomain(condNode, branchTargets, byId, graph, preds, fail)
}

/** 人工输入汇合：全部出口端口（actions＋可选 timeout）互斥，同一保守支配规则。 */
function validateHumanInputMerge(node, byId, outEdges, graph, preds, fail) {
  const ports = humanInputPorts(node)
  const branchTargets = ports.map((port) =>
    (outEdges.get(node.id) ?? []).filter((e) => e.sourcePortID === port).map((e) => e.targetNodeID)
  )
  if (branchTargets.some((targets) => targets.length === 0)) return // 出口缺失已单独报错
  checkMergeDomain(node, branchTargets, byId, graph, preds, fail)
}

/** N 路互斥分支共用：分支域（全支闭包并集）内节点的每个直接前驱要么在域内，要么支配它。 */
function checkMergeDomain(branchNode, branchTargets, byId, graph, preds, fail) {
  const forwardClosure = (startIds) => {
    const set = new Set()
    const queue = [...startIds]
    while (queue.length > 0) {
      const id = queue.pop()
      if (set.has(id)) continue
      set.add(id)
      for (const next of graph.get(id) ?? []) queue.push(next)
    }
    return set
  }
  const domain = new Set(branchTargets.flatMap((targets) => [...forwardClosure(targets)]))
  const startNode = [...byId.values()].find((n) => n.type === 'hemi-input')
  if (!startNode) return
  const dom = computeDominators(graph, startNode.id)
  for (const id of domain) {
    for (const pred of preds.get(id) ?? []) {
      if (pred === branchNode.id) continue // 分支节点本身是分支域的合法入口
      if (domain.has(pred)) continue
      if (dom.get(id)?.has(pred)) continue
      fail(
        'unsafe-branch-merge',
        `节点「${titleOf(byId.get(id))}」汇入了「${titleOf(branchNode)}」分支之外的上游（${titleOf(byId.get(pred))}），请改写为顺序结构或让汇合点只接收分支内节点`,
        id
      )
      return
    }
  }
}

/** 人工输入节点自身配置：内容、四类字段、动作与等待策略。 */
function validateHumanInputNode(node, fail) {
  const data = node.data ?? {}
  if (!isNonEmptyString(data.content)) {
    fail('human-input-content-missing', `人工输入节点「${titleOf(node)}」缺少展示内容`, node.id)
  }
  const fields = Array.isArray(data.fields) ? data.fields : null
  if (!fields) {
    fail('human-input-invalid', `人工输入节点「${titleOf(node)}」字段集合必须是数组`, node.id)
    return
  }
  const seenKeys = new Set()
  const seenFieldIds = new Set()
  for (const field of fields) {
    if (!field || typeof field !== 'object') {
      fail('human-input-invalid', `人工输入节点「${titleOf(node)}」存在非法字段`, node.id)
      continue
    }
    if (!ID_RE.test(String(field.key ?? '')) || field.key.startsWith('__')) {
      fail('human-input-invalid', `人工输入字段 key 非法或使用了保留前缀：${field.key}`, node.id)
      continue
    }
    if (seenKeys.has(field.key)) {
      fail('human-input-invalid', `人工输入字段 key 重复：${field.key}`, node.id)
      continue
    }
    seenKeys.add(field.key)
    if (field.fieldId != null && !ID_RE.test(String(field.fieldId))) {
      fail('human-input-invalid', `人工输入字段 fieldId 非法：${field.fieldId}`, node.id)
      continue
    }
    if (field.fieldId != null && seenFieldIds.has(field.fieldId)) {
      fail('human-input-invalid', `人工输入字段 fieldId 重复：${field.fieldId}`, node.id)
      continue
    }
    if (field.fieldId != null) seenFieldIds.add(field.fieldId)
    if (!Object.keys(HUMAN_INPUT_FIELD_TYPES).includes(field.type)) {
      fail('human-input-invalid', `人工输入字段 ${field.key} 类型非法：${field.type}`, node.id)
      continue
    }
    const config = field.config ?? {}
    if (field.type === 'choice') {
      const hasManual = Array.isArray(config.options)
      const hasBinding = Boolean(config.optionsBinding)
      if (!hasManual && !hasBinding) {
        fail('human-input-invalid', `单选字段 ${field.key} 没有手动选项，也没有配置选项来源`, node.id)
      }
      if (hasManual && config.options.length === 0) {
        fail('human-input-invalid', `单选字段 ${field.key} 手动选项为空列表`, node.id)
      }
    }
    if (field.type === 'text' && config.prefillBinding == null && config.prefillText != null && !isNonEmptyString(config.prefillText)) {
      fail('human-input-invalid', `多行文本字段 ${field.key} 预填内容非法`, node.id)
    }
  }
  const actions = Array.isArray(data.actions) ? data.actions : null
  if (!actions || actions.length === 0) {
    fail('human-input-invalid', `人工输入节点「${titleOf(node)}」至少需要一个操作按钮`, node.id)
    return
  }
  const seenActions = new Set()
  let primaryCount = 0
  for (const action of actions) {
    if (!action || !ID_RE.test(String(action.actionId ?? '')) || action.actionId === HUMAN_INPUT_TIMEOUT_PORT) {
      fail('human-input-invalid', `人工输入操作 ID 非法（或占用了保留的 timeout）：${action?.actionId}`, node.id)
      continue
    }
    if (seenActions.has(action.actionId)) {
      fail('human-input-invalid', `人工输入操作 ID 重复：${action.actionId}`, node.id)
      continue
    }
    seenActions.add(action.actionId)
    if (!isNonEmptyString(action.label)) {
      fail('human-input-invalid', `操作「${action.actionId}」缺少按钮文案`, node.id)
    }
    if (action.primary) primaryCount += 1
    for (const key of action.requiredKeys ?? []) {
      if (!seenKeys.has(key)) {
        fail('human-input-invalid', `操作「${action.label || action.actionId}」的额外必填字段不存在：${key}`, node.id)
      }
    }
  }
  if (primaryCount > 1) {
    fail('human-input-invalid', `人工输入节点「${titleOf(node)}」最多一个主按钮（当前 ${primaryCount} 个）`, node.id)
  }
  const wait = data.wait ?? { mode: 'forever' }
  if (!['forever', 'timeout'].includes(wait.mode)) {
    fail('human-input-invalid', `人工输入节点「${titleOf(node)}」等待策略非法：${wait.mode}`, node.id)
  } else if (wait.mode === 'timeout' && (!Number.isFinite(wait.timeoutMs) || wait.timeoutMs <= 0)) {
    fail('human-input-invalid', `人工输入节点「${titleOf(node)}」等待时限必须大于 0`, node.id)
  }
}

function validateBindings(node, byId, ancestors, fail) {
  const data = node.data ?? {}
  if(node.type==='hemi-condition' && data.condition && !['is_empty','is_not_empty'].includes(data.condition.operator)){
    const {fieldRef,value}=data.condition;
    const source=fieldRef?.kind==='parameter'?[...byId.values()].find(n=>n.type==='hemi-input'):byId.get(fieldRef?.nodeId);
    const type=source?upstreamOutputFields(source).get(fieldRef?.key):null;
    if(value===undefined || (type==='number' && (typeof value!=='number'||!Number.isFinite(value))) || (type==='boolean' && typeof value!=='boolean'))fail('invalid-condition',`条件「${titleOf(node)}」比较值缺失或类型不匹配`,node.id)
  }

  const bindings = []
  if (Array.isArray(data.inputBindings)) bindings.push(...data.inputBindings.filter((b) => b && typeof b === 'object'))
  if (node.type === 'hemi-condition' && data.condition?.fieldRef?.kind) bindings.push(data.condition.fieldRef)
  if (node.type === 'hemi-deliver' && Array.isArray(data.artifacts)) {
    for (const a of data.artifacts) {
      if (a && typeof a === 'object' && a.binding) bindings.push(a.binding)
    }
  }
  if (node.type === 'hemi-human-input') {
    // 内容模板变量：上游存在＋可达＋字段存在（类型不限定，展示用）。
    for (const ref of parseHumanInputContentVars(data.content)) {
      bindings.push({ kind: 'node-output', nodeId: ref.nodeId, key: ref.key, __from: `内容变量 {{${ref.nodeId}.${ref.key}}}` })
    }
    for (const field of data.fields ?? []) {
      const config = field?.config ?? {}
      if (config.optionsBinding) bindings.push({ ...config.optionsBinding, acceptType: 'array', __from: `字段 ${field.key} 的选项来源` })
      if (config.prefillBinding) bindings.push({ ...config.prefillBinding, acceptType: 'string', __from: `字段 ${field.key} 的预填来源` })
    }
  }

  for (const binding of bindings) {
    if (binding.kind === 'parameter') {
      const input = [...byId.values()].find((n) => n.type === 'hemi-input')
      const param = (input?.data?.parameters ?? []).find((p) => p.key === binding.key)
      if (!param) {
        fail('binding-missing', `节点「${titleOf(node)}」引用了不存在的运行参数 ${binding.key}${binding.__from ? `（${binding.__from}）` : ''}`, node.id)
        continue
      }
      checkTypeCompat(node, binding, paramTypeOf(param), fail)
    } else if (binding.kind === 'node-output') {
      const upstream = byId.get(binding.nodeId)
      if (!upstream) {
        fail('binding-missing', `节点「${titleOf(node)}」引用了不存在的节点 ${binding.nodeId}${binding.__from ? `（${binding.__from}）` : ''}`, node.id)
        continue
      }
      if (!(ancestors.get(node.id) ?? new Set()).has(binding.nodeId)) {
        fail('binding-not-upstream', `节点「${titleOf(node)}」引用了非上游节点「${titleOf(upstream)}」的输出${binding.__from ? `（${binding.__from}）` : ''}`, node.id)
        continue
      }
      const fields = upstreamOutputFields(upstream)
      if (!fields.has(binding.key)) {
        fail('binding-missing-field', `节点「${titleOf(upstream)}」没有声明输出字段 ${binding.key}${binding.__from ? `（${binding.__from}）` : ''}`, node.id)
        continue
      }
      checkTypeCompat(node, binding, fields.get(binding.key), fail)
    }
  }
}

function paramTypeOf(param) {
  return param.type === 'enum' ? 'enum' : param.type
}

/** 节点可绑定输出字段 → 类型（输入节点按参数、人工输入按字段＋保留输出）。 */
export function upstreamOutputFields(upstream) {
  const fields = new Map()
  if (upstream.type === 'hemi-input') {
    for (const p of upstream.data?.parameters ?? []) {
      if (p?.key) fields.set(p.key, paramTypeOf(p))
    }
    return fields
  }
  if (upstream.type === 'hemi-human-input') {
    for (const field of upstream.data?.fields ?? []) {
      if (field?.key) fields.set(field.key, HUMAN_INPUT_FIELD_TYPES[field.type] ?? 'string')
    }
    for (const [key, type] of Object.entries(HUMAN_INPUT_RESERVED_OUTPUTS)) fields.set(key, type)
    return fields
  }
  for (const [key, schema] of Object.entries(upstream.data?.outputSchema?.properties ?? {})) {
    if (schema?.type) fields.set(key, schema.type)
  }
  return fields
}

function checkTypeCompat(node, binding, upstreamType, fail) {
  const wanted = binding.type ?? binding.acceptType
  if (!wanted) return // 未声明期望类型则不查（首期宽松）
  if (COMPATIBLE.has(`${upstreamType}:${wanted}`)) return
  fail(
    'binding-type-mismatch',
    `节点「${titleOf(node)}」的绑定需要 ${wanted}，上游提供 ${upstreamType}`,
    node.id
  )
}
