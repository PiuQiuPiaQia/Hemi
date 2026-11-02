// Bounded real SDK/browser probe. It deliberately preserves test failures and
// hangs; the watchdog kills only this probe's process tree and exits nonzero.
import {spawn, spawnSync} from 'node:child_process';
const scenario=process.argv[2] ?? 'all';
const patterns={browser:'actual Bot Host/SDK navigates',history:'actual Bot conversation_read',all:'.*',full:'.*',jobs:'.*','jobs-delayed':'.*'};
const timeoutMs=scenario==='full'?900000:180000;
if(!Object.hasOwn(patterns,scenario))throw new Error('Unknown probe scenario');
console.log('BOT_PROBE',JSON.stringify({scenario,node:process.version,platform:process.platform,arch:process.arch}));
const files=scenario.startsWith('jobs')?['src/main/bot/background-jobs.test.mjs']:['src/main/bot/capabilities.integration.test.mjs',...(scenario==='all'?['scripts/test/bot-capability-fixture.test.mjs','src/main/bot/runtime.integration.test.mjs']:[])];
const executable=scenario==='full'?(process.platform==='win32'?'cmd.exe':'npm'):process.execPath;
const args=scenario==='full'?(process.platform==='win32'?['/d','/s','/c','npm test']:['test']):['--test','--test-reporter=spec',`--test-name-pattern=${patterns[scenario]}`,...files];
const child=spawn(executable,args,{
 stdio:'inherit',env:{...process.env,HEMI_BOT_FIXTURE_TRACE:'1',HEMI_BOT_JOB_GOAL_DELAY_MS:scenario==='jobs-delayed'?'5000':'0',DEBUG:'pw:browser'},detached:process.platform!=='win32',
});
let expired=false;
const timer=setTimeout(()=>{
 expired=true;console.error(`BOT_PROBE watchdog expired after ${timeoutMs/1000}s; collecting process diagnostics`);
 if(process.platform==='win32'){
  spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'node|chrome|msedge' } | Select-Object ProcessId,ParentProcessId,Name,CommandLine | Format-List`],{stdio:'inherit',timeout:10000});
  spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{stdio:'inherit',timeout:10000});
 }else{try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}
},timeoutMs);
child.once('error',error=>{clearTimeout(timer);console.error(error);process.exitCode=1;});
child.once('close',(code,signal)=>{clearTimeout(timer);console.log('BOT_PROBE exit',JSON.stringify({code,signal,expired}));process.exitCode=expired?124:code??1;});
