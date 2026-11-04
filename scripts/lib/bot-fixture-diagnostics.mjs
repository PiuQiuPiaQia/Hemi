// Synthetic-fixture diagnostics only; disabled in normal test runs.
import {monitorEventLoopDelay, performance} from 'node:perf_hooks';
const enabled = process.env.HEMI_BOT_FIXTURE_TRACE === '1';
if (enabled) {
  const delay = monitorEventLoopDelay({resolution: 20});
  const start = performance.eventLoopUtilization();
  delay.enable();
  process.once('exit', () => {
    delay.disable();
    console.log('BOT_EVENT_LOOP', JSON.stringify({pid: process.pid, maxMs: delay.max / 1e6, p99Ms: delay.percentile(99) / 1e6, utilization: performance.eventLoopUtilization(start).utilization}));
  });
}
export function botFixtureTrace(scope, ...values) {
  if (enabled) console.log(`[bot-${scope}]`, Date.now(), ...values);
}
export function botFlowDiagnostic(detail = {}) {
  const flow = detail.flow ?? detail;
  return {phase: flow.phase, activeRunId: flow.activeRunId, pending: flow.pending?.length,
    latestOutcome: Object.values(flow.runs ?? {}).at(-1)?.outcome,
    permissions: Object.values(detail.permissions ?? {}).map(p => ({id: p.id, status: p.status})),
    errors: (flow.timeline ?? []).flatMap(item => item.parts ?? []).filter(part => part.kind === 'notice' && part.level === 'error').map(part => part.text)};
}
