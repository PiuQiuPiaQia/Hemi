// A registered Node parent owns the Windows command tree. The command remains
// base64 data until the host confirms durable process ownership over stdin.
import {spawn} from 'node:child_process';
import {comSpecPath, cmdExecArgs} from '../../platform/win-compat.mjs';

const command=Buffer.from(process.argv[2],'base64').toString('utf8');
const originalNodeMode=JSON.parse(process.argv[3]);
if(originalNodeMode===null)delete process.env.ELECTRON_RUN_AS_NODE;
else process.env.ELECTRON_RUN_AS_NODE=originalNodeMode;
let child, started=false, input='', closing=false;
const stop=()=>{
  if(closing)return;closing=true;
  if(!child?.pid)process.exit(125);
  const killer=spawn('taskkill.exe',['/pid',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
  killer.once('error',()=>process.exit(125));
  killer.once('exit',()=>process.exit(125));
};
process.stdin.setEncoding('utf8');
process.stdin.on('end',stop);
process.stdin.on('error',stop);
process.stdin.on('data',chunk=>{
  if(started)return;
  input+=chunk;
  if(input.length>16)return stop();
  if(!input.includes('\n'))return;
  if(input!=='start\n'&&input!=='start\r\n')return stop();
  started=true;
  child=spawn(comSpecPath(),cmdExecArgs('"'+command+'"'),{
    env:process.env,windowsHide:true,windowsVerbatimArguments:true,stdio:['ignore','inherit','inherit'],
  });
  child.once('error',error=>{console.error(error.message);process.exit(1);});
  child.once('exit',code=>{closing=true;process.stdin.destroy();process.exit(code??1);});
});
