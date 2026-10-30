import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiRequest, baseUriFor } from '../clients/base.js';
import { clmRequest } from '../clients/clm.js';
import { PRODUCTS, type ProductId } from '../clients/products.js';
import { guard, ok, saveDownload } from '../lib/respond.js';

/**
 * CLM does not go through the shared client: its hosts are discovered at runtime
 * and its paths carry a /{version}/{accountId} prefix. Routing the raw tool
 * through the same dispatcher the curated CLM tools use keeps the escape hatch
 * honest -- otherwise clm_raw_request silently targets the wrong URL and 404s.
 */
async function dispatch(
  product: ProductId,
  req: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    query?: Record<string, string | number | boolean>;
    body?: unknown;
    raw?: boolean;
    accept?: string;
  },
): Promise<unknown> {
  if (product === 'clm') return clmRequest({ ...req });
  return apiRequest(product, req);
}

/**
 * Tier 2 of the tool design: one raw_request tool per product API.
 *
 * Curated tools cover the operations demos actually use. This covers everything
 * else -- every endpoint of every product stays reachable without shipping a
 * thousand tool definitions that would blow out each client's tool list.
 */
export function registerRawTool(server: McpServer, product: ProductId): void {
  const spec = PRODUCTS[product];

  server.registerTool(
    `${spec.toolPrefix}_raw_request`,
    {
      title: `Raw ${spec.label} request`,
      description:
        `Escape hatch: send an arbitrary authenticated request to the ${spec.label}. ` +
        `Use this only when no curated ${spec.toolPrefix}_* tool covers what you need.\n\n` +
        `Paths are relative to that API's base URI and "{accountId}" is substituted ` +
        `automatically, so a typical path looks like: ${spec.pathHint}\n\n` +
        (product === 'clm'
          ? `CLM paths are relative to /{version}/{accountId}, which is prepended for you ` +
            `after runtime host discovery -- pass e.g. /folders/type?systemFolder=root.\n\n`
          : '') +
        `Auth, token refresh and retry are handled for you. Docs: ${spec.docsUrl}` +
        (spec.status !== 'ga'
          ? `\n\nNOTE: this API is ${spec.status} -- verify endpoint shapes against the live docs.`
          : ''),
      inputSchema: {
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
        path: z.string().describe(`Path under the base URI, e.g. ${spec.pathHint}`),
        query: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe('Query string parameters.'),
        body: z.unknown().optional().describe('JSON request body for POST/PUT/PATCH.'),
        save_binary_as: z
          .string()
          .optional()
          .describe(
            'If set, treat the response as binary, write it to the downloads directory ' +
              'under this filename, and return the path instead of the content.',
          ),
      },
    },
    guard(async (args) => {
      if (args.save_binary_as) {
        const buf = (await dispatch(product, {
          method: args.method,
          path: args.path,
          query: args.query,
          body: args.body,
          raw: true,
          accept: '*/*',
        })) as Buffer;
        return ok({ path: saveDownload(args.save_binary_as, buf), bytes: buf.length });
      }
      const res = await dispatch(product, {
        method: args.method,
        path: args.path,
        query: args.query,
        body: args.body,
      });
      return ok(res ?? { status: 'ok (empty response body)' });
    }),
  );
}

/** Registers a raw_request tool for each enabled product. */
export function registerRawTools(server: McpServer, products: ProductId[]): void {
  for (const p of products) registerRawTool(server, p);
}

/** Resolved base URIs, for /health and the demo_context prompt. */
export async function describeProducts(products: ProductId[]) {
  return Promise.all(
    products.map(async (id) => ({
      id,
      label: PRODUCTS[id].label,
      baseUri: await baseUriFor(id).catch(() => null),
      status: PRODUCTS[id].status,
      docsUrl: PRODUCTS[id].docsUrl,
    })),
  );
}

/*
 * Reachability, which is NOT the same question as "does this API exist".
 *
 * Everything in the registry exists; whether this account may call it is a
 * per-account entitlement question, and the answer differs per product. Saying
 * "connected" because a product is configured is how a demo ends up claiming an
 * API it cannot actually reach, so this probes each one with a cheap read and
 * reports what came back, including the service's own words on a refusal.
 */
export type ProductReachability = {
  id: ProductId;
  label: string;
  /** live: a real 2xx. denied: routed and refused. missing: no such endpoint.
   *  unprobed: no safe cheap read defined. error: could not even try. */
  state: 'live' | 'denied' | 'missing' | 'unprobed' | 'error';
  httpStatus: number | null;
  /** The service's own message on a refusal, trimmed. Never invented. */
  detail: string | null;
  checkedAt: string;
};

let reachabilityCache: { at: number; rows: ProductReachability[] } | null = null;
const REACHABILITY_TTL_MS = 5 * 60 * 1000;

export async function probeProducts(
  products: ProductId[],
  { force = false }: { force?: boolean } = {},
): Promise<ProductReachability[]> {
  if (!force && reachabilityCache && Date.now() - reachabilityCache.at < REACHABILITY_TTL_MS) {
    return reachabilityCache.rows;
  }

  const rows = await Promise.all(
    products.map(async (id): Promise<ProductReachability> => {
      const spec = PRODUCTS[id];
      const checkedAt = new Date().toISOString();
      // CLM never goes through the shared client: its host is discovered at
      // runtime per data centre, so it is probed through its own client.
      if (id === 'clm') {
        try {
          await clmRequest({ method: 'GET', path: '/folders/type', query: { systemFolder: 'root' } });
          return { id, label: spec.label, state: 'live', httpStatus: 200, detail: null, checkedAt };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const code = /\b(\d{3})\b/.exec(msg)?.[1];
          return {
            id, label: spec.label,
            state: code === '403' || code === '401' ? 'denied' : code === '404' ? 'missing' : 'error',
            httpStatus: code ? Number(code) : null, detail: msg.slice(0, 180), checkedAt,
          };
        }
      }
      if (!spec.probe) {
        return { id, label: spec.label, state: 'unprobed', httpStatus: null, detail: null, checkedAt };
      }
      try {
        await apiRequest(id, { method: 'GET', path: spec.probe.path, query: spec.probe.query });
        return { id, label: spec.label, state: 'live', httpStatus: 200, detail: null, checkedAt };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = /\b(\d{3})\b/.exec(msg)?.[1];
        const httpStatus = code ? Number(code) : null;
        // Quote the service rather than paraphrasing it: "feature is disabled for
        // this account" and "not entitled" are different answers and both matter.
        const quoted = /"(?:message|errorMessage|UserMessage|DeveloperMessage)"\s*:\s*"([^"]{0,180})"/.exec(msg)?.[1]
          ?? msg.slice(0, 180);
        const state: ProductReachability['state'] =
          httpStatus === 403 || httpStatus === 401 ? 'denied'
          : httpStatus === 404 ? 'missing'
          : 'error';
        return { id, label: spec.label, state, httpStatus, detail: quoted, checkedAt };
      }
    }),
  );

  reachabilityCache = { at: Date.now(), rows };
  return rows;
}
