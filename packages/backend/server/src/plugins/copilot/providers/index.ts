import {
  AnthropicOfficialProvider,
  AnthropicVertexProvider,
} from './anthropic';
import { CloudflareWorkersAIProvider } from './cloudflare';
import { FalProvider } from './fal';
import { GeminiGenerativeProvider, GeminiVertexProvider } from './gemini';
import { MorphProvider } from './morph';
import { OllamaProvider } from './ollama';
import { OpenAIProvider } from './openai';
import { PerplexityProvider } from './perplexity';

export const CopilotProviders = [
  OpenAIProvider,
  CloudflareWorkersAIProvider,
  FalProvider,
  GeminiGenerativeProvider,
  GeminiVertexProvider,
  PerplexityProvider,
  AnthropicOfficialProvider,
  AnthropicVertexProvider,
  MorphProvider,
  OllamaProvider,
];

export {
  AnthropicOfficialProvider,
  AnthropicVertexProvider,
} from './anthropic';
export { CloudflareWorkersAIProvider } from './cloudflare';
export { CopilotProviderFactory } from './factory';
export { FalProvider } from './fal';
export { GeminiGenerativeProvider, GeminiVertexProvider } from './gemini';
export { OllamaProvider } from './ollama';
export { OpenAIProvider } from './openai';
export { PerplexityProvider } from './perplexity';
export type { CopilotProvider } from './provider';
export * from './types';
