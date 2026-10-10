import { createHash, randomBytes } from "node:crypto";
import { OAuthCallbackFlow } from "@oh-my-pi/pi-ai/oauth/callback-server";

const PROVIDER_ID = process.env.OMP_MULTI_CODEX_PROVIDER_ID || "codex-secondary";
if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(PROVIDER_ID)) {
  throw new Error("OMP_MULTI_CODEX_PROVIDER_ID must be a simple provider ID (letters, digits, dots, underscores, or hyphens)");
}
const API_BASE = "https://chatgpt.com/backend-api";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const CLIENT_VERSION = "0.159.0";
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

class CodexBrowserOAuth extends OAuthCallbackFlow {
  constructor(callbacks) {
    super(callbacks, {
      preferredPort: 1455,
      callbackPath: "/auth/callback",
      redirectUri: REDIRECT_URI,
      manualInputOnly: true,
    });
    this.fetcher = callbacks.fetch ?? fetch;
  }

  async generateAuthUrl(state, redirectUri) {
    const verifier = randomBytes(32).toString("base64url");
    this.verifier = verifier;
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const params = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      scope: SCOPE,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: "codex_cli_rs",
    });
    return { url: `${AUTHORIZE_URL}?${params}` };
  }

  async exchangeToken(code, _state, redirectUri) {
    const response = await this.fetcher(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code,
        code_verifier: this.verifier,
        redirect_uri: redirectUri,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return validateTokenResponse(await readJson(response, "Codex token exchange"));
  }
}

async function login(callbacks) {
  return new CodexBrowserOAuth(callbacks).login();
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
