(() => {
  const root=document.querySelector('.compact-shell'),backdrop=root.querySelector('.theme-home-backdrop'),master=backdrop.querySelector('img'),copy=root.querySelector('.theme-home-copy');
  const reduced=matchMedia('(prefers-reduced-motion: reduce)'),capture=new URLSearchParams(location.search).has('capture');
  const scene=document.createElement('div');scene.className='boot-scene';
  const actor=document.createElement('div');actor.className='boot-actor';actor.setAttribute('aria-hidden','true');
  const actorPoster=new Image();actorPoster.src='../v1/masters/cafe-blue.png';actorPoster.alt='';actor.append(actorPoster);
  const title=copy.cloneNode(true);title.classList.add('boot-copy');const ribbon=document.createElement('div');ribbon.className='boot-ribbon';
  document.body.prepend(scene);document.body.append(actor,title,ribbon);
  const makeVideo=()=>{const v=document.createElement('video');v.muted=true;v.loop=true;v.playsInline=true;v.preload='auto';v.setAttribute('aria-hidden','true');v.src='../home-background-motion-v1/character-idle-alpha-hq.webm';return v;};
  const homeVideo=makeVideo(),frontVideo=makeVideo();backdrop.append(homeVideo);actor.append(frontVideo);const videos=[homeVideo,frontVideo];
  const paths=[...title.querySelectorAll('path')];paths.forEach(path=>{path.setAttribute('pathLength','1');path.style.strokeDasharray='1';});
  const clamp=x=>Math.max(0,Math.min(1,x)),smooth=x=>{x=clamp(x);return x*x*(3-2*x)},out=x=>1-(1-clamp(x))**3,mix=(a,b,p)=>a+(b-a)*p;
  let time=0,playing=false,ready=false,failure=null,raf=0,start=0,lastReport=0,staticHome=false,baseOpacity=.94,actorShift={x:0,y:0,scale:1,width:1,height:1};
  const state=()=>({time,playing,phase:time<6000&&!staticHome?'boot':'home',duration:14000,bootDuration:6000,loopDuration:8000,staticHome,ready,failure,reducedMotion:reduced.matches});
  const report=requestId=>parent.postMessage({type:'hemi-demo-state',requestId,state:state()},'*');
  function align(){
    // Used CSS positions retain subpixels and stay local while root has a 3D transform.
    const style=getComputedStyle(master),scale=parseFloat(style.height)/1386;baseOpacity=Number(style.opacity);
    Object.assign(homeVideo.style,{left:`${parseFloat(style.left)-48*scale}px`,top:`${parseFloat(style.top)-16*scale}px`,width:`${1231*scale}px`,height:`${1418*scale}px`});
    const front=getComputedStyle(actor);actorShift={x:parseFloat(style.left)-parseFloat(front.left),y:parseFloat(style.top)-parseFloat(front.top),scale:parseFloat(style.width)/parseFloat(front.width),width:parseFloat(front.width),height:parseFloat(front.height)};
    if(ready)render(time);
  }
  function render(ms){
    time=Math.max(0,ms);const boot=time<6000&&!staticHome,t=Math.min(time,6000)/1000;
    const animated=!staticHome&&!failure;
    master.style.visibility=animated?'hidden':'visible';homeVideo.style.visibility=animated?'visible':'hidden';actorPoster.style.visibility=failure?'visible':'hidden';frontVideo.style.visibility=failure?'hidden':'visible';
    if(boot){
      const entry=out(t/1.1),arrival=smooth((t-1.4)/1.1),expand=smooth((t-3.2)/1.9),leave=smooth((t-5.1)/.65),write=smooth((t-.3)/1.2),reveal=leave;
      scene.style.opacity=String(1-expand);title.style.opacity=String(1-smooth((t-1.8)/1.25));
      title.querySelector('strong').style.clipPath=`inset(0 ${(1-write)*100}% 0 -12%)`;title.querySelector('p').style.opacity=String(smooth((t-1.05)/.6));paths.forEach((path,i)=>path.style.strokeDashoffset=String(1-smooth((t-1-i*.15)/1.05)));
      actor.style.opacity=String(entry*(1-leave));actor.style.transform=`translate3d(${.22*actorShift.width*(1-entry)+actorShift.x*expand}px,${.08*actorShift.height*(1-entry)+actorShift.y*expand}px,0) rotate(${2.5*(1-entry)}deg) scale(${mix(1,actorShift.scale,expand)})`;
      root.style.opacity=String(arrival);root.style.transform=`translate3d(${mix(5.5,0,expand)}%,${mix(26,0,expand)}%,0) rotateX(${mix(4,0,expand)}deg) rotateY(${mix(-12,0,expand)}deg) rotateZ(${mix(-5,0,expand)}deg) scale(${mix(.58,1,expand)})`;
      root.style.borderRadius=`${18*(1-expand)}px`;root.style.overflow=expand<1?'hidden':'';root.style.boxShadow=`0 ${22*(1-expand)}px ${65*(1-expand)}px rgba(38,70,118,${.24*(1-expand)})`;
      if(expand===1){root.style.transform='none';root.style.borderRadius='0';root.style.boxShadow='none';root.style.overflow='';}
      copy.style.opacity=String(smooth((t-4.7)/.65));homeVideo.style.opacity=String(baseOpacity*reveal);ribbon.style.opacity=String(arrival*(1-expand)*.7);
    }else{
      [scene,actor,title,ribbon].forEach(element=>element.style.opacity='0');root.style.opacity='1';root.style.transform='none';root.style.borderRadius='0';root.style.boxShadow='none';root.style.overflow='';copy.style.opacity='1';homeVideo.style.opacity=String(baseOpacity);
    }
    return state();
  }
  function pause(){playing=false;cancelAnimationFrame(raf);videos.forEach(video=>video.pause());report();return state();}
  async function locate(video,seconds){
    if(failure||Math.abs(video.currentTime-seconds)<.0001)return;
    await new Promise((resolve,reject)=>{const clean=()=>{video.removeEventListener('seeked',done);video.removeEventListener('error',bad);},done=()=>{clean();resolve();},bad=()=>{clean();reject(new Error('人物视频定位失败'));};video.addEventListener('seeked',done,{once:true});video.addEventListener('error',bad,{once:true});video.currentTime=seconds;});
  }
  async function seek(ms){
    pause();staticHome=false;const target=Math.max(0,ms);await Promise.all(videos.map(video=>locate(video,(target%8000)/1000)));render(target);align();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));report();return state();
  }
  function tick(now){
    if(!playing)return;render(now-start);
    if(time>=6000&&!frontVideo.paused)frontVideo.pause();
    if(now-lastReport>100){report();lastReport=now;}raf=requestAnimationFrame(tick);
  }
  async function play(){
    if(failure){staticHome=true;render(6000);report();return state();}
    pause();staticHome=false;await Promise.all(videos.map(video=>locate(video,(time%8000)/1000)));
    await Promise.all((time<6000?videos:[homeVideo]).map(video=>video.play()));start=performance.now()-time;playing=true;render(time);raf=requestAnimationFrame(tick);report();return state();
  }
  async function replay(){await seek(0);return play();}
  async function home(autoplay=true){await seek(6000);if(autoplay)return play();return state();}
  async function rest(){pause();staticHome=true;render(6000);report();return state();}
  videos.forEach(video=>video.addEventListener('error',()=>{failure='人物动画加载失败，保留静态主页';pause();staticHome=true;render(6000);report();}));
  new ResizeObserver(align).observe(backdrop);addEventListener('resize',align);document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();});reduced.addEventListener('change',()=>{if(reduced.matches)rest();});
  addEventListener('message',async event=>{
    if(event.source!==parent||event.data?.type!=='hemi-demo-command'||!ready)return;const {action,requestId}=event.data;
    try{
      if(action==='seek')await seek(event.data.time);else if(action==='play')await play();else if(action==='pause')pause();else if(action==='replay')await replay();else if(action==='home'||action==='skip')await home(event.data.autoplay!==false);else if(action==='rest')await rest();report(requestId);
    }catch(error){parent.postMessage({type:'hemi-demo-error',requestId,message:error.message},'*');}
  });
  window.fullDemo={seek,play,pause,replay,home,rest,getState:state,getVideos:()=>videos,duration:14000};
  window.sceneReady=(async()=>{
    await Promise.all([...document.images].map(image=>image.decode()));await document.fonts.ready;
    await Promise.all(videos.map(video=>new Promise((resolve,reject)=>{if(video.error||failure)return reject(new Error(failure||'人物动画加载失败'));if(video.readyState>=2)return resolve();video.addEventListener('loadeddata',resolve,{once:true});video.addEventListener('error',reject,{once:true});})));
    ready=true;document.body.classList.add('demo-ready');align();
    if(reduced.matches)await rest();else{await seek(0);if(!capture)await play();}
    parent.postMessage({type:'hemi-demo-ready',state:state()},'*');return true;
  })().catch(error=>{failure=error.message||'人物动画加载失败';ready=true;document.body.classList.add('demo-ready');align();rest();parent.postMessage({type:'hemi-demo-ready',state:state()},'*');return false;});
})();
