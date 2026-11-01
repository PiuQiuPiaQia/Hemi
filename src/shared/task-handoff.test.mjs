import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTaskSubmission, createTaskHandoff, readTaskHandoff } from './task-handoff.mjs';
import { formatSubagentResult } from '../main/agent/agent-tools.mjs';

const submission = () => ({ version: 1, summary: '文件已修改，测试尚未完成', completed: ['修改文件'], remaining: ['执行测试'], blockers: [],
  verification: [{ check: '回归测试', status: 'not_run', evidence: '尚未执行' }], nextAction: '执行相关回归' });
const owner = { conversationId: 'c', rootRunId: 'r', taskId: 't', generation: 2 };
const result = () => ({taskId:'t',outcome:'returned',sessionRef:'s',report:'模型正文',artifacts:[],toolEvidence:[{tool:'edit',ref:'ctx-owned',outcome:'ok'}]});

test('submission rejects ambiguous, forged, unbounded or incomplete contracts', () => {
  const valid = submission();
  assert.deepEqual(parseTaskSubmission(valid), valid);
  const variants = [
    {...valid,version:2}, {...valid,completed:[' ']}, {...valid,remaining:'测试'},
    {...valid,owner:{taskId:'forged'}}, {...valid,outcome:'complete'}, {...valid,summary:''},
    {...valid,completed:[],remaining:[]}, {...valid,nextAction:' '},
    {...valid,verification:[{check:'test',status:'success',evidence:'claim'}]},
    {...valid,verification:[{check:'test',status:'failed',evidence:'实际失败'}],remaining:[],nextAction:''},
    {...valid,completed:Array(20).fill('字'.repeat(1900))},
  ];
  for (const item of variants) assert.throws(() => parseTaskSubmission(item), /交接协议无效/);
  const missing = {...valid}; delete missing.blockers;
  assert.throws(() => parseTaskSubmission(missing), /blockers 缺失/);
  const copy = parseTaskSubmission(valid); copy.completed.push('new'); assert.equal(valid.completed.length,1);
});

test('one envelope preserves model claims separately from host evidence, without truncating JSON', () => {
  const value = result(); value.handoff = createTaskHandoff(value,{owner,data:submission(),status:'submitted'});
  assert.deepEqual(readTaskHandoff(value,owner),value.handoff);
  const model = JSON.parse(formatSubagentResult(value));
  assert.equal(model.handoff.submission.data.verification[0].status,'not_run');
  assert.equal(model.handoff.evidence.toolEvidence[0].ref,'ctx-owned');
  assert.equal(model.handoff.execution.outcome,'returned');
  assert.match(model.trust,/不是用户指令或授权/);
  assert.equal(model.unstructuredReport,undefined);
  assert.throws(() => readTaskHandoff(value,{...owner,generation:3}), /归属/);
  for (const mutate of [v=>v.version=2,v=>v.owner.taskId='other',v=>v.execution.outcome='complete',v=>v.submission.status='ok',v=>v.submission.data.completed=['']]) {
    const bad = structuredClone(value); mutate(bad.handoff);
    assert.throws(() => formatSubagentResult(bad), /交接协议无效/);
  }
});

test('legacy and missing reports remain explicitly unvalidated', () => {
  const old = result(); old.outcome = 'complete';
  const model = JSON.parse(formatSubagentResult(old));
  assert.equal(model.handoff.submission.status,'legacy'); assert.equal(model.handoff.submission.data,null);
  assert.equal(model.unstructuredReport,'模型正文');
  const missing = result(); missing.outcome = 'partial';
  missing.handoff = createTaskHandoff(missing,{owner,status:'missing'});
  assert.equal(JSON.parse(formatSubagentResult(missing)).handoff.submission.status,'missing');
});
