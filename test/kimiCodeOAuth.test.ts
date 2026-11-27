import { assert } from "chai";
import {
  buildKimiChatMessages,
  buildKimiCodeIdentityHeaders,
  KIMI_CODE_CLIENT_ID,
  KimiCodeUnauthorizedError,
  parseKimiCodeCredentialFile,
  parseKimiCodeModelsResponse,
  pollKimiCodeDeviceToken,
  refreshKimiCodeToken,
  requestKimiCodeDeviceAuthorization,
  resolveKimiCodeBaseUrl,
  resolveKimiCodeCredentialPath,
  resolveKimiCodeOAuthHost,
  serializeKimiCodeToken,
  shouldRefreshKimiCodeToken,
  tokenFromOAuthResponse,
} from "../src/utils/kimiCodeOAuth";
import { resetTokenPolicyCacheForTests } from "../src/utils/tokenParameterPolicy";
import { chatWithProviderOAuth, markerToProvider } from "../src/utils/oauthCli";

const winJoin = (...parts: string[]) => parts.join("\\");

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const noSleep = async () => undefined;

describe("Kimi Code OAuth helpers", function () {
  it("uses the Kimi Code CLI credential file and honours KIMI_CODE_HOME", function () {
    assert.equal(
      resolveKimiCodeCredentialPath({}, "C:\\Users\\a", winJoin),
      "C:\\Users\\a\\.kimi-code\\credentials\\kimi-code.json",
    );
    assert.equal(
      resolveKimiCodeCredentialPath(
        { KIMI_CODE_HOME: "D:\\kimi" },
        "C:\\Users\\a",
        winJoin,
      ),
      "D:\\kimi\\credentials\\kimi-code.json",
    );
    assert.equal(resolveKimiCodeCredentialPath({}, "", winJoin), "");
  });

  it("resolves hosts with the CLI's environment overrides", function () {
    assert.equal(resolveKimiCodeOAuthHost({}), "https://auth.kimi.com");
    assert.equal(
      resolveKimiCodeOAuthHost({ KIMI_OAUTH_HOST: "https://b.test/" }),
      "https://b.test",
    );
    assert.equal(
      resolveKimiCodeOAuthHost({
        KIMI_CODE_OAUTH_HOST: "https://a.test",
        KIMI_OAUTH_HOST: "https://b.test",
      }),
      "https://a.test",
    );
    assert.equal(resolveKimiCodeBaseUrl({}), "https://api.kimi.com/coding/v1");
  });

  it("round-trips the credential file in the CLI's field names", function () {
    const token = {
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: 1_800_000_000,
      expiresIn: 3600,
      scope: "kimi-code",
      tokenType: "Bearer",
    };
    const text = serializeKimiCodeToken(token);
    const raw = JSON.parse(text);
    assert.deepEqual(Object.keys(raw).sort(), [
      "access_token",
      "expires_at",
      "expires_in",
      "refresh_token",
      "scope",
      "token_type",
    ]);
    assert.deepEqual(parseKimiCodeCredentialFile(raw), token);
    assert.isNull(parseKimiCodeCredentialFile({ access_token: "" }));
    assert.isNull(parseKimiCodeCredentialFile(null));
  });

  it("stores expiry in epoch seconds", function () {
    const token = tokenFromOAuthResponse(
      { access_token: "a", refresh_token: "r", expires_in: 900 },
      1000.7,
    );
    assert.equal(token.expiresAt, 1900);
    assert.equal(token.tokenType, "Bearer");
  });

  it("refreshes below max(5 minutes, half the lifetime)", function () {
    const token = {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: 10_000,
      expiresIn: 3600,
      scope: "",
      tokenType: "Bearer",
    };
    // Half of 3600 s is 1800 s.
    assert.isFalse(shouldRefreshKimiCodeToken(token, 10_000 - 1801));
    assert.isTrue(shouldRefreshKimiCodeToken(token, 10_000 - 1799));
    const shortLived = { ...token, expiresIn: 200 };
    assert.isTrue(shouldRefreshKimiCodeToken(shortLived, 10_000 - 299));
    assert.isFalse(
      shouldRefreshKimiCodeToken({ ...token, refreshToken: "" }, 10_000),
    );
  });

  it("builds header-safe device identity headers", function () {
    const headers = buildKimiCodeIdentityHeaders(
      {
        version: "1.2.3",
        deviceId: "abc",
        deviceName: "Lab-PC\u00e9",
        deviceModel: "",
        osVersion: "10.0",
      },
      "AIdea/4.0.2",
    );
    assert.equal(headers["X-Msh-Platform"], "kimi_code_cli");
    assert.equal(headers["X-Msh-Device-Name"], "Lab-PC");
    assert.equal(headers["X-Msh-Device-Model"], "unknown");
    assert.equal(headers["User-Agent"], "AIdea/4.0.2");
  });

  it("parses the /models catalog including protocol and reasoning", function () {
    const models = parseKimiCodeModelsResponse({
      data: [
        {
          id: "kimi-for-coding",
          display_name: "Kimi K2.7 Code",
          limit: { context: 262144 },
          reasoning: {
            type: "both",
            effort: { valid: ["low", "high", "bogus"], default: "high" },
          },
        },
        { id: "k3", limit: { context: 1048576 }, protocol: "anthropic" },
        { id: "legacy", context_length: 131072, protocol: "response" },
        { id: "" },
      ],
    });
    assert.lengthOf(models, 3);
    assert.deepEqual(models[0], {
      id: "kimi-for-coding",
      label: "Kimi K2.7 Code",
      contextWindowTokens: 262144,
      supportedEndpoints: ["chat-completions"],
      reasoningLevels: ["low", "high"],
      defaultReasoningLevel: "high",
    });
    assert.deepEqual(models[1].supportedEndpoints, ["anthropic-messages"]);
    assert.deepEqual(models[2].supportedEndpoints, ["responses"]);
    assert.equal(models[2].contextWindowTokens, 131072);
  });

  it("attaches images to the final user turn", function () {
    const messages = buildKimiChatMessages({
      prompt: "What is this?",
      systemPrompt: "sys",
      context: "raw",
      formattedContext: "formatted",
      history: [{ role: "assistant", content: "earlier" }],
      images: ["data:image/png;base64,AAA"],
    });
    assert.deepEqual(
      messages.map((m) => m.role),
      ["system", "user", "assistant", "user"],
    );
    assert.equal(messages[1].content, "formatted");
    assert.deepEqual(messages[3].content, [
      { type: "text", text: "What is this?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
    ]);
  });
});

describe("Kimi Code device login and refresh", function () {
  it("requests a device code with only the client id", async function () {
    let seenBody = "";
    const auth = await requestKimiCodeDeviceAuthorization({
      fetch: async (url, init) => {
        assert.equal(url, "https://auth.test/api/oauth/device_authorization");
        seenBody = String(init?.body);
        return jsonResponse(200, {
          device_code: "dc",
          user_code: "ABCD-1234",
          verification_uri: "https://kimi.test/device",
          verification_uri_complete: "https://kimi.test/device?code=ABCD-1234",
          interval: 2,
          expires_in: 600,
        });
      },
      oauthHost: "https://auth.test",
      identityHeaders: {},
    });
    assert.equal(seenBody, `client_id=${KIMI_CODE_CLIENT_ID}`);
    assert.equal(auth.userCode, "ABCD-1234");
    assert.equal(auth.intervalSeconds, 2);
  });

  it("keeps polling through pending (non-2xx) and slow_down answers", async function () {
    const answers = [
      jsonResponse(400, { error: "authorization_pending" }),
      jsonResponse(400, { error: "slow_down" }),
      jsonResponse(200, {
        access_token: "at",
        refresh_token: "rt",
        expires_in: 3600,
      }),
    ];
    const sleeps: number[] = [];
    let clock = 0;
    const token = await pollKimiCodeDeviceToken({
      fetch: async (_url, init) => {
        assert.include(String(init?.body), "device_code=dc");
        assert.include(
          String(init?.body),
          "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code",
        );
        return answers.shift() as Response;
      },
      oauthHost: "https://auth.test",
      auth: {
        deviceCode: "dc",
        userCode: "u",
        verificationUri: "",
        verificationUriComplete: "x",
        intervalSeconds: 1,
        expiresInSeconds: 600,
      },
      identityHeaders: {},
      nowSeconds: () => 100,
      nowMs: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    assert.equal(token.accessToken, "at");
    assert.equal(token.expiresAt, 3700);
    assert.deepEqual(sleeps, [1000, 1000, 6000]);
  });

  it("stops on access_denied", async function () {
    try {
      await pollKimiCodeDeviceToken({
        fetch: async () => jsonResponse(400, { error: "access_denied" }),
        oauthHost: "https://auth.test",
        auth: {
          deviceCode: "dc",
          userCode: "u",
          verificationUri: "",
          verificationUriComplete: "x",
          intervalSeconds: 1,
          expiresInSeconds: 600,
        },
        identityHeaders: {},
        nowSeconds: () => 0,
        sleep: noSleep,
      });
      assert.fail("expected an error");
    } catch (err) {
      assert.match(String(err), /denied/);
    }
  });

  it("refreshes with the refresh_token grant and retries 5xx", async function () {
    const answers = [
      jsonResponse(503, {}),
      jsonResponse(200, { access_token: "new", expires_in: 3600 }),
    ];
    let lastBody = "";
    const token = await refreshKimiCodeToken({
      fetch: async (url, init) => {
        assert.equal(url, "https://auth.test/api/oauth/token");
        lastBody = String(init?.body);
        return answers.shift() as Response;
      },
      oauthHost: "https://auth.test",
      refreshToken: "old-rt",
      identityHeaders: {},
      nowSeconds: () => 0,
      sleep: noSleep,
    });
    assert.equal(token.accessToken, "new");
    assert.include(lastBody, "grant_type=refresh_token");
    assert.include(lastBody, "refresh_token=old-rt");
  });

  it("reports an invalid_grant refresh as signed out", async function () {
    try {
      await refreshKimiCodeToken({
        fetch: async () => jsonResponse(400, { error: "invalid_grant" }),
        oauthHost: "https://auth.test",
        refreshToken: "rt",
        identityHeaders: {},
        nowSeconds: () => 0,
        sleep: noSleep,
      });
      assert.fail("expected an error");
    } catch (err) {
      assert.instanceOf(err, KimiCodeUnauthorizedError);
    }
  });
});

describe("Kimi Code OAuth chat routing", function () {
  let originalFetch: typeof globalThis.fetch | undefined;
  let prefStore: Map<string, unknown>;
  const credentialFile = {
    access_token: "kimi-token",
    refresh_token: "kimi-refresh",
    // Far from expiry (well past half-life remaining), so no refresh happens.
    expires_at: Math.floor(Date.now() / 1000) + 86_400 * 365,
    expires_in: 3600,
    scope: "",
    token_type: "Bearer",
  };

  before(function () {
    originalFetch = globalThis.fetch;
  });

  beforeEach(function () {
    prefStore = new Map<string, unknown>();
    resetTokenPolicyCacheForTests();
    (globalThis as any).Zotero = {
      Prefs: {
        get: (key: string) => prefStore.get(key),
        set: (key: string, value: unknown) => prefStore.set(key, value),
      },
      File: {
        getContentsAsync: async (path: string) =>
          path.endsWith("device_id")
            ? "device-123"
            : JSON.stringify(credentialFile),
      },
    };
    (globalThis as any).ztoolkit = { log: () => undefined };
    (globalThis as any).Cc = {
      "@mozilla.org/process/environment;1": {
        getService: () => ({
          get: (name: string) => (name === "USERPROFILE" ? "C:\\test" : ""),
        }),
      },
      "@mozilla.org/file/local;1": {
        createInstance: () => ({
          initWithPath() {},
          exists: () => true,
          isDirectory: () => false,
          parent: { path: "C:\\test\\.kimi-code" },
        }),
      },
    };
    (globalThis as any).Ci = { nsIEnvironment: {}, nsIFile: {} };
  });

  afterEach(function () {
    globalThis.fetch = originalFetch as typeof globalThis.fetch;
  });

  it("recognises the oauth://kimi-code marker", function () {
    assert.equal(markerToProvider("oauth://kimi-code"), "kimi-code");
    assert.equal(markerToProvider("kimi-code"), "kimi-code");
  });

  it("streams OpenAI chat/completions from the Kimi Code endpoint", async function () {
    let seenUrl = "";
    let seenPayload: Record<string, any> = {};
    let seenHeaders = new Headers();
    globalThis.fetch = (async (url: string | URL | Request, init?: any) => {
      seenUrl = String(url);
      seenPayload = JSON.parse(String(init?.body || "{}"));
      seenHeaders = new Headers(init?.headers);
      const body =
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}\n\n` +
        "data: [DONE]\n\n";
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof globalThis.fetch;

    const deltas: string[] = [];
    const result = await chatWithProviderOAuth({
      provider: "kimi-code",
      model: "kimi-for-coding",
      prompt: "Hi",
      systemPrompt: "Be brief",
      reasoningEffort: "high",
      onDelta: (d) => deltas.push(d),
    });

    assert.equal(result, "Hello");
    assert.deepEqual(deltas, ["Hel", "lo"]);
    assert.equal(seenUrl, "https://api.kimi.com/coding/v1/chat/completions");
    assert.equal(seenHeaders.get("Authorization"), "Bearer kimi-token");
    assert.equal(seenHeaders.get("X-Msh-Platform"), "kimi_code_cli");
    assert.equal(seenHeaders.get("X-Msh-Device-Id"), "device-123");
    assert.equal(seenPayload.model, "kimi-for-coding");
    assert.equal(seenPayload.stream, true);
    assert.equal(seenPayload.reasoning_effort, "high");
    assert.deepEqual(seenPayload.messages[0], {
      role: "system",
      content: "Be brief",
    });
  });

  it("uses the Anthropic Messages endpoint for models that declare it", async function () {
    prefStore.set(
      "extensions.zotero.aidea.oauthModelListCache",
      JSON.stringify({
        "kimi-code": [
          { id: "k3", label: "K3", supportedEndpoints: ["anthropic-messages"] },
        ],
      }),
    );
    let seenUrl = "";
    let seenPayload: Record<string, any> = {};
    globalThis.fetch = (async (url: string | URL | Request, init?: any) => {
      seenUrl = String(url);
      seenPayload = JSON.parse(String(init?.body || "{}"));
      const body = `data: ${JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Yo" },
      })}\n\n`;
      return new Response(body, { status: 200 });
    }) as typeof globalThis.fetch;

    const result = await chatWithProviderOAuth({
      provider: "kimi-code",
      model: "k3",
      prompt: "Hi",
    });
    assert.equal(result, "Yo");
    assert.equal(seenUrl, "https://api.kimi.com/coding/v1/messages");
    assert.equal(seenPayload.max_tokens, 8192);
  });
});
