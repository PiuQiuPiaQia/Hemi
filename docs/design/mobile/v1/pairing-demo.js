// Local UI simulator only. Production authorization belongs to the Bot and native hosts.
export const comparisonCode='KQTD-MXHP';
export const demoQrPayload='hemi-demo://pairing?v=1&fixture=not-a-credential';
export const newInvitation=(now=Date.now())=>({id:crypto.randomUUID(),expiresAt:now+120000,status:'open',request:null});
export function createPairingDemo(scene){
  const invitation=newInvitation();
  if(scene==='pair-confirm'){invitation.status='pending';invitation.request={id:'request-preview',name:'我的新 iPhone',code:comparisonCode};}
  return {invitation,scan:'ready',scanExpiresAt:null,devices:[{id:'current',name:'这台 iPhone',current:true},{id:'mac',name:'我的 MacBook',lastSeen:'刚刚',manager:true}]};
}
export function pairingDemoReducer(state,action){
  const invitation=state.invitation;
  switch(action.type){
    case 'reset':return createPairingDemo(action.scene);
    case 'replace-demo':return action.value;
    case 'generate':return {...state,invitation:newInvitation(action.now)};
    case 'cancel':return ['open','pending'].includes(invitation.status)?{...state,invitation:{...invitation,status:'cancelled'}}:state;
    case 'expire':return ['open','pending'].includes(invitation.status)?{...state,invitation:{...invitation,status:'expired'}}:state;
    case 'request':return invitation.status==='open'&&action.now<invitation.expiresAt?{...state,invitation:{...invitation,status:'pending',request:{id:crypto.randomUUID(),name:'我的新 iPhone',code:comparisonCode}}}:state;
    case 'reject':return invitation.status==='pending'?{...state,invitation:{...invitation,status:'denied'}}:state;
    case 'approve':{
      if(!['open','pending'].includes(invitation.status))return state;
      if(action.now>=invitation.expiresAt)return {...state,invitation:{...invitation,status:'expired'}};
      if(invitation.status!=='pending'||!action.verified||action.requestId!==invitation.request.id)return state;
      return {...state,invitation:{...invitation,status:'used'},devices:[...state.devices,{id:invitation.request.id,name:invitation.request.name,lastSeen:'刚刚'}]};
    }
    case 'scan-reset':return {...state,scan:'ready',scanExpiresAt:null};
    case 'scan-read':return state.scan==='ready'?{...state,scan:'review',scanExpiresAt:action.now+120000}:state;
    case 'scan-invalid':return {...state,scan:'invalid'};
    case 'scan-request':return state.scan==='review'?{...state,scan:action.now<state.scanExpiresAt?'waiting':'expired'}:state;
    case 'scan-confirm':return state.scan==='waiting'?{...state,scan:action.now<state.scanExpiresAt?'connected':'expired'}:state;
    case 'scan-expire':return ['review','waiting'].includes(state.scan)?{...state,scan:'expired'}:state;
    case 'scan-deny':return state.scan==='waiting'?{...state,scan:'denied'}:state;
    case 'revoke':return {...state,devices:state.devices.map(device=>device.id===action.id&&!device.current?{...device,revoked:true}:device)};
    default:return state;
  }
}
