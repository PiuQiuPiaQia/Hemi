import test from 'node:test';
import assert from 'node:assert/strict';
import { isBackgroundWaitCommand } from './background-wait.mjs';

test('识别字面量占位等待，保留有实际工作或求值的 Shell 命令', () => {
  for (const command of ['echo 等待推送完成', 'echo "待命"', 'printf "%s\\n" "等待后台结果"',
    "printf 'waiting\\n'", 'echo waiting for push', 'true', ':', 'sleep 0.5',
    'Write-Output "Waiting for background"', 'Write-Host 等待完成', 'Start-Sleep -Seconds 3']) {
    assert.equal(isBackgroundWaitCommand(command), true, command);
  }
  assert.equal(isBackgroundWaitCommand('echo placeholder', '等待后台推送结果'), true);
  for (const command of ['echo READY', 'printf 42', 'echo 等待 > progress.txt', 'echo 等待 | cat',
    'echo 等待 && git status', 'echo 等待; git status', 'sleep 1; curl localhost',
    'echo $(git status)', 'echo "$STATUS"', 'echo `date`', 'echo %STATUS%',
    'echo \\等待', 'echo "等待', 'echo 等待\ngit status', 'git status', '',
    'echo waiting*', 'echo waiting?', 'echo waiting[12]', 'echo waiting{1,2}', 'echo ~waiting',
    "printf '%s\\n' 'processing records'", 'sleep "$SECONDS"']) {
    assert.equal(isBackgroundWaitCommand(command), false, command);
  }
  assert.equal(isBackgroundWaitCommand('echo 等待 > progress.txt', '等待后台结果'), false);
});
