import type {FlowSnapshotView,FlowChangeView,FlowHistoryPage} from './protocol.js';
export function projectFlowWindow(snapshot:FlowSnapshotView,options?:{limit?:number;maxBytes?:number;start?:number;total?:number}):FlowSnapshotView;
export function flowHistoryPage(snapshot:FlowSnapshotView,options:{before:number;generation:number;limit?:number;maxBytes?:number}):FlowHistoryPage;
export function createFlowWindowProjector(applyChange:(snapshot:FlowSnapshotView,change:FlowChangeView)=>{ok:boolean;snapshot?:FlowSnapshotView},readSnapshot?:(id:string)=>FlowSnapshotView):(frame:any)=>any;
