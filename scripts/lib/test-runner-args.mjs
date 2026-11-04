export function testRunnerArgs(args, files) {
  if (args.length > 1 || (args.length === 1 && !/^--test-concurrency=[1-9]\d*$/.test(args[0]))) {
    throw new Error('仅支持可选参数 --test-concurrency=<正整数>');
  }
  if (args.length && !Number.isSafeInteger(Number(args[0].split('=')[1]))) throw new Error('测试并发数超出安全整数范围');
  return ['--test', ...args, ...files];
}
export function testRunnerExitCode(result) {return result.status ?? 1;}
