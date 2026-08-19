import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiRequest } from '../clients/base.js';
import { guard, ok, pick, saveDownload } from '../lib/respond.js';

/** Base URI is {account base}/clickapi; paths start at the version segment. */
const CLICKWRAPS = '/v1/accounts/{accountId}/clickwraps';

const CLICKWRAP_KEYS = [
  'clickwrapId',
  'clickwrapName',
  'status',
  'versionId',
  'versionNumber',
  'createdTime',
  'lastModified',
  'requireReacceptance',
] as const;

export function registerClickTools(server: McpServer): void {
  server.registerTool(
    'click_list_clickwraps',
    {
      title: 'List clickwraps',
      description:
        'List the Click elastic templates (clickwraps) on this account -- the terms-of-service ' +
        'and consent agreements users accept with a single click, no signature ceremony. ' +
        'Only clickwraps in "active" status can collect new acceptances.',
      inputSchema: {
        status: z.enum(['active', 'inactive', 'draft', 'deleted']).optional(),
        limit: z.number().int().min(1).max(100).default(25),
        verbose: z.boolean().default(false),
      },
    },
    guard(async (args) => {
      const res = await apiRequest<{ clickwraps?: Array<Record<string, unknown>> }>('click', {
        method: 'GET',
        path: CLICKWRAPS,
        query: { status: args.status, page_size: args.limit },
      });
      const items = res.clickwraps ?? [];
      return ok({
        count: items.length,
        clickwraps: args.verbose ? items : items.map((c) => pick(c, CLICKWRAP_KEYS)),
      });
    }),
  );

  server.registerTool(
    'click_get_clickwrap',
    {
      title: 'Get a clickwrap',
      description:
        'Fetch one clickwrap with its current version, display settings and document. Use to ' +
        'inspect what a user is being asked to accept.',
      inputSchema: { clickwrap_id: z.string(), verbose: z.boolean().default(true) },
    },
    guard(async (args) =>
      ok(
        await apiRequest('click', { method: 'GET', path: `${CLICKWRAPS}/${args.clickwrap_id}` }),
      ),
    ),
  );

  server.registerTool(
    'click_list_agreements',
    {
      title: 'List clickwrap acceptances',
      description:
        'List the users who have been served a clickwrap and whether they accepted it, with ' +
        'timestamps. This is the audit answer to "who agreed to our terms and when".',
      inputSchema: {
        clickwrap_id: z.string(),
        status: z.enum(['agreed', 'declined']).optional(),
        client_user_id: z.string().optional().describe('Filter to one user in your system.'),
        verbose: z.boolean().default(false),
      },
    },
    guard(async (args) => {
      const res = await apiRequest<{ userAgreements?: Array<Record<string, unknown>> }>('click', {
        method: 'GET',
        path: `${CLICKWRAPS}/${args.clickwrap_id}/users`,
        query: { status: args.status, client_user_id: args.client_user_id },
      });
      const items = res.userAgreements ?? [];
      return ok({
        count: items.length,
        agreements: args.verbose
          ? items
          : items.map((u) =>
              pick(u, [
                'agreementId',
                'clientUserId',
                'status',
                'agreedOn',
                'declinedOn',
                'versionNumber',
                'customerName',
                'customerEmail',
              ] as const),
            ),
      });
    }),
  );

  server.registerTool(
    'click_create_clickwrap',
    {
      title: 'Create a clickwrap',
      description:
        'Create a new clickwrap from a document (local file path or base64). The clickwrap is ' +
        'created in draft status; publish it in the Click UI or via click_raw_request before ' +
        'it can collect acceptances.',
      inputSchema: {
        name: z.string(),
        display_name: z.string().default('I agree'),
        document_name: z.string().default('Terms'),
        file_path: z.string().optional().describe('Absolute path to a document on this server.'),
        base64: z.string().optional(),
        file_extension: z.string().default('pdf'),
        require_accept: z.boolean().default(true),
      },
    },
    guard(async (args) => {
      let content = args.base64;
      if (!content) {
        if (!args.file_path) throw new Error('provide either file_path or base64');
        const fs = await import('node:fs');
        const path = await import('node:path');
        const abs = path.resolve(args.file_path);
        if (!fs.existsSync(abs)) throw new Error(`file not found: ${abs}`);
        content = fs.readFileSync(abs).toString('base64');
      }
      const res = await apiRequest<Record<string, unknown>>('click', {
        method: 'POST',
        path: CLICKWRAPS,
        body: {
          name: args.name,
          displaySettings: {
            displayName: args.display_name,
            consentButtonText: 'I Agree',
            mustRead: args.require_accept,
            requireAccept: args.require_accept,
            documentDisplay: 'document',
          },
          documents: [
            {
              documentBase64: content,
              documentName: args.document_name,
              fileExtension: args.file_extension,
              order: 0,
            },
          ],
        },
      });
      return ok(pick(res, CLICKWRAP_KEYS));
    }),
  );

  server.registerTool(
    'click_download_agreement',
    {
      title: 'Download a clickwrap acceptance record',
      description:
        'Download the PDF evidence of one user accepting a clickwrap, saved to the downloads ' +
        'directory. Use when you need proof of consent for an audit.',
      inputSchema: {
        clickwrap_id: z.string(),
        agreement_id: z.string(),
        filename: z.string().optional(),
      },
    },
    guard(async (args) => {
      const buf = await apiRequest<Buffer>('click', {
        method: 'GET',
        path: `${CLICKWRAPS}/${args.clickwrap_id}/agreements/${args.agreement_id}/download`,
        raw: true,
        accept: 'application/pdf',
      });
      return ok({
        path: saveDownload(args.filename ?? `clickwrap-${args.agreement_id}.pdf`, buf),
        bytes: buf.length,
      });
    }),
  );
}
