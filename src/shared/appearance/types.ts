import type {SkinId} from './skins.mjs';
export type {SkinId};
export type AppearancePreference={schemaVersion:1;skinId:SkinId;mode:'light'};
export type AppearanceSnapshot={sessionId:string;revision:number;preference:AppearancePreference;resolvedMode:'light';recovery:null|{code:'INVALID_CONFIG'|'UNSUPPORTED_CONFIG'|'READ_FAILED';requiresBackup:boolean}};
export type AppearanceSetRequest={requestId:string;skinId:SkinId;mode:'light'};
export type AppearanceSetResult={ok:true;requestId:string;changed:boolean;snapshot:AppearanceSnapshot}|{ok:false;requestId:string;code:'INVALID_INPUT'|'FORBIDDEN'|'SAVE_FAILED'|'BACKUP_FAILED'|'REQUEST_CONFLICT';snapshot:AppearanceSnapshot};
export type AppearanceActivity={visible:boolean;focused:boolean};
export type AppearanceBootstrap={snapshot:AppearanceSnapshot;windowMode:'main'|'orb'|'caption'|'task-popover';backgroundColor:string;coldStart:boolean;activity:AppearanceActivity};
export type AppearanceApplied={sessionId:string;revision:number;status:'ready'|'degraded'|'error'};
