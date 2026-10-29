import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppCatalog } from './app-catalog.mjs';
test('Windows 应用目录保持 exe/AUMID 身份、平台与授权复核', async () => {
 const id='win32:exe:c:\\windows\\system32\\notepad.exe';
 let installed=[{bundleId:id,name:'记事本',path:'C:\\Windows\\System32\\notepad.exe'}];
 const catalog=createAppCatalog({platform:'win32',listInstalled:async()=>installed});
 const [row]=await catalog.listApplications({runningNames:new Map([[id,{}]])});
 assert.equal(row.platform,'win32'); assert.equal(row.source.kind,'executable'); assert.equal(row.running,true);
 assert.deepEqual(await catalog.resolveAppRef(row.ref.appRef,row.ref.catalogRevision),{ok:true,bundleId:id});
 const [fresh]=await catalog.listApplications(); installed=[];
 assert.equal((await catalog.resolveAppRef(fresh.ref.appRef,fresh.ref.catalogRevision)).errorCode,'APP_IDENTITY_CHANGED');
});
