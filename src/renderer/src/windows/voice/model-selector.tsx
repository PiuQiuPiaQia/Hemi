import {useState, type ComponentProps} from 'react';
import {ModelSelectorChip as SharedModelSelector} from '@hemi/conversation-flow/controls';
import {useApplicationNavigation, useConversationEnvironment} from './lib/conversation-bridge';
import {ModelRoutingDialog} from './model-routing-dialog';
export function ModelSelectorChip({onOpenAutoRoutingSettings, ...props}: ComponentProps<typeof SharedModelSelector>) {
  const [routingOpen,setRoutingOpen]=useState(false);
  const environment=useConversationEnvironment();
  const navigation=useApplicationNavigation();
  return <><SharedModelSelector {...props} automaticRouting={true} onOpenAutoRoutingSettings={()=>{if(environment==='bot') navigation?.navigate('settings','models','bot'); else setRoutingOpen(true);}}/>{routingOpen?<ModelRoutingDialog onClose={()=>{setRoutingOpen(false);onOpenAutoRoutingSettings?.();}}/>:null}</>;
}
