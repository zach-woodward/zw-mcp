import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiRequest } from '../clients/base.js';
import { guard, ok, pick, saveDownload } from '../lib/respond.js';

/** Base URI is {rooms host}/restapi; paths start at the version segment. */
const ACCT = '/v2/accounts/{accountId}';

const ROOM_KEYS = [
  'roomId',
  'name',
  'officeId',
  'createdDate',
  'submittedForReviewDate',
  'closedDate',
  'roomStatus',
  'transactionSideId',
] as const;

export function registerRoomsTools(server: McpServer): void {
  server.registerTool(
    'rooms_list_rooms',
    {
      title: 'List rooms',
      description:
        'List Docusign Rooms (transaction rooms) on this account. A room bundles the people, ' +
        'documents and data for one transaction -- typically a real-estate deal. Filter by ' +
        'status to separate live deals from closed ones.',
      inputSchema: {
        room_status: z.enum(['Active', 'Pending', 'Closed', 'Open']).optional(),
        count: z.number().int().min(1).max(100).default(25),
        verbose: z.boolean().default(false),
      },
    },
    guard(async (args) => {
      const res = await apiRequest<{ rooms?: Array<Record<string, unknown>>; totalRowCount?: number }>(
        'rooms',
        {
          method: 'GET',
          path: `${ACCT}/rooms`,
          query: { roomStatus: args.room_status, count: args.count },
        },
      );
      const rooms = res.rooms ?? [];
      return ok({
        count: rooms.length,
        total: res.totalRowCount,
        rooms: args.verbose ? rooms : rooms.map((r) => pick(r, ROOM_KEYS)),
      });
    }),
  );

  server.registerTool(
    'rooms_get_room',
    {
      title: 'Get a room',
      description: 'Fetch one room by ID with its status, dates and configuration.',
      inputSchema: { room_id: z.string(), verbose: z.boolean().default(true) },
    },
    guard(async (args) => {
      const r = await apiRequest<Record<string, unknown>>('rooms', {
        method: 'GET',
        path: `${ACCT}/rooms/${args.room_id}`,
      });
      return ok(args.verbose ? r : pick(r, ROOM_KEYS));
    }),
  );

  server.registerTool(
    'rooms_create_room',
    {
      title: 'Create a room',
      description:
        'Create a new transaction room. role_id and other required fields vary by account ' +
        'configuration -- call rooms_list_roles first, and rooms_get_field_data on an existing ' +
        'room to see which fields your account expects.',
      inputSchema: {
        name: z.string(),
        role_id: z.number().int().describe('Owner role id, from rooms_list_roles.'),
        transaction_side_id: z
          .string()
          .optional()
          .describe('e.g. buy, sell, listbuy -- account dependent.'),
        office_id: z.number().int().optional(),
      },
    },
    guard(async (args) =>
      ok(
        await apiRequest('rooms', {
          method: 'POST',
          path: `${ACCT}/rooms`,
          body: {
            name: args.name,
            roleId: args.role_id,
            ...(args.transaction_side_id ? { transactionSideId: args.transaction_side_id } : {}),
            ...(args.office_id ? { officeId: args.office_id } : {}),
          },
        }),
      ),
    ),
  );

  server.registerTool(
    'rooms_list_documents',
    {
      title: 'List documents in a room',
      description:
        'List the documents filed in a room, with their names and ids. Use before ' +
        'rooms_download_document.',
      inputSchema: {
        room_id: z.string(),
        count: z.number().int().min(1).max(100).default(50),
        verbose: z.boolean().default(false),
      },
    },
    guard(async (args) => {
      const res = await apiRequest<{ documents?: Array<Record<string, unknown>> }>('rooms', {
        method: 'GET',
        path: `${ACCT}/rooms/${args.room_id}/documents`,
        query: { count: args.count },
      });
      const docs = res.documents ?? [];
      return ok({
        count: docs.length,
        documents: args.verbose
          ? docs
          : docs.map((d) =>
              pick(d, ['documentId', 'name', 'ownerId', 'createdDate', 'isSigned'] as const),
            ),
      });
    }),
  );

  server.registerTool(
    'rooms_download_document',
    {
      title: 'Download a room document',
      description:
        'Download one document from a room, saved to the downloads directory. Returns the ' +
        'file path rather than base64.',
      inputSchema: { document_id: z.string(), filename: z.string().optional() },
    },
    guard(async (args) => {
      const doc = await apiRequest<Record<string, unknown>>('rooms', {
        method: 'GET',
        path: `${ACCT}/documents/${args.document_id}`,
        query: { includeContents: true },
      });
      const base64 = doc.base64Contents;
      if (typeof base64 !== 'string') {
        return ok({ note: 'no document contents returned', document: doc });
      }
      const buf = Buffer.from(base64, 'base64');
      const name = args.filename ?? String(doc.name ?? `room-doc-${args.document_id}`);
      return ok({ path: saveDownload(name, buf), bytes: buf.length });
    }),
  );

  server.registerTool(
    'rooms_list_roles',
    {
      title: 'List room roles',
      description:
        'List the roles defined on this Rooms account (agent, admin, transaction coordinator, ' +
        '...). You need a roleId to create a room or invite someone into one.',
      inputSchema: { verbose: z.boolean().default(false) },
    },
    guard(async (args) => {
      const res = await apiRequest<{ roles?: Array<Record<string, unknown>> }>('rooms', {
        method: 'GET',
        path: `${ACCT}/roles`,
      });
      const roles = res.roles ?? [];
      return ok({
        count: roles.length,
        roles: args.verbose
          ? roles
          : roles.map((r) => pick(r, ['roleId', 'name', 'isDefaultForAdmin', 'isExternal'] as const)),
      });
    }),
  );

  server.registerTool(
    'rooms_get_field_data',
    {
      title: 'Get a room\'s field data',
      description:
        'Read the structured transaction data attached to a room -- price, addresses, closing ' +
        'dates, and whatever else the account\'s field set defines. This is where the deal ' +
        'facts live, as opposed to the documents.',
      inputSchema: { room_id: z.string() },
    },
    guard(async (args) =>
      ok(
        await apiRequest('rooms', {
          method: 'GET',
          path: `${ACCT}/rooms/${args.room_id}/field_data`,
        }),
      ),
    ),
  );
}
