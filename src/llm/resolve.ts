// Source: AutoTriage (danielchalmers/AutoTriage, src/llm/). Nuntia copies this folder verbatim, so change it in AutoTriage and copy it over in a paired PR.

// Model resolution: which provider serves a model input, with which key, at which support tier.
// It is a pure function of the input and the environment the caller passes in, so both actions apply the same rules and the tests need no process state.

export type ProviderId = 'gemini' | 'anthropic' | 'openai';

/**
 * How well a route is supported.
 * `official` is the current model family on its provider's own API, which the request shape is tested against.
 * Anything else that is reachable, including every OPENAI_BASE_URL endpoint, is `best-effort`.
 */
export type Tier = 'official' | 'best-effort';

/**
 * The only variables resolution reads.
 * An empty string counts as absent, because that is what a workflow triggered from a fork gets for every secret.
 */
export interface ModelEnv {
  GEMINI_API_KEY?: string | undefined;
  ANTHROPIC_API_KEY?: string | undefined;
  OPENAI_API_KEY?: string | undefined;
  OPENAI_BASE_URL?: string | undefined;
  GOOGLE_GEMINI_BASE_URL?: string | undefined;
}

export interface ResolvedModel {
  provider: ProviderId;
  // The ID sent to the API, with any provider prefix that only picked the route removed.
  model: string;
  tier: Tier;
  // The API's base URL without a trailing slash, and its host for logs.
  baseUrl: string;
  host: string;
  // Absent only for an OPENAI_BASE_URL endpoint that takes no key, such as a local server.
  apiKey: string | undefined;
  // Why this route was picked, for the startup log line.
  reason: string;
  // True when the input was blank and the provider's default was used.
  isDefault: boolean;
}

export interface ResolveModelOptions {
  // The input's name as the user sees it, such as `model-pro`, for log lines and errors.
  input: string;
  // The input's value; blank means the default for the first key set.
  value: string | undefined;
  env: ModelEnv;
  // Each action's own default model per provider.
  defaults: Record<ProviderId, string>;
}

/** A model input that can't be resolved. Its message names the input, the model and what to change. */
export class ModelResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelResolutionError';
  }
}

const PROVIDERS: readonly ProviderId[] = ['gemini', 'anthropic', 'openai'];

const KEY_VARIABLES: Record<ProviderId, keyof ModelEnv> = {
  gemini: 'GEMINI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

const FIRST_PARTY_BASE_URLS: Record<ProviderId, string> = {
  gemini: 'https://generativelanguage.googleapis.com',
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
};

// Names that identify their provider without a prefix.
// `gpt-oss` is left out because it is an open-weight family served by many hosts.
const RECOGNIZED_NAMES: Record<ProviderId, RegExp> = {
  gemini: /^(gemini-|models\/|tunedModels\/)/i,
  anthropic: /^claude-/i,
  openai: /^(gpt-(?!oss)|ft:gpt-)/i,
};

// The official family on each first-party API: Gemini 3.x (including the `-latest` aliases), Claude 5.5, and GPT-6.x.
const OFFICIAL_FAMILIES: Record<ProviderId, RegExp> = {
  gemini: /^(models\/)?(gemini-3(\.\d+)?-.+|gemini-.+-latest)$/,
  anthropic: /^claude-(haiku|sonnet|opus)-5-5$/,
  openai: /^gpt-6/,
};

const FORK_NOTE = 'Secrets are not passed to workflows triggered from forks.';

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

// Plain http only reaches this machine, so it can't leak the key or the issue text on the way.
function isLoopback(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname === '[::1]'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * The OPENAI_BASE_URL endpoint, which decides where the key and the issue text go.
 * It must be https, except on loopback, and carry no user name or password, which fetch would print in its errors.
 */
function parseEndpoint(value: string): { baseUrl: string; host: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ModelResolutionError('OPENAI_BASE_URL is not a valid URL. Set it to the API base of an OpenAI-compatible service, such as https://openrouter.ai/api/v1.');
  }
  if (url.username || url.password) {
    throw new ModelResolutionError(`OPENAI_BASE_URL for ${url.host} includes a user name or password, which would show up in error messages. Remove them from the URL and put the key in OPENAI_API_KEY.`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new ModelResolutionError(`OPENAI_BASE_URL must use https (${url.protocol}//${url.host} was given), because it receives the API key and the issue text. Plain http is allowed only for localhost.`);
  }
  return { baseUrl: withoutTrailingSlash(url.toString()), host: url.host };
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

interface Route {
  provider: ProviderId;
  model: string;
  reason: string;
  isDefault?: boolean;
}

/**
 * Resolve a model input to the provider that serves it.
 * - A recognized name, or one with a `gemini/`, `anthropic/` or `openai/` prefix, goes to that provider when its key is set.
 * - OPENAI_BASE_URL makes the `openai` provider that endpoint, and a name whose provider has no key goes there unchanged (an explicit `openai/` prefix is removed).
 *   So does any unrecognized name without a prefix, whichever keys are set, because the endpoint is the only place that knows its models.
 * - Without OPENAI_BASE_URL, any other name goes to the only provider with a key.
 * - A blank input uses the default for the first key set, in the order Gemini, Anthropic, OpenAI.
 * Throws ModelResolutionError with a message that names the input, the model and the key or setting to fix.
 */
export function resolveModel(options: ResolveModelOptions): ResolvedModel {
  const { input, env, defaults } = options;
  const value = options.value?.trim() ?? '';
  const keys: Record<ProviderId, string | undefined> = {
    gemini: present(env.GEMINI_API_KEY),
    anthropic: present(env.ANTHROPIC_API_KEY),
    openai: present(env.OPENAI_API_KEY),
  };
  const endpointUrl = present(env.OPENAI_BASE_URL);
  const endpoint = endpointUrl ? parseEndpoint(endpointUrl) : undefined;

  const route = value ? routeNamed(input, value, keys, endpoint) : routeDefault(input, keys, endpoint, defaults);
  return bind(route, keys, endpoint, env);
}

function routeDefault(
  input: string,
  keys: Record<ProviderId, string | undefined>,
  endpoint: { host: string } | undefined,
  defaults: Record<ProviderId, string>
): Route {
  // With OPENAI_BASE_URL set, OPENAI_API_KEY belongs to that endpoint, whose models aren't known in advance.
  const provider = PROVIDERS.find(id => keys[id] && !(id === 'openai' && endpoint));
  if (provider) {
    return { provider, model: defaults[provider], reason: `default for ${KEY_VARIABLES[provider]}`, isDefault: true };
  }
  if (endpoint) {
    throw new ModelResolutionError(`${input} is blank, and OPENAI_BASE_URL (${endpoint.host}) has no default model. Set ${input} to a model that endpoint serves.`);
  }
  throw new ModelResolutionError(`${input} is blank and no model API key is set. Add GEMINI_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY as a secret and map it in the step's env. ${FORK_NOTE}`);
}

function routeNamed(
  input: string,
  value: string,
  keys: Record<ProviderId, string | undefined>,
  endpoint: { host: string } | undefined
): Route {
  // ":" appears in real model IDs (`ft:...`, Ollama tags), so it never separates a provider, and a provider name in front of one is a typo for "/".
  const colon = /^(gemini|anthropic|openai):(.*)$/i.exec(value);
  if (colon) {
    throw new ModelResolutionError(`${input} "${value}" uses ":" after the provider. Did you mean "${colon[1]}/${colon[2]}"? "/" separates the provider from the model.`);
  }

  // A provider with its key serves the name itself; otherwise OPENAI_BASE_URL takes it as `endpointModel`, or the missing key is named.
  const routeTo = (provider: ProviderId, model: string, endpointModel: string): Route => {
    if (keys[provider] && !(provider === 'openai' && endpoint)) return { provider, model, reason: `set by ${input}` };
    if (endpoint) return { provider: 'openai', model: endpointModel, reason: `set by ${input}; sent to OPENAI_BASE_URL` };
    throw missingKey(input, value, provider);
  };

  const prefixed = /^(gemini|anthropic|openai)\/(.*)$/i.exec(value);
  if (prefixed) {
    const provider = prefixed[1]!.toLowerCase() as ProviderId;
    const model = prefixed[2]!.trim();
    if (!model) {
      throw new ModelResolutionError(`${input} "${value}" names no model after "${prefixed[1]}/".`);
    }
    // An explicit openai/ prefix picks the endpoint and is removed; any other prefix is part of the endpoint's model ID, as on OpenRouter.
    return routeTo(provider, model, provider === 'openai' ? model : value);
  }

  const recognized = PROVIDERS.find(id => RECOGNIZED_NAMES[id].test(value));
  if (recognized) return routeTo(recognized, value, value);

  if (endpoint) return { provider: 'openai', model: value, reason: `set by ${input}; sent to OPENAI_BASE_URL` };

  // An unrecognized name, such as `gemma-*`, a preview name, or `o3`, goes to the only provider with a key.
  const keyed = PROVIDERS.filter(id => keys[id]);
  if (keyed.length === 1) {
    const provider = keyed[0]!;
    return { provider, model: value, reason: `set by ${input}; ${KEY_VARIABLES[provider]} is the only key set` };
  }
  if (keyed.length === 0) {
    throw new ModelResolutionError(`${input} "${value}" needs a model API key, and none is set. Add GEMINI_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY as a secret and map it in the step's env, or set OPENAI_BASE_URL. ${FORK_NOTE}`);
  }
  const variables = listOf(keyed.map(id => KEY_VARIABLES[id]), 'and');
  const suggestions = listOf(keyed.map(id => `"${id}/${value}"`), 'or');
  throw new ModelResolutionError(`Can't tell which provider serves ${input} "${value}", because ${variables} are ${keyed.length === 2 ? 'both' : 'all'} set. Write ${suggestions}.`);
}

function listOf(items: string[], conjunction: string): string {
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} ${conjunction} ${items[items.length - 1]}` : items.join('');
}

function missingKey(input: string, value: string, provider: ProviderId): ModelResolutionError {
  return new ModelResolutionError(`${input} "${value}" is served by ${provider}, which needs ${KEY_VARIABLES[provider]}, and it is not set. Add it as a secret and map it in the step's env, or set OPENAI_BASE_URL to send the model to an OpenAI-compatible service. ${FORK_NOTE}`);
}

function bind(
  route: Route,
  keys: Record<ProviderId, string | undefined>,
  endpoint: { baseUrl: string; host: string } | undefined,
  env: ModelEnv
): ResolvedModel {
  const { provider, model } = route;
  let baseUrl: string;
  if (provider === 'openai' && endpoint) {
    baseUrl = endpoint.baseUrl;
  } else if (provider === 'gemini') {
    // GOOGLE_GEMINI_BASE_URL sends Gemini requests to another host, such as a proxy, as it did with @google/genai.
    baseUrl = withoutTrailingSlash(present(env.GOOGLE_GEMINI_BASE_URL) ?? FIRST_PARTY_BASE_URLS.gemini);
  } else {
    baseUrl = FIRST_PARTY_BASE_URLS[provider];
  }

  const host = hostOf(baseUrl);
  const firstParty = host === hostOf(FIRST_PARTY_BASE_URLS[provider]);
  return {
    provider,
    model,
    tier: firstParty && OFFICIAL_FAMILIES[provider].test(model) ? 'official' : 'best-effort',
    baseUrl,
    host,
    apiKey: keys[provider],
    reason: route.reason,
    isDefault: route.isDefault ?? false,
  };
}

/**
 * The resolved route for the startup log, e.g. `claude-haiku-5-5 via anthropic [official] — default for ANTHROPIC_API_KEY`.
 * The host is named whenever it isn't the provider's own API, because it decides where the key and the issue text go.
 * Keys are never included.
 */
export function describeModel(resolved: ResolvedModel): string {
  const host = resolved.host === hostOf(FIRST_PARTY_BASE_URLS[resolved.provider]) ? '' : ` at ${resolved.host}`;
  const tier = resolved.tier === 'official' ? 'official' : 'best effort';
  return `${resolved.model} via ${resolved.provider}${host} [${tier}] — ${resolved.reason}`;
}
