import type {FlowSnapshotView,FlowChangeView,FlowHistoryPage} from './protocol.js';
export function retainFlowRows(snapshot:FlowSnapshotView,timeline:FlowSnapshotView['timeline'],history?:FlowSnapshotView['history']):FlowSnapshotView;
export function flowReplyText(snapshot:FlowSnapshotView,options:{runId:string;generation:number}):string;
/** limit counts complete QAs (default 10); legacy maxBytes is ignored to avoid splitting a QA. */
export function projectFlowWindow(snapshot:FlowSnapshotView,options?:{limit?:number;maxBytes?:number;start?:number;total?:number}):FlowSnapshotView;
/** limit counts complete QAs (default 10); legacy maxBytes is ignored. */
export function flowHistoryPage(snapshot:FlowSnapshotView,options:{before:number;generation:number;limit?:number;maxBytes?:number}):FlowHistoryPage;
export function createFlowWindowProjector(applyChange:(snapshot:FlowSnapshotView,change:FlowChangeView)=>{ok:boolean;snapshot?:FlowSnapshotView},readSnapshot?:(id:string)=>FlowSnapshotView):(frame:any)=>any;
