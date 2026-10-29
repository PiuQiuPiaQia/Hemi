/**
 * 057 对话流 IPC 桥（S2，契约 §1/§3/§7）：flow:command / flow:getSnapshot /
 * flow:changed 三个入口。控制器与写入器由 conversation-flow-service 持有
 * （llm.ipc 在同一服务上挂真实 runtime 适配——单一注册表，无双调度器）。
 */
import { ipcMain } from 'electron';

import { IPC } from '../../shared/ipc-channels.mjs';
import { getConversationFlowService } from '../services/conversation-flow-service.mjs';
import { freezeAcceptedInput } from '../agent-runtime/freeze-input.mjs';
import { getProfiles } from '../lib/profiles-holder.mjs';
import { getWorkspaceService } from './workspace.ipc.mjs';

export function registerFlowIpc() {
  const service = getConversationFlowService();

  ipcMain.handle(IPC.flow.command, async (_event, payload) => {
    const conversationId = String(payload?.conversationId ?? '');
    if (!conversationId) return { ok: false, code: 'invalid', message: '缺少 conversationId' };
    return service.operations.execute(conversationId,payload.operation,payload.command,async()=>{
    const controller = service.controllerFor(conversationId);
    if(payload.operation?.generation!=null&&payload.operation.generation!==controller.getSnapshot().generation)return {ok:false,code:'conflict'};
    const command = structuredClone(payload.command ?? {});
    if (command.input) { delete command.input.modelPolicySnapshot; delete command.input.workspaceSnapshot; }
    if (command.patch) { delete command.patch.modelPolicySnapshot; delete command.patch.workspaceSnapshot; }
    const snapshot = controller.getSnapshot();
    const known = command.input?.inputId && (snapshot.pending.some(item => item.inputId === command.input.inputId) || Object.values(snapshot.runs).some(run => run.inputIds?.includes(command.input.inputId)));
    if(command.type==='send'&&!command.input?.workflow&&service.submitChat)return service.submitChat({...command.input,conversationId,messages:[{role:'user',content:command.input?.text??''}],requestId:payload.operation?.requestId,expectedGeneration:payload.operation?.generation,voiceMode:command.preempt==='active'?'continuous':'hold'});
    if (!known && command.type === 'send' && !command.input?.workflow) {
      try { Object.assign(command.input, await freezeAcceptedInput({ store: getProfiles(), workspaceService: getWorkspaceService(), input: command.input })); }
      catch (error) { return { ok: false, code: 'invalid', message: error.message }; }
    }
    return controller.command(command).catch((error) => ({
      ok: false,
      code: 'runtime-failed',
      message: String(error?.message ?? error),
    }));
    });
  });

  ipcMain.handle(IPC.flow.lookupOperation,(_event,payload)=>service.operations.lookup(String(payload?.conversationId??''),String(payload?.requestId??'')));

  ipcMain.handle(IPC.flow.getSnapshot, (_event, payload) => {
    const conversationId = String(payload?.conversationId ?? '');
    if (!conversationId) return null;
    return service.controllerFor(conversationId).getSnapshot();
  });

  return service;
}
