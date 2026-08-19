/**
 * ZW MCP Admin -- a local operations console.
 *
 * Deliberately a SEPARATE app, not a route on the MCP server: ZW MCP stays
 * UI-free (see docs/ARCHITECTURE.md §7), and this talks to it over exactly the
 * same bearer-authed /mcp endpoint that Claude Desktop or claude.ai would use.
 * If the console can drive a tool, so can a real client.
 *
 * The bearer token stays server-side. The browser talks to this process, this
 * process talks to ZW MCP -- so the token is never in page source, and there is
 * no CORS dance.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { request } from 'undici';
import { loadConfig } from '../src/lib/config.js';

const execFileAsync = promisify(execFile);
const cfg = loadConfig();

/*
 * Tailscale controls.
 *
 * These live in the admin console, NOT in the MCP tool surface, and that is a
 * deliberate security boundary: /mcp is published on the public internet through
 * Funnel, so an MCP tool that toggles Funnel would let anyone holding the bearer
 * token re-open the tunnel after it had been closed -- or close it and cut off
 * every other client. The console is LAN-only and never funnelled, which makes it
 * the right place to control the machine's own network exposure.
 */
const TAILSCALE = '/opt/homebrew/bin/tailscale';
const TS_SOCKET = path.join(os.homedir(), '.tailscale/tailscaled.sock');
const FUNNEL_PORT = String(cfg.PORT);

async function tailscale(args: string[], timeoutMs = 60_000): Promise<string> {
  const { stdout, stderr } = await execFileAsync(
    TAILSCALE,
    [`--socket=${TS_SOCKET}`, ...args],
    { timeout: timeoutMs },
  );
  return `${stdout}${stderr}`.trim();
}

interface NetworkState {
  daemonRunning: boolean;
  loggedIn: boolean;
  hostname: string | null;
  publicUrl: string | null;
  funnelEnabled: boolean;
  funnelCapable: boolean;
  certReady: boolean;
  error?: string;
}

async function networkState(): Promise<NetworkState> {
  const base: NetworkState = {
    daemonRunning: false,
    loggedIn: false,
    hostname: null,
    publicUrl: null,
    funnelEnabled: false,
    funnelCapable: false,
    certReady: false,
  };
  try {
    const raw = await tailscale(['status', '--json'], 20_000);
    const st = JSON.parse(raw) as {
      Self?: { DNSName?: string; Online?: boolean; CapMap?: Record<string, unknown> };
      CertDomains?: string[] | null;
      BackendState?: string;
    };
    base.daemonRunning = true;
    base.loggedIn = st.BackendState === 'Running';
    // DNSName comes back with a trailing dot.
    const dns = (st.Self?.DNSName ?? '').replace(/\.$/, '');
    base.hostname = dns || null;
    base.certReady = Boolean(st.CertDomains?.length);
    base.funnelCapable = Object.keys(st.Self?.CapMap ?? {}).some((c) =>
      c.toLowerCase().includes('funnel'),
    );

    const funnel = await tailscale(['funnel', 'status'], 20_000).catch(() => '');
    base.funnelEnabled = /Funnel on/i.test(funnel);
    if (base.funnelEnabled && dns) base.publicUrl = `https://${dns}/mcp`;
  } catch (err) {
    base.error = (err as Error).message.slice(0, 300);
  }
  return base;
}
const ADMIN_PORT = Number(process.env.ADMIN_PORT ?? 8788);
const ADMIN_BIND = process.env.ADMIN_BIND ?? '127.0.0.1';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const ADMIN_USER = process.env.ADMIN_USER ?? 'zw';
const MCP_URL = process.env.ZW_MCP_URL ?? `http://${cfg.HOST}:${cfg.PORT}/mcp`;
const HEALTH_URL = MCP_URL.replace(/\/mcp$/, '/health');

const isLoopback = ADMIN_BIND === '127.0.0.1' || ADMIN_BIND === 'localhost' || ADMIN_BIND === '::1';

/*
 * Fail closed.
 *
 * This console can send and void real envelopes through the Run tab, and it holds
 * the ZW MCP bearer token server-side -- so reaching it IS reaching DocuSign.
 * Binding it anywhere but loopback without a password would put that on the
 * network for anyone who can route to the host, so we refuse to start instead.
 */
const ALLOW_INSECURE = process.env.ADMIN_ALLOW_INSECURE === '1';

if (!isLoopback && !ADMIN_PASSWORD && !ALLOW_INSECURE) {
  console.error(
    `\nRefusing to start.\n\n` +
      `ADMIN_BIND=${ADMIN_BIND} exposes this console beyond localhost, but ADMIN_PASSWORD\n` +
      `is not set. The console can send and void envelopes, so it must not be reachable\n` +
      `without a password.\n\n` +
      `Fix it with either:\n` +
      `  ADMIN_PASSWORD=$(openssl rand -hex 24)   # set one, then restart\n` +
      `  ADMIN_BIND=127.0.0.1                     # keep it local-only\n`,
  );
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Static assets live in admin/public. Under tsx that sits next to this file, but
 * `tsc` does not copy non-TS files, so in dist/ it does not. Resolve against the
 * working directory first (launchd sets it to the project root) and fall back to
 * the source-relative path for `npm run admin`.
 */
const PUBLIC_DIR = [
  path.resolve(process.cwd(), 'admin/public'),
  path.join(__dirname, 'public'),
].find((d) => fs.existsSync(path.join(d, 'index.html')));

if (!PUBLIC_DIR) {
  console.error('Cannot find admin/public/index.html. Run from the project root.');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '25mb' }));

/** Constant-time compare so the password can't be probed by timing. */
function matches(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// HTTP Basic, so any browser on the network gets a native login prompt with no
// login page to build. Applied before the static handler so the HTML itself is
// protected, not just the API.
if (ADMIN_PASSWORD) {
  app.use((req: Request, res: Response, next: NextFunction) => {
    const header = req.header('authorization') ?? '';
    if (header.startsWith('Basic ')) {
      const [user, ...rest] = Buffer.from(header.slice(6), 'base64').toString().split(':');
      if (matches(user ?? '', ADMIN_USER) && matches(rest.join(':'), ADMIN_PASSWORD)) {
        next();
        return;
      }
    }
    res
      .status(401)
      .set('WWW-Authenticate', 'Basic realm="ZW MCP Admin", charset="UTF-8"')
      .send('Authentication required.');
  });
}

app.use(express.static(PUBLIC_DIR));

let rpcId = 0;

/** One JSON-RPC round trip to ZW MCP, unwrapping the SSE framing it replies with. */
async function rpc(method: string, params?: unknown): Promise<unknown> {
  const res = await request(MCP_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${cfg.ZW_MCP_TOKEN}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });

  const text = await res.body.text();
  if (res.statusCode >= 400) {
    throw new Error(`ZW MCP returned ${res.statusCode}: ${text.slice(0, 300)}`);
  }
  // Streamable HTTP answers as SSE ("event: message\ndata: {...}") unless the
  // client asks for JSON only. Strip the framing rather than depend on it.
  const line = text
    .split('\n')
    .find((l) => l.startsWith('data: '));
  const payload = JSON.parse(line ? line.slice(6) : text) as {
    result?: unknown;
    error?: { message?: string };
  };
  if (payload.error) throw new Error(payload.error.message ?? 'unknown MCP error');
  return payload.result;
}

app.get('/api/health', async (_req: Request, res: Response) => {
  try {
    const r = await request(HEALTH_URL);
    res.status(r.statusCode).json(await r.body.json());
  } catch (err) {
    res.status(502).json({
      status: 'unreachable',
      error: `Cannot reach ZW MCP at ${HEALTH_URL}. Is it running? (npm run dev)`,
      detail: (err as Error).message,
    });
  }
});

app.get('/api/tools', async (_req: Request, res: Response) => {
  try {
    res.json(await rpc('tools/list'));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.get('/api/resources', async (_req: Request, res: Response) => {
  try {
    const [resources, prompts] = await Promise.all([
      rpc('resources/list').catch(() => ({ resources: [] })),
      rpc('prompts/list').catch(() => ({ prompts: [] })),
    ]);
    res.json({ ...(resources as object), ...(prompts as object) });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.post('/api/call', async (req: Request, res: Response) => {
  const { name, args } = req.body as { name?: string; args?: unknown };
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  const started = Date.now();
  try {
    const result = await rpc('tools/call', { name, arguments: args ?? {} });
    res.json({ result, durationMs: Date.now() - started });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message, durationMs: Date.now() - started });
  }
});

app.get('/api/network', async (_req: Request, res: Response) => {
  res.json(await networkState());
});

app.post('/api/network/funnel', async (req: Request, res: Response) => {
  const { enabled } = req.body as { enabled?: boolean };
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'body must be { "enabled": true | false }' });
    return;
  }
  try {
    if (enabled) {
      const state = await networkState();
      // Without these two the funnel command hangs silently rather than erroring,
      // which is a miserable thing to debug from a web UI.
      if (!state.funnelCapable) {
        throw new Error(
          'This tailnet has not granted the `funnel` node attribute. Add it at ' +
            'https://login.tailscale.com/admin/acls before enabling.',
        );
      }
      if (!state.certReady) {
        throw new Error(
          'HTTPS certificates are not enabled for this tailnet. Enable them at ' +
            'https://login.tailscale.com/admin/dns before enabling Funnel.',
        );
      }
      await tailscale(['funnel', '--bg', FUNNEL_PORT]);
    } else {
      await tailscale(['funnel', '--https=443', 'off']);
    }
    res.json({ ok: true, state: await networkState() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message.slice(0, 500) });
  }
});

// ---------------------------------------------------------------------------
// Activity: the structured log, made legible.
// ---------------------------------------------------------------------------

const LOG_FILE = path.resolve(process.cwd(), 'logs/zw-mcp.log');
const OAUTH_STATE = path.resolve(process.cwd(), '.oauth/state.json');

interface Event {
  time: number;
  kind: 'docusign' | 'request' | 'auth' | 'error' | 'other';
  level: number;
  summary: string;
  detail: Record<string, unknown>;
}

/** Classifies a pino record into something worth showing a human. */
function classify(d: Record<string, unknown>): Event | null {
  const msg = String(d.msg ?? '');
  const time = Number(d.time ?? 0);
  const level = Number(d.level ?? 30);
  const base = { time, level };

  if (msg === 'docusign api call') {
    return {
      ...base,
      kind: 'docusign',
      summary: `${d.product} ${d.method} ${d.path} -> ${d.status}`,
      detail: { durationMs: d.durationMs, product: d.product, status: d.status },
    };
  }
  if (msg === 'inbound request') {
    return {
      ...base,
      kind: 'request',
      summary: `${d.method} ${d.path} -> ${d.status}`,
      detail: { durationMs: d.durationMs, ua: d.ua, ip: d.ip },
    };
  }
  if (
    msg.includes('oauth') ||
    msg.includes('access token') ||
    msg.includes('unauthenticated') ||
    msg.includes('bad token') ||
    msg.includes('consent')
  ) {
    return { ...base, kind: 'auth', summary: msg, detail: d };
  }
  if (level >= 50 || msg.includes('error') || msg.includes('failed')) {
    return { ...base, kind: 'error', summary: msg, detail: d };
  }
  if (msg) return { ...base, kind: 'other', summary: msg, detail: {} };
  return null;
}

/** Reads the tail of the log without loading a large file into memory. */
function tailLog(maxBytes = 512 * 1024): string[] {
  if (!fs.existsSync(LOG_FILE)) return [];
  const size = fs.statSync(LOG_FILE).size;
  const start = Math.max(0, size - maxBytes);
  const fd = fs.openSync(LOG_FILE, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    // A partial first line is likely when starting mid-file.
    if (start > 0) lines.shift();
    return lines.filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

app.get('/api/activity', (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit ?? 150), 1000);
  const kind = String(req.query.kind ?? 'all');
  const q = String(req.query.q ?? '').toLowerCase();

  const events: Event[] = [];
  for (const line of tailLog()) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const ev = classify(parsed);
    if (!ev) continue;
    if (kind !== 'all' && ev.kind !== kind) continue;
    if (q && !ev.summary.toLowerCase().includes(q)) continue;
    events.push(ev);
  }

  const recent = events.slice(-limit).reverse();
  const counts = events.reduce<Record<string, number>>((acc, e) => {
    acc[e.kind] = (acc[e.kind] ?? 0) + 1;
    return acc;
  }, {});
  res.json({ events: recent, counts, scanned: events.length });
});

// ---------------------------------------------------------------------------
// OAuth grants. Read straight from the state file; the MCP server reloads it on
// change, so a revoke here takes effect there without a restart.
// ---------------------------------------------------------------------------

interface OAuthFile {
  clients?: Record<string, { client_name?: string; redirect_uris?: string[]; created_at?: number }>;
  tokens?: Record<string, { client_id: string; audience: string; expires_at: number }>;
  refresh?: Record<string, string>;
}

function readOAuth(): OAuthFile {
  try {
    return JSON.parse(fs.readFileSync(OAUTH_STATE, 'utf8')) as OAuthFile;
  } catch {
    return {};
  }
}

app.get('/api/grants', (_req: Request, res: Response) => {
  const st = readOAuth();
  const tokensByClient = new Map<string, number>();
  for (const t of Object.values(st.tokens ?? {})) {
    tokensByClient.set(t.client_id, (tokensByClient.get(t.client_id) ?? 0) + 1);
  }
  res.json({
    clients: Object.entries(st.clients ?? {}).map(([id, c]) => ({
      client_id: id,
      client_name: c.client_name ?? '(unnamed)',
      redirect_uris: c.redirect_uris ?? [],
      created_at_iso: c.created_at ? new Date(c.created_at * 1000).toISOString() : null,
      live_tokens: tokensByClient.get(id) ?? 0,
    })),
    totalTokens: Object.keys(st.tokens ?? {}).length,
  });
});

app.post('/api/grants/revoke', (req: Request, res: Response) => {
  const { client_id, all } = req.body as { client_id?: string; all?: boolean };
  const st = readOAuth();
  let removedClients = 0;
  let removedTokens = 0;

  if (all) {
    removedClients = Object.keys(st.clients ?? {}).length;
    removedTokens = Object.keys(st.tokens ?? {}).length;
    st.clients = {};
    st.tokens = {};
    st.refresh = {};
  } else if (client_id) {
    if (st.clients?.[client_id]) {
      delete st.clients[client_id];
      removedClients = 1;
    }
    for (const [tok, t] of Object.entries(st.tokens ?? {})) {
      if (t.client_id === client_id) {
        delete st.tokens![tok];
        removedTokens += 1;
        for (const [r, target] of Object.entries(st.refresh ?? {})) {
          if (target === tok) delete st.refresh![r];
        }
      }
    }
  } else {
    res.status(400).json({ error: 'pass { client_id } or { all: true }' });
    return;
  }

  try {
    fs.mkdirSync(path.dirname(OAUTH_STATE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(OAUTH_STATE, JSON.stringify(st, null, 2), { mode: 0o600 });
    res.json({ ok: true, removedClients, removedTokens });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Static project state the console renders: phases, known gaps, next steps. */
app.get('/api/roadmap', (_req: Request, res: Response) => {
  res.json({
    phases: [
      { id: 1, name: 'Scaffold, JWT auth, HTTP transport, eSignature', status: 'done' },
      { id: 2, name: 'Navigator, CLM, Maestro', status: 'done' },
      { id: 3, name: 'Web Forms, Rooms, Click, Admin, Monitor, Notary, Connected Fields, Workspaces', status: 'done' },
      { id: 4, name: 'Resources, demo_context prompt, launchd, README + architecture refresh', status: 'next' },
    ],
    gaps: [
      {
        title: 'Monitor has no entitlement on this organization',
        detail:
          'The endpoint is correct -- api-d.docusign.com/v1/organizations/{orgId}/stream returns a ' +
          'Monitor-specific 403, meaning it routed and evaluated entitlement. Nothing to fix in code.',
        action: 'Ask your Docusign rep to enable Monitor on org 4773242b-…',
        severity: 'external',
      },
      {
        title: 'CLM full-text search body schema is unpublished',
        detail:
          'POST /documentsearchtasks rejects every body shape tried (7+ variants) with 422 ' +
          '"No valid search parameters were found". Neither the swagger nor the Developer Center ' +
          'documents it.',
        action:
          'clm_search_documents does a documented NAME search over the folder tree instead. ' +
          'Reach full-text via clm_raw_request once the schema is known.',
        severity: 'workaround',
      },
      {
        title: 'Trust Records is not a real public API',
        detail:
          'Six candidate endpoint shapes all 404, and it appears in no spec, base-path table or ' +
          'scopes reference. The brief listed 13 products; there are 12.',
        action: 'No action. Registry entry kept so the raw hatch exists if Docusign ships it.',
        severity: 'resolved',
      },
      {
        title: 'Notary pool is empty',
        detail: 'notary_list_notaries returns 0 notaries. That is a true answer, not a failure.',
        action: 'Enrol a notary in Docusign Admin to demo remote online notarization.',
        severity: 'external',
      },
    ],
    notes: [
      'Tailscale runs under launchd as com.zw.tailscaled in userspace mode (no root). Funnel config lives in the tailscaled state dir and self-restores on restart.',
      'The Funnel toggle is in this console rather than the MCP tool surface: /mcp is public while Funnel is on, so a tool that toggled it could be used by anyone holding the bearer token.',
      'models_read (Navigator) and content (CLM) are documented scopes that this account never grants. Both are excluded; Navigator and CLM work without them.',
      'npm run scopecheck is reliable only in the negative direction -- Docusign silently ignores unknown scopes, so a pass does not prove a scope is real.',
    ],
  });
});

app.listen(ADMIN_PORT, ADMIN_BIND, () => {
  const shown = isLoopback ? '127.0.0.1' : ADMIN_BIND;
  console.log(`ZW MCP Admin  ->  http://${shown}:${ADMIN_PORT}`);
  console.log(`  driving      ${MCP_URL}`);
  console.log(
    `  auth         ${
      ADMIN_PASSWORD
        ? `Basic (user "${ADMIN_USER}")`
        : isLoopback
          ? 'none -- loopback only'
          : 'NONE -- exposed on the network by explicit ADMIN_ALLOW_INSECURE=1'
    }`,
  );
  if (!isLoopback) {
    console.log(
      `  note         Basic auth over plain HTTP sends credentials base64-encoded,\n` +
        `               not encrypted. Fine on a trusted LAN; use Tailscale Serve for\n` +
        `               real HTTPS if this leaves your network.`,
    );
  }
});
