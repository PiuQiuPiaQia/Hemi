import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsAppIdentity } from '../bot/windows-desktop-apps.mjs';
import { listInstalledApplications, findInstalledApplication } from './installed-apps.mjs';
test('Windows exe 与 AUMID 身份规范化一致', () => {
 assert.equal(windowsAppIdentity({executable:'C:\\Windows\\System32\\notepad.exe'}),'win32:exe:c:\\windows\\system32\\notepad.exe');
 assert.equal(windowsAppIdentity({appId:'Test.Package!App'}),'win32:aumid:test.package!app');
});
test('Windows 本地安装清单及按身份查找经真实目录服务', {skip:process.platform!=='win32'}, async()=> {
 const apps=await listInstalledApplications();
 const notepad=apps.find(a=>a.bundleId.endsWith('\\notepad.exe'));
 assert.ok(notepad?.bundleId.startsWith('win32:'));
 assert.equal((await findInstalledApplication(notepad.bundleId)).bundleId,notepad.bundleId);
});
