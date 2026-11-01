import test from 'node:test';
import assert from 'node:assert/strict';
import {agentReplyText} from './agent-reply.mjs';

test('正文为空时按后台交接、提问及真实状态返回，不让用户重复派单', () => {
  assert.equal(agentReplyText({texts:[],waitingForBackground:true,toolNames:['task','report_progress']}),'任务已交接到后台，结果就绪后会继续处理。');
  assert.equal(agentReplyText({texts:['  实际结果  '],waitingForBackground:true}),'实际结果');
  assert.equal(agentReplyText({texts:[],waitingForUser:{question:'请选择工作区'}}),'请选择工作区');
  assert.equal(agentReplyText({texts:[],blocked:{reason:'文件尚未提供'}}),'文件尚未提供');
  assert.doesNotMatch(agentReplyText({texts:[],toolNames:['write']}),/再说|重试|重新/);
  assert.doesNotMatch(agentReplyText({texts:[]}),/再说|重试|重新/);
});
