# `opencode-anthropic-auth`

OpenCode plugin for Anthropic auth and Claude-style request adaptation.

It adds Anthropic login methods to OpenCode, supports reusing Claude CLI OAuth credentials, injects model-specific system prompts, and rewrites a few request details so Anthropic OAuth requests behave more like Claude Code.

## Important Info

- Adds an `anthropic` auth provider to OpenCode.
- Supports four auth flows:
  - `Claude Pro/Max` OAuth
  - `Use Claude CLI OAuth`
  - `Create an API Key`
  - `Manually enter API Key`
- Supports exact model-id prompt files like `anthropic-claude-opus-4-6-prompt.txt`.
- Prompt fallback order is:
  - `anthropic-<model-id>-prompt.txt`
  - `anthropic-prompt.txt`
  - built-in default string
- CLI-backed OAuth is stored with `accountId: "cli"` so the plugin can keep using the Claude CLI refresh path.
- The plugin logs which prompt file was used through the OpenCode app logger.

## Installation

OpenCode installs npm plugins automatically with Bun at startup.

For a published package, add it to the `plugin` array in your OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["github:username/opencode-anthropic-auth#main"]
}
```

You can put this in either:

- project config: `opencode.json`
- global config: `~/.config/opencode/opencode.json`

Do not use `plugins` as the key. OpenCode uses `plugin`.

If you want to use this repo as a local file-based plugin instead of a published npm package, place the plugin file in one of OpenCode's plugin directories:

- project plugins: `.opencode/plugins/`
- global plugins: `~/.config/opencode/plugins/`

## Add To OpenCode Plugins

For the npm package form, add the package name to the `plugin` array:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["github:username/opencode-anthropic-auth#main"]
}
```

OpenCode will install the package and its dependencies automatically on startup.

Notes:

- regular and scoped npm package names are supported
- npm packages belong in the `plugin` array
- local source files belong in `.opencode/plugins/` or `~/.config/opencode/plugins/`

## Usage

Start OpenCode after adding the plugin to config. When the plugin is loaded, Anthropic auth will be available as a provider login option.

Typical flow:

1. Add `opencode-anthropic-auth` to `plugin` in `opencode.json`.
2. Restart OpenCode.
3. Open provider login and select `anthropic`.
4. Choose one of the auth methods below.
5. Use an Anthropic model in OpenCode.

### Auth Methods

#### `Claude Pro/Max`

- Opens a browser OAuth flow against `claude.ai`.
- You paste the returned authorization code back into OpenCode.
- The plugin exchanges it for OAuth access and refresh tokens.

#### `Use Claude CLI OAuth`

- Reuses an existing Claude CLI login.
- Credential lookup order:
  - macOS Keychain service `Claude Code-credentials`
  - `$CLAUDE_CONFIG_DIR/.credentials.json`
  - `~/.claude/.credentials.json`
- If the CLI-backed token is expired, the plugin refreshes it by running:

```bash
claude -p . --model claude-haiku-4-5-20250514
```

- The plugin then re-reads the Claude CLI credentials and persists the refreshed OAuth values into OpenCode auth storage.

#### `Create an API Key`

- Opens a browser OAuth flow against `console.anthropic.com`.
- Exchanges the auth code for OAuth credentials.
- Calls Anthropic's API key creation endpoint and stores the returned raw API key.

#### `Manually enter API Key`

- Lets you paste an Anthropic API key directly.

## Prompt Files

For Anthropic models, the plugin resolves prompts using the exact upstream model id from OpenCode.

Examples:

- `anthropic-claude-opus-4-6-prompt.txt`
- `anthropic-claude-sonnet-4-5-20250929-prompt.txt`
- `anthropic-prompt.txt`

Resolution order:

1. exact model file: `anthropic-<model-id>-prompt.txt`
2. default file: `anthropic-prompt.txt`
3. built-in fallback: `You are Claude Code, Anthropic's official CLI for Claude.`

The plugin logs the selected prompt source with service name `opencode-anthropic-auth`.

## What The Plugin Changes

- injects the selected Anthropic system prompt before requests are sent
- refreshes OAuth credentials automatically
- sends OAuth-authenticated Anthropic requests with `Authorization: Bearer ...`
- removes `x-api-key` for OAuth requests
- adds Anthropic beta headers required by this flow
- rewrites tool names with `mcp_` on the way out and strips them back from streamed responses
- adds the Claude-style billing header for `/v1/messages`

## Notes And Caveats

- `Use Claude CLI OAuth` requires the `claude` CLI to already be installed and logged in.
- CLI refresh depends on the `claude` command being available on `PATH`.
- macOS Keychain lookup is only attempted on macOS.
- If no model-specific prompt file exists, the default `anthropic-prompt.txt` file is used.
- Existing non-CLI OAuth still uses Anthropic's token endpoint refresh flow.

## Development

Useful quick check:

```bash
bun -e 'await import("./index.mjs"); console.log("import-ok")'
```

If you are developing this as a local plugin and need extra dependencies for file-based plugin loading, OpenCode expects them in `.opencode/package.json` for the local plugin environment.
