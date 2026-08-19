import express, { type NextFunction, type Request, type Response } from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildServer, SERVER_NAME, SERVER_VERSION } from './server.js';
import { loadConfig } from './lib/config.js';
import { logger } from './lib/logger.js';
import { consentUrl, ConsentRequiredError, getAccount, getAccessToken, tokenStatus } from './auth/jwt.js';
import { describeProducts } from './tools/raw.js';
import type { ProductId } from './clients/products.js';

const startedAt = Date.now();

/** Constant-time bearer comparison so the token can't be probed by timing. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function bearerAuth(expected: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header('authorization') ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!presented || !tokenMatches(presented, expected)) {
      logger.warn({ ip: req.ip, path: req.path }, 'rejected unauthenticated MCP request');
      res
        .status(401)
        .set('WWW-Authenticate', 'Bearer realm="zw-mcp"')
        .json({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Unauthorized: valid Bearer token required' },
          id: null,
        });
      return;
    }
    next();
  };
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const app = express();
  app.use(express.json({ limit: '50mb' }));

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
