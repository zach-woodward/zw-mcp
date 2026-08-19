import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiRequest } from '../clients/base.js';
import { guard, ok, pick } from '../lib/respond.js';

/**
 * Notary needs FOUR scopes together: notary_read, notary_write, organization_read
 * and signature.
 * VERIFIED 2026-08-19 https://developers.docusign.com/docs/notary-api/how-to/send-signature-request-notary-group/
 *
 * The base URI carries /restapi, so paths start at the version segment. Note the
 * version is v1.0, not v1.
 *
 * Sending an envelope TO a notary is an eSignature operation (a recipient of type
 * `notaries`), not a Notary API one -- use esign_create_envelope / esign_raw_request
 * for that. These tools manage the notary pool itself.
 */
export function registerNotaryTools(server: McpServer): void {
  server.registerTool(
    'notary_list_notaries',
    {
      title: 'List notaries in the pool',
      description:
        "List the notaries public in this organization's notary pool, who can be added to an " +
        'envelope to witness a remote online notarization (RON) session. Search by name, ' +
        'email, jurisdiction or session type.',
      inputSchema: {
        search: z.string().optional(),
        search_context: z
          .enum(['Any', 'Name', 'Email', 'Jurisdiction', 'SessionType'])
          .default('Any')
          .describe('Which field the search text applies to.'),
        count: z.number().int().min(1).max(100).default(25),
        verbose: z.boolean().default(false),
      },
    },
    guard(async (args) => {
      const res = await apiRequest<{ notaries?: Array<Record<string, unknown>> }>('notary', {
        method: 'GET',
        path: '/v1.0/accounts/{accountId}/notaries',
        query: {
          search: args.search,
          searchContext: args.search_context,
          count: args.count,
        },
      });
      const notaries = res.notaries ?? [];
      return ok({
        count: notaries.length,
        notaries: args.verbose
          ? notaries
          : notaries.map((n) =>
              pick(n, ['userId', 'name', 'email', 'jurisdictions', 'enabled'] as const),
            ),
      });
    }),
  );

  server.registerTool(
    'notary_list_jurisdictions',
    {
      title: 'List enabled notary jurisdictions',
      description:
        'List the jurisdictions (US states) enabled for notarization on this account. RON is ' +
        'only valid in supported states, so check here before planning a notary session.',
      inputSchema: { verbose: z.boolean().default(false) },
    },
    guard(async (args) => {
      const res = await apiRequest<{ jurisdictions?: Array<Record<string, unknown>> }>('notary', {
        method: 'GET',
        path: '/v1.0/accounts/{accountId}/notary/jurisdictions',
      });
      const j = res.jurisdictions ?? [];
      return ok({
        count: j.length,
        jurisdictions: args.verbose
          ? j
          : j.map((x) => pick(x, ['jurisdiction', 'countyName', 'enabled'] as const)),
      });
    }),
  );

  server.registerTool(
    'notary_list_journals',
    {
      title: 'List notary journal entries',
      description:
        'List the notary journal -- the legally required record of each notarial act performed, ' +
        'with the session details. Use for compliance questions about what was notarized and ' +
        'by whom.',
      inputSchema: {
        count: z.number().int().min(1).max(100).default(25),
        verbose: z.boolean().default(false),
      },
    },
    guard(async (args) => {
      const res = await apiRequest<{ notaryJournals?: Array<Record<string, unknown>> }>('notary', {
        method: 'GET',
        path: '/v1.0/accounts/{accountId}/notary/journals',
        query: { count: args.count },
      });
      const journals = res.notaryJournals ?? [];
      return ok({
        count: journals.length,
        journals: args.verbose
          ? journals
          : journals.map((j) =>
              pick(j, [
                'jurisdiction',
                'journalId',
                'createdDate',
                'documentName',
                'signerName',
              ] as const),
            ),
      });
    }),
  );
}
