import test from 'node:test';
import assert from 'node:assert/strict';
import { retainedDeliverables } from './retained-deliverables.ts';

test('回卷后的菜单保留旧代有效文件，排除撤回运行，共享文件保留有效生产者即可', () => {
  const producer = (runId, generation) => ({ runId, generation });
  const flow = { generation: 3, timeline: [{ runId: 'kept' }], tasks: {}, artifacts: {
    old: { artifactId: 'old', producers: [producer('kept', 1)] },
    removed: { artifactId: 'removed', producers: [producer('cut', 2)] },
    shared: { artifactId: 'shared', producers: [producer('cut', 2), producer('kept', 1)] },
  } };
  assert.deepEqual(retainedDeliverables(flow).map(a => a.artifactId), ['old', 'shared']);
});

test('Bot 与旧档只有 producerRunId 时同样排除已撤回运行，无归属旧登记保持兼容', () => {
  const flow = { generation: 2, timeline: [{ runId: 'kept' }], tasks: {}, artifacts: {
    kept: { artifactId: 'kept', producerRunId: 'kept' },
    removed: { artifactId: 'removed', producerRunId: 'cut' },
    legacy: { artifactId: 'legacy' },
  } };
  assert.deepEqual(retainedDeliverables(flow).map(a => a.artifactId), ['kept', 'legacy']);
});
