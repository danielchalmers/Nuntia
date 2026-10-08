import { AnthropicClient } from './llm/anthropic';
import { GeminiClient } from './llm/gemini';
import { OpenAIClient } from './llm/openai';
import type { ProviderId, ResolvedModel } from './llm/resolve';
import { createModelFetch, MODEL_TIMEOUT_MS } from './llm/transport';
import { ModelError, type TextRequest, type TextResult } from './llm/types';

// Ordinary failures (server errors, network errors, an empty reply) are retried twice, 5s apart and then 10s.
// Capacity errors get the shared layer's longer schedule instead.
const MAX_RETRIES = 2;
const INITIAL_BACKOFF_MS = 5000;

const KEY_VARIABLES: Record<ProviderId, string> = {
  gemini: 'GEMINI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

// What undici's fetch says when the request deadline aborts it; the retry layer keeps only the message.
const ABORTED = 'This operation was aborted';

/** What Nuntia needs from a model provider: one plain text reply, with thoughts and reasoning left out. */
export interface TextClient {
  generateText(request: TextRequest, maxRetries: number, initialBackoffMs: number): Promise<TextResult>;
}

/**
 * The request written to nuntia-payload.json for debugging.
 * It keeps the shape @google/genai took, so the file is the same as before for Gemini, and it holds the model and both prompts for every provider.
 */
export function buildTextPayload(systemPrompt: string, userPrompt: string, model: string) {
  return {
    model,
    contents: [
      {
        role: 'user',
        parts: [{ text: userPrompt }],
      },
    ],
    config: {
      systemInstruction: systemPrompt,
    },
  };
}

/**
 * The client for the provider the model input resolved to.
 * No temperature or reasoning settings are sent, so each model runs at its provider's defaults, as Gemini always has for Nuntia.
 */
export function createModelClient(resolved: ResolvedModel): TextClient {
  if (resolved.provider === 'gemini') {
    // GeminiClient reads GOOGLE_GEMINI_BASE_URL itself, the same variable resolution reads.
    return new GeminiClient(resolved.apiKey ?? '');
  }
  if (resolved.provider === 'anthropic') {
    return new AnthropicClient(resolved.apiKey ?? '', createModelFetch(), resolved.baseUrl);
  }
  // The key is absent only for an OPENAI_BASE_URL endpoint that takes none, such as a local server.
  return new OpenAIClient(resolved.apiKey, createModelFetch(), resolved.baseUrl);
}

// The API's name in messages. An OPENAI_BASE_URL endpoint is named by its host, since it is not OpenAI.
function apiLabel(resolved: ResolvedModel): string {
  if (resolved.provider === 'gemini') return 'Gemini';
  if (resolved.provider === 'anthropic') return 'Claude';
  return resolved.host === 'api.openai.com' ? 'OpenAI' : resolved.host;
}

function keyDescription(resolved: ResolvedModel): string {
  if (resolved.provider === 'gemini') return 'Gemini API key';
  if (resolved.provider === 'anthropic') return 'Anthropic API key';
  return resolved.host === 'api.openai.com' ? 'OpenAI API key' : `key for ${resolved.host}`;
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/**
 * The message for a failed model call, which says what went wrong and what to change.
 * Failures that would repeat on every attempt, such as a bad key or an unknown model, name the secret or the input to fix.
 */
export function explainFailure(err: unknown, resolved: ResolvedModel): string {
  const detail = err instanceof Error ? err.message : String(err);
  if (!(err instanceof ModelError)) return detail;

  const label = apiLabel(resolved);
  const model = resolved.model;
  const key = KEY_VARIABLES[resolved.provider];
  const failure = err.failure;

  switch (failure.kind) {
    case 'fatal':
      if (failure.cause === 'auth') {
        // An OPENAI_BASE_URL endpoint is called without a key when OPENAI_API_KEY is not set.
        const fix = resolved.apiKey
          ? `Check that the ${key} secret is a valid ${keyDescription(resolved)} with access to model "${model}".`
          : `Set ${key} to a key for ${resolved.host}.`;
        return `${label} rejected the credentials: ${detail} ${fix}`;
      }
      if (failure.cause === 'model') {
        return `${label} does not recognize model "${model}", or the model does not support this request: ${detail} Check the "model" input for a typo.`;
      }
      return `${label} says the account is out of credit or over its spend limit: ${detail} Check the billing for the account that ${key} belongs to.`;
    case 'permanent':
      return `${label} rejected the request: ${detail} Check the "model" input (currently "${model}") and the request payload.`;
    case 'truncated':
      return `${detail}, so the release notes would be incomplete and were not written. A response that long would likely hit the limit again, so it is not retried. Narrow the commit range, use a prompt that asks for shorter notes, or choose a model with a larger output limit.`;
    case 'refusal':
      return `${sentence(detail)} The same request would most likely be refused again, so it is not retried.`;
    case 'capacity':
      return `${label} is overloaded or rate limited, and still was after retrying for several minutes: ${detail}`;
    case 'retryable':
      if (detail === ABORTED) return `${label} did not respond within ${MODEL_TIMEOUT_MS / 1000}s, and retries ran out.`;
      return `${label} request failed, and retries ran out: ${detail}`;
  }
}

/** Generate the release notes, retrying as the shared layer does, and fail with a message from explainFailure. */
export async function generateNotes(client: TextClient, resolved: ResolvedModel, request: TextRequest): Promise<TextResult> {
  try {
    return await client.generateText(request, MAX_RETRIES, INITIAL_BACKOFF_MS);
  } catch (err) {
    throw new Error(explainFailure(err, resolved));
  }
}
