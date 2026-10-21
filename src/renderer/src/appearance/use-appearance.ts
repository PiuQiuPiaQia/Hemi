import {useSyncExternalStore} from 'react';
import {getAppearanceState,subscribeAppearance} from './runtime';
export const useAppearance=()=>useSyncExternalStore(subscribeAppearance,getAppearanceState,getAppearanceState);
