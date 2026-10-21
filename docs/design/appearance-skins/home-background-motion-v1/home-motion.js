(() => {
  const backdrop=document.querySelector('.theme-home-backdrop'),master=backdrop.querySelector('img');
  const video=document.createElement('video');
  video.muted=true;video.loop=true;video.playsInline=true;video.preload='auto';video.setAttribute('aria-hidden','true');
  video.src='character-idle-alpha-hq.webm';backdrop.append(video);
  const reduced=matchMedia('(prefers-reduced-motion: reduce)'),capture=new URLSearchParams(location.search).has('capture');
  let mode='motion',ready=false,failure=null;
  const state=()=>({mode,playing:!video.paused,time:video.currentTime*1000,duration:8000,reducedMotion:reduced.matches,ready,failure});
  const report=requestId=>parent.postMessage({type:'hemi-home-state',requestId,state:state()},'*');
  function align(){
    const anchor=master.getBoundingClientRect(),host=backdrop.getBoundingClientRect(),scale=anchor.height/1386;
    Object.assign(video.style,{left:`${anchor.left-host.left-48*scale}px`,top:`${anchor.top-host.top-16*scale}px`,width:`${1231*scale}px`,height:`${1418*scale}px`,opacity:getComputedStyle(master).opacity});
  }
  function reflect(){
    const animated=mode==='motion'&&!failure;
    master.style.visibility=animated?'hidden':'visible';video.style.visibility=animated?'visible':'hidden';align();
  }
  function pause(){video.pause();report();return state();}
  async function play(){
    if(failure)throw new Error(failure);
    mode='motion';reflect();await video.play();
    report();return state();
  }
  async function setMode(next,autoplay=true){
    if(!['motion','static'].includes(next))throw new Error('Unknown home preview mode');
    pause();mode=next;reflect();if(next==='motion'&&autoplay&&!reduced.matches)await play();report();return state();
  }
  async function seek(ms){
    pause();mode='motion';reflect();const target=((Math.max(0,ms)%8000)/1000);
    if(Math.abs(video.currentTime-target)>.0001){
      await new Promise((resolve,reject)=>{const done=()=>{cleanup();resolve();},bad=()=>{cleanup();reject(new Error('人物视频定位失败'));},cleanup=()=>{video.removeEventListener('seeked',done);video.removeEventListener('error',bad);};video.addEventListener('seeked',done,{once:true});video.addEventListener('error',bad,{once:true});video.currentTime=target;});
    }
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));report();return state();
  }
  new ResizeObserver(align).observe(backdrop);addEventListener('resize',align);
  video.addEventListener('timeupdate',()=>report());video.addEventListener('pause',()=>report());
  video.addEventListener('error',()=>{failure='人物视频加载失败，已保留静态背景';mode='static';reflect();report();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();});
  reduced.addEventListener('change',()=>{if(reduced.matches){pause();setMode('static',false);}});
  addEventListener('message',async event=>{
    if(event.source!==parent||event.data?.type!=='hemi-home-command'||!ready)return;
    const {action,requestId}=event.data;
    try{
      if(action==='play')await play();
      else if(action==='pause')pause();
      else if(action==='mode')await setMode(event.data.mode,event.data.autoplay!==false);
      else if(action==='seek')await seek(event.data.time);
      report(requestId);
    }catch(error){parent.postMessage({type:'hemi-home-error',requestId,message:error.message},'*');}
  });
  window.homeScene={play,pause,seek,setMode,getState:state,getVideo:()=>video};
  window.sceneReady=(async()=>{
    await Promise.all([...document.images].map(image=>image.decode()));await document.fonts.ready;
    await new Promise((resolve,reject)=>{if(failure||video.error)return reject(new Error(failure||'人物视频加载失败'));if(video.readyState>=2)return resolve();video.addEventListener('loadeddata',resolve,{once:true});video.addEventListener('error',()=>reject(new Error(failure||'人物视频加载失败')),{once:true});});
    ready=true;mode=reduced.matches?'static':'motion';reflect();
    if(!capture&&!reduced.matches)await play();
    parent.postMessage({type:'hemi-home-ready',state:state()},'*');return true;
  })().catch(error=>{failure=error.message;ready=true;mode='static';reflect();parent.postMessage({type:'hemi-home-ready',state:state()},'*');return false;});
})();
