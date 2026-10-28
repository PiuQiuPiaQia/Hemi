/** 主／子会话、工具说明与后台回执共用同一等待约定。 */
export const BACKGROUND_WAIT_GUIDANCE = '命令转后台后，可以继续不依赖结果的独立工作；无独立工作时，只输出简短等待说明，不附带工具调用，结束本次生成。宿主保留当前目标，等待后台命令完成后自动投递真实退出状态和输出，再继续原目标。不要用 echo、printf、sleep、true 等占位命令、反复查询或持续思考等待；生成结束不等于目标完成，不要提前宣布成功。长命令应保留可用的增量输出，避免用汇总管道把全部进度藏到结束。可用 job_list、job_output、job_kill 查询和控制当前目标的后台命令；有限等待到期并不终止命令。收到宿主的静默观察时核对事实后再决定下一步，不把无输出直接当作失败。';

const waitIntent = /等待|待命|占位|空转|轮询|\b(?:wait(?:ing)?|await(?:ing)?|standby|no[ -]?op)\b/i;

/**
 * 只认单条、字面量的等待命令；不解析或改写任意 Shell 脚本。
 * 重定向、管道、复合命令、变量和命令替换可能有独立工作，一律留给原执行路径。
 * 这是防空转提示的保守识别器，不是 Shell 安全边界。
 */
export function isBackgroundWaitCommand(command, description = '') {
  const source = String(command ?? '').trim();
  if (!source || /[|&;<>`$(){}*?\[\]~!\r\n]/.test(source) || /%[^%\s]+%/.test(source)) return false;
  const words = [], token = /\s*(?:'([^']*)'|"([^"\\]*(?:\\.[^"\\]*)*)"|([^\s'"\\]+))(?=\s|$)/gy;
  while (token.lastIndex < source.length) {
    const match = token.exec(source);
    if (!match) return false;
    words.push(match[1] ?? match[2] ?? match[3]);
  }
  const [name, ...args] = words;
  if (['true', ':'].includes(name) && !args.length) return true;
  if (/^(?:sleep|start-sleep)$/i.test(name)) {
    return /^(?:(?:-s(?:econds)?|-m(?:illiseconds)?)\s+)?\d+(?:\.\d+)?(?:ms|s|m|h|d)?$/i.test(args.join(' '));
  }
  return /^(?:echo|printf|write-output|write-host)$/i.test(name)
    && waitIntent.test(`${args.join(' ')} ${String(description ?? '')}`);
}
