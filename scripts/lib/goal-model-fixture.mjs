/** Existing synthetic providers acknowledge the new independent completion check. */
export function replyToGoalCheck(body, res) {
  if (!body.messages?.some(message => message.role === 'system' && String(message.content).includes('［Hemi 目标完成校验］'))) return false;
  const content = JSON.stringify({status:'complete',reason:'本测试的预期结果已在工具与会话记录中提供',evidence:['合成提供者已完成本测试所定义的响应'],remaining:[],nextAction:''});
  res.writeHead(200, {'content-type':'text/event-stream'});
  res.end('data: '+JSON.stringify({choices:[{index:0,delta:{role:'assistant',content},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
  return true;
}
