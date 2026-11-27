/**
 * Kimi Code (Moonshot AI) OAuth support.
 *
 * Mirrors the login used by the official Kimi Code CLI (`kimi`,
 * github.com/MoonshotAI/kimi-code): an RFC 8628 device-code flow against
 * auth.kimi.com, with the token stored in
 * `$KIMI_CODE_HOME/credentials/kimi-code.json` (default `~/.kimi-code`).
 * AIdea reads and writes that same file, so signing in from either AIdea or
 * the CLI signs in both.
 *
 * Everything here is free of Zotero globals except the small file helpers at
 * the bottom, so the wire logic can be unit tested in Node.
 */

export const KIMI_CODE_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
export const KIMI_CODE_DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
export const KIMI_CODE_DEFAULT_BASE_URL = "https://api.kimi.com/coding/v1";
export const KIMI_CODE_CREDENTIAL_NAME = "kimi-code";
/** The platform tag the Kimi Code CLI sends in X-Msh-Platform. */
export const KIMI_CODE_PLATFORM = "kimi_code_cli";

/** Refresh when less than max(5 min, half the lifetime) remains (CLI rule). */
const MIN_REFRESH_THRESHOLD_SECONDS = 300;
const REFRESH_THRESHOLD_RATIO = 0.5;

export type KimiCodeToken = {
  accessToken: string;
  refreshToken: string;
  /** Epoch seconds. */
  expiresAt: number;
  /** Lifetime in seconds as issued. */
  expiresIn: number;
  scope: string;
  tokenType: string;
};

export type KimiCodeEnv = {
  KIMI_CODE_HOME?: string;
  KIMI_CODE_OAUTH_HOST?: string;
  KIMI_OAUTH_HOST?: string;
  KIMI_CODE_BASE_URL?: string;
};

type PathJoin = (...parts: string[]) => string;

export function resolveKimiCodeHomeDir(
  env: KimiCodeEnv,
  home: string,
  join: PathJoin,
): string {
  const explicit = String(env.KIMI_CODE_HOME || "").trim();
  if (explicit) return explicit;
  return home ? join(home, ".kimi-code") : "";
}

export function resolveKimiCodeCredentialPath(
  env: KimiCodeEnv,
  home: string,
  join: PathJoin,
): string {
  const dir = resolveKimiCodeHomeDir(env, home, join);
  return dir
    ? join(dir, "credentials", `${KIMI_CODE_CREDENTIAL_NAME}.json`)
    : "";
}

export function resolveKimiCodeOAuthHost(env: KimiCodeEnv): string {
  const host =
    String(env.KIMI_CODE_OAUTH_HOST || "").trim() ||
    String(env.KIMI_OAUTH_HOST || "").trim() ||
    KIMI_CODE_DEFAULT_OAUTH_HOST;
  return host.replace(/\/+$/, "");
}

export function resolveKimiCodeBaseUrl(env: KimiCodeEnv): string {
  const base =
    String(env.KIMI_CODE_BASE_URL || "").trim() || KIMI_CODE_DEFAULT_BASE_URL;
  return base.replace(/\/+$/, "");
}

/** Parse the CLI's credential file. Returns null for missing or revoked tokens. */
export function parseKimiCodeCredentialFile(
  data: unknown,
): KimiCodeToken | null {
  if (!data || typeof data !== "object") return null;
  const row = data as Record<string, unknown>;
  const accessToken =
    typeof row.access_token === "string" ? row.access_token.trim() : "";
  if (!accessToken) return null;
  const num = (value: unknown) => {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    accessToken,
    refreshToken:
      typeof row.refresh_token === "string" ? row.refresh_token.trim() : "",
    expiresAt: num(row.expires_at),
    expiresIn: num(row.expires_in),
    scope: typeof row.scope === "string" ? row.scope : "",
    tokenType:
      typeof row.token_type === "string" && row.token_type
        ? row.token_type
        : "Bearer",
  };
}

/** Serialize in the exact shape the Kimi Code CLI writes. */
export function serializeKimiCodeToken(token: KimiCodeToken): string {
  return JSON.stringify(
    {
      access_token: token.accessToken,
      refresh_token: token.refreshToken,
      expires_at: token.expiresAt,
      scope: token.scope,
      token_type: token.tokenType,
      expires_in: token.expiresIn,
    },
    null,
    2,
  );
}

export function tokenFromOAuthResponse(
  payload: Record<string, unknown>,
  nowSeconds: number,
): KimiCodeToken {
  const accessToken = String(payload.access_token || "").trim();
  if (!accessToken)
    throw new Error("Kimi Code token response has no access_token");
  const expiresIn = Number(payload.expires_in);
  const lifetime = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 0;
  return {
    accessToken,
    refreshToken: String(payload.refresh_token || "").trim(),
    expiresAt: lifetime ? Math.floor(nowSeconds) + lifetime : 0,
    expiresIn: lifetime,
    scope: typeof payload.scope === "string" ? payload.scope : "",
    tokenType:
      typeof payload.token_type === "string" && payload.token_type
        ? payload.token_type
        : "Bearer",
  };
}

export function shouldRefreshKimiCodeToken(
  token: KimiCodeToken,
  nowSeconds: number,
): boolean {
  if (!token.refreshToken || !token.expiresAt) return false;
  const threshold = Math.max(
    MIN_REFRESH_THRESHOLD_SECONDS,
    (token.expiresIn || 0) * REFRESH_THRESHOLD_RATIO,
  );
  return token.expiresAt - nowSeconds < threshold;
}

export type KimiCodeDeviceIdentity = {
  version: string;
  deviceId: string;
  deviceName: string;
  deviceModel: string;
  osVersion: string;
};

/** HTTP header values must be printable ASCII. */
function headerSafe(value: string, fallback: string): string {
  const cleaned = String(value || "")
    .replace(/[^\x20-\x7e]/g, "")
    .trim();
  return cleaned || fallback;
}

/** Device headers the Kimi Code service expects on auth and API calls. */
export function buildKimiCodeIdentityHeaders(
  identity: KimiCodeDeviceIdentity,
  userAgent: string,
): Record<string, string> {
  return {
    "User-Agent": headerSafe(userAgent, "AIdea"),
    "X-Msh-Platform": KIMI_CODE_PLATFORM,
    "X-Msh-Version": headerSafe(identity.version, "0.0.0"),
    "X-Msh-Device-Name": headerSafe(identity.deviceName, "zotero"),
    "X-Msh-Device-Model": headerSafe(identity.deviceModel, "unknown"),
    "X-Msh-Os-Version": headerSafe(identity.osVersion, "unknown"),
    "X-Msh-Device-Id": headerSafe(identity.deviceId, "unknown"),
  };
}

export type KimiCodeTransport =
  "chat-completions" | "anthropic-messages" | "responses";

export type KimiCodeModel = {
  id: string;
  label: string;
  contextWindowTokens?: number;
  reasoningLevels?: string[];
  defaultReasoningLevel?: string;
  supportedEndpoints: KimiCodeTransport[];
};

function transportFromProtocol(value: unknown): KimiCodeTransport {
  const protocol = String(value || "")
    .trim()
    .toLowerCase();
  if (protocol === "anthropic") return "anthropic-messages";
  if (protocol === "response" || protocol === "responses") return "responses";
  return "chat-completions";
}

const KNOWN_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/**
 * Parse `GET {base}/models`. The current CLI reads `limit.context`,
 * `reasoning.effort.{valid,default}` and `protocol`; older responses used
 * `context_length`. Both are accepted.
 */
export function parseKimiCodeModelsResponse(data: unknown): KimiCodeModel[] {
  const rows = Array.isArray(data)
    ? data
    : Array.isArray((data as any)?.data)
      ? (data as any).data
      : [];
  const out: KimiCodeModel[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, any>;
    const id = String(row.id || "").trim();
    if (!id) continue;
    const context = Number(row.limit?.context ?? row.context_length);
    const model: KimiCodeModel = {
      id,
      label: String(row.display_name || id).trim() || id,
      supportedEndpoints: [transportFromProtocol(row.protocol)],
    };
    if (Number.isFinite(context) && context > 0) {
      model.contextWindowTokens = Math.floor(context);
    }
    const effort = row.reasoning?.effort;
    if (row.reasoning?.type !== "none" && Array.isArray(effort?.valid)) {
      const levels = effort.valid
        .map((value: unknown) =>
          String(value || "")
            .trim()
            .toLowerCase(),
        )
        .filter((value: string) => KNOWN_EFFORTS.has(value));
      model.reasoningLevels = Array.from(new Set<string>(levels));
      const def = String(effort.default || "")
        .trim()
        .toLowerCase();
      if (def && model.reasoningLevels.includes(def)) {
        model.defaultReasoningLevel = def;
      }
    }
    out.push(model);
  }
  return out;
}

export type KimiChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | Array<Record<string, unknown>>;
};

/** OpenAI chat/completions messages, with images on the final user turn. */
export function buildKimiChatMessages(params: {
  prompt: string;
  context?: string;
  formattedContext?: string;
  history?: Array<{ role: "user" | "assistant" | "system"; content: any }>;
  systemPrompt?: string;
  images?: string[];
}): KimiChatMessage[] {
  const messages: KimiChatMessage[] = [];
  if (params.systemPrompt?.trim()) {
    messages.push({ role: "system", content: params.systemPrompt.trim() });
  }
  if (params.context?.trim()) {
    messages.push({
      role: "user",
      content: params.formattedContext || params.context,
    });
  }
  for (const msg of params.history || []) {
    const content =
      typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content);
    if (!content.trim()) continue;
    messages.push({
      role:
        msg.role === "assistant"
          ? "assistant"
          : msg.role === "system"
            ? "system"
            : "user",
      content,
    });
  }
  const images = (params.images || []).filter(Boolean);
  if (images.length) {
    messages.push({
      role: "user",
      content: [
        { type: "text", text: params.prompt },
        ...images.map((url) => ({ type: "image_url", image_url: { url } })),
      ],
    });
  } else {
    messages.push({ role: "user", content: params.prompt });
  }
  return messages;
}

// ---------- Network flows (fetch is injected) ----------

type FetchLike = (url: string, init?: any) => Promise<Response>;

export class KimiCodeUnauthorizedError extends Error {}

async function readJsonBody(res: Response): Promise<Record<string, unknown>> {
  try {
    const parsed = (await res.json()) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function formHeaders(identityHeaders: Record<string, string>) {
  return {
    ...identityHeaders,
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
}

/** Refresh an access token. Retries transient failures like the CLI does. */
export async function refreshKimiCodeToken(params: {
  fetch: FetchLike;
  oauthHost: string;
  refreshToken: string;
  identityHeaders: Record<string, string>;
  nowSeconds: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<KimiCodeToken> {
  const sleep =
    params.sleep || ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const url = `${params.oauthHost}/api/oauth/token`;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let res: Response;
    try {
      res = await params.fetch(url, {
        method: "POST",
        headers: formHeaders(params.identityHeaders),
        body: new URLSearchParams({
          client_id: KIMI_CODE_CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: params.refreshToken,
        }).toString(),
      });
    } catch (err) {
      lastError = err;
      await sleep(2 ** attempt * 1000);
      continue;
    }
    const body = await readJsonBody(res);
    if (
      res.status === 401 ||
      res.status === 403 ||
      body.error === "invalid_grant"
    ) {
      throw new KimiCodeUnauthorizedError(
        "Kimi Code session expired. Please log in again.",
      );
    }
    if ([429, 500, 502, 503, 504].includes(res.status)) {
      lastError = new Error(`Kimi Code token refresh HTTP ${res.status}`);
      await sleep(2 ** attempt * 1000);
      continue;
    }
    if (!res.ok) {
      throw new Error(
        `Kimi Code token refresh HTTP ${res.status}${body.error ? `: ${String(body.error)}` : ""}`,
      );
    }
    return tokenFromOAuthResponse(body, params.nowSeconds());
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Kimi Code token refresh failed");
}

export type KimiCodeDeviceAuthorization = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  intervalSeconds: number;
  expiresInSeconds: number;
};

export async function requestKimiCodeDeviceAuthorization(params: {
  fetch: FetchLike;
  oauthHost: string;
  identityHeaders: Record<string, string>;
}): Promise<KimiCodeDeviceAuthorization> {
  const res = await params.fetch(
    `${params.oauthHost}/api/oauth/device_authorization`,
    {
      method: "POST",
      headers: formHeaders(params.identityHeaders),
      body: new URLSearchParams({ client_id: KIMI_CODE_CLIENT_ID }).toString(),
    },
  );
  const body = await readJsonBody(res);
  if (!res.ok) {
    throw new Error(
      `Kimi Code device authorization HTTP ${res.status}${body.error ? `: ${String(body.error)}` : ""}`,
    );
  }
  const deviceCode = String(body.device_code || "");
  const userCode = String(body.user_code || "");
  const verificationUri = String(body.verification_uri || "");
  const verificationUriComplete = String(
    body.verification_uri_complete || verificationUri,
  );
  if (!deviceCode || !verificationUriComplete) {
    throw new Error("Kimi Code device authorization response missing fields");
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete,
    intervalSeconds: Math.max(1, Number(body.interval) || 5),
    expiresInSeconds: Number(body.expires_in) || 15 * 60,
  };
}

/**
 * Poll the token endpoint until the user approves. Kimi answers a pending
 * authorization with a non-2xx status and `error: authorization_pending`, so
 * the body is read regardless of status.
 */
export async function pollKimiCodeDeviceToken(params: {
  fetch: FetchLike;
  oauthHost: string;
  auth: KimiCodeDeviceAuthorization;
  identityHeaders: Record<string, string>;
  nowSeconds: () => number;
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Throw to abort (e.g. a newer login superseded this one). */
  checkCurrent?: () => void;
}): Promise<KimiCodeToken> {
  const sleep =
    params.sleep || ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const nowMs = params.nowMs || (() => Date.now());
  const deadline = nowMs() + params.auth.expiresInSeconds * 1000;
  let intervalSec = params.auth.intervalSeconds;
  let consecutiveFailures = 0;
  while (nowMs() < deadline) {
    await sleep(intervalSec * 1000);
    params.checkCurrent?.();
    let res: Response;
    try {
      res = await params.fetch(`${params.oauthHost}/api/oauth/token`, {
        method: "POST",
        headers: formHeaders(params.identityHeaders),
        body: new URLSearchParams({
          client_id: KIMI_CODE_CLIENT_ID,
          device_code: params.auth.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }).toString(),
      });
    } catch (err) {
      // A dropped request while the user is in the browser must not end the login.
      consecutiveFailures += 1;
      if (consecutiveFailures >= 5) throw err;
      continue;
    }
    consecutiveFailures = 0;
    const body = await readJsonBody(res);
    params.checkCurrent?.();
    if (res.ok && typeof body.access_token === "string" && body.access_token) {
      return tokenFromOAuthResponse(body, params.nowSeconds());
    }
    const error = String(body.error || "");
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      intervalSec += 5;
      continue;
    }
    if (error === "expired_token")
      throw new Error("Kimi Code login code expired");
    if (error === "access_denied")
      throw new Error("Kimi Code login was denied");
    if (res.status >= 500) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= 5) {
        throw new Error(`Kimi Code token poll HTTP ${res.status}`);
      }
      continue;
    }
    throw new Error(
      `Kimi Code login failed${error ? `: ${error}` : ` (HTTP ${res.status})`}`,
    );
  }
  throw new Error("Kimi Code login code expired");
}
