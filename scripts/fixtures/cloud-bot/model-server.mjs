// An isolated OpenAI-compatible fixture. No external model, keys or remote repository.
import http from 'node:http';
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  const messages = body.messages ?? [],
    tools = messages
      .slice(messages.findLastIndex((m) => m.role === 'user') + 1)
      .filter((m) => m.role === 'tool');
  const latest = messages.findLast((m) => m.role === 'user');
  const text =
    typeof latest?.content === 'string'
      ? latest.content
      : JSON.stringify(latest?.content ?? '');
  let tool = null,
    content = '好的，已在云端完成。';
  const key = String(latest?.content ?? '');
  if (/生成文件|WRITE_CLOUD_PROOF|延时任务/.test(text)) {
    const delayed = /延时任务/.test(text),
      name = delayed ? 'background-proof.md' : 'bot-proof.md',
      first = 'fixture-bash-' + (delayed ? 'slow' : 'file'),
      delivery = 'fixture-delivery-' + (delayed ? 'slow' : 'file');
    if (!tools.some((m) => m.tool_call_id === first))
      tool = {
        id: first,
        type: 'function',
        function: {
          name: 'bash',
          arguments: JSON.stringify({
            command:
              (delayed
                ? 'sleep ' + (/队列验收/.test(text) ? 15 : 8) + '; '
                : '') + `printf 'cloud host proof' > ${name}`,
          }),
        },
      };
    else if (!tools.some((m) => m.tool_call_id === delivery))
      tool = {
        id: delivery,
        type: 'function',
        function: {
          name: 'register_delivery',
          arguments: JSON.stringify({
            files: [{ path: name, description: '隔离云端运行验证' }],
          }),
        },
      };
    else content = `已完成：[${name}](${name})`;
  } else if (/PDF 交付验收/.test(text)) {
    if (!tools.some((m) => m.tool_call_id === 'fixture-pdf'))
      tool = {
        id: 'fixture-pdf',
        type: 'function',
        function: {
          name: 'register_delivery',
          arguments: JSON.stringify({
            files: [{ path: 'fixture.pdf', description: '隔离 PDF 文件' }],
          }),
        },
      };
    else content = '[fixture.pdf](fixture.pdf)';
  } else if (/需要确认/.test(text)) {
    if (!tools.some((m) => m.tool_call_id === 'fixture-permission'))
      tool = {
        id: 'fixture-permission',
        type: 'function',
        function: {
          name: 'bash',
          arguments: JSON.stringify({
            command: 'rm -rf ./hemi-permission-fixture',
          }),
        },
      };
    else content = '已处理你的确认选择。';
  } else if (/Reply OK/.test(text)) content = 'OK';
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const base = {
    id: 'fixture',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'fixture-model',
  };
  res.write(
    'data: ' +
      JSON.stringify({
        ...base,
        choices: [
          {
            index: 0,
            delta: tool
              ? { role: 'assistant', tool_calls: [{ ...tool, index: 0 }] }
              : { role: 'assistant', content },
            finish_reason: null,
          },
        ],
      }) +
      '\n\n',
  );
  res.write(
    'data: ' +
      JSON.stringify({
        ...base,
        choices: [
          { index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      }) +
      '\n\n',
  );
  res.end('data: [DONE]\n\n');
});
server.listen(Number(process.env.PORT ?? 3030), '0.0.0.0');
