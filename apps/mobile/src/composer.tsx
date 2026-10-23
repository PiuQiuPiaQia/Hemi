import { type FormEvent } from 'react';

export function Composer({ busy, text, onText, onSend, onStop }: {
  busy: boolean;
  text: string;
  onText(text: string): void;
  onSend(): void;
  onStop(): void;
}) {
  function submit(event: FormEvent) {
    event.preventDefault();
    const value = text.trim();
    if (!value) return;
    onSend();
  }
  return (
    <form className="composer" onSubmit={submit}>
      <label className="sr-only" htmlFor="message-input">消息</label>
      <textarea id="message-input" rows={2} value={text} onChange={event => onText(event.target.value)}
        placeholder="输入消息，体验离线对话…" enterKeyHint="enter" />
      <div className="composer-footer">
        <span>离线演示 · 草稿自动保存于本机</span>
        {busy ? <button className="primary icon-button" type="button" onClick={onStop} aria-label="停止回复"><span aria-hidden="true">■</span></button> : null}
        <button className="primary icon-button" type="submit" disabled={!text.trim()} aria-label="发送消息"><span aria-hidden="true">↑</span></button>
      </div>
    </form>
  );
}
