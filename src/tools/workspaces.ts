import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiRequest } from '../clients/base.js';
import { guard, ok, pick, saveDownload } from '../lib/respond.js';

const WS = '/v1/accounts/{accountId}/workspaces';

/**
 * Workspaces answers in snake_case (like the Admin API, unlike eSignature), and
 * wraps lists as { workspaces, result_set_size, total_row_count }.
 * VERIFIED 2026-08-19 against a live demo account (live payload).
 */
const WORKSPACE_KEYS = [
  'workspace_id',
  'name',
  'status',
  'created_date',
  'created_by_user_id',
  'last_modified_date',
] as const;

interface ListResponse<T = Record<string, unknown>> {
  workspaces?: T[];
  documents?: T[];
  envelopes?: T[];
  users?: T[];
  /** Upload requests wrap in `data`, not `upload_requests` -- unlike every sibling. */
  data?: T[];
  value?: T[];
  total_row_count?: number;
}

export function registerWorkspacesTools(server: McpServer): void {
  server.registerTool(
    'workspaces_list',
    {
      title: 'List workspaces',
      description:
        'List Docusign Workspaces -- shared spaces where a deal team and their counterparties ' +
        'collect documents, request uploads and send envelopes together. Start here for a ' +
        'workspace_id.',
      inputSchema: {
        count: z.number().int().min(1).max(100).default(25),
        verbose: z.boolean().default(false),
      },
    },
    guard(async (args) => {
      const res = await apiRequest<ListResponse>('workspaces', {
        method: 'GET',
        path: WS,
        query: { count: args.count },
      });
      const items = res.workspaces ?? res.value ?? [];
      return ok({
        count: items.length,
        total: res.total_row_count,
        workspaces: args.verbose ? items : items.map((w) => pick(w, WORKSPACE_KEYS)),
      });
    }),
  );

  server.registerTool(
    'workspaces_get',
    {
      title: 'Get a workspace',
      description: 'Fetch one workspace with its status and settings.',
      inputSchema: { workspace_id: z.string(), verbose: z.boolean().default(true) },
    },
    guard(async (args) => {
      const w = await apiRequest<Record<string, unknown>>('workspaces', {
        method: 'GET',
        path: `${WS}/${args.workspace_id}`,
      });
      return ok(args.verbose ? w : pick(w, WORKSPACE_KEYS));
    }),
  );

  server.registerTool(
    'workspaces_list_documents',
    {
      title: 'List workspace documents',
      description: 'List the documents held in a workspace.',
      inputSchema: { workspace_id: z.string(), verbose: z.boolean().default(false) },
    },
    guard(async (args) => {
      const res = await apiRequest<ListResponse>('workspaces', {
        method: 'GET',
        path: `${WS}/${args.workspace_id}/documents`,
      });
      const docs = res.documents ?? res.value ?? [];
      return ok({
        count: docs.length,
        documents: args.verbose
          ? docs
          : docs.map((d) =>
              pick(d, [
                'document_id',
                'name',
                'owner_id',
                'size',
                'created_date',
                'last_updated_date',
              ] as const),
            ),
      });
    }),
  );

  server.registerTool(
    'workspaces_download_document',
    {
      title: 'Download a workspace document',
      description:
        'Download one workspace document to the downloads directory and return its path.',
      inputSchema: {
        workspace_id: z.string(),
        document_id: z.string(),
        filename: z.string().optional(),
      },
    },
    guard(async (args) => {
      const buf = await apiRequest<Buffer>('workspaces', {
        method: 'GET',
        path: `${WS}/${args.workspace_id}/documents/${args.document_id}/contents`,
        raw: true,
        accept: '*/*',
      });
      return ok({
        path: saveDownload(args.filename ?? `workspace-${args.document_id}`, buf),
        bytes: buf.length,
      });
    }),
  );

  server.registerTool(
    'workspaces_list_envelopes',
    {
      title: 'List envelopes in a workspace',
      description:
        'List the eSignature envelopes created from a workspace, tying the collaboration space ' +
        'back to signature activity.',
      inputSchema: { workspace_id: z.string(), verbose: z.boolean().default(false) },
    },
    guard(async (args) => {
      const res = await apiRequest<ListResponse>('workspaces', {
        method: 'GET',
        path: `${WS}/${args.workspace_id}/envelopes`,
      });
      const envs = res.envelopes ?? res.value ?? [];
      return ok({
        count: envs.length,
        envelopes: args.verbose
          ? envs
          : envs.map((e) => pick(e, ['envelope_id', 'status'] as const)),
      });
    }),
  );

  server.registerTool(
    'workspaces_list_upload_requests',
    {
      title: 'List workspace upload requests',
      description:
        'List outstanding document-upload requests in a workspace -- the "please send us your ' +
        'bank statement" asks. Use to answer what a counterparty still owes you.',
      inputSchema: { workspace_id: z.string(), verbose: z.boolean().default(false) },
    },
    guard(async (args) => {
      const res = await apiRequest<ListResponse>('workspaces', {
        method: 'GET',
        path: `${WS}/${args.workspace_id}/upload-requests`,
      });
      const items = res.data ?? res.value ?? [];
      return ok({
        count: items.length,
        uploadRequests: args.verbose
          ? items
          : items.map((u) =>
              pick(u, [
                'upload_request_id',
                'name',
                'description',
                'status',
                'due_date',
                'sent_date',
                'completed_date',
              ] as const),
            ),
      });
    }),
  );

  server.registerTool(
    'workspaces_list_users',
    {
      title: 'List workspace users',
      description: 'List the people with access to a workspace and their roles.',
      inputSchema: { workspace_id: z.string(), verbose: z.boolean().default(false) },
    },
    guard(async (args) => {
      const res = await apiRequest<ListResponse>('workspaces', {
        method: 'GET',
        path: `${WS}/${args.workspace_id}/users`,
      });
      const users = res.users ?? res.value ?? [];
      return ok({
        count: users.length,
        users: args.verbose
          ? users
          : users.map((u) =>
              pick(u, [
                'user_id',
                'email',
                'first_name',
                'last_name',
                'role_id',
                'role_name',
              ] as const),
            ),
      });
    }),
  );
}
