import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiRequest } from '../clients/base.js';
import { guard, ok, pick } from '../lib/respond.js';

/**
 * The Admin API is ORGANIZATION-scoped. `{organizationId}` is substituted from
 * /oauth/userinfo by the shared client, so callers never pass it.
 *
 * Note the two coexisting versions: v2 for organization/account listings, v2.1
 * for the newer user-profile and DS-group endpoints. Both are current.
 * Deliberately read-heavy -- user creation and redaction are reachable through
 * admin_raw_request rather than being given a friendly tool.
 */
const ORG = '/v2/organizations/{organizationId}';
const ORG21 = '/v2.1/organizations/{organizationId}';

export function registerAdminTools(server: McpServer): void {
  server.registerTool(
    'admin_list_organizations',
    {
      title: 'List organizations',
      description:
        'List the Docusign organizations this user administers, with the accounts under each. ' +
        'Run this first to confirm the organization and account IDs the other admin_* tools ' +
        'will act on.',
      inputSchema: { verbose: z.boolean().default(false) },
    },
    guard(async (args) => {
      const res = await apiRequest<{ organizations?: Array<Record<string, unknown>> }>('admin', {
        method: 'GET',
        path: '/v2/organizations',
      });
      const orgs = res.organizations ?? [];
      if (args.verbose) return ok(res);
      return ok({
        count: orgs.length,
        organizations: orgs.map((o) => ({
          ...pick(o, ['id', 'name', 'defaultAccountId'] as const),
          accounts: ((o.accounts ?? []) as Array<Record<string, unknown>>).map((a) =>
            pick(a, ['id', 'name', 'siteName'] as const),
          ),
        })),
      });
    }),
  );

  server.registerTool(
    'admin_list_users',
    {
      title: 'List organization users',
      description:
        'List users across the organization with their status and account membership. Use for ' +
        '"who has access", "find this person\'s user id", "who is still pending activation". ' +
        'Filter by email to locate one person.',
      inputSchema: {
        email: z.string().optional().describe('Exact email to look up.'),
        account_id: z.string().optional().describe('Restrict to one account.'),
        start: z.number().int().min(0).default(0),
        take: z.number().int().min(1).max(100).default(25),
        verbose: z.boolean().default(false),
      },
    },
    guard(async (args) => {
      const res = await apiRequest<{ users?: Array<Record<string, unknown>> }>('admin', {
        method: 'GET',
        path: `${ORG21}/users/dsprofile`,
        query: {
          email: args.email,
          account_id: args.account_id,
          start: args.start,
          take: args.take,
        },
      });
      const users = res.users ?? [];
      return ok({
        count: users.length,
        users: args.verbose
          ? users
          : users.map((u) =>
              pick(u, [
                'id',
                'userName',
                'firstName',
                'lastName',
                'userStatus',
                'defaultAccountId',
              ] as const),
            ),
      });
    }),
  );

  server.registerTool(
    'admin_get_user',
    {
      title: 'Get an organization user',
      description:
        'Fetch one user profile by their user GUID, including account memberships and status.',
      inputSchema: { user_id: z.string() },
    },
    guard(async (args) =>
      ok(await apiRequest('admin', { method: 'GET', path: `${ORG21}/users/${args.user_id}/dsprofile` })),
    ),
  );

  server.registerTool(
    'admin_list_groups',
    {
      title: 'List account groups',
      description:
        'List the permission groups defined on an account. Groups are how eSignature ' +
        'permissions and template sharing are granted in bulk.',
      inputSchema: {
        account_id: z
          .string()
          .optional()
          .describe('Defaults to the account this server is configured for.'),
        verbose: z.boolean().default(false),
      },
    },
    guard(async (args) => {
      const account = args.account_id ?? '{accountId}';
      const res = await apiRequest<{ groups?: Array<Record<string, unknown>> }>('admin', {
        method: 'GET',
        path: `${ORG}/accounts/${account}/groups`,
      });
      const groups = res.groups ?? [];
      return ok({
        count: groups.length,
        groups: args.verbose
          ? groups
          : groups.map((g) => pick(g, ['id', 'name', 'type', 'userCount'] as const)),
      });
    }),
  );

  server.registerTool(
    'admin_list_permission_profiles',
    {
      title: 'List permission profiles',
      description:
        'List the permission profiles on an account -- the named bundles of capability ' +
        '(Account Administrator, Sender, Viewer, ...) assigned to users.',
      inputSchema: {
        account_id: z.string().optional(),
        verbose: z.boolean().default(false),
      },
    },
    guard(async (args) => {
      const account = args.account_id ?? '{accountId}';
      const res = await apiRequest<{ permissions?: Array<Record<string, unknown>> }>('admin', {
        method: 'GET',
        path: `${ORG}/accounts/${account}/permissions`,
      });
      const perms = res.permissions ?? [];
      return ok({
        count: perms.length,
        permissionProfiles: args.verbose
          ? perms
          : perms.map((p) => pick(p, ['id', 'name', 'isDefault'] as const)),
      });
    }),
  );
}
