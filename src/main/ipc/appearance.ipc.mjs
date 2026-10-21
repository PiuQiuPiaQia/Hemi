import {ipcMain} from 'electron';
import {IPC} from '../../shared/ipc-channels.mjs';
import {getAppearanceService} from '../services/appearance-instance.mjs';
import {appearanceCaller,appearanceBootstrap,appearanceApplied,appearanceVisualReady} from '../windows/appearance-window.mjs';
export async function registerAppearanceIpc(){
  const service=getAppearanceService();await service.initialize();
  ipcMain.on(IPC.appearance.bootstrap,event=>{const caller=appearanceCaller(event);event.returnValue=caller?appearanceBootstrap(caller):null;});
  ipcMain.handle(IPC.appearance.get,event=>{if(!appearanceCaller(event))throw new Error('FORBIDDEN');return service.getSnapshot();});
  ipcMain.handle(IPC.appearance.set,(event,request)=>appearanceCaller(event,true)?service.set(request,event.sender.id):{ok:false,requestId:typeof request?.requestId==='string'?request.requestId.slice(0,128):'',code:'FORBIDDEN',snapshot:service.getSnapshot()});
  ipcMain.on(IPC.appearance.applied,(event,value)=>{const caller=appearanceCaller(event);if(caller)appearanceApplied(caller,value);});
  ipcMain.on(IPC.appearance.visualReady,(event,value)=>{const caller=appearanceCaller(event);if(caller)appearanceVisualReady(caller,value);});
}
