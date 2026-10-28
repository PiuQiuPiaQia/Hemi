import test from 'node:test';
import assert from 'node:assert/strict';
import {moduleUnderTest} from '../../../packages/conversation-flow/test/compile.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {dependencySourcePath} from '../../../scripts/lib/dependency-source-path.mjs';
const {previewTarget, taskArtifactReference} = await moduleUnderTest('../../../apps/mobile/src/preview.ts');
const {flowPartsToTranscriptParts} = await moduleUnderTest('../src/core/transcript-parts-view.ts');

test('workflow drawer receives existing step facts rather than losing them in the transcript projection', () => {
  const nodes={step:{status:'succeeded',outputs:{proof:'完成记录'},log:[{at:1,tool:'read',kind:'tool-end'}]}};
  const [part]=flowPartsToTranscriptParts([{partId:'workflow',kind:'workflow-card',invocationId:'inv',nodes}]);
  assert.deepEqual(part.card.nodes,nodes);
});

test('one preview target replaces files, child details, reports and workflow records without a tab list', () => {
  let selection = previewTarget({type:'preview.open',target:'resource',resource:{id:'deliverable:a',version:'1'},targetId:'a'});
  assert.equal(selection.kind,'resource');
  selection = previewTarget({type:'preview.open',target:'task',taskId:'child',targetId:'child'});
  assert.deepEqual(selection,{kind:'task',taskId:'child',confirmStop:false});
  selection = previewTarget({type:'preview.open',target:'resource',resource:{id:'task-body:child',version:'1'},targetId:'child'});
  assert.deepEqual(selection,{kind:'report',taskId:'child'});
  selection = previewTarget({type:'preview.open',target:'workflow',invocationId:'inv',targetId:'inv'});
  assert.deepEqual(selection,{kind:'workflow',invocationId:'inv'});
  assert.deepEqual(taskArtifactReference({id:'task-artifact:child:artifact:a',version:'1'}),{taskId:'child',artifactId:'artifact:a'});
  assert.equal(taskArtifactReference({id:'task-artifact:child',version:'1'}),null);
});

test('license paths support the declared node_modules symlink while rejecting neighboring private files', async t => {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'hemi-license-path-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const repo=path.join(root,'repo'),cache=path.join(root,'cache');
  await fs.mkdir(repo);await fs.mkdir(cache);await fs.symlink(cache,path.join(repo,'node_modules'));
  assert.equal(dependencySourcePath(repo,path.join(cache,'package/LICENSE')),'node_modules/package/LICENSE');
  assert.equal(dependencySourcePath(repo,path.join(repo,'src/a.ts')),'src/a.ts');
  assert.throws(()=>dependencySourcePath(repo,path.join(root,'cache-other/private')),/outside/);
});
