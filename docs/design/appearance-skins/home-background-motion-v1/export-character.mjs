// Re-export the approved v2 mesh at source resolution for the large homepage background.
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const { chromium }=await import(process.env.HEMI_PREVIEW_PLAYWRIGHT||'/Users/zhangao/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const output=fileURLToPath(new URL('./character-idle-alpha-hq.webm',import.meta.url));
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
let encoder;
try{
  const page=await browser.newPage({viewport:{width:1440,height:960}});
  await page.goto(new URL('../character-motion-trial-v2/index.html?capture',import.meta.url).href);
  await page.evaluate(()=>window.previewReady);
  encoder=spawn(process.env.HEMI_PREVIEW_FFMPEG||'/opt/homebrew/bin/ffmpeg',['-hide_banner','-loglevel','error','-y','-framerate','30','-f','image2pipe','-vcodec','png','-i','pipe:0','-vf','scale=1232:1418','-c:v','libvpx-vp9','-pix_fmt','yuva420p','-auto-alt-ref','0','-b:v','0','-crf','18','-row-mt','1','-deadline','good','-cpu-used','4','-an',output],{stdio:['pipe','ignore','pipe']});
  let log='';encoder.stderr.on('data',data=>log+=data);
  const done=new Promise((resolve,reject)=>{encoder.on('error',reject);encoder.on('exit',code=>code===0?resolve():reject(new Error(log||`ffmpeg ${code}`)));});done.catch(()=>{});
  for(let frame=0;frame<240;frame++){
    await page.evaluate(time=>window.characterTrial.seek(time),frame*1000/30);
    const data=await page.locator('#hero').evaluate(canvas=>canvas.toDataURL('image/png').split(',')[1]);
    if(!encoder.stdin.write(Buffer.from(data,'base64')))await once(encoder.stdin,'drain');
    if(frame%30===0)console.log(`HQ character ${frame}/240`);
  }
  encoder.stdin.end();await done;
  console.log(JSON.stringify({output,bytes:(await fs.stat(output)).size}));
}finally{if(encoder&&encoder.exitCode===null)encoder.kill();await browser.close();}
