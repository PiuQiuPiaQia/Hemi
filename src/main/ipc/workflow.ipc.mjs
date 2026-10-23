/**
 * 059 工作流 IPC（S3b）：渲染层唯一入口——定义只读＋两入口受理。依赖经
 * setWorkflowServiceDeps 注入（openAgent 生产装配；测试可换 stub）。
 * startPrepared 的 requestId 去重在 invocationStore（幂等重放同 receipt）。
 */
import { app, ipcMain, shell } from 'electron';
import {listInstalledApplications} from '../services/installed-apps.mjs';

import { IPC } from '../../shared/ipc-channels.mjs';
import { verifyWorkflowArtifact } from '../workflows/workflow-artifacts.mjs';
import { getWorkflowService } from '../workflows/workflow-service.mjs';

export function registerWorkflowIpc() {
  const serviceOf = () => {
    // 延迟取服务（initWorkflowService 由 index 在依赖齐后调）。
    const service = getWorkflowService();
    if (!service) throw new Error('工作流服务未初始化');
    return service;
  };

  ipcMain.handle(IPC.workflow.applications,async()=> (await listInstalledApplications()).map(({name,bundleId})=>({name,applicationRef:bundleId})));
  ipcMain.handle(IPC.workflow.remove, (_e,{workflowId})=>serviceOf().definitionStore.remove(workflowId));
  ipcMain.handle(IPC.workflow.openArtifact, async (_e,{invocationId,path})=>{
    const invocation=await serviceOf().getInvocation(invocationId);
    if(invocation?.run?.status!=='completed')throw new Error('本次运行尚无已核查交付');
    const outputs=invocation.run.engineReport?.outputs ?? {};
    const declared=invocation.documentSnapshot.nodes.filter(n=>n.type==='hemi-deliver').flatMap(n=>(n.data.artifacts??[]).flatMap((a,i)=>['file','files'].includes(a.binding.type) ? outputs[a.label||`artifact_${i}`]??[] : []));
    if(!declared.includes(path))throw new Error('不是本次运行的交付文件');
    const verdict=await verifyWorkflowArtifact(path,{workspace:invocation.run.workspace,controlRoot:app.getPath('userData')});
    if(!verdict.ok)throw new Error(verdict.reason);
    const error=await shell.openPath(path);if(error)throw new Error(error);return {ok:true};
  });
  ipcMain.handle(IPC.workflow.listInvocations, (_e, filter) => serviceOf().listInvocations(filter));
  ipcMain.handle(IPC.workflow.list, () => serviceOf().listDefinitions());
  ipcMain.handle(IPC.workflow.getRevision, (_e, { workflowId, revision } = {}) =>
    serviceOf().getDefinitionRevision(workflowId, revision ?? undefined));
  ipcMain.handle(IPC.workflow.saveDraft, (_e, { workflowId, document, name, expectedDraftRevision } = {}) =>
    serviceOf().definitionStore.saveDraft({ workflowId, document, name, expectedDraftRevision }));
  ipcMain.handle(IPC.workflow.getDraft, (_e, { workflowId } = {}) => serviceOf().definitionStore.getDraft(workflowId));
  ipcMain.handle(IPC.workflow.publish, (_e, { workflowId, expectedDraftRevision, expectedRevision } = {}) =>
    serviceOf().definitionStore.publish({ workflowId, expectedDraftRevision, expectedRevision }));
  ipcMain.handle(IPC.workflow.prepare, (_e, params) => serviceOf().prepare(params ?? {}));
  ipcMain.handle(IPC.workflow.updatePreparation, (_e, params) => serviceOf().updatePreparation(params ?? {}));
  ipcMain.handle(IPC.workflow.startPrepared, (_e, params) => serviceOf().startPrepared(params ?? {}));
  ipcMain.handle(IPC.workflow.abandon, (_e, params) => serviceOf().abandonPreparation(params));
  ipcMain.handle(IPC.workflow.continue, (_e,params)=>serviceOf().continueWaiting(params));
  ipcMain.handle(IPC.workflow.submitInteraction, (_e, params) => serviceOf().submitInteraction(params ?? {}));
  ipcMain.handle(IPC.workflow.saveInteractionDraft, async (_e, params) => {
    try { return await serviceOf().saveInteractionDraft(params ?? {}); }
    catch(error) {
      if(error?.code === 'stale-revision')return {ok:false,code:'conflict',message:error.message};
      throw error;
    }
  });
  ipcMain.handle(IPC.workflow.stop, (_e, { workflowRunId } = {}) => serviceOf().stop({ workflowRunId }));
  ipcMain.handle(IPC.workflow.getInvocation, (_e, { invocationId } = {}) => serviceOf().getInvocation(invocationId));
}
