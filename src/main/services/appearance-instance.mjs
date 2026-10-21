import {app} from 'electron';
import path from 'node:path';
import {createAppearanceStore} from '../lib/appearance-store.mjs';
import {createAppearanceService} from './appearance-service.mjs';
import {createLogger} from '../lib/logger.mjs';
let service;const subscribers=new Set();
export function getAppearanceService(){
  return service??=createAppearanceService({store:createAppearanceStore({filePath:path.join(app.getPath('userData'),'appearance.json'),log:createLogger('appearance')}),log:createLogger('appearance'),onCommit:snapshot=>{for(const listener of subscribers){try{listener(snapshot);}catch{}}}});
}
export const onAppearanceCommit=listener=>{subscribers.add(listener);return()=>subscribers.delete(listener);};
