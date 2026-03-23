import { homedir, platform } from "node:os";
import { join } from "node:path";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const VERSION = "2.1.76";
const AGENT = `claude-code/${VERSION}`;
const SALT = "59cf53e54c78";

const CLI_ACCOUNT_ID = "cli";
const CLI_KEYCHAIN_SERVICE = "Claude Code-credentials";
const CLI_REFRESH_MODEL = "claude-haiku-4-5-20250514";

const DEFAULT_PROMPT_FILENAME = "anthropic-prompt.txt";
const DEFAULT_PROMPT =
  "You are Claude Code, Anthropic's official CLI for Claude.";

function promptUrl(filename) {
  return new URL(`./${filename}`, import.meta.url);
}

async function readPromptFile(url) {
  const file = Bun.file(url);
  if (!(await file.exists())) {
    return null;
  }
  return file.text();
}

async function prompt(model) {
  const modelID = model?.api?.id;
  if (typeof modelID === "string" && modelID.trim()) {
    const filename = `anthropic-${modelID.trim()}-prompt.txt`;
    const exact = await readPromptFile(promptUrl(filename));
    if (exact !== null) {
      return { text: exact, source: filename };
    }
  }

  const fallback = await readPromptFile(
    promptUrl("./" + DEFAULT_PROMPT_FILENAME),
  );
  if (fallback !== null) {
    return { text: fallback, source: DEFAULT_PROMPT_FILENAME };
  }

  return { text: DEFAULT_PROMPT, source: "builtin-default" };
}

function normalizeExpiry(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;

    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return normalizeExpiry(numeric);

    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) return parsed;
  }

  return null;
}

function oauthSuccess({ access, refresh, expires, accountId }) {
  return {
    type: "success",
    access,
    refresh,
    expires,
    ...(accountId ? { accountId } : {}),
  };
}

function parseClaudeCliCredentials(value) {
  if (!value || typeof value !== "object") return null;

  const oauth =
    value.claudeAiOauth && typeof value.claudeAiOauth === "object"
      ? value.claudeAiOauth
      : value;

  const access = oauth.accessToken ?? oauth.access_token;
  const refresh = oauth.refreshToken ?? oauth.refresh_token;
  const expires = normalizeExpiry(
    oauth.expiresAt ?? oauth.expires_at ?? oauth.expiry ?? oauth.expires,
  );

  if (typeof access !== "string" || !access.trim()) return null;
  if (typeof refresh !== "string" || !refresh.trim()) return null;
  if (!expires || expires <= 0) return null;

  return oauthSuccess({
    access: access.trim(),
    refresh: refresh.trim(),
    expires,
    accountId: CLI_ACCOUNT_ID,
  });
}

function claudeCredentialsPath() {
  const base =
    process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  return join(base, ".credentials.json");
}

async function readStream(stream) {
  if (!stream) return "";
  return new Response(stream).text();
}

async function run(command, args) {
  try {
    const proc = Bun.spawn([command, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: {
        ...process.env,
        TERM: process.env.TERM || "dumb",
      },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      readStream(proc.stdout),
      readStream(proc.stderr),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  } catch (error) {
    return {
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: 1,
    };
  }
}

async function readClaudeCliCredentialsFromKeychain() {
  if (platform() !== "darwin") return null;

  const result = await run("security", [
    "find-generic-password",
    "-s",
    CLI_KEYCHAIN_SERVICE,
    "-w",
  ]);
  if (result.exitCode !== 0 || !result.stdout.trim()) return null;

  try {
    return parseClaudeCliCredentials(JSON.parse(result.stdout.trim()));
  } catch {
    return null;
  }
}

async function readClaudeCliCredentialsFromFile() {
  const file = Bun.file(claudeCredentialsPath());
  if (!(await file.exists())) return null;

  try {
    return parseClaudeCliCredentials(await file.json());
  } catch {
    return null;
  }
}

async function loadClaudeCliCredentials() {
  return (
    (await readClaudeCliCredentialsFromKeychain()) ??
    (await readClaudeCliCredentialsFromFile())
  );
}

async function refreshClaudeCliCredentials() {
  const result = await run("claude", ["-p", ".", "--model", CLI_REFRESH_MODEL]);

  if (result.exitCode !== 0) {
    const detail =
      result.stderr.trim() || result.stdout.trim() || String(result.exitCode);
    throw new Error(`Claude CLI refresh failed: ${detail}`);
  }

  const credentials = await loadClaudeCliCredentials();
  if (!credentials) {
    throw new Error("Claude CLI credentials not found after refresh");
  }

  return credentials;
}

async function loadFreshClaudeCliCredentials() {
  const credentials = await loadClaudeCliCredentials();
  if (credentials && credentials.expires > Date.now()) return credentials;
  return refreshClaudeCliCredentials();
}

function isCliOAuth(auth) {
  return auth?.type === "oauth" && auth.accountId === CLI_ACCOUNT_ID;
}

async function saveOAuthAuth(client, auth) {
  await client.auth.set({
    path: { id: "anthropic" },
    body: {
      type: "oauth",
      access: auth.access,
      refresh: auth.refresh,
      expires: auth.expires,
      ...(auth.accountId ? { accountId: auth.accountId } : {}),
    },
  });
}

async function refreshStoredOAuth(client, auth) {
  if (isCliOAuth(auth)) {
    const refreshed = await refreshClaudeCliCredentials();
    await saveOAuthAuth(client, refreshed);
    return refreshed;
  }

  const res = await fetch("https://console.anthropic.com/v1/oauth/token", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: auth.refresh,
      client_id: CLIENT_ID,
    }),
  });

  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);

  const json = await res.json();
  const refreshed = oauthSuccess({
    refresh: json.refresh_token,
    access: json.access_token,
    expires: Date.now() + json.expires_in * 1000,
    accountId: auth.accountId,
  });
  await saveOAuthAuth(client, refreshed);
  return refreshed;
}

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function random(size) {
  return base64url(crypto.getRandomValues(new Uint8Array(size)));
}

async function pkce() {
  const verifier = random(32);
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return {
    verifier,
    challenge: base64url(new Uint8Array(hash)),
  };
}

function authHeaders(extra = {}) {
  return {
    "Content-Type": "application/json",
    "User-Agent": AGENT,
    ...extra,
  };
}

function text(input) {
  if (!Array.isArray(input)) return "";

  for (const msg of input) {
    if (!msg || typeof msg !== "object") continue;
    if (msg.role !== "user") continue;
    if (typeof msg.content === "string") return msg.content;
    if (!Array.isArray(msg.content)) return "";

    for (const block of msg.content) {
      if (!block || typeof block !== "object") continue;
      if (block.type !== "text") continue;
      if (typeof block.text === "string") return block.text;
    }

    return "";
  }

  return "";
}

function billing(body) {
  const json = JSON.parse(body);
  const sample = [4, 7, 20]
    .map((idx) => text(json.messages).charAt(idx) || "0")
    .join("");
  const hash = Bun.CryptoHasher.hash(
    "sha256",
    `${SALT}${sample}${VERSION}`,
    "hex",
  ).slice(0, 3);
  const entry = process.env["CLAUDE_CODE_ENTRYPOINT"]?.trim() || "cli";
  return `cc_version=${VERSION}.${hash}; cc_entrypoint=${entry}; cch=00000;`;
}

async function authorize(mode) {
  const code = await pkce();
  const url = new URL(
    `https://${mode === "console" ? "console.anthropic.com" : "claude.ai"}/oauth/authorize`,
  );
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set(
    "redirect_uri",
    "https://console.anthropic.com/oauth/code/callback",
  );
  url.searchParams.set(
    "scope",
    "org:create_api_key user:profile user:inference",
  );
  url.searchParams.set("code_challenge", code.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", code.verifier);
  return {
    url: url.toString(),
    verifier: code.verifier,
  };
}

async function exchange(code, verifier) {
  const split = code.split("#");
  const res = await fetch("https://console.anthropic.com/v1/oauth/token", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      code: split[0],
      state: split[1],
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: "https://console.anthropic.com/oauth/code/callback",
      code_verifier: verifier,
    }),
  });

  if (!res.ok) return { type: "failed" };

  const json = await res.json();
  return oauthSuccess({
    refresh: json.refresh_token,
    access: json.access_token,
    expires: Date.now() + json.expires_in * 1000,
  });
}

export async function AnthropicAuthPlugin({ client }) {
  return {
    /* ---------- Could only get defualt prompt working ----------- */
    async "experimental.chat.system.transform"(input, output) {
      if (input.model?.providerID !== "anthropic") return;
      output.system.unshift(DEFAULT_PROMPT);
      if (output.system[1])
        output.system[1] = `${DEFAULT_PROMPT}\n\n${output.system[1]}`;
    },
    // async "experimental.chat.system.transform"(input, output) {
    //   if (input.model?.providerID !== "anthropic") return;
    //   const resolved = await prompt(input.model);
    //   await client.app
    //     .log({
    //       body: {
    //         service: "opencode-anthropic-auth",
    //         level: "debug",
    //         message: "Using Anthropic system prompt",
    //         extra: {
    //           modelID: input.model?.api?.id ?? null,
    //           prompt: resolved.source,
    //         },
    //       },
    //     })
    //     .catch(() => {});
    //   output.system.unshift(resolved.text);
    //   if (output.system[1])
    //     output.system[1] = `${resolved.text}\n\n${output.system[1]}`;
    // },
    auth: {
      provider: "anthropic",
      async loader(getAuth, provider) {
        const auth = await getAuth();
        if (auth.type !== "oauth") return {};

        for (const model of Object.values(provider.models)) {
          model.cost = {
            input: 0,
            output: 0,
            cache: { read: 0, write: 0 },
          };
        }

        return {
          apiKey: "",
          async fetch(input, init) {
            let auth = await getAuth();
            if (auth.type !== "oauth") return fetch(input, init);

            if (!auth.access || auth.expires < Date.now()) {
              auth = await refreshStoredOAuth(client, auth);
            }

            const req = init ?? {};
            const headers = new Headers(
              input instanceof Request ? input.headers : undefined,
            );
            new Headers(req.headers).forEach((value, key) =>
              headers.set(key, value),
            );

            const beta = headers.get("anthropic-beta") || "";
            const list = beta
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean);
            headers.set(
              "anthropic-beta",
              [
                ...new Set([
                  "oauth-2025-04-20",
                  "interleaved-thinking-2025-05-14",
                  ...list,
                ]),
              ].join(","),
            );
            headers.set("authorization", `Bearer ${auth.access}`);
            headers.set("user-agent", AGENT);
            headers.delete("x-api-key");

            const tool = "mcp_";
            let body = req.body;
            if (typeof body === "string") {
              const json = JSON.parse(body);

              if (Array.isArray(json.system)) {
                json.system = json.system.map((item) => {
                  if (!item || typeof item !== "object") return item;
                  if (item.type !== "text" || typeof item.text !== "string")
                    return item;
                  return {
                    ...item,
                    text: item.text
                      .replace(/OpenCode/g, "Claude Code")
                      .replace(/opencode/gi, "Claude"),
                  };
                });
              }

              if (Array.isArray(json.tools)) {
                json.tools = json.tools.map((item) => {
                  if (!item || typeof item !== "object") return item;
                  if (typeof item.name !== "string") return item;
                  return { ...item, name: `${tool}${item.name}` };
                });
              }

              if (Array.isArray(json.messages)) {
                json.messages = json.messages.map((msg) => {
                  if (
                    !msg ||
                    typeof msg !== "object" ||
                    !Array.isArray(msg.content)
                  )
                    return msg;
                  return {
                    ...msg,
                    content: msg.content.map((item) => {
                      if (!item || typeof item !== "object") return item;
                      if (
                        item.type !== "tool_use" ||
                        typeof item.name !== "string"
                      )
                        return item;
                      return { ...item, name: `${tool}${item.name}` };
                    }),
                  };
                });
              }

              body = JSON.stringify(json);
            }

            let url;
            try {
              if (typeof input === "string" || input instanceof URL)
                url = new URL(input.toString());
              if (input instanceof Request) url = new URL(input.url);
            } catch {}

            if (url?.pathname === "/v1/messages" && typeof body === "string") {
              headers.set("x-anthropic-billing-header", billing(body));
            }

            if (
              url?.pathname === "/v1/messages" &&
              !url.searchParams.has("beta")
            ) {
              url.searchParams.set("beta", "true");
              input =
                input instanceof Request
                  ? new Request(url.toString(), input)
                  : url;
            }

            const res = await fetch(input, {
              ...req,
              body,
              headers,
            });

            if (!res.body) return res;

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            const encoder = new TextEncoder();
            const stream = new ReadableStream({
              async pull(ctrl) {
                const part = await reader.read();
                if (part.done) {
                  ctrl.close();
                  return;
                }

                const text = decoder
                  .decode(part.value, { stream: true })
                  .replace(/"name"\s*:\s*"mcp_([^"]+)"/g, '"name": "$1"');

                ctrl.enqueue(encoder.encode(text));
              },
            });

            return new Response(stream, {
              status: res.status,
              statusText: res.statusText,
              headers: res.headers,
            });
          },
        };
      },
      methods: [
        {
          label: "Claude Pro/Max",
          type: "oauth",
          authorize: async () => {
            const auth = await authorize("max");
            return {
              url: auth.url,
              instructions: "Paste the authorization code here: ",
              method: "code",
              callback: async (code) => exchange(code, auth.verifier),
            };
          },
        },
        {
          label: "Use Claude CLI OAuth",
          type: "oauth",
          authorize: async () => ({
            url: "",
            instructions:
              "Reads your existing Claude CLI login and refreshes it with `claude` if needed.",
            method: "auto",
            callback: async () => {
              try {
                return await loadFreshClaudeCliCredentials();
              } catch {
                return { type: "failed" };
              }
            },
          }),
        },
        {
          label: "Create an API Key",
          type: "oauth",
          authorize: async () => {
            const auth = await authorize("console");
            return {
              url: auth.url,
              instructions: "Paste the authorization code here: ",
              method: "code",
              callback: async (code) => {
                const credentials = await exchange(code, auth.verifier);
                if (credentials.type === "failed") return credentials;

                const res = await fetch(
                  "https://api.anthropic.com/api/oauth/claude_cli/create_api_key",
                  {
                    method: "POST",
                    headers: authHeaders({
                      authorization: `Bearer ${credentials.access}`,
                    }),
                  },
                );
                const json = await res.json();
                return { type: "success", key: json.raw_key };
              },
            };
          },
        },
        {
          provider: "anthropic",
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
  };
}
