const PROVIDER_ID = process.env.OMP_MULTI_CODEX_PROVIDER_ID || "codex-secondary";
if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(PROVIDER_ID)) {
  throw new Error("OMP_MULTI_CODEX_PROVIDER_ID must be a simple provider ID (letters, digits, dots, underscores, or hyphens)");
}
const API_BASE = "https://chatgpt.com/backend-api";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEVICE_AUTH_URL = "https://auth.openai.com/codex/device";
const DEVICE_USERCODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
const CLIENT_VERSION = "0.159.0";
const MAX_POLLS = 120;
const POLL_INTERVAL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 15_000;

const fallbackModels = [{
  id: "gpt-daybreak-blue-latest",
  name: "gpt-daybreak-blue-latest",
  api: "openai-codex-responses",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 272_000,
  maxTokens: 128_000,
}];

function decodeJwtPayload(token) {
  try {
    const segment = token.split(".")[1];
    if (!segment) return {};
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

function accountIdFromToken(token) {
  const claims = decodeJwtPayload(token);
  const accountId = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
  return typeof accountId === "string" ? accountId : undefined;
}

function accountEmailFromToken(token) {
  const claims = decodeJwtPayload(token);
  const email = claims["https://api.openai.com/profile"]?.email;
  return typeof email === "string" ? email : undefined;
}

function validateTokenResponse(body) {
  if (
    typeof body?.access_token !== "string" ||
    typeof body?.refresh_token !== "string" ||
    typeof body?.expires_in !== "number"
  ) {
    throw new Error("Codex OAuth returned an incomplete token response");
  }
  const accountId = accountIdFromToken(body.access_token) ?? accountIdFromToken(body.id_token ?? "");
  if (!accountId) throw new Error("Codex OAuth token did not contain a ChatGPT account ID");
  return {
    access: body.access_token,
    refresh: body.refresh_token,
    expires: Date.now() + body.expires_in * 1000,
    accountId,
    email: accountEmailFromToken(body.access_token),
  };
}

async function readJson(response, action) {
  if (!response.ok) throw new Error(`${action} failed with HTTP ${response.status}`);
  return response.json();
}

async function login(callbacks) {
  const fetcher = callbacks.fetch ?? fetch;
  callbacks.onProgress?.("Requesting a Codex device code…");
  const initiation = await fetcher(DEVICE_USERCODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const authorization = await readJson(initiation, "Codex device authorization");
  if (typeof authorization.device_auth_id !== "string" || typeof authorization.user_code !== "string") {
    throw new Error("Codex device authorization response was incomplete");
  }

  const serverInterval = Number.parseInt(String(authorization.interval ?? "5"), 10);
  const pollIntervalMs = (Number.isFinite(serverInterval) && serverInterval > 0 ? serverInterval : 5) * 1000 + 3_000;
  callbacks.onAuth({
    url: DEVICE_AUTH_URL,
    instructions: `Sign in to the ChatGPT account you want to use for ${PROVIDER_ID} and enter this code: ${authorization.user_code}`,
  });
  callbacks.onProgress?.(`Waiting for ${PROVIDER_ID} account authorization…`);

  for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
    if (callbacks.signal?.aborted) throw new Error("Codex login cancelled");
    await new Promise(resolve => setTimeout(resolve, attempt === 0 ? Math.min(pollIntervalMs, POLL_INTERVAL_MS) : pollIntervalMs));
    const response = await fetcher(DEVICE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_auth_id: authorization.device_auth_id, user_code: authorization.user_code }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 403 || response.status === 404) continue;
    const tokenExchange = await readJson(response, "Codex device authorization");
    if (typeof tokenExchange.authorization_code !== "string" || typeof tokenExchange.code_verifier !== "string") {
      throw new Error("Codex device authorization response was incomplete");
    }

    const tokens = await fetcher(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code: tokenExchange.authorization_code,
        code_verifier: tokenExchange.code_verifier,
        redirect_uri: DEVICE_REDIRECT_URI,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return validateTokenResponse(await readJson(tokens, "Codex token exchange"));
  }
  throw new Error("Codex device authorization expired before login completed");
}

async function refreshToken(credentials) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: credentials.refresh,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const refreshed = validateTokenResponse(await readJson(response, "Codex token refresh"));
  return { ...refreshed, email: refreshed.email ?? credentials.email };
}

function toModel(entry) {
  const id = typeof entry?.slug === "string" ? entry.slug : entry?.id;
  if (typeof id !== "string" || !/^[a-zA-Z0-9._-]+$/.test(id)) return null;
  const contextWindow = Number.isInteger(entry.context_window) && entry.context_window > 0
    ? entry.context_window
    : 272_000;
  const modalities = Array.isArray(entry.input_modalities)
    ? entry.input_modalities.filter(value => value === "text" || value === "image")
    : ["text", "image"];
  return {
    id,
    name: typeof entry.display_name === "string" ? entry.display_name : id,
    api: "openai-codex-responses",
    reasoning: true,
    input: modalities.length ? modalities : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 128_000,
  };
}

async function fetchDynamicModels(apiKey) {
  if (!apiKey) return fallbackModels;
  const accountId = accountIdFromToken(apiKey);
  const headers = new Headers({
    Authorization: `Bearer ${apiKey}`,
    "OpenAI-Beta": "responses=experimental",
    originator: "codex_cli_rs",
    version: CLIENT_VERSION,
    accept: "application/json",
  });
  if (accountId) headers.set("chatgpt-account-id", accountId);

  for (const path of ["/codex/models", "/models"]) {
    const url = new URL(`${API_BASE}${path}`);
    url.searchParams.set("client_version", CLIENT_VERSION);
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }).catch(() => null);
    if (!response?.ok) continue;
    const payload = await response.json().catch(() => null);
    const entries = Array.isArray(payload?.models) ? payload.models : Array.isArray(payload?.data) ? payload.data : [];
    const models = entries.map(toModel).filter(Boolean);
    if (models.length) return models;
  }
  return fallbackModels;
}

export default function registerMultiCodex(pi) {
  pi.registerProvider(PROVIDER_ID, {
    name: `Codex account (${PROVIDER_ID})`,
    baseUrl: API_BASE,
    // OMP v18.8.0 drops runtime OAuth-only provider models without a non-empty apiKey.
    // Remove this sentinel once OMP keeps OAuth-only extension models registered.
    // OAuth credentials win; this non-secret value only keeps model registration visible.
    apiKey: `${PROVIDER_ID}-oauth-required`,
    api: "openai-codex-responses",
    models: fallbackModels,
    fetchDynamicModels,
    oauth: {
      name: `Codex account (${PROVIDER_ID})`,
      login,
      refreshToken,
      getApiKey: credentials => credentials.access,
    },
  });
}
