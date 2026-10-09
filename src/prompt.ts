import bundledPrompt from '../examples/Nuntia.prompt';
import { errorMessage } from './llm/chat';
import type { ReleaseContext } from './types';

const PROMPT_TIMEOUT_MS = 30_000;
const PROMPT_RETRY_DELAY_MS = 5_000;
const PROMPT_ATTEMPTS = 3;
const PROMPT_URL_HINT = 'Check prompt-url, or leave it blank to use the bundled prompt.';

// A failure that can clear up on its own, so the fetch is tried again.
class TransientError extends Error {}

export type Prompt = {
  text: string;
  // "built-in" for the prompt bundled with the action, or else the URL it came from.
  source: string;
};

/** The prompt bundled with the action when promptUrl is blank, or else the prompt fetched from it. */
export async function loadPrompt(promptUrl: string): Promise<Prompt> {
  if (!promptUrl) return { text: bundledPrompt, source: 'built-in' };
  return { text: await fetchPrompt(promptUrl), source: promptUrl };
}

async function fetchPrompt(url: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchOnce(url);
    } catch (error) {
      if (!(error instanceof TransientError)) throw error;
      if (attempt === PROMPT_ATTEMPTS) {
        throw new Error(`Failed to fetch prompt from ${url} after ${PROMPT_ATTEMPTS} attempts: ${error.message}. ${PROMPT_URL_HINT}`);
      }
      console.warn(`Failed to fetch prompt from ${url}; retrying in ${PROMPT_RETRY_DELAY_MS / 1000}s: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, PROMPT_RETRY_DELAY_MS));
    }
  }
}

async function fetchOnce(url: string): Promise<string> {
  let response: Response;
  let text: string;
  try {
    // The timeout covers reading the body too.
    response = await fetch(url, { signal: AbortSignal.timeout(PROMPT_TIMEOUT_MS) });
    text = await response.text();
  } catch (error) {
    throw new TransientError(error instanceof Error && error.name === 'TimeoutError' ? `no response within ${PROMPT_TIMEOUT_MS / 1000}s` : errorMessage(error));
  }
  if (!response.ok) {
    const status = `${response.status} ${response.statusText}`.trim();
    // A request timeout, a rate limit or a server error can succeed when sent again, while any other status means the URL is wrong.
    if (response.status === 408 || response.status === 429 || response.status >= 500) throw new TransientError(status);
    throw new Error(`Failed to fetch prompt from ${url}: ${status}. ${PROMPT_URL_HINT}`);
  }
  if (!text.trim()) throw new Error(`Prompt at ${url} is empty. ${PROMPT_URL_HINT}`);
  return text;
}

export function buildPrompt(
  context: ReleaseContext,
  basePrompt: string
): { systemPrompt: string; userPrompt: string } {
  const userPrompt = `=== RELEASE CONTEXT (JSON) ===\n${JSON.stringify(context, null, 2)}\n`;

  return { systemPrompt: basePrompt, userPrompt };
}
