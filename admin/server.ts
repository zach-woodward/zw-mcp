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
import express, { type Request, type Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'undici';
import { loadConfig } from '../src/lib/config.js';

const cfg = loadConfig();
const ADMIN_PORT = Number(process.env.ADMIN_PORT ?? 8788);
const MCP_URL = process.env.ZW_MCP_URL ?? `http://${cfg.HOST}:${cfg.PORT}/mcp`;
const HEALTH_URL = MCP_URL.replace(/\/mcp$/, '/health');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
      'models_read (Navigator) and content (CLM) are documented scopes that this account never grants. Both are excluded; Navigator and CLM work without them.',
      'npm run scopecheck is reliable only in the negative direction -- Docusign silently ignores unknown scopes, so a pass does not prove a scope is real.',
    ],
  });
});

app.listen(ADMIN_PORT, '127.0.0.1', () => {
  console.log(`ZW MCP Admin  ->  http://127.0.0.1:${ADMIN_PORT}`);
  console.log(`  driving      ${MCP_URL}`);
});
