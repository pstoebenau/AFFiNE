import { z } from 'zod';

import {
  CopilotProviderSideError,
  metrics,
  UserFriendlyError,
} from '../../../base';
import {
  llmDispatchStream,
  type NativeLlmBackendConfig,
  type NativeLlmRequest,
} from '../../../native';
import type { NodeTextMiddleware } from '../config';
import type { CopilotToolSet } from '../tools';
import { buildNativeRequest, NativeProviderAdapter } from './native';
import { CopilotProvider } from './provider';
import type {
  CopilotChatOptions,
  ModelAttachmentCapability,
  ModelCapability,
  ModelConditions,
  PromptMessage,
  StreamObject,
} from './types';
import {
  CopilotProviderType,
  ModelInputType,
  ModelOutputType,
} from './types';

export type OllamaConfig = {
  baseURL?: string;
  apiKey?: string;
};

const ModelListSchema = z.object({
  data: z.array(z.object({ id: z.string() })),
});

const OLLAMA_ATTACHMENT_CAPABILITY: ModelAttachmentCapability = {
  kinds: ['image', 'audio'],
  sourceKinds: ['data'],
  allowRemoteUrls: false,
};

function createGemma4Capability(
  output: ModelCapability['output'],
  options: Pick<ModelCapability, 'defaultForOutputType'> = {}
): ModelCapability {
  return {
    input: [ModelInputType.Text, ModelInputType.Image, ModelInputType.Audio],
    output,
    attachments: OLLAMA_ATTACHMENT_CAPABILITY,
    structuredAttachments: OLLAMA_ATTACHMENT_CAPABILITY,
    ...options,
  };
}

export class OllamaProvider extends CopilotProvider<OllamaConfig> {
  readonly type = CopilotProviderType.Ollama;

  readonly models = [
    {
      name: 'Gemma 4 E4B',
      id: 'gemma4:e4b',
      capabilities: [
        createGemma4Capability(
          [ModelOutputType.Text, ModelOutputType.Object],
          { defaultForOutputType: true }
        ),
      ],
    },
  ];

  override configured(): boolean {
    return true;
  }

  protected override setup() {
    super.setup();
  }

  private handleError(e: any) {
    if (e instanceof UserFriendlyError) {
      return e;
    }
    return new CopilotProviderSideError({
      provider: this.type,
      kind: 'unexpected_response',
      message: e?.message || 'Unexpected ollama response',
    });
  }

  private get baseUrl(): string {
    return this.config.baseURL || 'http://localhost:11434/v1';
  }

  override async refreshOnlineModels() {
    try {
      const baseUrl = this.baseUrl;
      if (!this.onlineModelList.length) {
        const { data } = await fetch(`${baseUrl}/models`, {
          headers: {
            ...(this.config.apiKey
              ? { Authorization: `Bearer ${this.config.apiKey}` }
              : {}),
            'Content-Type': 'application/json',
          },
        })
          .then(r => r.json())
          .then(r => ModelListSchema.parse(r));
        this.onlineModelList = data.map(model => model.id);
      }
    } catch (e) {
      this.logger.error('Failed to fetch available Ollama models', e);
    }
  }

  private createNativeConfig(): NativeLlmBackendConfig {
    const baseUrl = this.baseUrl;
    return {
      base_url: baseUrl.replace(/\/v1\/?$/, ''),
      auth_token: this.config.apiKey ?? '',
    };
  }

  private createNativeAdapter(
    tools: CopilotToolSet,
    nodeTextMiddleware?: NodeTextMiddleware[]
  ) {
    return new NativeProviderAdapter(
      (request: NativeLlmRequest, signal?: AbortSignal) =>
        llmDispatchStream(
          'openai_chat',
          this.createNativeConfig(),
          request,
          signal
        ),
      tools,
      this.MAX_STEPS,
      { nodeTextMiddleware }
    );
  }

  private isReasoningModel(model: string): boolean {
    return model.startsWith('gemma4');
  }

  private getReasoning(
    options: NonNullable<CopilotChatOptions>,
    model: string
  ): Record<string, unknown> | undefined {
    if (options.reasoning && this.isReasoningModel(model)) {
      return { effort: 'medium' };
    }
    return undefined;
  }

  async text(
    cond: ModelConditions,
    messages: PromptMessage[],
    options: CopilotChatOptions = {}
  ): Promise<string> {
    const fullCond = { ...cond, outputType: ModelOutputType.Text };
    const model = this.selectModel(
      await this.checkParams({
        messages,
        cond: fullCond,
        options,
      })
    );

    try {
      metrics.ai.counter('chat_text_calls').add(1, this.metricLabels(model.id));
      const tools = await this.getTools(options, model.id);
      const middleware = this.getActiveProviderMiddleware();
      const cap = this.getAttachCapability(model, ModelOutputType.Text);
      const { request } = await buildNativeRequest({
        model: model.id,
        messages,
        options,
        tools,
        attachmentCapability: cap,
        reasoning: this.getReasoning(options, model.id),
        middleware,
      });
      const adapter = this.createNativeAdapter(tools, middleware.node?.text);
      return await adapter.text(request, options.signal, messages);
    } catch (e: any) {
      metrics.ai
        .counter('chat_text_errors')
        .add(1, this.metricLabels(model.id));
      throw this.handleError(e);
    }
  }

  async *streamText(
    cond: ModelConditions,
    messages: PromptMessage[],
    options: CopilotChatOptions = {}
  ): AsyncIterable<string> {
    const fullCond = { ...cond, outputType: ModelOutputType.Text };
    const model = this.selectModel(
      await this.checkParams({
        messages,
        cond: fullCond,
        options,
      })
    );

    try {
      metrics.ai
        .counter('chat_text_stream_calls')
        .add(1, this.metricLabels(model.id));
      const tools = await this.getTools(options, model.id);
      const middleware = this.getActiveProviderMiddleware();
      const cap = this.getAttachCapability(model, ModelOutputType.Text);
      const { request } = await buildNativeRequest({
        model: model.id,
        messages,
        options,
        tools,
        attachmentCapability: cap,
        reasoning: this.getReasoning(options, model.id),
        middleware,
      });
      const adapter = this.createNativeAdapter(tools, middleware.node?.text);
      for await (const chunk of adapter.streamText(
        request,
        options.signal,
        messages
      )) {
        yield chunk;
      }
    } catch (e: any) {
      metrics.ai
        .counter('chat_text_stream_errors')
        .add(1, this.metricLabels(model.id));
      throw this.handleError(e);
    }
  }

  override async *streamObject(
    cond: ModelConditions,
    messages: PromptMessage[],
    options: CopilotChatOptions = {}
  ): AsyncIterable<StreamObject> {
    const fullCond = { ...cond, outputType: ModelOutputType.Object };
    const normalizedCond = await this.checkParams({
      cond: fullCond,
      messages,
      options,
    });
    const model = this.selectModel(normalizedCond);

    try {
      metrics.ai
        .counter('chat_object_stream_calls')
        .add(1, this.metricLabels(model.id));
      const tools = await this.getTools(options, model.id);
      const middleware = this.getActiveProviderMiddleware();
      const cap = this.getAttachCapability(model, ModelOutputType.Object);
      const { request } = await buildNativeRequest({
        model: model.id,
        messages,
        options,
        tools,
        attachmentCapability: cap,
        reasoning: this.getReasoning(options, model.id),
        middleware,
      });
      const adapter = this.createNativeAdapter(tools, middleware.node?.text);
      for await (const chunk of adapter.streamObject(
        request,
        options.signal,
        messages
      )) {
        yield chunk;
      }
    } catch (e: any) {
      metrics.ai
        .counter('chat_object_stream_errors')
        .add(1, this.metricLabels(model.id));
      throw this.handleError(e);
    }
  }
}
