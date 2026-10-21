// Offline export of existing artwork. Runtime builds consume checked-in local assets, not this toolchain.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url)),out=path.join(root,'src/renderer/src/assets/skins');await fs.mkdir(out,{recursive:true});
const manifest=JSON.parse(await fs.readFile(path.join(root,'docs/design/appearance-skins/v1/manifest.json'),'utf8'));
const ffmpeg=process.env.HEMI_PREVIEW_FFMPEG||'/opt/homebrew/bin/ffmpeg';
const run=args=>new Promise((resolve,reject)=>{const child=spawn(ffmpeg,['-hide_banner','-loglevel','error','-y',...args],{stdio:['ignore','ignore','pipe']});let log='';child.stderr.on('data',d=>log+=d);child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(log)));});
const profiles={
 'cafe-purple':{face:[.49,.32,.30,.24],red:0},'cafe-orange':{face:[.49,.26,.30,.22],red:0},
 'cafe-gold':{face:[.48,.28,.31,.23],red:0},'cafe-red':{face:[.49,.28,.32,.25],red:1},
};
const {chromium}=await import(process.env.HEMI_PREVIEW_PLAYWRIGHT||pathToFileURL(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')).href);
const browser=await chromium.launch({headless:true,executablePath:process.env.HEMI_PREVIEW_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
async function webp(source,file,width,height){const page=await browser.newPage();try{const data='data:image/png;base64,'+(await fs.readFile(source)).toString('base64');const encoded=await page.evaluate(async({data,width,height})=>{const image=new Image();image.src=data;await image.decode();const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height||Math.round(image.height*width/image.width);canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);const result=canvas.toDataURL('image/webp',.90);if(!result.startsWith('data:image/webp;'))throw new Error('WebP encoder unavailable');return result.split(',')[1];},{data,width,height});await fs.writeFile(file,Buffer.from(encoded,'base64'));}finally{await page.close();}}
const records={};
try{
 for(const skin of manifest.skins.filter(s=>s.id!=='classic')){
  const source=skin.assets.master,src=path.join(root,'docs/design/appearance-skins/v1',source.path),portrait=path.join(root,'docs/design/appearance-skins/v1',skin.assets.portrait.path);
  await webp(src,path.join(out,`${skin.id}.webp`),960);
  await webp(portrait,path.join(out,`${skin.id}-portrait.webp`),256,256);
  if(skin.id==='cafe-blue')await run(['-c:v','libvpx-vp9','-i',path.join(root,'docs/design/appearance-skins/home-background-motion-v1/character-idle-alpha-hq.webm'),'-c:v','libvpx-vp9','-vf','scale=1000:-2','-pix_fmt','yuva420p','-auto-alt-ref','0','-b:v','0','-crf','23','-row-mt','1','-cpu-used','4','-an',path.join(out,`${skin.id}-idle.webm`)]);
  else {
   const page=await browser.newPage();let encoder;
   try{
    await page.setContent('<canvas id="actor"></canvas>');
    const data='data:image/png;base64,'+(await fs.readFile(src)).toString('base64');
    await page.evaluate(async ({data,w,h,profile})=>{
     const image=new Image();image.src=data;await image.decode();const canvas=document.querySelector('canvas');canvas.width=w+96;canvas.height=h+32;
     const gl=canvas.getContext('webgl',{alpha:true,premultipliedAlpha:true,preserveDrawingBuffer:true});if(!gl)throw new Error('WebGL unavailable');
     const vertex=`attribute vec2 uv;varying vec2 v;uniform float t;float band(float a,float b,float c,float d,float x){return smoothstep(a,b,x)*(1.-smoothstep(c,d,x));}void main(){v=uv;float p=t*6.2831853/8.;vec2 s=vec2(${w}.,${h}.);vec2 q=uv*s;float pin=1.-smoothstep(.85,1.1,length((uv-vec2(${profile.face[0]},${profile.face[1]}))/vec2(${profile.face[2]},${profile.face[3]})));float l=(1.-smoothstep(.18,.35,uv.x))*smoothstep(.32,.65,uv.y),r=smoothstep(.76,.9,uv.x)*smoothstep(.32,.65,uv.y);float body=band(.16,.3,.76,.9,uv.x)*band(.45,.61,.91,1.,uv.y);vec2 shift=vec2(26.*(l*sin(p+uv.y*1.7)+r*sin(p+uv.y*1.6+1.35)),6.*(l*sin(p+uv.y)+r*sin(p+uv.y+1.1)));shift.x+=(q.x-s.x*.51)*.014*sin(p*2.)*body;shift.y-=7.*sin(p*2.)*body;float scarf=${profile.red}. *band(.61,.7,.94,1.,uv.x)*band(.36,.49,.74,.87,uv.y);shift+=scarf*vec2(18.*sin(p+.5),8.*sin(p+1.));q+=shift*(1.-pin);q=(q+vec2(48.,16.))/vec2(${w+96}.,${h+32}.);gl_Position=vec4(q.x*2.-1.,1.-q.y*2.,0.,1.);}`;
     const fragment='precision highp float;varying vec2 v;uniform sampler2D source;void main(){vec4 c=texture2D(source,v);gl_FragColor=vec4(c.rgb*c.a,c.a);}';
     const shader=(type,source)=>{const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));return s;};
     const program=gl.createProgram();gl.attachShader(program,shader(gl.VERTEX_SHADER,vertex));gl.attachShader(program,shader(gl.FRAGMENT_SHADER,fragment));gl.linkProgram(program);gl.useProgram(program);
     const vertices=[],indices=[],cols=72,rows=100;for(let y=0;y<=rows;y++)for(let x=0;x<=cols;x++)vertices.push(x/cols,y/rows);for(let y=0;y<rows;y++)for(let x=0;x<cols;x++){const a=y*(cols+1)+x,b=a+1,c=a+cols+1,d=c+1;indices.push(a,c,b,b,c,d);}
     gl.bindBuffer(gl.ARRAY_BUFFER,gl.createBuffer());gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(vertices),gl.STATIC_DRAW);const loc=gl.getAttribLocation(program,'uv');gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0);gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,gl.createBuffer());gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array(indices),gl.STATIC_DRAW);
     gl.bindTexture(gl.TEXTURE_2D,gl.createTexture());gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image);gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);const time=gl.getUniformLocation(program,'t');
     window.drawSkin=ms=>{gl.viewport(0,0,canvas.width,canvas.height);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);gl.uniform1f(time,(ms%8000)/1000);gl.drawElements(gl.TRIANGLES,indices.length,gl.UNSIGNED_SHORT,0);return canvas.toDataURL('image/png').split(',')[1];};
    },{data,w:source.width,h:source.height,profile:profiles[skin.id]});
    encoder=spawn(ffmpeg,['-hide_banner','-loglevel','error','-y','-framerate','30','-f','image2pipe','-vcodec','png','-i','pipe:0','-vf','scale=1000:-2','-c:v','libvpx-vp9','-pix_fmt','yuva420p','-auto-alt-ref','0','-b:v','0','-crf','23','-row-mt','1','-cpu-used','4','-an',path.join(out,`${skin.id}-idle.webm`)],{stdio:['pipe','ignore','pipe']});
    let log='';encoder.stderr.on('data',d=>log+=d);const done=new Promise((resolve,reject)=>{encoder.on('error',reject);encoder.on('exit',code=>code===0?resolve():reject(new Error(log)));});done.catch(()=>{});
    for(let frame=0;frame<240;frame++){const png=await page.evaluate(t=>window.drawSkin(t),frame*1000/30);if(!encoder.stdin.write(Buffer.from(png,'base64')))await once(encoder.stdin,'drain');if(frame%60===0)console.log(`${skin.id} ${frame}/240`);}
    encoder.stdin.end();await done;
   }finally{if(encoder&&encoder.exitCode===null)encoder.kill();await page.close();}
  }
  const files={};for(const name of [`${skin.id}.webp`,`${skin.id}-portrait.webp`,`${skin.id}-idle.webm`]){const bytes=await fs.readFile(path.join(out,name));files[name]={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};}
  records[skin.id]={width:source.width,height:source.height,padding:{x:48,y:16},motion:skin.id==='cafe-blue'?'blink-hair-cloth':skin.id==='cafe-red'?'scarf-cloth':'hair-cloth',files};console.log(`${skin.id}: exported`);
 }
 await fs.writeFile(path.join(out,'manifest.json'),JSON.stringify({version:1,durationMs:8000,framesPerSecond:30,method:'Existing approved artwork; offline WebGL local deformation and VP9 alpha encoding. No Cubism runtime.',skins:records},null,2)+'\n');
}finally{await browser.close();}
