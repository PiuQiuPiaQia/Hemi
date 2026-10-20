import assert from 'node:assert/strict';
import test from 'node:test';

import { validateWorkflowDocument, CONDITION_PORTS } from './workflow.mjs';

/** 图构造助手：seven-node 标准图（输入→agent→条件→skill/browser→desktop→交付）。 */
function buildGraph(overrides = {}) {
  const nodes = [
    { id: 'in', type: 'hemi-input', meta: { position: { x: 0, y: 0 } }, data: { title: '输入', parameters: [{ key: 'format', type: 'enum', options: ['ppt', 'text'] }, { key: 'topic', type: 'string', required: true }] } },
    { id: 'agent', type: 'hemi-agent', meta: { position: { x: 1, y: 0 } }, data: { title: '起草', goal: '按主题起草', inputBindings: [{ kind: 'parameter', key: 'topic', type: 'string' }], outputSchema: { type: 'object', properties: { draft: { type: 'string' } } } } },
    { id: 'cond', type: 'hemi-condition', meta: { position: { x: 2, y: 0 } }, data: { title: '分流', condition: { fieldRef: { kind: 'parameter', key: 'format', type: 'enum' }, operator: 'eq', value: 'ppt' } } },
    { id: 'skill', type: 'hemi-skill', meta: { position: { x: 3, y: -1 } }, data: { title: '美化', goal: '美化成 ppt', skillRefs: [{ name: 'weekly-report' }], inputBindings: [{ kind: 'node-output', nodeId: 'agent', key: 'draft', type: 'string' }], outputSchema: { type: 'object', properties: { deck: { type: 'file' } } } } },
    { id: 'browser', type: 'hemi-browser', meta: { position: { x: 3, y: 1 } }, data: { title: '取数', goal: '补数据', targetUrl: 'https://example.com', outputSchema: { type: 'object', properties: { table: { type: 'string' } } } } },
    { id: 'desk', type: 'hemi-desktop', meta: { position: { x: 4, y: 0 } }, data: { title: '排版', goal: '排版', applicationRef: 'com.apple.Keynote', outputSchema: { type: 'object', properties: { deck: { type: 'file' } } } } },
    { id: 'deliver', type: 'hemi-deliver', meta: { position: { x: 5, y: 0 } }, data: { title: '交付', summary: '本次报告', artifacts: [{ label: '报告', binding: { kind: 'node-output', nodeId: 'desk', key: 'deck', type: 'file' } }] } },
  ];
  const edges = [
    { sourceNodeID: 'in', targetNodeID: 'agent' },
    { sourceNodeID: 'agent', targetNodeID: 'cond' },
    { sourceNodeID: 'cond', targetNodeID: 'skill', sourcePortID: 'yes' },
    { sourceNodeID: 'cond', targetNodeID: 'browser', sourcePortID: 'else' },
    { sourceNodeID: 'skill', targetNodeID: 'desk' },
    { sourceNodeID: 'browser', targetNodeID: 'desk' },
    { sourceNodeID: 'desk', targetNodeID: 'deliver' },
  ];
  return applyOverrides({ nodes, edges }, overrides);
}

function applyOverrides(graph, overrides) {
  const nodes = overrides.removeNodes ? graph.nodes.filter((n) => !overrides.removeNodes.includes(n.id)) : graph.nodes;
  const patch = (id, data) => nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...data } } : n));
  let out = { nodes, edges: graph.edges };
  if (overrides.removeEdges) out = { ...out, edges: out.edges.filter((e) => !overrides.removeEdges.some((r) => r.sourceNodeID === e.sourceNodeID && r.targetNodeID === e.targetNodeID)) };
  if (overrides.addEdges) out = { ...out, edges: [...out.edges, ...overrides.addEdges] };
  if (overrides.patch) for (const [id, data] of Object.entries(overrides.patch)) out = { ...out, nodes: patch(id, data) };
  return out;
}

const codes = (result) => result.errors.map((e) => e.code);

test('标准七节点图（条件双支＋汇合）通过完整业务校验', () => {
  const result = validateWorkflowDocument(buildGraph());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('未知节点类型拒绝（不静默落成普通执行）', () => {
  const graph = buildGraph({ patch: { agent: { goal: 'x' } } });
  graph.nodes[1].type = 'hemi-unknown';
  const result = validateWorkflowDocument(graph);
  assert.ok(codes(result).includes('unknown-node-type'));
});

test('输入节点必须恰一个；缺输入/双输入都拒', () => {
  const noInput = validateWorkflowDocument(buildGraph({ removeNodes: ['in'] }));
  assert.ok(codes(noInput).includes('input-cardinality'));
  const twoInputs = buildGraph();
  twoInputs.nodes.push({ id: 'in2', type: 'hemi-input', meta: { position: { x: 0, y: 1 } }, data: { parameters: [{ key: 'a', type: 'string' }] } });
  const result = validateWorkflowDocument(twoInputs);
  assert.ok(codes(result).includes('input-cardinality'));
});

test('缺交付节点拒；不可达交付的节点带定位', () => {
  const noDeliver = validateWorkflowDocument(buildGraph({ removeNodes: ['deliver'], removeEdges: [{ sourceNodeID: 'desk', targetNodeID: 'deliver' }] }));
  assert.ok(codes(noDeliver).includes('no-delivery'));
  const stranded = validateWorkflowDocument(buildGraph({ patch: { browser: { goal: '孤岛' } } }));
  // browser 仍在主链上可达；构造真孤岛：加一个到不了交付的节点
  const g = buildGraph();
  g.nodes.push({ id: 'stray', type: 'hemi-agent', meta: { position: { x: 9, y: 9 } }, data: { goal: '游离' } });
  const result = validateWorkflowDocument(g);
  const unreachable = result.errors.filter((e) => e.code === 'unreachable-delivery');
  assert.ok(unreachable.some((e) => e.nodeId === 'stray'), JSON.stringify(unreachable));
});

test('环拒绝', () => {
  // 交付出边／输入入边被方向规则先拒；环只在中间节点间构造（desk → agent 逆行）
  const result = validateWorkflowDocument(buildGraph({ addEdges: [{ sourceNodeID: 'desk', targetNodeID: 'agent' }] }));
  assert.ok(codes(result).includes('cycle'), JSON.stringify(result.errors));
});

test('自连、重复边、输入入边、交付出边分别拒绝且带 nodeId', () => {
  const selfLoop = validateWorkflowDocument(buildGraph({ addEdges: [{ sourceNodeID: 'agent', targetNodeID: 'agent' }] }));
  assert.ok(codes(selfLoop).includes('self-edge'));
  const dup = validateWorkflowDocument(buildGraph({ addEdges: [{ sourceNodeID: 'in', targetNodeID: 'agent' }] }));
  assert.ok(codes(dup).includes('duplicate-edge'));
  const inEdge = validateWorkflowDocument(buildGraph({ addEdges: [{ sourceNodeID: 'agent', targetNodeID: 'in' }] }));
  assert.ok(codes(inEdge).includes('input-in-edge'));
  const outEdge = validateWorkflowDocument(buildGraph({ addEdges: [{ sourceNodeID: 'deliver', targetNodeID: 'desk' }] }));
  assert.ok(codes(outEdge).includes('deliver-out-edge'));
});

test('条件双端口必须都有连线；未知端口拒绝', () => {
  const missingElse = validateWorkflowDocument(buildGraph({ removeEdges: [{ sourceNodeID: 'cond', targetNodeID: 'browser' }] }));
  assert.ok(codes(missingElse).includes('condition-port-missing'));
  const badPort = validateWorkflowDocument(buildGraph({ removeEdges: [{ sourceNodeID: 'cond', targetNodeID: 'browser' }], addEdges: [{ sourceNodeID: 'cond', targetNodeID: 'browser', sourcePortID: 'maybe' }] }));
  assert.ok(codes(badPort).includes('invalid-port'));
});

test('第三方路径汇入分支控制域被保守拒绝（unsafe-branch-merge）', () => {
  // 旁路节点 aux（不经 agent）直接汇入 desk：aux 既不在条件两支闭包内也不支配 desk
  const graph = buildGraph();
  graph.nodes.push({ id: 'aux', type: 'hemi-agent', meta: { position: { x: 9, y: 9 } }, data: { goal: '旁路' } });
  graph.edges.push({ sourceNodeID: 'in', targetNodeID: 'aux' }, { sourceNodeID: 'aux', targetNodeID: 'desk' });
  const result = validateWorkflowDocument(graph);
  const unsafe = result.errors.filter((e) => e.code === 'unsafe-branch-merge');
  assert.ok(unsafe.length > 0, JSON.stringify(result.errors));
});

test('agent 直连汇合点不误报（agent 是 desk 的必经节点，受支配规则保护）', () => {
  const result = validateWorkflowDocument(buildGraph({ addEdges: [{ sourceNodeID: 'agent', targetNodeID: 'desk' }] }));
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('必经前驱汇入分支域不误报（in 节点支配全图）', () => {
  // 输入节点直接连 skill（skill 的前驱：in＋cond）。in 支配 skill → 不拒。
  const result = validateWorkflowDocument(buildGraph({ addEdges: [{ sourceNodeID: 'in', targetNodeID: 'skill' }] }));
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('绑定：参数缺失、非上游引用、字段缺失、类型不兼容分别拒绝', () => {
  const missingParam = validateWorkflowDocument(buildGraph({ patch: { agent: { inputBindings: [{ kind: 'parameter', key: 'nope', type: 'string' }] } } }));
  assert.ok(codes(missingParam).includes('binding-missing'));
  const notUpstream = validateWorkflowDocument(buildGraph({ patch: { skill: { inputBindings: [{ kind: 'node-output', nodeId: 'desk', key: 'deck', type: 'file' }] } } }));
  assert.ok(codes(notUpstream).includes('binding-not-upstream'));
  const missingField = validateWorkflowDocument(buildGraph({ patch: { skill: { inputBindings: [{ kind: 'node-output', nodeId: 'agent', key: 'ghost', type: 'string' }] } } }));
  assert.ok(codes(missingField).includes('binding-missing-field'));
  const badType = validateWorkflowDocument(buildGraph({ patch: { skill: { inputBindings: [{ kind: 'node-output', nodeId: 'agent', key: 'draft', type: 'file' }] } } }));
  assert.ok(codes(badType).includes('binding-type-mismatch'));
});

test('条件 fieldRef 与交付产物绑定纳入校验', () => {
  const badCond = validateWorkflowDocument(buildGraph({ patch: { cond: { condition: { fieldRef: { kind: 'parameter', key: 'ghost', type: 'enum' }, operator: 'eq' } } } }));
  assert.ok(codes(badCond).includes('binding-missing'));
  const badArtifact = validateWorkflowDocument(buildGraph({ patch: { deliver: { artifacts: [{ label: 'x', binding: { kind: 'node-output', nodeId: 'desk', key: 'nope', type: 'file' } }] } } }));
  assert.ok(codes(badArtifact).includes('binding-missing-field'));
});

test('节点必填字段：goal/Skill 引用/URL/应用身份/交付说明/条件配置缺失分别拒绝', () => {
  const noGoal = validateWorkflowDocument(buildGraph({ patch: { agent: { goal: '  ' } } }));
  assert.ok(codes(noGoal).includes('missing-goal'));
  const noSkill = validateWorkflowDocument(buildGraph({ patch: { skill: { skillRefs: [] } } }));
  assert.ok(codes(noSkill).includes('missing-skill-ref'));
  const noUrl = validateWorkflowDocument(buildGraph({ patch: { browser: { targetUrl: '' } } }));
  assert.ok(codes(noUrl).includes('missing-browser-target'));
  const noApp = validateWorkflowDocument(buildGraph({ patch: { desk: { applicationRef: '' } } }));
  assert.ok(codes(noApp).includes('missing-desktop-app'));
  const noSummary = validateWorkflowDocument(buildGraph({ patch: { deliver: { summary: '' } } }));
  assert.ok(codes(noSummary).includes('missing-delivery-summary'));
  const noCond = validateWorkflowDocument(buildGraph({ patch: { cond: { condition: null } } }));
  assert.ok(codes(noCond).includes('missing-condition'));
});

test('输入参数校验：允许零输入，拒绝缺失声明、重复 key、非法类型和空枚举', () => {
  const empty = validateWorkflowDocument(buildGraph({ patch: { in: { parameters: [] } } }));
  assert.ok(!codes(empty).includes('input-no-parameters'), '零输入合法；图中其它失效绑定仍各自报错');
  assert.ok(codes(validateWorkflowDocument(buildGraph({ patch: { in: { parameters: null } } }))).includes('input-no-parameters'));
  const dup = validateWorkflowDocument(buildGraph({ patch: { in: { parameters: [{ key: 'a', type: 'string' }, { key: 'a', type: 'string' }] } } }));
  assert.ok(codes(dup).includes('duplicate-parameter'));
  const badType = validateWorkflowDocument(buildGraph({ patch: { in: { parameters: [{ key: 'a', type: 'wav' }] } } }));
  assert.ok(codes(badType).includes('invalid-parameter-type'));
  const noOptions = validateWorkflowDocument(buildGraph({ patch: { in: { parameters: [{ key: 'a', type: 'enum' }] } } }));
  assert.ok(codes(noOptions).includes('enum-no-options'));
});

test('空文档与缺字段输入快速失败', () => {
  assert.equal(validateWorkflowDocument(null).valid, false);
  assert.equal(validateWorkflowDocument({ nodes: [] }).valid, false);
});

test('CONDITION_PORTS 契约固定为 yes/else', () => {
  assert.deepEqual(CONDITION_PORTS, ['yes', 'else']);
});

test('普通执行缺预期输出或声明未知输出类型，不能保存为可运行版本',()=>{
  const missing=buildGraph();delete missing.nodes.find(node=>node.type==='hemi-agent').data.outputSchema;
  assert.ok(validateWorkflowDocument(missing).errors.some(issue=>issue.code==='missing-output'));
  const invalid=buildGraph();invalid.nodes.find(node=>node.type==='hemi-agent').data.outputSchema.properties.draft.type='imaginary';
  assert.ok(validateWorkflowDocument(invalid).errors.some(issue=>issue.code==='invalid-output'));
});

test('数字比较值保持数字类型，拒绝把输入框的文本直接作为条件常量',()=>{
 const graph=buildGraph(),param=graph.nodes.find(n=>n.type==='hemi-input').data.parameters.find(p=>p.key==='format'),condition=graph.nodes.find(n=>n.type==='hemi-condition').data.condition;
 param.type='number';condition.fieldRef.type='number';condition.value='2';
 assert.ok(validateWorkflowDocument(graph).errors.some(issue=>issue.code==='invalid-condition'));
 condition.value=2;assert.equal(validateWorkflowDocument(graph).valid,true);
});

// ── 人工输入（hemi-human-input，HI 通用节点）──

import {
  parseHumanInputContentVars,
  humanInputPorts,
  HUMAN_INPUT_TIMEOUT_PORT,
} from './workflow.mjs';

/** 人工输入标准图：输入 → 起草 → 人工输入（两动作分支）→ 双交付。 */
function buildHumanInputGraph(overrides = {}) {
  const nodes = [
    { id: 'in', type: 'hemi-input', meta: { position: { x: 0, y: 0 } }, data: { title: '输入', parameters: [{ key: 'topic', type: 'string', required: true }] } },
    { id: 'agent', type: 'hemi-agent', meta: { position: { x: 1, y: 0 } }, data: { title: '起草', goal: '按主题起草', inputBindings: [{ kind: 'parameter', key: 'topic', type: 'string' }], outputSchema: { type: 'object', properties: { draft: { type: 'string' }, ideas: { type: 'array' } } } } },
    {
      id: 'hi', type: 'hemi-human-input', meta: { position: { x: 2, y: 0 } },
      data: {
        title: '确认方向',
        content: '草稿如下：\n{{agent.draft}}',
        fields: [
          { fieldId: 'f-comment', key: 'comment', label: '批注', type: 'text', required: false, config: { prefillText: '默认意见' } },
          { fieldId: 'f-plan', key: 'plan', label: '方案', type: 'choice', required: true, config: { optionsBinding: { kind: 'node-output', nodeId: 'agent', key: 'ideas', type: 'array' } } },
          { fieldId: 'f-proof', key: 'proof', label: '补充材料', type: 'file', required: false },
        ],
        actions: [
          { actionId: 'approve', label: '通过', primary: true, requiredKeys: ['comment'] },
          { actionId: 'revise', label: '再改一版' },
        ],
        wait: { mode: 'forever' },
      },
    },
    { id: 'okDeliver', type: 'hemi-deliver', meta: { position: { x: 3, y: -1 } }, data: { title: '定稿交付', summary: '定稿', artifacts: [{ label: '定稿', binding: { kind: 'node-output', nodeId: 'hi', key: 'comment', type: 'string' } }] } },
    { id: 'redoDeliver', type: 'hemi-deliver', meta: { position: { x: 3, y: 1 } }, data: { title: '重做交付', summary: '重做', artifacts: [] } },
  ];
  const edges = [
    { sourceNodeID: 'in', targetNodeID: 'agent' },
    { sourceNodeID: 'agent', targetNodeID: 'hi' },
    { sourceNodeID: 'hi', targetNodeID: 'okDeliver', sourcePortID: 'approve' },
    { sourceNodeID: 'hi', targetNodeID: 'redoDeliver', sourcePortID: 'revise' },
  ];
  const graph = { nodes, edges };
  if (overrides.patchHi) {
    const hi = graph.nodes.find((n) => n.id === 'hi');
    hi.data = { ...hi.data, ...overrides.patchHi };
  }
  if (overrides.addNodes) graph.nodes.push(...overrides.addNodes);
  if (overrides.removeEdges) graph.edges = graph.edges.filter((e) => !overrides.removeEdges.some((r) => r.sourcePortID === e.sourcePortID && r.targetNodeID === e.targetNodeID && r.sourceNodeID === e.sourceNodeID));
  if (overrides.addEdges) graph.edges.push(...overrides.addEdges);
  return graph;
}

test('人工输入标准图（内容变量＋动态选项＋按动作必填＋双分支）通过完整校验', () => {
  const result = validateWorkflowDocument(buildHumanInputGraph());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('人工输入缺内容／空操作集／字段 key 保留前缀分别拒绝', () => {
  const noContent = validateWorkflowDocument(buildHumanInputGraph({ patchHi: { content: ' ' } }));
  assert.ok(codes(noContent).includes('human-input-content-missing'));
  const noActions = validateWorkflowDocument(buildHumanInputGraph({ patchHi: { actions: [] } }));
  assert.ok(codes(noActions).includes('human-input-invalid'));
  const reservedKey = buildHumanInputGraph();
  reservedKey.nodes.find((n) => n.id === 'hi').data.fields[0].key = '__action_id';
  assert.ok(codes(validateWorkflowDocument(reservedKey)).includes('human-input-invalid'));
});

test('单选字段缺选项来源、选项来源类型不符分别定位拒绝', () => {
  const noOptions = buildHumanInputGraph();
  const plan = noOptions.nodes.find((n) => n.id === 'hi').data.fields.find((f) => f.key === 'plan');
  delete plan.config.optionsBinding;
  assert.ok(codes(validateWorkflowDocument(noOptions)).includes('human-input-invalid'));
  const badType = buildHumanInputGraph();
  badType.nodes.find((n) => n.id === 'hi').data.fields.find((f) => f.key === 'plan').config.optionsBinding = { kind: 'node-output', nodeId: 'agent', key: 'draft', type: 'array' };
  assert.ok(codes(validateWorkflowDocument(badType)).includes('binding-type-mismatch'));
});

test('双主按钮、操作 ID 重复／占用 timeout、额外必填字段不存在都拒绝', () => {
  const twoPrimary = buildHumanInputGraph();
  twoPrimary.nodes.find((n) => n.id === 'hi').data.actions[1].primary = true;
  assert.ok(codes(validateWorkflowDocument(twoPrimary)).includes('human-input-invalid'));
  const reserved = buildHumanInputGraph();
  reserved.nodes.find((n) => n.id === 'hi').data.actions[1].actionId = 'timeout';
  assert.ok(codes(validateWorkflowDocument(reserved)).includes('human-input-invalid'));
  const ghostRequired = buildHumanInputGraph();
  ghostRequired.nodes.find((n) => n.id === 'hi').data.actions[0].requiredKeys = ['nope'];
  assert.ok(codes(validateWorkflowDocument(ghostRequired)).includes('human-input-invalid'));
});

test('动作出口未连线／超时出口缺失定位到节点；未知端口拒绝', () => {
  const unwired = validateWorkflowDocument(buildHumanInputGraph({ removeEdges: [{ sourceNodeID: 'hi', sourcePortID: 'revise', targetNodeID: 'redoDeliver' }] }));
  assert.ok(codes(unwired).includes('human-input-port-missing'));
  const timeoutNoWire = validateWorkflowDocument(buildHumanInputGraph({ patchHi: { wait: { mode: 'timeout', timeoutMs: 60000 } } }));
  assert.ok(codes(timeoutNoWire).includes('human-input-port-missing'));
  const timeoutWired = buildHumanInputGraph({
    patchHi: { wait: { mode: 'timeout', timeoutMs: 60000 } },
    addEdges: [{ sourceNodeID: 'hi', targetNodeID: 'redoDeliver', sourcePortID: HUMAN_INPUT_TIMEOUT_PORT }],
  });
  assert.equal(validateWorkflowDocument(timeoutWired).valid, true, JSON.stringify(validateWorkflowDocument(timeoutWired).errors));
  const badPort = buildHumanInputGraph();
  badPort.edges[2].sourcePortID = 'unknown-port';
  assert.ok(codes(validateWorkflowDocument(badPort)).includes('invalid-port'));
});

test('内容变量引用不存在节点／非上游／缺失字段明确定位', () => {
  const missingNode = buildHumanInputGraph({ patchHi: { content: '{{ghost.key}}' } });
  assert.ok(codes(validateWorkflowDocument(missingNode)).includes('binding-missing'));
  const missingField = buildHumanInputGraph({ patchHi: { content: '{{agent.nope}}' } });
  assert.ok(codes(validateWorkflowDocument(missingField)).includes('binding-missing-field'));
  // 非上游：交付节点不在 hi 上游
  const notUpstream = buildHumanInputGraph({ patchHi: { content: '{{okDeliver.comment}}' } });
  assert.ok(codes(validateWorkflowDocument(notUpstream)).includes('binding-not-upstream'));
});

test('下游绑定人工输入字段与保留输出按映射类型校验', () => {
  const graph = buildHumanInputGraph();
  graph.nodes.find((n) => n.id === 'okDeliver').data.artifacts = [
    { label: '批注', binding: { kind: 'node-output', nodeId: 'hi', key: 'comment', type: 'string' } },
    { label: '动作', binding: { kind: 'node-output', nodeId: 'hi', key: '__action_id', type: 'string' } },
    { label: '材料', binding: { kind: 'node-output', nodeId: 'hi', key: 'proof', type: 'file' } },
  ];
  assert.equal(validateWorkflowDocument(graph).valid, true, JSON.stringify(validateWorkflowDocument(graph).errors));
  graph.nodes.find((n) => n.id === 'okDeliver').data.artifacts = [
    { label: '材料', binding: { kind: 'node-output', nodeId: 'hi', key: 'proof', type: 'string' } },
  ];
  assert.ok(codes(validateWorkflowDocument(graph)).includes('binding-type-mismatch'));
});

test('第三方路径半途汇入人工输入分支域拒绝（N 路支配规则）', () => {
  // in → agent → {hi(approve→okDeliver, revise→redoDeliver), side→okDeliver}：
  // side 不在任一分支闭包内、也不支配 okDeliver（绕过 side 也能到 okDeliver）→ 拒。
  const graph = buildHumanInputGraph({
    addNodes: [{ id: 'side', type: 'hemi-agent', meta: { position: { x: 2, y: 2 } }, data: { title: '旁路', goal: '旁路任务', inputBindings: [], outputSchema: { type: 'object', properties: { note: { type: 'string' } } } } }],
    addEdges: [
      { sourceNodeID: 'agent', targetNodeID: 'side' },
      { sourceNodeID: 'side', targetNodeID: 'okDeliver' },
    ],
  });
  assert.ok(codes(validateWorkflowDocument(graph)).includes('unsafe-branch-merge'));
});

test('parseHumanInputContentVars 去重保序；humanInputPorts 含超时端口', () => {
  const vars = parseHumanInputContentVars('a {{n1.k1}} b {{n1.k1}} {{n2.k2}}');
  assert.deepEqual(vars, [{ nodeId: 'n1', key: 'k1' }, { nodeId: 'n2', key: 'k2' }]);
  const node = { data: { actions: [{ actionId: 'go' }, { actionId: 'back' }] } };
  assert.deepEqual(humanInputPorts(node), ['go', 'back']);
  assert.deepEqual(humanInputPorts({ data: { actions: [{ actionId: 'go' }], wait: { mode: 'timeout', timeoutMs: 1 } } }), ['go', 'timeout']);
});
