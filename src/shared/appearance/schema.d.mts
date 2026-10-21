import type {AppearancePreference,AppearanceSnapshot,AppearanceSetRequest} from './types';
export const DEFAULT_APPEARANCE:Readonly<AppearancePreference>;
export function validPreference(value:unknown):value is AppearancePreference;
export function validAppearanceRequest(value:unknown):value is AppearanceSetRequest;
export function validSnapshot(value:unknown):value is AppearanceSnapshot;
export function newerSnapshot(current:AppearanceSnapshot|null,next:unknown):boolean;
