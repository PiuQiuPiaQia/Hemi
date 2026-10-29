/** Short user-facing copy; the complete provider response stays available in details. */
export function turnErrorCopy(raw: string) {
  const detail = raw.trim();
  let title = '这轮未能完成';
  let description = '可以发送“继续”，或调整模型后继续。';
  if (/ENOSPC|EDQUOT|no space left|disk (?:is )?full/i.test(detail)) {
    title = '本机存储空间不足';
    description = '请释放存储空间，再发送“继续”。';
  } else if (/运行状态尚未保存|运行状态保存超时|\b(EACCES|EPERM|EROFS|EIO)\b/i.test(detail)) {
    title = '运行状态未能保存';
    description = '请检查本机存储与写入权限，再发送“继续”。';
  } else if (/connection error|fetch failed|econn|enotfound|socket|network|网络|连接失败|terminated/i.test(detail)) {
    title = '连接模型失败';
    description = '请求连接中断，请稍后发送“继续”。';
  } else if (/timeout|time.out|超时|\b(502|503|504)\b/i.test(detail)) {
    title = '模型暂时没有响应';
    description = '服务响应超时或暂时不可用，请稍后发送“继续”。';
  } else if (/\b(401|403)\b|api.?key|authentication|unauthorized|鉴权|凭据/i.test(detail)) {
    title = '模型访问未通过验证';
    description = '请检查模型的密钥与访问权限，再发送“继续”。';
  } else if (/quota|credit|balance|余额|配额/i.test(detail)) {
    title = '模型额度不足';
    description = '请检查服务额度，或更换模型后发送“继续”。';
  } else if (/\b429\b|rate.?limit|限流/i.test(detail)) {
    title = '模型请求过于频繁';
    description = '请稍等片刻再发送“继续”。';
  } else if (/context.*(length|window|limit)|上下文.*(超|限)/i.test(detail)) {
    title = '对话超出模型上下文限制';
    description = '请换用上下文更大的模型，或新建对话。';
  } else if (/\b400\b|invalid.?request|参数/i.test(detail)) {
    title = '模型未接受这次请求';
    description = '请检查模型配置，具体原因见错误详情。';
  }
  return { title, description, detail };
}
