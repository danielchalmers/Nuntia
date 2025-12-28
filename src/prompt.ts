import type { ReleaseContext } from './types';
import { loadPrompt } from './storage';

export function buildPrompt(context: ReleaseContext, promptPath: string): { systemPrompt: string; userPrompt: string } {
  const basePrompt = loadPrompt(promptPath);
  const systemPrompt = `${basePrompt}\n\n=== INPUT GUIDANCE ===\nYou will receive a JSON payload with commit data and linked references. Use only that data.\n`;
  const userPrompt = `=== RELEASE CONTEXT (JSON) ===\n${JSON.stringify(context, null, 2)}\n`;

  return { systemPrompt, userPrompt };
}
