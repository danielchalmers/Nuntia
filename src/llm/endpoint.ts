export type ProviderId = 'gemini' | 'anthropic' | 'openai';

// An empty string counts as absent, because that is what a workflow triggered from a fork gets for every secret.
export interface ModelEnv {
  GEMINI_API_KEY?: string | undefined;
  ANTHROPIC_API_KEY?: string | undefined;
  OPENAI_API_KEY?: string | undefined;
  OPENAI_BASE_URL?: string | undefined;
}

// The Chat Completions endpoint that serves a model.
export interface Endpoint {
  provider: ProviderId;
  model: string;
  baseUrl: string;
  host: string;
  // Absent only for an OPENAI_BASE_URL endpoint that takes no key, such as a local server.
  apiKey: string | undefined;
  keyName: string;
  isDefault: boolean;
}

// In the order a blank model input picks a default from.
const PROVIDERS: Record<ProviderId, { keyName: keyof ModelEnv; baseUrl: string; names?: RegExp }> = {
  gemini: { keyName: 'GEMINI_API_KEY', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', names: /^gemini-/i },
  anthropic: { keyName: 'ANTHROPIC_API_KEY', baseUrl: 'https://api.anthropic.com/v1', names: /^claude-/i },
  openai: { keyName: 'OPENAI_API_KEY', baseUrl: 'https://api.openai.com/v1' },
};

const NO_KEY = 'No model API key is set. Add GEMINI_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY as a secret and map it in the step\'s env. Secrets are not passed to workflows triggered from forks.';

function present(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

// Plain http only reaches this machine, so it can't leak the key or the issue text on the way.
function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(hostname);
}

function parseBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('OPENAI_BASE_URL is not a valid URL. Set it to the API base of an OpenAI-compatible service, such as https://openrouter.ai/api/v1.');
  }
  if (url.username || url.password) {
    throw new Error('OPENAI_BASE_URL includes a user name or password, which would show up in error messages. Put the key in OPENAI_API_KEY instead.');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new Error('OPENAI_BASE_URL must use https, because it receives the API key and the issue text. Plain http is allowed only for localhost.');
  }
  return url;
}

/**
 * Pick the endpoint for a model input from the API keys that are set, where OPENAI_BASE_URL counts as an OpenAI key.
 * With one key set, every model goes to it. With several, `gemini-*` and `claude-*` go to Gemini and Claude, and any other name goes to OpenAI.
 * A blank input uses the default for the first key set, in the order Gemini, Anthropic, OpenAI.
 */
export function resolveModel(input: string, value: string | undefined, env: ModelEnv, defaults: Record<ProviderId, string>): Endpoint {
  const baseUrl = present(env.OPENAI_BASE_URL);
  const keys = (Object.keys(PROVIDERS) as ProviderId[]).filter(id => present(env[PROVIDERS[id].keyName]) || (id === 'openai' && baseUrl));
  if (keys.length === 0) throw new Error(NO_KEY);

  const named = value?.trim();
  const provider = !named || keys.length === 1
    ? keys[0]!
    : keys.find(id => PROVIDERS[id].names?.test(named)) ?? keys.find(id => id === 'openai');
  if (!provider) {
    throw new Error(`${input} "${named}" isn't a gemini-* or claude-* name, so it needs OPENAI_API_KEY or OPENAI_BASE_URL.`);
  }
  if (!named && provider === 'openai' && baseUrl) {
    throw new Error(`${input} is blank, and OPENAI_BASE_URL has no default model. Set ${input} to a model that endpoint serves.`);
  }

  const { keyName } = PROVIDERS[provider];
  const url = provider === 'openai' && baseUrl ? parseBaseUrl(baseUrl) : new URL(PROVIDERS[provider].baseUrl);
  return {
    provider,
    model: named || defaults[provider],
    baseUrl: url.toString().replace(/\/+$/, ''),
    host: url.host,
    apiKey: present(env[keyName]),
    keyName,
    isDefault: !named,
  };
}

// The startup log line for a pass, which names the host because it decides where the key and the issue text go.
export function describeEndpoint(endpoint: Endpoint): string {
  return `${endpoint.model} at ${endpoint.host}${endpoint.isDefault ? ` (default for ${endpoint.keyName})` : ''}`;
}
