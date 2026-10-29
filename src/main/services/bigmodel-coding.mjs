import { createProvider } from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { ZAI_CODING_CN_MODELS } from '@earendil-works/pi-ai/providers/zai-coding-cn.models';
import { bigModelCodingAuth } from './bigmodel-coding-auth.mjs';
import { createCodingTransport } from './bigmodel-coding-transport.mjs';

export function bigModelCodingProvider(credentials, { fetchImpl } = {}) {
  const baseUrl = 'https://open.bigmodel.cn/api/anthropic';
  const models = ['glm-5.3', 'glm-5.3-flash'].map(id => {
    const native = ZAI_CODING_CN_MODELS[id];
    return { ...native, provider: 'bigmodel', api: 'anthropic-messages', baseUrl,
      // The quota is subscription based; API list prices are not billed here.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsMidConvoEffort: false, supportsMidConvoSystemMessages: false, supportsMidConvoToolChanges: false, allowEmptySignature: true },
    };
  });
  const provider = createProvider({ id: 'bigmodel', name: 'GLM Coding Plan（BigModel）', baseUrl,
    auth: { oauth: bigModelCodingAuth({ fetchImpl }) }, models, api: anthropicMessagesApi(),
  });
  const transport = createCodingTransport(credentials);
  const requestOptions = options => ({
    ...options, maxRetries: 0,
    onPayload: async (body, model) => {
      // GLM uses paired effort + budget fields on the Anthropic wire.
      if (body.thinking?.type === 'enabled') {
        const effort = ['minimal', 'low'].includes(options.reasoning) ? 'low' : ['high', 'xhigh', 'max'].includes(options.reasoning) ? 'max' : 'high';
        body.thinking = { type: 'enabled', budget_tokens: Math.min({ low: 8000, high: 16000, max: 32000 }[effort], body.max_tokens - 1) };
        body.output_config = { effort };
      } else if (body.thinking) delete body.thinking.display;
      return options.onPayload ? await options.onPayload(body, model) : body;
    },
    fetch: transport.forRequest({ authKey: options.apiKey, sessionId: options.sessionId, fetchImpl: fetchImpl ?? options.fetch ?? ((...args) => globalThis.fetch(...args)) }),
  });
  return { ...provider,
    stream: (model, context, options = {}) => provider.stream(model, context, requestOptions(options)),
    streamSimple: (model, context, options = {}) => provider.streamSimple(model, context, requestOptions(options)),
  };
}
