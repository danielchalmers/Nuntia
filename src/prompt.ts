import type { ReleaseContext } from './types';

export async function fetchPrompt(promptUrl: string): Promise<string> {
  const trimmedUrl = promptUrl.trim();
  if (!trimmedUrl) {
    throw new Error('Prompt URL is required and cannot be empty.');
  }

  try {
    const response = await fetch(trimmedUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch prompt from ${trimmedUrl}: ${response.status} ${response.statusText}`.trim());
    }
    const text = await response.text();
    if (!text.trim()) {
      throw new Error(`Prompt at ${trimmedUrl} is empty.`);
    }
    return text;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('Failed to fetch prompt from') || message.startsWith('Prompt at')) {
      throw error instanceof Error ? error : new Error(message);
    }
    throw new Error(`Failed to fetch prompt from ${trimmedUrl}: ${message}`);
  }
}

export function buildPrompt(
  context: ReleaseContext,
  basePrompt: string
): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = `${basePrompt}\n\n=== INPUT GUIDANCE ===\nYou will receive a JSON payload with commit data and linked references. Use only that data.\n`;
  const userPrompt = `=== RELEASE CONTEXT (JSON) ===\n${JSON.stringify(context, null, 2)}\n`;

  return { systemPrompt, userPrompt };
}
