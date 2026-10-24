// Native event transport boundary for browser checks. Events come from the actual Bot Host.
export async function installMobileBotEvents(context, host, {offline = () => false} = {}) {
  const streams = new Map();
  const stop = page => {for (const item of streams.get(page)?.values() ?? []) item.release();streams.delete(page);};
  context.on('page', page => {page.on('close',()=>stop(page));page.on('framenavigated',frame=>{if(frame===page.mainFrame())stop(page);});});
  await context.exposeBinding('__hemiBotEventsFixture', async ({page}, {method,streamId,options}) => {
    let group=streams.get(page);if(!group){group=new Map();streams.set(page,group);}
    group.get(streamId)?.release();group.delete(streamId);
    if(method==='closeEvents')return {};
    if(offline())throw new Error('Isolated connection unavailable');
    const emit=value=>{void page.evaluate(value=>window.__hemiDeliverBotEvent?.(value),{streamId,...value}).catch(()=>{});};
    const release=host.watch(options,frame=>emit({frame}),()=>emit({disconnected:true}),{clientId:'browser-verification'});
    group.set(streamId,{release,emit});return {};
  });
  await context.addInitScript(()=>{
    let bridge=window.Capacitor;
    const wrap=value=>{
      if(!value || value.__hemiEventsFixture)return value;
      value.__hemiEventsFixture=true;
      const listeners=new Map();let next=0;
      window.__hemiDeliverBotEvent=frame=>{for(const callback of listeners.values())callback(frame);};
      const originalCallback=value.nativeCallback?.bind(value),originalPromise=value.nativePromise?.bind(value);
      const header=value.PluginHeaders?.find(item=>item.name==='HemiBot');
      header?.methods.push({name:'addListener',rtype:'callback'},...['removeListener','openEvents','closeEvents'].map(name=>({name,rtype:'promise'})));
      value.nativeCallback=(plugin,method,options,callback)=>{
        if(plugin==='HemiBot'&&method==='addListener'){const id='bot-'+(++next);listeners.set(id,callback);return Promise.resolve(id);}
        return originalCallback?.(plugin,method,options,callback);
      };
      value.nativePromise=(plugin,method,options)=>{
        if(plugin==='HemiBot'&&method==='removeListener'){listeners.delete(options.callbackId);return Promise.resolve({});}
        if(plugin==='HemiBot'&&['openEvents','closeEvents'].includes(method))return window.__hemiBotEventsFixture({method,...options});
        return originalPromise?.(plugin,method,options);
      };
      return value;
    };
    Object.defineProperty(window,'Capacitor',{configurable:true,get:()=>bridge,set:value=>{bridge=wrap(value);}});
    bridge=wrap(bridge);
  });
  const timer=setInterval(()=>{if(offline())for(const [page,group] of streams){for(const item of group.values())item.emit({disconnected:true});stop(page);}},50);
  const dispose=()=>{clearInterval(timer);for(const page of streams.keys())stop(page);};
  context.on('close',dispose);return dispose;
}
