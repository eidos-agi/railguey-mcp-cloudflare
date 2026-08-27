/**
 * Git-attached loader for railguey — NOT LIVE on this account.
 *
 * Cloudflare rejected the worker_loader binding with 10195
 * (Dynamic Workers requires a paid Workers plan). Live deploys
 * upload index.js instead, via Grok automation railguey-git-deploy
 * on push to eidos-agi/railguey-mcp-cloudflare@main.
 *
 * Keep this file. If the account is upgraded, wrangler.toml main
 * can point here and the isolate will pull index.js from git.
 */
const REPO = "eidos-agi/railguey-mcp-cloudflare";
const BRANCH = "main";
const SRC = "index.js";
const GH = "https://api.github.com/repos/" + REPO;
const RAW = "https://raw.githubusercontent.com/" + REPO;
const UA = { "User-Agent": "railguey-git-loader", Accept: "application/vnd.github+json" };

async function githubJson(url) {
  const res = await fetch(url, { headers: UA });
  const text = await res.text();
  if (!res.ok) throw new Error("github " + res.status + " " + url + " " + text.slice(0, 180));
  return JSON.parse(text);
}

async function syncFromGit(env) {
  const head = await githubJson(GH + "/commits/" + BRANCH);
  const sha = head.sha;
  if (!sha) throw new Error("github main has no sha");
  const prev = await env.ACCOUNTS.get("git:sha");
  if (sha === prev) {
    return { sha: sha, changed: false, syncedAt: await env.ACCOUNTS.get("git:synced_at") };
  }
  const raw = await fetch(RAW + "/" + sha + "/" + SRC, { headers: { "User-Agent": UA["User-Agent"] } });
  if (!raw.ok) throw new Error("raw " + raw.status);
  const code = await raw.text();
  if (code.length < 2000 || code.indexOf("export default") === -1) {
    throw new Error("refusing to load source: " + code.length + " bytes");
  }
  const now = new Date().toISOString();
  await env.ACCOUNTS.put("git:code", code);
  await env.ACCOUNTS.put("git:sha", sha);
  await env.ACCOUNTS.put("git:synced_at", now);
  return { sha: sha, changed: true, syncedAt: now, bytes: code.length };
}

function innerEnv(env) {
  const out = {
    ACCOUNTS: env.ACCOUNTS,
    MCP_AUTH_TOKEN: env.MCP_AUTH_TOKEN,
  };
  if (env.RAILWAY_API_TOKEN) out.RAILWAY_API_TOKEN = env.RAILWAY_API_TOKEN;
  if (env.ALLOW_QUERY_TOKEN) out.ALLOW_QUERY_TOKEN = env.ALLOW_QUERY_TOKEN;
  return out;
}

async function loadInner(env, request) {
  let sha = await env.ACCOUNTS.get("git:sha");
  let code = await env.ACCOUNTS.get("git:code");
  if (!code || !sha) {
    await syncFromGit(env);
    sha = await env.ACCOUNTS.get("git:sha");
    code = await env.ACCOUNTS.get("git:code");
  }
  if (!code) throw new Error("no source after sync");
  if (!env.LOADER) throw new Error("LOADER binding missing");
  const worker = env.LOADER.get(sha, () => ({
    compatibilityDate: "2025-04-01",
    mainModule: "index.js",
    modules: { "index.js": code },
    env: innerEnv(env),
  }));
  return worker.getEntrypoint().fetch(request);
}

export default {
  async scheduled(_event, env) {
    await syncFromGit(env);
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/__sync") {
      try {
        const result = await syncFromGit(env);
        return Response.json({ ok: true, repo: REPO, branch: BRANCH, ...result });
      } catch (err) {
        return Response.json({ ok: false, error: String(err && err.message ? err.message : err) }, { status: 502 });
      }
    }
    if (url.pathname === "/__git") {
      return Response.json({
        ok: true,
        repo: "https://github.com/" + REPO,
        branch: BRANCH,
        sha: await env.ACCOUNTS.get("git:sha"),
        syncedAt: await env.ACCOUNTS.get("git:synced_at"),
        loader: true,
      });
    }
    try {
      return await loadInner(env, request);
    } catch (err) {
      return Response.json(
        {
          ok: false,
          error: "git loader failed",
          detail: String(err && err.message ? err.message : err),
          hint: "POST /__sync",
        },
        { status: 503 },
      );
    }
  },
};
