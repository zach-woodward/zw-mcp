import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiRequest } from '../clients/base.js';
import { guard, ok, pick } from '../lib/respond.js';

/**
 * Agreement Desk — agreement intake requests.
 *
 * Deliberately a SMALL curated set. Only two routes are confirmed to exist
 * (`/requests` and `/request-types`, both answering a feature-level 403 on an
 * account without the entitlement). Everything else about this API — the response
 * shape, the sub-resources, whether notes hang off a request — is unknown, and
 * guessing would produce tools that look authoritative and return nothing.
 *
 * So: thin wrappers over the confirmed routes with verbose-by-default output, and
 * `desk_raw_request` for the rest. Once the account is entitled, call these, read
 * the real payloads, and only then add projections.
 *
 * VERIFIED 2026-10-27: routes exist, feature disabled on this account.
 * See the comment in src/clients/products.ts for the evidence.
 */
const REQUESTS = '/v1/accounts/{accountId}/requests';

/** Explains the feature gate rather than surfacing a bare 403. */
function deskHint(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('feature is disabled')) {
    throw new Error(
      'Agreement Desk is not enabled on this account. The endpoint exists and the ' +
        'token has sufficient scope — this is an account entitlement gate. Request ' +
        'enablement for the account ID, then retry; no code or consent change is needed.',
    );
  }
  throw err instanceof Error ? err : new Error(msg);
}

export function registerAgreementDeskTools(server: McpServer): void {
  server.registerTool(
    'desk_list_requests',
    {
      title: 'List Agreement Desk requests',
      description:
        'List agreement intake requests from Agreement Desk — the queue where business ' +
        'users submit "I need a contract" asks that then get routed, tracked and discussed. ' +
        'Use for "what is in the intake queue", "what requests are waiting on legal". ' +
        'Returns raw payloads: the response shape is not yet documented or observed, so ' +
        'nothing is trimmed away that might matter.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(25),
        status: z.string().optional().describe('Status filter, if the API supports one.'),
        ctoken: z.string().optional().describe('Continuation token from a previous page.'),
      },
    },
    guard(async (args) => {
      try {
        return ok(
          await apiRequest('agreementdesk', {
            method: 'GET',
            path: REQUESTS,
            query: { limit: args.limit, status: args.status, ctoken: args.ctoken },
          }),
        );
      } catch (err) {
        return deskHint(err);
      }
    }),
  );

  server.registerTool(
    'desk_list_request_types',
    {
      title: 'List Agreement Desk request types',
      description:
        'List the kinds of request Agreement Desk accepts on this account — the intake ' +
        'form definitions. Call this before interpreting desk_list_requests so you know ' +
        'what each request type means.',
      inputSchema: {},
    },
    guard(async () => {
      try {
        return ok(
          await apiRequest('agreementdesk', {
            method: 'GET',
            path: '/v1/accounts/{accountId}/request-types',
          }),
        );
      } catch (err) {
        return deskHint(err);
      }
    }),
  );

  server.registerTool(
    'desk_get_request',
    {
      title: 'Get one Agreement Desk request',
      description:
        'Fetch a single intake request by ID, including whatever the API returns with it. ' +
        'NOTE: this path is inferred from the collection route and has not been confirmed ' +
        'against a live entitled account — if it 404s, the item route may differ. Use ' +
        'desk_raw_request to explore, and report what works.',
      inputSchema: { request_id: z.string() },
    },
    guard(async (args) => {
      try {
        return ok(
          await apiRequest('agreementdesk', {
            method: 'GET',
            path: `${REQUESTS}/${args.request_id}`,
          }),
        );
      } catch (err) {
        return deskHint(err);
      }
    }),
  );

  server.registerTool(
    'desk_get_request_notes',
    {
      title: 'Read the notes on an Agreement Desk request',
      description:
        'Read the discussion notes attached to an intake request — the back-and-forth ' +
        'between requester and reviewer. This is the context an agent needs to answer ' +
        '"why is this request stalled" or "what did legal ask for".\n\n' +
        'UNCONFIRMED path. Probing with a placeholder ID returned 404, which on a ' +
        'feature-disabled account cannot distinguish "no such route" from "no such ' +
        'request" — so this is a best guess at the shape. If it fails on an entitled ' +
        'account, find the real path with desk_raw_request against a real request ID.',
      inputSchema: { request_id: z.string() },
    },
    guard(async (args) => {
      try {
        const res = await apiRequest<unknown>('agreementdesk', {
          method: 'GET',
          path: `${REQUESTS}/${args.request_id}/notes`,
        });
        return ok(res);
      } catch (err) {
        return deskHint(err);
      }
    }),
  );
}
