import express, { type NextFunction, type Request, type Response } from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildServer, SERVER_NAME, SERVER_VERSION } from './server.js';
import { loadConfig } from './lib/config.js';
import { logger } from './lib/logger.js';
import { consentUrl, ConsentRequiredError, getAccount, getAccessToken, tokenStatus } from './auth/jwt.js';
import { describeProducts } from './tools/raw.js';
import {
  canonicalResource,
  createAuthCode,
  exchangeCode,
  getClient,
  publicBaseUrl,
  refreshAccessToken,
  registerClient,
  validateAccessToken,
} from './auth/oauth.js';
import type { ProductId } from './clients/products.js';

const startedAt = Date.now();

/** Constant-time bearer comparison so the token can't be probed by timing. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** The public origin this request arrived on, used to build spec-compliant metadata. */
function originOf(req: Request): string {
  const proto = (req.header('x-forwarded-proto') ?? '').split(',')[0]?.trim();
  return publicBaseUrl(req.header('host') ?? undefined, proto || undefined);
}

/**
 * Accepts EITHER the static ZW_MCP_TOKEN or an OAuth access token this server
 * issued.
 *
 * Both are kept because the clients genuinely differ: Claude Code, Claude Desktop
 * and the Agent SDK can send a static header and never need OAuth, while Claude
 * custom connectors (claude.ai, Cowork) have no header field at all and must go
 * through the OAuth flow. Dropping the static path would break the former to
 * serve the latter.
 *
 * On failure the 401 carries the RFC 9728 `resource_metadata` pointer, which is
 * what starts a connector's discovery chain.
 */
function bearerAuth(expected: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header('authorization') ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

    if (presented) {
      if (tokenMatches(presented, expected)) {
        next();
        return;
      }
      const audience = canonicalResource(originOf(req));
      const check = validateAccessToken(presented, audience);
      if (check.valid) {
        next();
        return;
      }
      logger.warn({ ip: req.ip, reason: check.reason }, 'rejected MCP request: bad token');
    } else {
      logger.warn({ ip: req.ip, path: req.path }, 'rejected unauthenticated MCP request');
    }

    const metadataUrl = `${originOf(req)}/.well-known/oauth-protected-resource`;
    res
      .status(401)
      .set(
        'WWW-Authenticate',
        `Bearer realm="zw-mcp", resource_metadata="${metadataUrl}"`,
      )
      .json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized: valid Bearer token required' },
        id: null,
      });
  };
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  /*
   * Log every inbound request, matched or not.
   *
   * Without this, a client probing endpoints we do not implement -- the MCP
   * OAuth discovery chain (/.well-known/oauth-protected-resource,
   * /.well-known/oauth-authorization-server, /register) -- gets a silent 404 and
   * the server shows nothing, which makes "the client says it cannot connect"
   * impossible to diagnose from this side.
   */
  app.use((req: Request, res: Response, next: NextFunction) => {
    const started = Date.now();
    res.on('finish', () => {
      logger.info(
        {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          ip: req.ip,
          ua: req.header('user-agent')?.slice(0, 80),
          durationMs: Date.now() - started,
        },
        'inbound request',
      );
    });
    next();
  });

  app.get('/health', async (_req: Request, res: Response) => {
    const token = tokenStatus();
    let account: unknown = null;
    let authError: string | null = null;
    try {
      account = await getAccount();
    } catch (err) {
      authError = err instanceof Error ? err.message : String(err);
    }
    res.json({
      status: authError ? 'degraded' : 'ok',
      server: { name: SERVER_NAME, version: SERVER_VERSION },
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      environment: cfg.DS_ENVIRONMENT,
      token: { hasToken: token.hasToken, expiresAt: token.expiresAt, scopes: token.scopes },
      account,
      products: await describeProducts(cfg.products as ProductId[]),
      authError,
    });
  });

  // ---------------------------------------------------------------------------
  // OAuth 2.1 surface. Order matters: these must be reachable WITHOUT a token.
  // ---------------------------------------------------------------------------

  // RFC 9728 protected-resource metadata. Connectors probe both the bare path and
  // the path-suffixed form (/.well-known/oauth-protected-resource/mcp), so serve
  // both rather than making the client guess.
  const protectedResourceMetadata = (req: Request, res: Response): void => {
    const base = originOf(req);
    res.json({
      resource: canonicalResource(base),
      authorization_servers: [base],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp'],
      resource_documentation: `${base}/health`,
    });
  };
  app.get('/.well-known/oauth-protected-resource', protectedResourceMetadata);
  app.get('/.well-known/oauth-protected-resource/*splat', protectedResourceMetadata);

  // RFC 8414 authorization-server metadata.
  const authServerMetadata = (req: Request, res: Response): void => {
    const base = originOf(req);
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      scopes_supported: ['mcp'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      resource_indicators_supported: true,
    });
  };
  app.get('/.well-known/oauth-authorization-server', authServerMetadata);
  app.get('/.well-known/oauth-authorization-server/*splat', authServerMetadata);
  app.get('/.well-known/openid-configuration', authServerMetadata);

  // RFC 7591 dynamic client registration.
  app.post('/register', (req: Request, res: Response) => {
    try {
      const client = registerClient((req.body ?? {}) as Record<string, unknown>);
      res.status(201).json(client);
    } catch (err) {
      res.status(400).json({
        error: 'invalid_client_metadata',
        error_description: (err as Error).message,
      });
    }
  });

  /**
   * Authorization endpoint. The resource owner proves ownership by entering
   * ZW_MCP_TOKEN -- this is a single-operator server, so knowledge of that token
   * IS the authorization decision.
   */
  app.get('/authorize', (req: Request, res: Response) => {
    const q = req.query as Record<string, string | undefined>;
    const client = q.client_id ? getClient(q.client_id) : undefined;
    if (!client) {
      res.status(400).send('Unknown client_id. Register first (POST /register).');
      return;
    }
    if (!q.redirect_uri || !client.redirect_uris.includes(q.redirect_uri)) {
      // Never redirect to an unregistered URI -- that is the open-redirect hole.
      res.status(400).send('redirect_uri does not match a registered value for this client.');
      return;
    }
    if (!q.code_challenge) {
      res.status(400).send('code_challenge is required (PKCE).');
      return;
    }

    const esc = (v: string | undefined) =>
      (v ?? '').replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
      );

    res.set('content-type', 'text/html; charset=utf-8').send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize ZW MCP</title>
<style>
 :root{color-scheme:light dark}
 body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      max-width:440px;margin:12vh auto;padding:0 24px}
 h1{font-size:19px;margin:0 0 6px}
 p{color:#666;margin:0 0 18px}
 code{background:rgba(128,128,128,.16);padding:2px 6px;border-radius:5px;font-size:13px}
 input{width:100%;font:inherit;padding:11px 13px;border:1px solid rgba(128,128,128,.45);
       border-radius:9px;background:transparent;color:inherit;box-sizing:border-box}
 button{width:100%;font:600 15px inherit;padding:12px;margin-top:12px;border:0;
        border-radius:9px;background:#2f6fed;color:#fff;cursor:pointer}
 .who{background:rgba(128,128,128,.1);border-radius:10px;padding:12px 14px;margin-bottom:18px}
</style></head><body>
<h1>Authorize access to ZW MCP</h1>
<p>An application is requesting access to your Docusign tools.</p>
<div class="who">
  <strong>${esc(client.client_name) || 'Unnamed client'}</strong><br>
  <code>${esc(client.client_id)}</code><br>
  redirect: <code>${esc(q.redirect_uri)}</code>
</div>
<form method="POST" action="/authorize">
  <input type="hidden" name="client_id" value="${esc(q.client_id)}">
  <input type="hidden" name="redirect_uri" value="${esc(q.redirect_uri)}">
  <input type="hidden" name="state" value="${esc(q.state)}">
  <input type="hidden" name="code_challenge" value="${esc(q.code_challenge)}">
  <input type="hidden" name="code_challenge_method" value="${esc(q.code_challenge_method) || 'S256'}">
  <input type="hidden" name="resource" value="${esc(q.resource)}">
  <input type="hidden" name="scope" value="${esc(q.scope)}">
  <label for="tok">Server token</label>
  <input id="tok" name="server_token" type="password" autocomplete="off" autofocus
         placeholder="ZW_MCP_TOKEN from your .env">
  <button type="submit">Approve</button>
</form>
</body></html>`);
  });

  app.post('/authorize', express.urlencoded({ extended: false }), (req: Request, res: Response) => {
    const b = req.body as Record<string, string | undefined>;
    const client = b.client_id ? getClient(b.client_id) : undefined;
    if (!client || !b.redirect_uri || !client.redirect_uris.includes(b.redirect_uri)) {
      res.status(400).send('Invalid client_id or redirect_uri.');
      return;
    }
    if (!b.server_token || !tokenMatches(b.server_token, cfg.ZW_MCP_TOKEN)) {
      logger.warn({ ip: req.ip, client_id: b.client_id }, 'oauth approval rejected: bad token');
      res.status(401).send('Incorrect server token. Go back and try again.');
      return;
    }

    const code = createAuthCode({
      client_id: client.client_id,
      redirect_uri: b.redirect_uri,
      code_challenge: b.code_challenge ?? '',
      code_challenge_method: b.code_challenge_method || 'S256',
      resource: b.resource || canonicalResource(originOf(req)),
      scope: b.scope,
    });

    const target = new URL(b.redirect_uri);
    target.searchParams.set('code', code);
    if (b.state) target.searchParams.set('state', b.state);
    logger.info({ client_id: client.client_id }, 'oauth authorization approved');
    res.redirect(302, target.toString());
  });

  app.post('/token', express.urlencoded({ extended: false }), (req: Request, res: Response) => {
    const b = { ...(req.body as Record<string, string | undefined>) };
    // client_secret_basic puts the credentials in the Authorization header.
    const basic = req.header('authorization');
    if (basic?.startsWith('Basic ')) {
      const [id, ...rest] = Buffer.from(basic.slice(6), 'base64').toString().split(':');
      b.client_id ??= id;
      b.client_secret ??= rest.join(':');
    }
    try {
      if (b.grant_type === 'refresh_token') {
        if (!b.refresh_token || !b.client_id) throw new Error('invalid_request: missing fields');
        res.json(refreshAccessToken(b.refresh_token, b.client_id));
        return;
      }
      if (b.grant_type !== 'authorization_code') {
        throw new Error(`unsupported_grant_type: ${b.grant_type ?? '(none)'}`);
      }
      if (!b.code || !b.client_id || !b.redirect_uri) {
        throw new Error('invalid_request: code, client_id and redirect_uri are required');
      }
      res.json(
        exchangeCode({
          code: b.code,
          client_id: b.client_id,
          redirect_uri: b.redirect_uri,
          code_verifier: b.code_verifier ?? '',
          resource: b.resource,
          defaultAudience: canonicalResource(originOf(req)),
        }),
      );
    } catch (err) {
      const msg = (err as Error).message;
      const code = msg.split(':')[0] ?? 'invalid_request';
      res.status(400).json({ error: code, error_description: msg });
    }
  });

  app.use('/mcp', bearerAuth(cfg.ZW_MCP_TOKEN));

  /**
   * Stateless transport: a fresh server + transport per request.
   *
   * ZW MCP is always-on and serves several clients at once (Claude Desktop,
   * claude.ai, Claude Code). Statelessness means a server restart never orphans
   * a client's session, and concurrent requests can't collide on JSON-RPC ids.
   * The per-request build is cheap because auth and discovery are cached globally.
   */
  app.all('/mcp', async (req: Request, res: Response) => {
    const requestId = randomUUID();
    try {
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error({ requestId, err: (err as Error).message }, 'MCP request failed');
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: `Internal server error: ${(err as Error).message}` },
          id: null,
        });
      }
    }
  });

  // Warm the token at boot so the first tool call is fast and, more importantly,
  // so a missing consent grant surfaces in the startup log instead of mid-demo.
  try {
    await getAccessToken();
    const account = await getAccount();
    logger.info(
      { account: account.accountId, name: account.accountName, env: cfg.DS_ENVIRONMENT },
      'DocuSign auth ready',
    );
  } catch (err) {
    if (err instanceof ConsentRequiredError) {
      logger.error(err.message);
      console.error(`\n${err.message}\n`);
    } else {
      logger.error({ err: (err as Error).message }, 'DocuSign auth failed at startup');
      console.error(
        `\nDocuSign auth failed: ${(err as Error).message}\n` +
          `The server is still starting so /health can report the problem.\n` +
          `Consent URL if you need it:\n  ${consentUrl()}\n`,
      );
    }
  }

  app.listen(cfg.PORT, cfg.HOST, () => {
    logger.info({ host: cfg.HOST, port: cfg.PORT }, 'ZW MCP listening');
    console.log(`ZW MCP listening on http://${cfg.HOST}:${cfg.PORT}`);
    console.log(`  MCP endpoint : http://${cfg.HOST}:${cfg.PORT}/mcp  (Bearer auth required)`);
    console.log(`  Health       : http://${cfg.HOST}:${cfg.PORT}/health`);
  });
}

main().catch((err) => {
  logger.fatal({ err: err instanceof Error ? err.message : String(err) }, 'fatal startup error');
  console.error(err);
  process.exit(1);
});
