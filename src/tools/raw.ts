import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiRequest, baseUriFor } from '../clients/base.js';
import { PRODUCTS, type ProductId } from '../clients/products.js';
import { guard, ok, saveDownload } from '../lib/respond.js';

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
    `${product}_raw_request`,
    {
      title: `Raw ${spec.label} request`,
      description:
        `Escape hatch: send an arbitrary authenticated request to the ${spec.label}. ` +
        `Use this only when no curated ${product}_* tool covers what you need.\n\n` +
        `Paths are relative to that API's base URI and "{accountId}" is substituted ` +
        `automatically, so a typical path looks like: ${spec.pathHint}\n\n` +
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
        const buf = await apiRequest<Buffer>(product, {
          method: args.method,
          path: args.path,
          query: args.query,
          body: args.body,
          raw: true,
          accept: '*/*',
        });
        return ok({ path: saveDownload(args.save_binary_as, buf), bytes: buf.length });
      }
      const res = await apiRequest(product, {
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
