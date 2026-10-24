import {type ComponentProps} from 'react';
import {ModelSelectorChip as SharedModelSelector} from '../controls/model-selector.js';
import {useFlow} from '../host/context.js';
export function ModelSelectorChip(props: ComponentProps<typeof SharedModelSelector>) {
  const {runtime}=useFlow();
  return <SharedModelSelector {...props} onOpenAutoRoutingSettings={()=>{void runtime.action({type:'model.configure-routing',targetId:'routing'});}}/>;
}
