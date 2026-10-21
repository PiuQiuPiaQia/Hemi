(() => {
  const root=document.querySelector('.compact-shell'),master=root.querySelector('.theme-home-backdrop > img'),copy=root.querySelector('.theme-home-copy');
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const scene=document.createElement('div');scene.className='boot-scene';
  const actor=new Image();actor.className='boot-actor';actor.alt='';actor.src='../v1/masters/cafe-blue.png';
  const title=copy.cloneNode(true);title.classList.add('boot-copy');
  const ribbon=document.createElement('div');ribbon.className='boot-ribbon';
  const light=document.createElement('div');light.className='ambient-light';root.querySelector('.theme-home-backdrop').append(light);
  document.body.prepend(scene);document.body.append(actor,title,ribbon);
  const clamp=x=>Math.max(0,Math.min(1,x)),mix=(a,b,p)=>a+(b-a)*p,smooth=x=>{x=clamp(x);return x*x*(3-2*x)},out=x=>1-Math.pow(1-clamp(x),3);
  let mode=document.documentElement.dataset.scene==='conversation'?'conversation':'boot',time=0,playing=false,raf=0,start=0,lastReport=0,ready=false;
  const paths=[...title.querySelectorAll('path')];paths.forEach(p=>{p.setAttribute('pathLength','1');p.style.strokeDasharray='1';});
  function state(){return {mode,time,playing,reducedMotion:reduced.matches,scene:document.documentElement.dataset.scene};}
  function report(requestId){parent.postMessage({type:'hemi-motion-state',requestId,state:state()},'*');}
  function render(ms){
    time=Math.max(0,ms);const boot=mode==='boot',t=Math.min(time,6000)/1000;
    if(boot){
      const entry=out(t/1.1),arrival=smooth((t-1.4)/1.1),expand=smooth((t-3.2)/1.9),leave=smooth((t-4.0)/1.1),write=smooth((t-.3)/1.2);
      scene.style.opacity=1-expand;title.style.opacity=1-smooth((t-1.8)/1.25);
      title.querySelector('strong').style.clipPath=`inset(0 ${(1-write)*100}% 0 -12%)`;
      title.querySelector('p').style.opacity=smooth((t-1.05)/.6);paths.forEach((p,i)=>p.style.strokeDashoffset=String(1-smooth((t-1.0-i*.15)/1.05)));
      actor.style.opacity=entry*(1-leave);actor.style.transform=`translate(${22*(1-entry)+18*leave}%,${8*(1-entry)}%) rotate(${2.5*(1-entry)}deg)`;
      root.style.opacity=arrival;root.style.transform=`translate3d(${mix(5.5,0,expand)}%,${mix(26,0,expand)}%,0) rotateX(${mix(4,0,expand)}deg) rotateY(${mix(-12,0,expand)}deg) rotateZ(${mix(-5,0,expand)}deg) scale(${mix(.58,1,expand)})`;
      root.style.borderRadius=`${18*(1-expand)}px`;root.style.overflow=expand<1?'hidden':'';root.style.boxShadow=`0 ${22*(1-expand)}px ${65*(1-expand)}px rgba(38,70,118,${.24*(1-expand)})`;
      copy.style.opacity=smooth((t-4.7)/.65);master.style.opacity=String(.94*smooth((t-4.15)/1));master.style.transform='none';light.style.opacity='0';ribbon.style.opacity=arrival*(1-expand)*.7;
    }else{
      [scene,actor,title,ribbon].forEach(n=>n.style.opacity='0');root.style.opacity='1';root.style.transform='none';root.style.borderRadius='0';root.style.boxShadow='none';root.style.overflow='';copy.style.opacity='1';
      const idle=mode==='idle',wave=Math.sin(time/9000*Math.PI*2);master.style.opacity='.94';master.style.transform=idle?`translate3d(0,${wave*2.2}px,0) scale(${1+wave*.0012})`:'none';light.style.opacity=idle?String(.16+Math.sin(time/14000*Math.PI*2)*.045):'0';light.style.transform=idle?`translateX(${Math.sin(time/14000*Math.PI*2)*5}px)`:'none';
    }
    if(boot&&time>=6000){root.style.transform='none';root.style.borderRadius='0';root.style.boxShadow='none';root.style.overflow='';copy.style.opacity='1';master.style.transform='translate3d(0,0px,0) scale(1)';light.style.opacity='.16';light.style.transform='translateX(0px)';}
    return state();
  }
  function pause(){playing=false;cancelAnimationFrame(raf);}
  function tick(now){if(!playing)return;render(now-start);if(mode==='boot'&&time>=6000){mode='idle';time=0;start=now;render(0);}if(now-lastReport>100){report();lastReport=now;}raf=requestAnimationFrame(tick);}
  function play(){if(mode==='conversation')return;playing=true;start=performance.now()-time;cancelAnimationFrame(raf);raf=requestAnimationFrame(tick);}
  addEventListener('message',event=>{
    if(event.source!==parent||event.data?.type!=='hemi-motion-command'||!ready)return;
    const {action,requestId}=event.data;
    if(action==='seek'){pause();mode=event.data.mode;render(event.data.time);}
    if(action==='play')play();
    if(action==='pause')pause();
    if(action==='mode'){pause();mode=event.data.mode;render(0);if(event.data.autoplay&&!reduced.matches)play();}
    if(action==='skip'){pause();mode='idle';render(0);if(!reduced.matches)play();}
    report(requestId);
  });
  document.addEventListener('visibilitychange',()=>{if(document.hidden){pause();report();}});
  reduced.addEventListener('change',()=>{if(reduced.matches){pause();mode=document.documentElement.dataset.scene==='conversation'?'conversation':'idle';render(0);report();}});
  Promise.all([...document.images].map(i=>i.decode())).then(()=>document.fonts.ready).then(()=>{ready=true;document.body.classList.add('motion-ready');if(reduced.matches&&mode==='boot')mode='idle';render(0);parent.postMessage({type:'hemi-motion-ready',state:state()},'*');}).catch(error=>parent.postMessage({type:'hemi-motion-error',message:error.message},'*'));
})();
