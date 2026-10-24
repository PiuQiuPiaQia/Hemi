import {useCallback, type ComponentProps} from 'react';
import {DirectoryPicker} from '@hemi/conversation-flow/navigation';
import type {MobileWorkspace} from '../workspace';
export function DirectoryPanel({workspace,...props}: Omit<ComponentProps<typeof DirectoryPicker>, 'load'> & {workspace:MobileWorkspace}) {
  const load=useCallback((path:string,signal:AbortSignal)=>workspace.listDirectories(path,signal),[workspace]);
  return <DirectoryPicker {...props} load={load}/>;
}
