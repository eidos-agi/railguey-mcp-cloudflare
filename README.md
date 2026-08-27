# railguey-mcp-cloudflare

Railguey **in the cloud**. A Cloudflare Worker MCP server that bridges Grok to Railway GraphQL.

The CLI lives in [`eidos-agi/railguey`](https://github.com/eidos-agi/railguey). This repo is the hosted Streamable HTTP MCP that Grok can actually add as a connector — Railway’s own MCP (`mcp.railway.com`) is OAuth/CLI-shaped and cannot be added to Grok directly.

Live worker: [railguey.eidos-agi.workers.dev](https://railguey.eidos-agi.workers.dev)

MCP: `https://railguey.eidos-agi.workers.dev/mcp`

Product page: [eidosagi.com/tools/railguey](https://eidosagi.com/tools/railguey/)

## Why a separate repo

| Repo | What it is |
|------|------------|
| [`eidos-agi/railguey`](https://github.com/eidos-agi/railguey) | Project-scoped Railway **CLI** (Go). Local shells, GitHub Actions, agents with a workspace path. |
| **`eidos-agi/railguey-mcp-cloudflare`** | Hosted **MCP server** (this Worker). Grok talks HTTP here; the Worker talks Railway GraphQL. |

The Worker script is still named `railguey` on Cloudflare. That name is the `workers.dev` host and must match `wrangler.toml` `name`. The GitHub repo is named for what it is.

## Pairing (claim codes)

Railway tokens never go through Grok chat. Pairing is a device-code flow:

1. Grok calls `account_pair_begin` (or a code is minted here).
2. You open `/pair/<CODE>` on this worker.
3. Paste a Railway token and give the account a slug (`eidos`, `personal`, `client-acme`).
4. The worker validates the token against Railway, stores it in KV, and Grok sees it via `account_list`.

Codes expire in 10 minutes, are single-use, and burn after 8 failed pastes.

Account tokens (`railway.com/account/tokens`), workspace tokens, and project tokens (Project → Settings → Tokens) are all accepted. Kind is recorded so Grok knows the scope.

## Multiple accounts

Each pair is a named slot. Railway tools take an optional `account` slug. One slot is the default.

This matches the CLI model (`~/.railguey/accounts.json`) — named accounts, one default — stored in Workers KV instead of a home directory.

## Endpoints

- `GET /` — status page
- `GET /health` — JSON health (no secrets; includes paired account metadata)
- `GET /pair` — enter a claim code
- `GET|POST /pair/:code` — paste a Railway token
- `POST /mcp` — MCP Streamable HTTP (auth required)
- `GET /__git` — which GitHub SHA the live Worker is running
- `POST /__sync` — pull `main` now (GitHub Actions does this on every push)

## Secrets and bindings

- `MCP_AUTH_TOKEN` — bearer Grok sends as `Authorization: Bearer …`
- KV `ACCOUNTS` (`railguey-accounts`) — paired Railway tokens, claim codes, default slug, plus `git:sha` / `git:code`
- `LOADER` — Dynamic Worker Loader; runs `index.js` from git

Never commit tokens. `wrangler.toml` only has the KV namespace id and Cloudflare account id.

## Connect in Grok

1. grok.com/connectors → Add connector → Other
2. Server URL: `https://railguey.eidos-agi.workers.dev/mcp`
3. Header: `Authorization: Bearer <MCP_AUTH_TOKEN>`
4. Ask Grok to pair a Railway account, then open the claim URL it returns

## Deploy

**`git push` to `main` is the deploy.** The live Worker is a git-attached loader:

1. `loader.js` is the Cloudflare script (KV + Worker Loader + cron).
2. On push, GitHub Actions POSTs `/__sync`. The loader fetches `index.js` from this repo’s `main` and runs it.
3. A `*/5 * * * *` cron is the backup if Actions is delayed.

No Cloudflare API token. No Cloudflare GitHub App. Changing MCP behavior means editing `index.js` and pushing.

`GET /__git` shows the SHA currently loaded.

`name = "railguey"` must not change. Renaming the Worker would break the live host and Grok’s connector URL.

## License

MIT
