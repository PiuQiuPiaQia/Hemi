(() => {
  const $=s=>document.querySelector(s),params=new URLSearchParams(location.search),capture=params.has('capture');if(capture)document.body.classList.add('capture');
  const fit=()=>$('.logical').style.transform=`scale(${$('.stage').clientWidth/1440})`;new ResizeObserver(fit).observe($('.stage'));fit();
  const vertex=`
    attribute vec2 aUv; varying vec2 vUv; uniform vec4 uView; uniform vec4 uMotion;
    float band(float a,float b,float c,float d,float x){return smoothstep(a,b,x)*(1.-smoothstep(c,d,x));}
    void main(){
      vUv=aUv;vec2 p=aUv*vec2(1135.,1386.);float t=uMotion.x;float phase=t*6.2831853/8.;
      float left=(1.-smoothstep(.24,.34,aUv.x))*smoothstep(.31,.65,aUv.y);
      float right=smoothstep(.77,.88,aUv.x)*smoothstep(.29,.68,aUv.y);
      float guard=band(.14,.24,.77,.88,aUv.x)*smoothstep(.48,.69,aUv.y);
      left*=1.-guard*.85;right*=1.-guard*.85;
      float enhanced=uMotion.w;
      float hairX=mix(7.,28.,enhanced),hairY=mix(2.4,8.,enhanced);
      p.x+=uMotion.y*hairX*(left*sin(phase+aUv.y*1.7)+right*sin(phase+aUv.y*1.6+1.35));
      p.x+=uMotion.y*enhanced*4.*(left*sin(2.*phase+aUv.y*2.1)+right*sin(2.*phase+aUv.y*2.2+1.8));
      p.y+=uMotion.y*hairY*(left*sin(phase+aUv.y)+right*sin(phase+aUv.y+1.1));
      float oldBody=band(.16,.3,.72,.87,aUv.x)*band(.45,.62,.88,1.,aUv.y);
      float newBody=band(.16,.3,.76,.90,aUv.x)*band(.445,.52,.92,1.,aUv.y);
      float body=mix(oldBody,newBody,enhanced),breath=sin(phase*2.);
      p.x+=(p.x-580.)*mix(.0022,.018,enhanced)*breath*body*uMotion.z;
      p.y-=mix(1.8,8.,enhanced)*breath*body*uMotion.z;
      float bow=1.-smoothstep(.45,1.,length((aUv*vec2(1135.,1386.)-vec2(650.,730.))/vec2(150.,90.)));
      p.x+=1.5*sin(phase*2.-.45)*bow*enhanced*uMotion.z;
      p.y-=3.5*sin(phase*2.-.45)*bow*enhanced*uMotion.z;
      vec2 q=(p-uView.xy)/uView.zw;gl_Position=vec4(q.x*2.-1.,1.-q.y*2.,0.,1.);
    }`;
  const fragment=`
    precision highp float;varying vec2 vUv;uniform sampler2D uBase;uniform sampler2D uHalf;uniform sampler2D uClosed;uniform float uEye;uniform float uDebug;
    void main(){
      vec4 base=texture2D(uBase,vUv);vec2 d=vUv*vec2(1135.,1386.)-vec2(478.,468.);
      vec2 r=vec2(.92718*d.x-.37461*d.y,.37461*d.x+.92718*d.y)/vec2(76.,49.);
      float mask=1.-smoothstep(.88,1.15,length(r));
      vec4 halfEye=texture2D(uHalf,vUv),closedEye=texture2D(uClosed,vUv);
      vec4 eye=uEye<.5?mix(base,halfEye,uEye*2.):mix(halfEye,closedEye,(uEye-.5)*2.);
      vec4 c=mix(base,eye,mask);
      if(uDebug>.5){c=vec4(.22,.46,.8,.30*max(base.a,.08));}
      gl_FragColor=vec4(c.rgb*c.a,c.a);
    }`;
  function shader(gl,type,src){const s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));return s;}
  function renderer(canvas,images,view){
    const gl=canvas.getContext('webgl',{alpha:true,premultipliedAlpha:true,antialias:true,preserveDrawingBuffer:true});if(!gl)throw new Error('当前浏览器无法创建 WebGL 场景');
    const program=gl.createProgram();gl.attachShader(program,shader(gl,gl.VERTEX_SHADER,vertex));gl.attachShader(program,shader(gl,gl.FRAGMENT_SHADER,fragment));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));gl.useProgram(program);
    const cols=96,rows=120,verts=[],tri=[],wire=[];for(let y=0;y<=rows;y++)for(let x=0;x<=cols;x++)verts.push(x/cols,y/rows);
    for(let y=0;y<rows;y++)for(let x=0;x<cols;x++){const a=y*(cols+1)+x,b=a+1,c=a+cols+1,d=c+1;tri.push(a,c,b,b,c,d);wire.push(a,b,b,d,d,c,c,a);}
    const vb=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,vb);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(verts),gl.STATIC_DRAW);const loc=gl.getAttribLocation(program,'aUv');gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0);
    const ib=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ib);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array(tri),gl.STATIC_DRAW);const wb=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,wb);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array(wire),gl.STATIC_DRAW);
    images.forEach((img,i)=>{gl.activeTexture(gl.TEXTURE0+i);const texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,img);gl.uniform1i(gl.getUniformLocation(program,['uBase','uHalf','uClosed'][i]),i);});
    gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);const uv=gl.getUniformLocation(program,'uView'),motion=gl.getUniformLocation(program,'uMotion'),eye=gl.getUniformLocation(program,'uEye'),debug=gl.getUniformLocation(program,'uDebug');
    return {draw(t,a,showMesh,hair=1,breath=1,enhanced=1){gl.viewport(0,0,canvas.width,canvas.height);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);gl.useProgram(program);gl.uniform4fv(uv,view);gl.uniform4f(motion,t,hair,breath,enhanced);gl.uniform1f(eye,a);gl.uniform1f(debug,0);gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ib);gl.drawElements(gl.TRIANGLES,tri.length,gl.UNSIGNED_SHORT,0);if(showMesh){gl.uniform1f(debug,1);gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,wb);gl.drawElements(gl.LINES,wire.length,gl.UNSIGNED_SHORT,0);}},info:{renderer:gl.getParameter(gl.RENDERER),cols,rows,vertices:verts.length/2,triangles:tri.length/3}};
  }
  const clamp=x=>Math.max(0,Math.min(1,x)),smooth=x=>{x=clamp(x);return x*x*(3-2*x)};
  function blinkWave(dt){if(dt<0||dt>270)return 0;if(dt<80)return smooth(dt/80);if(dt<145)return 1;return 1-smooth((dt-145)/125);}
  let playing=false,time=0,start=0,raf=0,forced=-1e9,manual=null,mesh=false,engines=[],mode='enhanced';
  const blinkAt=ms=>Math.max(blinkWave(ms%8000-2200),blinkWave(ms%8000-5650),blinkWave(ms-forced));
  function render(ms){time=Math.max(0,ms);const amount=mode==='still'?0:manual===null?blinkAt(time):manual,active=mode==='still'?0:1;engines.forEach(e=>e.draw((time%8000)/1000,amount,mesh,active,active,mode==='enhanced'?1:0));$('#eye').value=amount;$('#time').value=time%8000;$('output').textContent=`${((time%8000)/1000).toFixed(1)} / 8.0s`;return {time,eye:amount,playing,mesh,mode};}
  function setMode(next){if(!['original','enhanced','still'].includes(next))throw new Error('Unknown motion mode');mode=next;document.querySelectorAll('[data-mode]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.mode===mode)));$('#mode-label').textContent={original:'原版 · 轻微动态',enhanced:'新版 · 动作增强',still:'静止对照'}[mode];return render(time);}
  document.querySelectorAll('[data-mode]').forEach(button=>button.onclick=()=>setMode(button.dataset.mode));
  function pause(){playing=false;cancelAnimationFrame(raf);$('#toggle').textContent='播放';}
  function tick(now){if(!playing)return;render(now-start);raf=requestAnimationFrame(tick);}
  function play(){manual=null;playing=true;start=performance.now()-time;$('#toggle').textContent='暂停';cancelAnimationFrame(raf);raf=requestAnimationFrame(tick);}
  $('#toggle').onclick=()=>playing?pause():play();$('#blink').onclick=()=>{manual=null;forced=time+80;if(!playing)play();};$('#eye').oninput=()=>{pause();manual=Number($('#eye').value);render(time);};$('#time').oninput=()=>{pause();manual=null;render(Number($('#time').value));};$('#mesh').onclick=()=>{mesh=!mesh;$('#mesh').setAttribute('aria-pressed',String(mesh));render(time);};
  document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();});document.addEventListener('keydown',event=>{if(event.code==='Space'&&!['INPUT','BUTTON'].includes(event.target.tagName)){event.preventDefault();$('#toggle').click();}});
  window.characterTrial={seek(ms,eye=null){pause();manual=eye;return render(ms);},setMode,play,pause,getState:()=>({time,eye:mode==='still'?0:manual===null?blinkAt(time):manual,playing,mesh,mode}),getInfo:()=>engines.map(e=>e.info),duration:8000};
  window.previewReady=Promise.all(['base','half','closed'].map(key=>new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>reject(new Error('人物素材加载失败：'+key));img.src=window.CHARACTER_ASSETS[key];}))).then(images=>{engines=[renderer($('#hero'),images,[-48,-16,1231,1418]),renderer($('#hair'),images,[0,830,430,256]),renderer($('#cloth'),images,[330,655,610,364])];render(0);if(!capture&&!matchMedia('(prefers-reduced-motion: reduce)').matches)play();else pause();return true;}).catch(error=>{const p=$('.error');p.style.display='block';p.textContent=error.message;throw error;});
})();
