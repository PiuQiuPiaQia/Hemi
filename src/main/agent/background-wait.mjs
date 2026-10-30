/** 主／子会话、工具说明与后台回执共用同一等待约定。 */
export const BACKGROUND_WAIT_GUIDANCE = '后台命令统一由会话管理，不区分服务和普通任务。启动前用 job_list 检查已有工作，避免重复启动；需要立即交还控制权时设 run_in_background=true。转后台后可以继续独立工作，也可以简短说明当前状态并结束本轮回复；宿主释放主对话，命令继续运行，用户可以正常提问。用户要求启动项目供查看时，应做独立的有界 HTTP、端口或界面就绪核验；就绪后回复即可，不等服务退出。用户要求构建、测试、下载的结果时，必须拿到真实退出状态和输出后才能宣称完成；仅启动不算完成。需要同步结果才能继续当前动作时，可显式调用 job_output 有限等待；若只剩等待后台结果，说明正在等待后结束本轮回复，宿主在真实完成时按原目标排队唤醒，不需要额外校验者决定是否释放对话，不持续请求模型。可用 job_list、job_output、job_kill 查询和控制本会话的后台命令；子任务仅可控制自己的命令，主会话可控制此前目标及所属子任务命令。job_output 的有限等待到期不终止进程。不要用占位命令、反复查询或持续思考等待，不因为静默或超时自动重新启动命令，也不延长已有硬截止时间。';

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
