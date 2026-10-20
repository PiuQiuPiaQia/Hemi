// 059 强退恢复验证的运行子进程（由 verify-059-crash-recovery.mjs spawn）：
//   run       建 invocation（direct）并以慢 executor 跑（写 marker 后挂起 8s，期间被 SIGKILL）
//   readonly  只读恢复：不调 runner.run，打印中断态与产物存在性（R-18）
//   continue  用户显式继续：持久事实构造回放缓存，零外部动作重放跑完
import fs from 'node:fs'
import path from 'node:path'
import { createInvocationStore } from '../src/main/workflows/invocation-store.mjs'
import { createWorkflowRunner } from '../src/main/workflows/workflow-runner.mjs'

const mode = process.argv[2] ?? process.argv[1]
const workflowsDir = process.env.CRASH_WORKFLOWS_DIR
const artifact = process.env.CRASH_ARTIFACT
const marker = process.env.CRASH_MARKER
const store = createInvocationStore({ dir: workflowsDir })

const document = {
  nodes: [
    { id: 'in', type: 'hemi-input', meta: {}, data: { parameters: [] } },
    { id: 'sk', type: 'hemi-skill', meta: {}, data: { title: '交付', goal: '写产物', skillRefs: [{ name: 'demo' }], outputSchema: { type: 'object', properties: { deck: { type: 'file' } } } } },
    { id: 'deliver', type: 'hemi-deliver', meta: {}, data: { title: '交付', summary: 's', artifacts: [{ label: 'deck', binding: { kind: 'node-output', nodeId: 'sk', key: 'deck', type: 'file' } }] } },
  ],
  edges: [
    { sourceNodeID: 'in', targetNodeID: 'sk' },
    { sourceNodeID: 'sk', targetNodeID: 'deliver' },
  ],
}

const makeExecutors = (replayCache = null) => ({
  'hemi-skill': {
    async execute(ctx) {
      if (replayCache?.has(ctx.node.id)) {
        const cached = replayCache.get(ctx.node.id)
        return { outputs: cached.outputs, branch: cached.branch }
      }
      fs.writeFileSync(marker, 'running', 'utf8')
      await new Promise((r) => setTimeout(r, 8000)) // 模拟在途慢任务（期间被 SIGKILL）
      fs.writeFileSync(artifact, '交付内容', 'utf8')
      return { outputs: { deck: artifact } }
    },
  },
})

if (mode === 'run') {
  const invocation = await store.createInvocation({ workflowId: 'wf-crash', definitionRevision: 1, document, entryMode: 'direct' })
  await store.applyPreparation(invocation.invocationId,{values:{},issues:[]})
  await store.start(invocation.invocationId, {
    requestId: 'req-crash',
    buildRun: (inv) => ({ workflowRunId: inv.workflowRunId, definitionRevision: 1, frozenValues: {}, frozenDocument: inv.documentSnapshot, status: 'queued', nodes: {} }),
  })
  const runner = createWorkflowRunner({ invocationStore: store, executors: makeExecutors(), verifyArtifact: (p) => ({ ok: fs.existsSync(p) }) })
  const outcome = await runner.run({ invocationId: invocation.invocationId })
  console.log(`RUN_OUTCOME ${outcome.status}`)
  process.exit(0)
}

const invocationId = fs
  .readdirSync(path.join(workflowsDir, 'invocations'))
  .filter((f) => f.startsWith('inv-') && !f.startsWith('._'))
  .map((f) => f.replace(/\.json$/, ''))
  [0]

if (mode === 'readonly') {
  // 只读恢复：不调 runner.run——重开显示中断与已有结果，不自动重放（R-18）
  const invocation = await store.get(invocationId)
  console.log('READONLY ' + JSON.stringify({
    status: invocation.run?.status ?? null,
    skStatus: invocation.run?.nodes?.sk?.status ?? null,
    artifactExists: fs.existsSync(artifact),
  }))
  process.exit(0)
}

if (mode === 'continue') {
  const invocation = await store.get(invocationId)
  const replayCache = new Map(
    Object.entries(invocation.run?.nodes ?? {})
      .filter(([, fact]) => fact.status === 'succeeded')
      .map(([nodeId, fact]) => [nodeId, { outputs: fact.outputs ?? {}, branch: fact.branch ?? undefined }]),
  )
  const before = fs.existsSync(artifact) ? fs.statSync(artifact).mtimeMs : 0
  const runner = createWorkflowRunner({ invocationStore: store, executors: makeExecutors(replayCache), verifyArtifact: (p) => ({ ok: fs.existsSync(p) }) })
  const outcome = await runner.run({ invocationId, replayCache })
  const after = fs.existsSync(artifact) ? fs.statSync(artifact).mtimeMs : 0
  console.log(`CONTINUE ${JSON.stringify({ status: outcome.status, noReplay: before === after })}`)
  process.exit(0)
}
