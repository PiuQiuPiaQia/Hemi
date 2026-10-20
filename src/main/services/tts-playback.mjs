/** Own the whole request, including config lookup and the connection handshake.
 * Started is a milestone, not a terminal event. Old callbacks cannot release a
 * newer request or forward audio after cancellation. */
export class TtsPlayback {
  constructor({ resolveConfig, createSession, emit, log }) {
    Object.assign(this, { resolveConfig, createSession, emit, log });
    this.active = null;
  }

  cancel(turnId) {
    const active = this.active;
    if (!active || (turnId !== undefined && active.turnId !== Number(turnId))) return;
    this.active = null;
    active.session?.close();
  }

  async speak(turnId, text) {
    this.cancel();
    const request = { turnId, session: null, sequence: 0 };
    this.active = request;
    const cancelled = () => ({ ok: false, message: '播报已取消。' });
    try {
      const config = await this.resolveConfig();
      if (this.active !== request) return cancelled();
      if (!config.apiKey) throw new Error('未配置豆包 API Key，无法播报。');
      const clipped = text.trim().slice(0, 300);
      if (!clipped) throw new Error('没有可播报的内容。');

      const session = this.createSession(config, (event) => {
        if (this.active !== request || event.type === 'started') return;
        if (event.type === 'finished' || event.type === 'error') this.active = null;
        if (event.type === 'audio') event = { ...event, seq: ++request.sequence };
        this.emit(turnId, event);
      });
      request.session = session;
      await session.start();
      if (this.active !== request) return cancelled();
      session.speak(clipped);
      this.log?.(`speak ${turnId} → ${config.ttsResourceId} / ${config.ttsVoice}（${clipped.length} 字）`);
      return { ok: true };
    } catch (error) {
      if (this.active !== request) return cancelled();
      this.cancel(turnId);
      return { ok: false, message: error instanceof Error ? error.message : '无法连接豆包语音合成服务。' };
    }
  }
}
