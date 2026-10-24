import {useLayoutEffect} from 'react';
import {Capacitor, type PluginListenerHandle} from '@capacitor/core';
import {Keyboard} from '@capacitor/keyboard';

/** Native keyboard overlay uses one layout inset; browsers use their visible viewport. */
export function useAppViewport() {
  useLayoutEffect(()=>{
    const root=document.documentElement, viewport=window.visualViewport;
    const native=Capacitor.getPlatform()==='ios'&&Capacitor.isPluginAvailable('Keyboard');
    let disposed=false;
    const listeners:PluginListenerHandle[]=[];
    const keyboard=(open:boolean,height=0)=>{
      if(disposed)return;
      root.dataset.keyboardOpen=String(open);
      root.style.setProperty('--sa-bottom',open?'0':'1');
      root.style.setProperty('--keyboard-inset',`${Math.max(0,height)}px`);
    };
    root.dataset.viewportOwner=native?'native':'browser';
    keyboard(false);
    const resize=()=>{
      if(native)return; // The native keyboard overlays an unchanged WebView; its inset owns layout.
      root.style.setProperty('--app-height',`${viewport?.height??window.innerHeight}px`);
      keyboard(!!viewport&&viewport.scale===1&&window.innerHeight-viewport.height>120);
    };
    if(native){
      root.style.removeProperty('--app-height');
      const track=(handle:Promise<PluginListenerHandle>)=>{void handle.then(value=>{if(disposed)void value.remove();else listeners.push(value);});};
      track(Keyboard.addListener('keyboardWillShow',info=>keyboard(info.keyboardHeight>0,info.keyboardHeight)));
      track(Keyboard.addListener('keyboardDidShow',info=>keyboard(info.keyboardHeight>0,info.keyboardHeight)));
      track(Keyboard.addListener('keyboardWillHide',()=>keyboard(false)));
      track(Keyboard.addListener('keyboardDidHide',()=>keyboard(false)));
    } else {
      resize();viewport?.addEventListener('resize',resize);window.addEventListener('resize',resize);
    }
    return()=>{
      disposed=true;for(const listener of listeners)void listener.remove();
      viewport?.removeEventListener('resize',resize);window.removeEventListener('resize',resize);
      root.style.removeProperty('--app-height');root.style.removeProperty('--sa-bottom');root.style.removeProperty('--keyboard-inset');
      delete root.dataset.viewportOwner;delete root.dataset.keyboardOpen;
    };
  },[]);
}
