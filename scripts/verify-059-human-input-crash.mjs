// 059 人工输入 SIGKILL 强退恢复（HI-AC08 真机层）：挂起等待中的进程被强杀 →
// 同盘新进程恢复（waiting 合法保留、草稿在、期限不重计、零自动续跑）→ 显式提交
// 后新执行片段完成。node 直跑：node scripts/verify-059-human-input-crash.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "hemi-059-hicrash-"));
const marker = path.join(workDir, "suspended.json");
const done = path.join(workDir, "done.json");
const childFile = path.resolve(here, "verify-059-human-input-crash-child.mjs");
const env = { ...process.env, CRASH_DIR: workDir, CRASH_MARKER: marker, CRASH_DONE: done };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function spawnChild(mode, capture = false) {
  const child = spawn(process.execPath, [childFile, mode], {
    cwd: path.resolve(here, ".."),
    env,
    stdio: ["ignore", capture ? "pipe" : "ignore", "pipe"],
  });
  if (capture)
    child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => fs.appendFileSync(path.join(workDir, "child-err.log"), String(d)));
  return child;
}

// A：挂起中 SIGKILL
const runner = spawnChild("run");
const deadline = Date.now() + 30000;
while (!fs.existsSync(marker) && Date.now() < deadline) await sleep(50);
if (!fs.existsSync(marker)) {
  console.error("HEMI_059_HICRASH_RESULT 未进入挂起");
  process.exit(1);
}
await sleep(300); // 草稿写完、盘上事实落稳
runner.kill("SIGKILL");
await new Promise((resolve) => runner.on("exit", resolve));
const killedRun = JSON.parse(fs.readFileSync(marker, "utf8"));

// B：重开恢复 + 显式提交
const reopener = spawnChild("reopen", true);
const doneDeadline = Date.now() + 60000;
while (!fs.existsSync(done) && Date.now() < doneDeadline) {
  await sleep(100);
  if (reopener.exitCode !== null) break;
}
if (!fs.existsSync(done)) {
  console.error("HEMI_059_HICRASH_RESULT 恢复进程未完成");
  process.exit(1);
}
await new Promise((resolve) => {
  if (reopener.exitCode !== null) return resolve();
  reopener.on("exit", resolve);
  setTimeout(resolve, 2000);
});
const checks = JSON.parse(fs.readFileSync(done, "utf8"));
let failed = 0;
for (const { name, ok } of checks) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) failed++;
}
fs.rmSync(workDir, { recursive: true, force: true });
console.log(`HEMI_059_HICRASH_SUMMARY ${checks.length - failed}/${checks.length} invocation=${killedRun.invocationId}`);
process.exit(failed ? 1 : 0);
