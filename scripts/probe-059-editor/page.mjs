// 059 P01 编辑器探针页面：真实 React 19 + @flowgram.ai/free-layout-editor@1.0.16。
// 七种 hemi 节点类型注册＋初始文档加载＋DOM 渲染＋JSON round-trip。
// 断言结果写 window.__runProbe()，由 Electron 壳轮询收集；页面自身不感知 Electron。
import 'reflect-metadata'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { FreeLayoutEditor } from '@flowgram.ai/free-layout-editor'

const { createElement: h } = React

// ---------- 七种 Hemi 节点注册 ----------

const nodeRender = (props) =>
  h(
    'div',
    {
      className: 'hemi-probe-node',
      style: {
        padding: '8px 12px',
        border: '1px solid #4d60a6',
        borderRadius: 8,
        background: '#fff',
        minWidth: 160,
        fontSize: 12,
      },
    },
    `${props.node?.formModel?.formItem?.title ?? ''}${props.node.id}`.trim()
  )

const baseMeta = { size: { width: 200, height: 56 } }
const REGISTRIES = [
  { type: 'hemi-input', meta: baseMeta, defaultData: { title: '输入' }, render: nodeRender },
  {
    type: 'hemi-condition',
    meta: {
      ...baseMeta,
      defaultPorts: [
        { portID: 'yes', type: 'output' },
        { portID: 'no', type: 'output' },
      ],
    },
    defaultData: { title: '条件' },
    render: nodeRender,
  },
  { type: 'hemi-agent', meta: baseMeta, defaultData: { title: '普通执行' }, render: nodeRender },
  { type: 'hemi-skill', meta: baseMeta, defaultData: { title: 'Skill' }, render: nodeRender },
  { type: 'hemi-browser', meta: baseMeta, defaultData: { title: '浏览器操作' }, render: nodeRender },
  { type: 'hemi-desktop', meta: baseMeta, defaultData: { title: '桌面操作' }, render: nodeRender },
  { type: 'hemi-deliver', meta: baseMeta, defaultData: { title: '交付' }, render: nodeRender },
]

// ---------- 初始文档（round-trip 输入） ----------

const INITIAL = {
  nodes: [
    { id: 'in-1', type: 'hemi-input', meta: { position: { x: 100, y: 200 } }, data: { title: '输入', parameters: [{ key: 'format', type: 'string', required: true }] } },
    { id: 'agent-1', type: 'hemi-agent', meta: { position: { x: 400, y: 200 } }, data: { title: '起草', goal: '按主题起草' } },
    { id: 'cond-1', type: 'hemi-condition', meta: { position: { x: 700, y: 200 } }, data: { title: '格式分流', fieldRef: { kind: 'parameter', key: 'format' } } },
    { id: 'skill-1', type: 'hemi-skill', meta: { position: { x: 1000, y: 100 } }, data: { title: '美化', skillRefs: ['weekly-report'] } },
    { id: 'browser-1', type: 'hemi-browser', meta: { position: { x: 1000, y: 300 } }, data: { title: '取数', targetUrl: 'https://example.com' } },
    { id: 'desk-1', type: 'hemi-desktop', meta: { position: { x: 1300, y: 200 } }, data: { title: '排版', applicationRef: 'Keynote' } },
    { id: 'del-1', type: 'hemi-deliver', meta: { position: { x: 1600, y: 200 } }, data: { title: '交付', summary: '本次报告' } },
  ],
  edges: [
    { id: 'e1', sourceNodeID: 'in-1', targetNodeID: 'agent-1' },
    { id: 'e2', sourceNodeID: 'agent-1', targetNodeID: 'cond-1' },
    { id: 'e3', sourceNodeID: 'cond-1', targetNodeID: 'skill-1', sourcePortID: 'yes' },
    { id: 'e4', sourceNodeID: 'cond-1', targetNodeID: 'browser-1', sourcePortID: 'no' },
    { id: 'e5', sourceNodeID: 'skill-1', targetNodeID: 'desk-1' },
    { id: 'e6', sourceNodeID: 'browser-1', targetNodeID: 'desk-1' },
    { id: 'e7', sourceNodeID: 'desk-1', targetNodeID: 'del-1' },
  ],
}

// ---------- 挂载 ----------

const editorRef = React.createRef()
function App() {
  return h(FreeLayoutEditor, {
    ref: editorRef,
    nodeRegistries: REGISTRIES,
    initialData: INITIAL,
    readonly: false,
  })
}
createRoot(document.getElementById('root')).render(h(App))

// ---------- 探针断言（由壳轮询调用） ----------

const num = (v) => (typeof v === 'number' ? Math.round(v) : v)
function normalizeNode(n) {
  return {
    id: n.id,
    type: n.type,
    x: num(n.meta?.position?.x),
    y: num(n.meta?.position?.y),
    data: n.data ?? {},
  }
}
function normalizeEdge(e) {
  return {
    sourceNodeID: e.sourceNodeID,
    targetNodeID: e.targetNodeID,
    sourcePortID: e.sourcePortID,
    targetPortID: e.targetPortID,
  }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

window.__runProbe = function runProbe() {
  if (!editorRef.current) return null
  const checks = []
  const record = (id, claim, ok, detail) => {
    checks.push({ id, claim, ok, detail })
  }

  const ctx = editorRef.current
  record('A1', '编辑器挂载：ref 上下文可用且带 document', Boolean(ctx && ctx.document), { hasCtx: Boolean(ctx) })

  let json1, json2
  try {
    json1 = ctx.document.toJSON()
    json2 = ctx.document.toJSON()
  } catch (e) {
    record('A2', 'toJSON 可调用', false, String(e))
    return { checks, pass: false, react: React.version }
  }
  record('A2', 'toJSON 连续两次稳定', same(json1, json2), {})

  const outNodes = (json1.nodes ?? []).map(normalizeNode)
  const inNodes = INITIAL.nodes.map(normalizeNode)
  const byId = new Map(outNodes.map((n) => [n.id, n]))
  const missing = inNodes.filter((n) => !byId.has(n.id))
  const dataMismatch = inNodes.filter((n) => byId.has(n.id) && !same({ ...byId.get(n.id), x: 0, y: 0 }, { ...n, x: 0, y: 0 }))
  const posMismatch = inNodes.filter((n) => {
    const o = byId.get(n.id)
    return o && (Math.abs(o.x - n.x) > 1 || Math.abs(o.y - n.y) > 1)
  })
  record(
    'A3',
    'round-trip 节点：7 个 id/type 全在、data 深等、position 误差 ≤1px',
    missing.length === 0 && dataMismatch.length === 0 && posMismatch.length === 0,
    { missing: missing.map((n) => n.id), dataMismatch: dataMismatch.map((n) => n.id), posMismatch: posMismatch.map((n) => n.id) }
  )

  const types = new Set(outNodes.map((n) => n.type))
  const allTypes = REGISTRIES.map((r) => r.type).every((t) => types.has(t))
  record('A4', '七种 hemi-* 类型全部被文档接受（未丢未改）', allTypes, [...types].sort())

  const outEdges = (json1.edges ?? []).map(normalizeEdge)
  const inEdges = INITIAL.edges.map(normalizeEdge)
  const edgeKey = (e) => `${e.sourceNodeID}|${e.sourcePortID ?? ''}|${e.targetNodeID}|${e.targetPortID ?? ''}`
  const outKeys = new Set(outEdges.map(edgeKey))
  const lostEdges = inEdges.filter((e) => !outKeys.has(edgeKey(e)))
  record('A5', 'round-trip 边：7 条（含条件双端口）四字段全保留', lostEdges.length === 0, {
    edgeCount: outEdges.length,
    lost: lostEdges.map(edgeKey),
  })

  const renderedIds = new Set(
    Array.from(document.querySelectorAll('[data-node-id]')).map((el) => el.getAttribute('data-node-id'))
  )
  const unrendered = INITIAL.nodes.filter((n) => !renderedIds.has(n.id))
  record('A6', '七节点 DOM 渲染（data-node-id 齐全）', unrendered.length === 0, {
    rendered: renderedIds.size,
    unrendered: unrendered.map((n) => n.id),
  })

  const pass = checks.every((c) => c.ok)
  return { checks, pass, react: React.version }
}
