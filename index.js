/**
 * Railguey — remote MCP server for Railway, hosted on Cloudflare Workers.
 * Streamable HTTP at /mcp. Bearer auth via MCP_AUTH_TOKEN.
 * Railway accounts are paired via claim codes into KV (ACCOUNTS).
 */
const NAME = "railguey";
const VERSION = "1.1.0";
const GQL = "https://backboard.railway.com/graphql/v2";
const PROTOCOLS = ["2024-11-05", "2025-03-26", "2025-06-18", "2026-07-28"];
const DEFAULT_PROTOCOL = "2025-03-26";
const PAIR_TTL = 600;
const PAIR_MAX_ATTEMPTS = 8;
const CODE_ALPH = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SLUG_RE = /^[a-z][a-z0-9-]{1,31}$/;
const RESERVED_SLUGS = new Set(["default", "legacy", "pair", "meta", "accounts", "mcp"]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, Authorization, X-Api-Key, X-Railguey-Key, MCP-Session-Id, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "MCP-Session-Id, Mcp-Session-Id, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...extra },
  });
}

function text(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS, ...extra },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...CORS },
  });
}

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const aa = enc.encode(a);
  const bb = enc.encode(b);
  if (aa.byteLength !== bb.byteLength) {
    let acc = 0;
    for (let i = 0; i < aa.byteLength; i++) acc |= aa[i];
    return false;
  }
  let out = 0;
  for (let i = 0; i < aa.byteLength; i++) out |= aa[i] ^ bb[i];
  return out === 0;
}

function extractBearer(request, env) {
  const h = request.headers;
  const auth = h.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  const alt = h.get("X-Api-Key") || h.get("X-Railguey-Key") || "";
  if (alt) return alt.trim();
  const url = new URL(request.url);
  const q = url.searchParams.get("token");
  if (q && env.ALLOW_QUERY_TOKEN === "1") return q.trim();
  return "";
}

function authorized(request, env) {
  const expected = env.MCP_AUTH_TOKEN;
  if (!expected) return { ok: false, status: 503, error: "MCP_AUTH_TOKEN is not configured on this worker." };
  const got = extractBearer(request, env);
  if (!got || !timingSafeEqual(got, expected)) {
    return { ok: false, status: 401, error: "Unauthorized. Send Authorization: Bearer <MCP_AUTH_TOKEN>." };
  }
  return { ok: true };
}

function originOf(request) {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

function mintCode() {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  let out = "";
  for (const b of buf) out += CODE_ALPH[b % CODE_ALPH.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

function normalizeCode(raw) {
  const s = String(raw || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (s.length !== 8) return "";
  for (const ch of s) if (!CODE_ALPH.includes(ch)) return "";
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

function publicAccount(acct, isDefault) {
  if (!acct) return null;
  return {
    slug: acct.slug,
    label: acct.label || acct.slug,
    email: acct.email || null,
    name: acct.name || null,
    kind: acct.kind || "unknown",
    railwayUserId: acct.railwayUserId || null,
    workspaces: acct.workspaces || [],
    projects: (acct.projects || []).map((p) => ({ id: p.id, name: p.name })),
    isDefault: !!isDefault,
    createdAt: acct.createdAt || null,
  };
}

async function readMeta(kv) {
  if (!kv) return { default: null, slugs: [] };
  const meta = await kv.get("meta", { type: "json" });
  if (!meta || typeof meta !== "object") return { default: null, slugs: [] };
  return { default: meta.default || null, slugs: Array.isArray(meta.slugs) ? meta.slugs : [] };
}

async function writeMeta(kv, meta) {
  await kv.put("meta", JSON.stringify({ default: meta.default || null, slugs: meta.slugs || [] }));
}

async function listAccounts(env) {
  const kv = env.ACCOUNTS;
  const meta = await readMeta(kv);
  const accounts = [];
  if (kv) {
    for (const slug of meta.slugs) {
      const acct = await kv.get(`acct:${slug}`, { type: "json" });
      if (acct) accounts.push(publicAccount(acct, meta.default === slug));
    }
  }
  if (!accounts.length && env.RAILWAY_API_TOKEN) {
    accounts.push({
      slug: "legacy",
      label: "Worker secret",
      email: null,
      name: null,
      kind: "secret",
      railwayUserId: null,
      workspaces: [],
      projects: [],
      isDefault: true,
      createdAt: null,
    });
  }
  return { defaultAccount: meta.default || (accounts[0]?.slug ?? null), accounts };
}

async function resolveAccount(env, slug) {
  const kv = env.ACCOUNTS;
  const wanted = slug ? String(slug).trim().toLowerCase() : "";
  if (wanted === "legacy" && env.RAILWAY_API_TOKEN) {
    return { slug: "legacy", token: env.RAILWAY_API_TOKEN, account: { slug: "legacy", kind: "secret", label: "Worker secret" } };
  }
  const meta = await readMeta(kv);
  const use = wanted || meta.default;
  if (kv && use) {
    const acct = await kv.get(`acct:${use}`, { type: "json" });
    if (acct?.token) return { slug: use, token: acct.token, account: acct };
    if (wanted) {
      const known = (await listAccounts(env)).accounts.map((a) => a.slug);
      throw new Error(`Unknown account '${wanted}'. Paired: ${known.join(", ") || "(none)"}.`);
    }
  }
  if (kv && !wanted) {
    const slugs = meta.slugs || [];
    if (slugs.length === 1) {
      const acct = await kv.get(`acct:${slugs[0]}`, { type: "json" });
      if (acct?.token) return { slug: slugs[0], token: acct.token, account: acct };
    }
    if (slugs.length > 1) {
      throw new Error(
        `Multiple Railway accounts paired (${slugs.join(", ")}). Pass account=<slug> or call account_set_default.`,
      );
    }
  }
  if (env.RAILWAY_API_TOKEN) {
    return { slug: "legacy", token: env.RAILWAY_API_TOKEN, account: { slug: "legacy", kind: "secret", label: "Worker secret" } };
  }
  throw new Error("No Railway account paired. Call account_pair_begin and open the claim URL.");
}

async function railwayGql(token, query, variables, mode = "auto") {
  if (!token) throw new Error("No Railway token for this account.");
  const send = (headers) =>
    fetch(GQL, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ query, variables: variables || {} }),
    });
  const read = async (res) => {
    const payload = await res.json().catch(() => ({}));
    return { res, payload };
  };
  const fail = (payload, res) => {
    if (payload.errors && payload.errors.length) {
      throw new Error(payload.errors.map((e) => e.message).join("; "));
    }
    if (!res.ok) throw new Error(`Railway HTTP ${res.status}`);
  };

  if (mode === "project") {
    const { res, payload } = await read(await send({ "Project-Access-Token": token }));
    fail(payload, res);
    return payload.data;
  }
  if (mode === "bearer") {
    const { res, payload } = await read(await send({ Authorization: `Bearer ${token}` }));
    fail(payload, res);
    return payload.data;
  }

  let { res, payload } = await read(await send({ Authorization: `Bearer ${token}` }));
  const failed = !res.ok || (payload.errors && payload.errors.length);
  if (failed && (res.status === 401 || res.status === 403 || /not authorized|unauthor/i.test(JSON.stringify(payload.errors || [])))) {
    ({ res, payload } = await read(await send({ "Project-Access-Token": token })));
  }
  fail(payload, res);
  return payload.data;
}

async function probeToken(token) {
  const trimmed = String(token || "").trim();
  if (trimmed.length < 20) throw new Error("Token looks too short — Railway tokens are typically 30+ characters.");
  if (/\s/.test(trimmed)) throw new Error("Token contains whitespace — likely a paste error.");

  try {
    const data = await railwayGql(trimmed, `query { me { id name email } }`, {}, "bearer");
    if (data?.me) {
      let workspaces = [];
      try {
        const w = await railwayGql(
          trimmed,
          `query { me { workspaces { edges { node { id name } } } } }`,
          {},
          "bearer",
        );
        workspaces = (w?.me?.workspaces?.edges || []).map((e) => e.node);
      } catch {
        try {
          const t = await railwayGql(trimmed, `query { me { teams { edges { node { id name } } } } }`, {}, "bearer");
          workspaces = (t?.me?.teams?.edges || []).map((e) => e.node);
        } catch {
          workspaces = [];
        }
      }
      let projects = [];
      try {
        const p = await railwayGql(trimmed, `query { projects { edges { node { id name } } } }`, {}, "bearer");
        projects = (p?.projects?.edges || []).map((e) => e.node);
      } catch {
        projects = [];
      }
      return {
        kind: "account",
        railwayUserId: data.me.id,
        name: data.me.name || null,
        email: data.me.email || null,
        workspaces,
        projects,
      };
    }
  } catch {
    /* try workspace / project */
  }

  try {
    const data = await railwayGql(trimmed, `query { projects { edges { node { id name } } } }`, {}, "bearer");
    const projects = (data?.projects?.edges || []).map((e) => e.node);
    if (projects.length) {
      return { kind: "workspace", railwayUserId: null, name: null, email: null, workspaces: [], projects };
    }
  } catch {
    /* try project token */
  }

  try {
    const data = await railwayGql(trimmed, `query { projects { edges { node { id name } } } }`, {}, "project");
    const projects = (data?.projects?.edges || []).map((e) => e.node);
    if (projects.length) {
      return {
        kind: "project",
        railwayUserId: null,
        name: projects[0].name || null,
        email: null,
        workspaces: [],
        projects,
      };
    }
  } catch (err) {
    throw new Error(
      `Railway rejected that token (${String(err.message || err)}). Use an account/workspace token from https://railway.com/account/tokens or a project token from Project → Settings → Tokens.`,
    );
  }
  throw new Error("Token did not resolve any Railway identity.");
}

async function saveAccount(env, slug, label, token, probe) {
  const kv = env.ACCOUNTS;
  if (!kv) throw new Error("ACCOUNTS KV is not bound.");
  const meta = await readMeta(kv);
  const rec = {
    slug,
    label: label || slug,
    token,
    kind: probe.kind,
    email: probe.email || null,
    name: probe.name || null,
    railwayUserId: probe.railwayUserId || null,
    workspaces: probe.workspaces || [],
    projects: probe.projects || [],
    createdAt: new Date().toISOString(),
  };
  await kv.put(`acct:${slug}`, JSON.stringify(rec));
  if (!meta.slugs.includes(slug)) meta.slugs.push(slug);
  if (!meta.default) meta.default = slug;
  await writeMeta(kv, meta);
  return publicAccount(rec, meta.default === slug);
}

async function revokeAccount(env, slug) {
  const kv = env.ACCOUNTS;
  if (!kv) throw new Error("ACCOUNTS KV is not bound.");
  const meta = await readMeta(kv);
  if (!meta.slugs.includes(slug)) throw new Error(`Account '${slug}' is not paired.`);
  await kv.delete(`acct:${slug}`);
  meta.slugs = meta.slugs.filter((s) => s !== slug);
  if (meta.default === slug) meta.default = meta.slugs[0] || null;
  await writeMeta(kv, meta);
  return { revoked: slug, defaultAccount: meta.default };
}

async function getPair(kv, code) {
  if (!kv) return null;
  return kv.get(`pair:${code}`, { type: "json" });
}

async function putPair(kv, rec, ttl) {
  const extra = ttl ? { expirationTtl: ttl } : {};
  await kv.put(`pair:${rec.code}`, JSON.stringify(rec), extra);
}

async function mintPair(env, suggestedSlug, suggestedLabel, origin) {
  const kv = env.ACCOUNTS;
  if (!kv) throw new Error("ACCOUNTS KV is not bound.");
  let code = mintCode();
  for (let i = 0; i < 5; i++) {
    if (!(await getPair(kv, code))) break;
    code = mintCode();
  }
  const rec = {
    code,
    suggestedSlug: suggestedSlug || "",
    suggestedLabel: suggestedLabel || "",
    createdAt: Date.now(),
    expiresAt: Date.now() + PAIR_TTL * 1000,
    status: "pending",
    attempts: 0,
    accountSlug: null,
    identity: null,
  };
  await putPair(kv, rec, PAIR_TTL);
  return {
    code,
    url: `${origin}/pair/${code}`,
    expiresIn: PAIR_TTL,
    suggestedSlug: rec.suggestedSlug || null,
    hint: "Open the URL, paste a Railway token, and name the account. Token never goes through Grok.",
  };
}

function resultText(value, isError = false) {
  const textOut = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text: textOut }], isError };
}

function tool(name, description, properties, required, hints, run) {
  const inputSchema = { type: "object", properties: properties || {}, additionalProperties: false };
  if (required && required.length) inputSchema.required = required;
  return {
    name,
    description,
    inputSchema,
    annotations: {
      title: name,
      readOnlyHint: !!hints.readOnly,
      destructiveHint: !!hints.destructive,
      idempotentHint: !!hints.idempotent,
      openWorldHint: true,
    },
    run,
  };
}

const S = (desc) => ({ type: "string", description: desc });
const I = (desc) => ({ type: "integer", description: desc });
const B = (desc) => ({ type: "boolean", description: desc });
const ACCOUNT = S("Paired account slug. Omit to use the default.");

function makeTools(env, origin) {
  const gql = (account) => (q, v) =>
    resolveAccount(env, account).then((resolved) =>
      railwayGql(resolved.token, q, v, resolved.account?.kind === "project" ? "project" : "auto"),
    );

  return [
    tool(
      "account_list",
      "List paired Railway accounts (no tokens). Use the slug as the `account` argument on other tools.",
      {},
      [],
      { readOnly: true, idempotent: true },
      async () => listAccounts(env),
    ),
    tool(
      "account_pair_begin",
      "Mint a one-time claim code. Tell the user to open the returned URL and paste a Railway token there — never ask them to paste a token in chat.",
      { slug: S("Suggested account slug, e.g. eidos or personal"), label: S("Human label") },
      [],
      { idempotent: false },
      async ({ slug, label }) => {
        if (slug) {
          const s = String(slug).trim().toLowerCase();
          if (!SLUG_RE.test(s) || RESERVED_SLUGS.has(s)) throw new Error("Slug must be 2–32 chars, start with a letter, and use lowercase letters, digits, hyphens.");
        }
        return mintPair(env, slug ? String(slug).trim().toLowerCase() : "", label || "", origin);
      },
    ),
    tool(
      "account_pair_status",
      "Check whether a claim code has been completed.",
      { code: S("Claim code, e.g. K7M2-Q9XP") },
      ["code"],
      { readOnly: true },
      async ({ code }) => {
        const kv = env.ACCOUNTS;
        const n = normalizeCode(code);
        if (!n) throw new Error("Invalid claim code.");
        const rec = await getPair(kv, n);
        if (!rec) return { status: "unknown", code: n, note: "Expired, used, or never minted." };
        return {
          status: rec.status,
          code: n,
          accountSlug: rec.accountSlug || null,
          identity: rec.identity || null,
          expiresAt: rec.expiresAt || null,
        };
      },
    ),
    tool(
      "account_set_default",
      "Set the default paired account. Tools that omit `account` use this slug.",
      { slug: S("Account slug") },
      ["slug"],
      { idempotent: true },
      async ({ slug }) => {
        const kv = env.ACCOUNTS;
        const s = String(slug).trim().toLowerCase();
        const meta = await readMeta(kv);
        if (!meta.slugs.includes(s)) throw new Error(`Account '${s}' is not paired.`);
        meta.default = s;
        await writeMeta(kv, meta);
        return { defaultAccount: s };
      },
    ),
    tool(
      "account_revoke",
      "DESTRUCTIVE. Drop a paired Railway account and delete its stored token.",
      { slug: S("Account slug") },
      ["slug"],
      { destructive: true },
      async ({ slug }) => revokeAccount(env, String(slug).trim().toLowerCase()),
    ),
    tool(
      "whoami",
      "Return Railway identity for a paired account. Falls back to project access if the token cannot query me.",
      { account: ACCOUNT },
      [],
      { readOnly: true, idempotent: true },
      async ({ account }) => {
        const resolved = await resolveAccount(env, account);
        try {
          const data = await gql(account)(`query { me { id name email } }`);
          return { account: publicAccount(resolved.account, false), me: data.me };
        } catch (err) {
          const data = await gql(account)(`query { projects { edges { node { id name } } } }`);
          return {
            account: publicAccount(resolved.account, false),
            note: "This token cannot query `me` (typical of workspace/project tokens). Showing accessible projects instead.",
            error: String(err.message || err),
            projects: (data.projects?.edges || []).map((e) => e.node),
          };
        }
      },
    ),
    tool("project_list", "List Railway projects visible to the account, including environments and services.", { account: ACCOUNT }, [], { readOnly: true, idempotent: true }, async ({ account }) => {
      const data = await gql(account)(`
        query {
          projects {
            edges {
              node {
                id name description createdAt updatedAt isPublic teamId baseEnvironmentId
                environments { edges { node { id name } } }
                services { edges { node { id name } } }
              }
            }
          }
        }`);
      return (data.projects?.edges || []).map((e) => e.node);
    }),
    tool("project_info", "Get one Railway project with environments and services.", { account: ACCOUNT, projectId: S("Project ID") }, ["projectId"], { readOnly: true, idempotent: true }, async ({ account, projectId }) => {
      const data = await gql(account)(
        `query project($id: String!) {
          project(id: $id) {
            id name description createdAt updatedAt isPublic teamId baseEnvironmentId
            environments { edges { node { id name createdAt isEphemeral } } }
            services { edges { node { id name createdAt icon } } }
          }
        }`,
        { id: projectId },
      );
      if (!data.project) throw new Error("Project not found");
      return data.project;
    }),
    tool("project_create", "Create a Railway project. Optional workspace/team ID.", { account: ACCOUNT, name: S("Project name"), teamId: S("Workspace/team ID") }, ["name"], { idempotent: false }, async ({ account, name, teamId }) => {
      const data = await gql(account)(
        `mutation projectCreate($name: String!, $teamId: String) {
          projectCreate(input: { name: $name, teamId: $teamId }) {
            id name
            environments { edges { node { id name } } }
          }
        }`,
        { name, teamId: teamId || null },
      );
      return data.projectCreate;
    }),
    tool("project_delete", "DESTRUCTIVE. Permanently delete a Railway project.", { account: ACCOUNT, projectId: S("Project ID") }, ["projectId"], { destructive: true }, async ({ account, projectId }) => {
      await gql(account)(`mutation projectDelete($id: String!) { projectDelete(id: $id) }`, { id: projectId });
      return { deleted: true, projectId };
    }),
    tool("project_environments", "List environments in a project.", { account: ACCOUNT, projectId: S("Project ID") }, ["projectId"], { readOnly: true, idempotent: true }, async ({ account, projectId }) => {
      const data = await gql(account)(
        `query environments($projectId: String!) {
          environments(projectId: $projectId) {
            edges { node { id name projectId createdAt updatedAt isEphemeral unmergedChangesCount } }
          }
        }`,
        { projectId },
      );
      return (data.environments?.edges || []).map((e) => e.node);
    }),
    tool("environment_create", "Create an environment. Optionally clone from sourceEnvironmentId.", {
      account: ACCOUNT, projectId: S("Project ID"), name: S("Environment name"), sourceEnvironmentId: S("Environment to copy from"), ephemeral: B("Create as ephemeral"),
    }, ["projectId", "name"], { idempotent: false }, async ({ account, projectId, name, sourceEnvironmentId, ephemeral }) => {
      const data = await gql(account)(
        `mutation environmentCreate($input: EnvironmentCreateInput!) { environmentCreate(input: $input) { id name } }`,
        { input: { projectId, name, sourceEnvironmentId: sourceEnvironmentId || undefined, ephemeral: ephemeral ?? undefined } },
      );
      return data.environmentCreate;
    }),
    tool("environment_delete", "DESTRUCTIVE. Delete an environment.", { account: ACCOUNT, environmentId: S("Environment ID") }, ["environmentId"], { destructive: true }, async ({ account, environmentId }) => {
      await gql(account)(`mutation environmentDelete($id: String!) { environmentDelete(id: $id) }`, { id: environmentId });
      return { deleted: true, environmentId };
    }),
    tool("service_list", "List services in a project, with recent deployments.", { account: ACCOUNT, projectId: S("Project ID") }, ["projectId"], { readOnly: true, idempotent: true }, async ({ account, projectId }) => {
      const data = await gql(account)(
        `query project($id: String!) {
          project(id: $id) {
            services {
              edges {
                node {
                  id name createdAt icon
                  deployments(first: 5) { edges { node { id status createdAt environmentId staticUrl } } }
                }
              }
            }
          }
        }`,
        { id: projectId },
      );
      return (data.project?.services?.edges || []).map((e) => e.node);
    }),
    tool("service_info", "Get a service and its instance config for an environment.", {
      account: ACCOUNT, serviceId: S("Service ID"), environmentId: S("Environment ID"),
    }, ["serviceId", "environmentId"], { readOnly: true, idempotent: true }, async ({ account, serviceId, environmentId }) => {
      const data = await gql(account)(
        `query serviceInfo($id: String!, $serviceId: String!, $environmentId: String!) {
          service(id: $id) { id name icon createdAt projectId }
          serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
            id serviceName startCommand buildCommand rootDirectory healthcheckPath
            region numReplicas restartPolicyType latestDeployment { id status createdAt url staticUrl }
          }
        }`,
        { id: serviceId, serviceId, environmentId },
      );
      return data;
    }),
    tool("service_create", "Create a service from a GitHub repo (owner/repo or URL), a Docker image, or empty.", {
      account: ACCOUNT, projectId: S("Project ID"), name: S("Service name"), repo: S("GitHub repo, owner/repo or https URL"), branch: S("Git branch"), image: S("Docker image, e.g. nginx:latest"),
    }, ["projectId"], { idempotent: false }, async ({ account, projectId, name, repo, branch, image }) => {
      let source;
      if (image) source = { image };
      else if (repo) {
        const cleaned = String(repo).replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/, "").replace(/\/$/, "");
        source = { repo: cleaned, ...(branch ? { branch } : {}) };
      }
      const data = await gql(account)(
        `mutation serviceCreate($projectId: String!, $name: String, $source: ServiceSourceInput) {
          serviceCreate(input: { projectId: $projectId, name: $name, source: $source }) { id name projectId createdAt }
        }`,
        { projectId, name: name || null, source: source || null },
      );
      return data.serviceCreate;
    }),
    tool("service_update", "Update service instance settings (build/start command, replicas, region, healthcheck).", {
      account: ACCOUNT, serviceId: S("Service ID"), environmentId: S("Environment ID"),
      buildCommand: S("Build command"), startCommand: S("Start command"), rootDirectory: S("Root directory"),
      healthcheckPath: S("Healthcheck path"), numReplicas: I("Replica count"), region: S("Region code"),
    }, ["serviceId", "environmentId"], { idempotent: true }, async (args) => {
      const { account, serviceId, environmentId, ...rest } = args;
      const input = {};
      for (const [k, v] of Object.entries(rest)) if (v !== undefined && v !== null && v !== "") input[k] = v;
      const data = await gql(account)(
        `mutation serviceInstanceUpdate($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
          serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
        }`,
        { serviceId, environmentId, input },
      );
      return { updated: data.serviceInstanceUpdate, serviceId, environmentId, input };
    }),
    tool("service_delete", "DESTRUCTIVE. Delete a service from its project.", { account: ACCOUNT, serviceId: S("Service ID") }, ["serviceId"], { destructive: true }, async ({ account, serviceId }) => {
      await gql(account)(`mutation serviceDelete($id: String!) { serviceDelete(id: $id) }`, { id: serviceId });
      return { deleted: true, serviceId };
    }),
    tool("service_redeploy", "Redeploy the current instance of a service in an environment.", {
      account: ACCOUNT, serviceId: S("Service ID"), environmentId: S("Environment ID"),
    }, ["serviceId", "environmentId"], { idempotent: false }, async ({ account, serviceId, environmentId }) => {
      const data = await gql(account)(
        `mutation serviceInstanceRedeploy($serviceId: String!, $environmentId: String!) { serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId) }`,
        { serviceId, environmentId },
      );
      return { redeployed: data.serviceInstanceRedeploy, serviceId, environmentId };
    }),
    tool("service_deploy", "Trigger a new deploy, optionally at a commit SHA.", {
      account: ACCOUNT, serviceId: S("Service ID"), environmentId: S("Environment ID"), commitSha: S("Git commit SHA"),
    }, ["serviceId", "environmentId"], { idempotent: false }, async ({ account, serviceId, environmentId, commitSha }) => {
      const data = await gql(account)(
        `mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!, $commitSha: String) {
          serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId, commitSha: $commitSha)
        }`,
        { serviceId, environmentId, commitSha: commitSha || null },
      );
      return { deploymentId: data.serviceInstanceDeployV2 };
    }),
    tool("deployment_list", "List recent deployments for a service.", {
      account: ACCOUNT, projectId: S("Project ID"), serviceId: S("Service ID"), environmentId: S("Environment ID"), limit: I("Max deployments, default 10"),
    }, ["projectId", "serviceId"], { readOnly: true, idempotent: true }, async ({ account, projectId, serviceId, environmentId, limit }) => {
      const data = await gql(account)(
        `query deployments($input: DeploymentListInput!, $first: Int) {
          deployments(input: $input, first: $first) {
            edges { node { id status createdAt url staticUrl serviceId environmentId canRedeploy canRollback } }
          }
        }`,
        { input: { projectId, serviceId, environmentId: environmentId || undefined }, first: limit || 10 },
      );
      return (data.deployments?.edges || []).map((e) => e.node);
    }),
    tool("deployment_info", "Get one deployment by ID.", { account: ACCOUNT, deploymentId: S("Deployment ID") }, ["deploymentId"], { readOnly: true, idempotent: true }, async ({ account, deploymentId }) => {
      const data = await gql(account)(
        `query deployment($id: String!) {
          deployment(id: $id) { id status createdAt url staticUrl meta canRedeploy canRollback serviceId environmentId projectId }
        }`,
        { id: deploymentId },
      );
      if (!data.deployment) throw new Error("Deployment not found");
      return data.deployment;
    }),
    tool("deployment_logs", "Fetch runtime logs for a deployment.", {
      account: ACCOUNT, deploymentId: S("Deployment ID"), limit: I("Line cap, default 200"),
    }, ["deploymentId"], { readOnly: true }, async ({ account, deploymentId, limit }) => {
      const data = await gql(account)(
        `query deploymentLogs($deploymentId: String!, $limit: Int) { deploymentLogs(deploymentId: $deploymentId, limit: $limit) { timestamp message severity } }`,
        { deploymentId, limit: limit || 200 },
      );
      return data.deploymentLogs || [];
    }),
    tool("deployment_build_logs", "Fetch build logs for a deployment.", {
      account: ACCOUNT, deploymentId: S("Deployment ID"), limit: I("Line cap, default 200"),
    }, ["deploymentId"], { readOnly: true }, async ({ account, deploymentId, limit }) => {
      const data = await gql(account)(
        `query buildLogs($deploymentId: String!, $limit: Int) { buildLogs(deploymentId: $deploymentId, limit: $limit) { timestamp message severity } }`,
        { deploymentId, limit: limit || 200 },
      );
      return data.buildLogs || [];
    }),
    tool("deployment_restart", "Restart a running deployment.", { account: ACCOUNT, deploymentId: S("Deployment ID") }, ["deploymentId"], {}, async ({ account, deploymentId }) => {
      await gql(account)(`mutation deploymentRestart($id: String!) { deploymentRestart(id: $id) }`, { id: deploymentId });
      return { restarted: true, deploymentId };
    }),
    tool("deployment_rollback", "DESTRUCTIVE. Roll a service back to this deployment.", { account: ACCOUNT, deploymentId: S("Deployment ID") }, ["deploymentId"], { destructive: true }, async ({ account, deploymentId }) => {
      const data = await gql(account)(
        `mutation deploymentRollback($id: String!) { deploymentRollback(id: $id) { id status } }`,
        { id: deploymentId },
      );
      return data.deploymentRollback;
    }),
    tool("deployment_stop", "Stop a running deployment.", { account: ACCOUNT, deploymentId: S("Deployment ID") }, ["deploymentId"], { destructive: true }, async ({ account, deploymentId }) => {
      await gql(account)(`mutation deploymentStop($id: String!) { deploymentStop(id: $id) }`, { id: deploymentId });
      return { stopped: true, deploymentId };
    }),
    tool("deployment_cancel", "Cancel an in-progress deployment.", { account: ACCOUNT, deploymentId: S("Deployment ID") }, ["deploymentId"], { destructive: true }, async ({ account, deploymentId }) => {
      await gql(account)(`mutation deploymentCancel($id: String!) { deploymentCancel(id: $id) }`, { id: deploymentId });
      return { cancelled: true, deploymentId };
    }),
    tool("variable_list", "List variables for a service or shared environment.", {
      account: ACCOUNT, projectId: S("Project ID"), environmentId: S("Environment ID"), serviceId: S("Service ID; omit for shared env vars"),
    }, ["projectId", "environmentId"], { readOnly: true, idempotent: true }, async ({ account, projectId, environmentId, serviceId }) => {
      const data = await gql(account)(
        `query variables($projectId: String!, $environmentId: String!, $serviceId: String) {
          variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
        }`,
        { projectId, environmentId, serviceId: serviceId || null },
      );
      return data.variables || {};
    }),
    tool("variable_set", "Create or update a variable. Does not print the value back.", {
      account: ACCOUNT, projectId: S("Project ID"), environmentId: S("Environment ID"), serviceId: S("Service ID; omit for shared"), name: S("Variable name"), value: S("Variable value"),
    }, ["projectId", "environmentId", "name", "value"], { idempotent: true }, async ({ account, projectId, environmentId, serviceId, name, value }) => {
      await gql(account)(
        `mutation variableUpsert($input: VariableUpsertInput!) { variableUpsert(input: $input) }`,
        { input: { projectId, environmentId, serviceId: serviceId || undefined, name, value } },
      );
      return { upserted: true, name, serviceId: serviceId || null };
    }),
    tool("variable_delete", "Delete a variable.", {
      account: ACCOUNT, projectId: S("Project ID"), environmentId: S("Environment ID"), serviceId: S("Service ID; omit for shared"), name: S("Variable name"),
    }, ["projectId", "environmentId", "name"], { destructive: true }, async ({ account, projectId, environmentId, serviceId, name }) => {
      await gql(account)(
        `mutation variableDelete($input: VariableDeleteInput!) { variableDelete(input: $input) }`,
        { input: { projectId, environmentId, serviceId: serviceId || undefined, name } },
      );
      return { deleted: true, name };
    }),
    tool("domain_list", "List custom and service domains for a service instance.", {
      account: ACCOUNT, projectId: S("Project ID"), environmentId: S("Environment ID"), serviceId: S("Service ID"),
    }, ["projectId", "environmentId", "serviceId"], { readOnly: true, idempotent: true }, async ({ account, projectId, environmentId, serviceId }) => {
      const data = await gql(account)(
        `query domains($projectId: String!, $environmentId: String!, $serviceId: String!) {
          domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) {
            customDomains { id domain environmentId serviceId targetPort }
            serviceDomains { id domain suffix environmentId serviceId targetPort }
          }
        }`,
        { projectId, environmentId, serviceId },
      );
      return data.domains;
    }),
    tool("domain_create", "Create a Railway-provided *.up.railway.app service domain.", {
      account: ACCOUNT, environmentId: S("Environment ID"), serviceId: S("Service ID"), targetPort: I("Container port to target"),
    }, ["environmentId", "serviceId"], { idempotent: false }, async ({ account, environmentId, serviceId, targetPort }) => {
      const data = await gql(account)(
        `mutation serviceDomainCreate($input: ServiceDomainCreateInput!) {
          serviceDomainCreate(input: $input) { id domain suffix environmentId serviceId targetPort }
        }`,
        { input: { environmentId, serviceId, targetPort: targetPort ?? undefined } },
      );
      return data.serviceDomainCreate;
    }),
    tool("domain_delete", "Delete a service domain by ID.", { account: ACCOUNT, domainId: S("Service domain ID") }, ["domainId"], { destructive: true }, async ({ account, domainId }) => {
      await gql(account)(`mutation serviceDomainDelete($id: String!) { serviceDomainDelete(id: $id) }`, { id: domainId });
      return { deleted: true, domainId };
    }),
    tool("railway_graphql", "Escape hatch: run a raw GraphQL query or mutation against Railway. Prefer named tools.", {
      account: ACCOUNT, query: S("GraphQL document"), variablesJson: S("JSON object of variables"),
    }, ["query"], {}, async ({ account, query, variablesJson }) => {
      let variables = {};
      if (variablesJson) {
        try { variables = JSON.parse(variablesJson); }
        catch { throw new Error("variablesJson must be a JSON object string"); }
      }
      return gql(account)(query, variables);
    }),
  ];
}

function publicToolList(tools) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: t.annotations,
  }));
}

function pickProtocol(requested) {
  if (requested && PROTOCOLS.includes(requested)) return requested;
  return DEFAULT_PROTOCOL;
}

async function handleRpc(msg, env, tools) {
  if (!msg || typeof msg !== "object") return null;
  const { id, method, params } = msg;
  const isNote = id === undefined || id === null;
  if (!method) return null;
  if (method === "notifications/initialized" || method === "notifications/cancelled") return null;
  if (isNote) return null;

  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

  try {
    switch (method) {
      case "initialize": {
        const requested = params?.protocolVersion;
        return ok({
          protocolVersion: pickProtocol(requested),
          capabilities: { tools: { listChanged: false }, resources: {}, prompts: {}, logging: {} },
          serverInfo: { name: NAME, version: VERSION, title: "Railguey" },
          instructions:
            "Railguey holds multiple Railway accounts behind claim-code pairing. Start with account_list. If empty, call account_pair_begin and tell the user to open the URL — never ask them to paste a Railway token in chat. Pass account=<slug> on tools, or omit to use the default. Destructive tools are marked.",
        });
      }
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: publicToolList(tools) });
      case "tools/call": {
        const name = params?.name;
        const args = params?.arguments || {};
        const found = tools.find((t) => t.name === name);
        if (!found) return ok(resultText(`Unknown tool: ${name}`, true));
        const missing = (found.inputSchema.required || []).filter((k) => args[k] === undefined || args[k] === null || args[k] === "");
        if (missing.length) return ok(resultText(`Missing required arguments: ${missing.join(", ")}`, true));
        try {
          const out = await found.run(args);
          return ok(resultText(out));
        } catch (err) {
          return ok(resultText(String(err.message || err), true));
        }
      }
      case "resources/list":
        return ok({ resources: [] });
      case "resources/templates/list":
        return ok({ resourceTemplates: [] });
      case "prompts/list":
        return ok({ prompts: [] });
      case "logging/setLevel":
        return ok({});
      default:
        return fail(-32601, `Method not found: ${method}`);
    }
  } catch (err) {
    return fail(-32603, String(err.message || err));
  }
}

function shellPage({ title, kicker, heading, body, extra = "" }) {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=Syne:wght@600;700&display=swap" rel="stylesheet">
<style>
  :root { --bg:#27282d; --fg:#f5f2e5; --muted:#9a9890; --subtle:#6e6d68; --line:rgba(245,242,229,.12); --ok:#25a34b; --warn:#c4b07a; --danger:#c17a74; --surface:#1f2025; }
  * { box-sizing: border-box; }
  html,body { margin:0; background:var(--bg); color:var(--fg); font: 15px/1.5 "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 560px; margin: 0 auto; padding: 48px 24px 80px; }
  .brand { height: 36px; width: auto; display: block; }
  .kicker { font-size: 11px; letter-spacing: .16em; text-transform: uppercase; color: var(--muted); margin: 22px 0 0; }
  h1 { font: 600 36px/1.05 "Syne", "Avenir Next", sans-serif; letter-spacing:-.03em; margin: 10px 0 12px; }
  p { color: var(--muted); max-width: 46ch; }
  a { color: var(--fg); }
  label { display:block; font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:var(--muted); margin: 18px 0 8px; }
  input { width:100%; height:44px; border:1px solid var(--line); background:var(--surface); color:var(--fg); border-radius:8px; padding:0 12px; font: 14px/1.4 "IBM Plex Mono", ui-monospace, monospace; }
  input:focus { outline: 2px solid var(--fg); outline-offset: 2px; }
  button, .btn { display:inline-flex; align-items:center; justify-content:center; height:44px; padding:0 18px; border:0; border-radius:8px; background:#f5f2e5; color:var(--bg); font: 600 14px/1 "IBM Plex Sans", sans-serif; cursor:pointer; }
  button:hover { opacity:.92; }
  .ghost { background:transparent; color:var(--fg); border:1px solid var(--line); }
  .row { display:flex; gap:10px; flex-wrap:wrap; margin-top: 22px; }
  .err { color: var(--danger); }
  .ok { color: var(--ok); }
  code { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 13px; color: var(--fg); }
  .panel { margin-top: 28px; padding: 18px 0; border-top:1px solid var(--line); }
  .meta { font-size:12px; color:var(--subtle); }
</style>
<body>
<main>
  <img class="brand" src="https://raw.githubusercontent.com/eidos-agi/railguey/main/logo.png" alt="railguey">
  <p class="kicker">${kicker}</p>
  ${heading ? `<h1>${heading}</h1>` : ""}
  ${body}
  ${extra}
</main>
</body>
</html>`;
}

function pairEnterPage(error) {
  return shellPage({
    title: "Pair · Railguey",
    kicker: "Claim code",
    heading: "Pair a Railway account",
    body: `
      <p>Grok mints a short code. Paste it here, then drop in a Railway token. The token never goes through chat.</p>
      ${error ? `<p class="err">${error}</p>` : ""}
      <form method="GET" action="/pair">
        <label for="code">Code</label>
        <input id="code" name="code" required autocomplete="off" spellcheck="false" placeholder="K7M2-Q9XP" inputmode="text">
        <div class="row"><button type="submit">Continue</button></div>
      </form>
      <p class="meta panel">Mint tokens at <a href="https://railway.com/account/tokens">railway.com/account/tokens</a> (account or workspace) or Project → Settings → Tokens (project-scoped).</p>`,
  });
}

function pairFormPage(code, rec, error) {
  const slug = rec?.suggestedSlug || "";
  const label = rec?.suggestedLabel || "";
  return shellPage({
    title: `Pair ${code} · Railguey`,
    kicker: "Claim code",
    heading: code,
    body: `
      <p>Paste a Railway token and give this account a slug. You can pair as many accounts as you want — each gets its own name.</p>
      ${error ? `<p class="err">${error}</p>` : ""}
      <form method="POST" action="/pair/${encodeURIComponent(code)}" autocomplete="off">
        <label for="slug">Slug</label>
        <input id="slug" name="slug" required value="${escapeHtml(slug)}" placeholder="eidos" pattern="[a-z][a-z0-9-]{1,31}" autocomplete="off">
        <label for="label">Label</label>
        <input id="label" name="label" value="${escapeHtml(label)}" placeholder="Eidos AGI" autocomplete="off">
        <label for="token">Railway token</label>
        <input id="token" name="token" type="password" required autocomplete="off" spellcheck="false" placeholder="••••••••">
        <div class="row"><button type="submit">Pair this account</button></div>
      </form>
      <p class="meta panel">Expires in ten minutes. Single use. Token is stored in Cloudflare KV on this worker and is never echoed back.</p>`,
  });
}

function pairSuccessPage(code, identity) {
  const kind = identity?.kind || "unknown";
  const who = identity?.email || identity?.name || identity?.slug || "paired";
  return shellPage({
    title: "Paired · Railguey",
    kicker: "Claim complete",
    heading: identity?.slug || "Paired",
    body: `
      <p class="ok">Railway account stored. Grok can use slug <code>${escapeHtml(identity?.slug || "")}</code> on tool calls.</p>
      <div class="panel">
        <p class="meta">Kind <code>${escapeHtml(kind)}</code></p>
        <p class="meta">Identity <code>${escapeHtml(who)}</code></p>
        <p class="meta">Code <code>${escapeHtml(code)}</code> is spent.</p>
      </div>
      <p>Pair another account the same way — ask Grok to mint a new claim code.</p>`,
  });
}

function pairDonePage(code, rec) {
  if (rec?.status === "complete") return pairSuccessPage(code, rec.identity);
  return shellPage({
    title: "Pair · Railguey",
    kicker: "Claim code",
    heading: "This code is spent",
    body: `<p class="err">That claim code is expired, used, or unknown. Ask Grok to mint a new one with <code>account_pair_begin</code>.</p>
      <div class="row"><a class="btn ghost" href="/pair">Enter another code</a></div>`,
  });
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (ch) => {
    if (ch === "&") return "&" + "amp;";
    if (ch === "<") return "&" + "lt;";
    if (ch === ">") return "&" + "gt;";
    if (ch === '"') return "&" + "quot;";
    return "&#39;";
  });
}

function landingPage(env, listed) {
  const auth = env.MCP_AUTH_TOKEN ? "required" : "unconfigured";
  const n = listed.accounts.length;
  const names = listed.accounts.map((a) => a.slug).join(", ") || "none";
  return shellPage({
    title: "Railguey",
    kicker: "MCP / Railway",
    heading: "",
    body: `
      <p>Remote MCP server for Railway. Streamable HTTP at <code>/mcp</code>. Pair accounts with a claim code so tokens never go through Grok.</p>
      <div class="panel">
        <p class="meta">MCP <code>/mcp</code></p>
        <p class="meta">Auth ${auth}</p>
        <p class="meta">Accounts ${n} · ${escapeHtml(names)}</p>
        <p class="meta">Pair <code>/pair</code></p>
        <p class="meta">Version ${VERSION}</p>
      </div>
      <p>Health JSON lives at <code>/health</code>. Tool calls require a bearer token. Railway credentials live in KV and are never returned.</p>`,
  });
}

async function readPairBody(request) {
  const ctype = request.headers.get("content-type") || "";
  if (ctype.includes("application/json")) {
    const body = await request.json().catch(() => ({}));
    return { slug: body.slug, label: body.label, token: body.token };
  }
  const form = await request.formData();
  return { slug: form.get("slug"), label: form.get("label"), token: form.get("token") };
}

async function handlePair(request, env, path, method) {
  const kv = env.ACCOUNTS;
  const url = new URL(request.url);

  if (path === "/pair" && method === "GET") {
    const q = url.searchParams.get("code");
    if (q) {
      const n = normalizeCode(q);
      if (!n) return html(pairEnterPage("That does not look like a claim code."), 400);
      return Response.redirect(`${originOf(request)}/pair/${n}`, 302);
    }
    return html(pairEnterPage(""));
  }

  const m = path.match(/^\/pair\/([A-Za-z0-9-]+)$/);
  if (!m) return json({ error: "not found" }, 404);
  const code = normalizeCode(m[1]);
  if (!code) return html(pairEnterPage("That does not look like a claim code."), 400);

  const rec = await getPair(kv, code);
  if (!rec || rec.status !== "pending") return html(pairDonePage(code, rec), 410);
  if (rec.expiresAt && Date.now() > rec.expiresAt) return html(pairDonePage(code, rec), 410);

  if (method === "GET") return html(pairFormPage(code, rec, ""));

  if (method !== "POST") return text("Method Not Allowed", 405, { Allow: "GET, POST, OPTIONS" });

  rec.attempts = (rec.attempts || 0) + 1;
  if (rec.attempts > PAIR_MAX_ATTEMPTS) {
    rec.status = "expired";
    await putPair(kv, rec, 60);
    return html(pairDonePage(code, rec), 410);
  }

  let body;
  try {
    body = await readPairBody(request);
  } catch {
    return html(pairFormPage(code, rec, "Could not read the form."), 400);
  }

  const slug = String(body.slug || "").trim().toLowerCase();
  const label = String(body.label || "").trim();
  const token = String(body.token || "").trim();

  if (!SLUG_RE.test(slug) || RESERVED_SLUGS.has(slug)) {
    await putPair(kv, rec, Math.max(30, Math.floor((rec.expiresAt - Date.now()) / 1000)));
    return html(pairFormPage(code, rec, "Slug must start with a letter and use lowercase letters, digits, hyphens."), 400);
  }
  if (!token) {
    await putPair(kv, rec, Math.max(30, Math.floor((rec.expiresAt - Date.now()) / 1000)));
    return html(pairFormPage(code, rec, "Paste a Railway token."), 400);
  }

  let probe;
  try {
    probe = await probeToken(token);
  } catch (err) {
    await putPair(kv, rec, Math.max(30, Math.floor((rec.expiresAt - Date.now()) / 1000)));
    return html(pairFormPage(code, rec, escapeHtml(String(err.message || err))), 400);
  }

  const saved = await saveAccount(env, slug, label, token, probe);
  rec.status = "complete";
  rec.accountSlug = slug;
  rec.identity = saved;
  await putPair(kv, rec, 300);
  return html(pairSuccessPage(code, saved));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method === "HEAD" ? "GET" : request.method;
    const origin = originOf(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (path === "/health" && method === "GET") {
      const listed = await listAccounts(env);
      return json({
        ok: true,
        name: NAME,
        version: VERSION,
        mcp: "/mcp",
        pair: "/pair",
        authConfigured: Boolean(env.MCP_AUTH_TOKEN),
        railwayConfigured: listed.accounts.length > 0,
        defaultAccount: listed.defaultAccount,
        accounts: listed.accounts,
        tools: makeTools(env, origin).map((t) => t.name),
      });
    }

    if (path === "/" && method === "GET") {
      const listed = await listAccounts(env);
      return html(landingPage(env, listed));
    }

    if (path === "/pair" || path.startsWith("/pair/")) {
      return handlePair(request, env, path, method);
    }

    if (path === "/mcp" || path === "/sse") {
      if (request.method === "GET" || request.method === "DELETE") {
        return json({ error: "stateless streamable HTTP — POST JSON-RPC to /mcp" }, 405, { Allow: "POST, OPTIONS" });
      }
      if (request.method !== "POST") {
        return text("Method Not Allowed", 405, { Allow: "POST, OPTIONS" });
      }

      const gate = authorized(request, env);
      if (!gate.ok) return json({ error: gate.error }, gate.status);

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }, 400);
      }

      const tools = makeTools(env, origin);
      const extra = { "MCP-Protocol-Version": pickProtocol(request.headers.get("MCP-Protocol-Version")) };

      if (Array.isArray(body)) {
        const replies = [];
        for (const msg of body) {
          const r = await handleRpc(msg, env, tools);
          if (r) replies.push(r);
        }
        if (!replies.length) return new Response(null, { status: 202, headers: { ...CORS, ...extra } });
        return json(replies, 200, extra);
      }

      const reply = await handleRpc(body, env, tools);
      if (!reply) return new Response(null, { status: 202, headers: { ...CORS, ...extra } });
      return json(reply, 200, extra);
    }

    return json({ error: "not found", hint: "POST /mcp or GET /pair" }, 404);
  },
};
