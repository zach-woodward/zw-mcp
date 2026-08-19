import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiRequest } from '../clients/base.js';
import { guard, ok, pick } from '../lib/respond.js';

/**
 * Monitor is organization-scoped, not account-scoped: `{organizationId}` comes
 * from /oauth/userinfo and is substituted by the shared client.
 * VERIFIED 2026-08-19: host+path from monitor.rest.swagger-v2.0.json, confirmed
 * by a live probe (403 "Organization does not have Monitor entitlement" -- the
 * request routed and entitlement was evaluated).
 */
const STREAM = '/v1/organizations/{organizationId}/stream';

export function registerMonitorTools(server: McpServer): void {
  server.registerTool(
    'monitor_get_events',
    {
      title: 'Get Monitor security events',
      description:
        'Read the organization security-event stream: logins, permission changes, envelope ' +
        'activity, admin actions. Monitor is a cursor-based stream, not a searchable log -- ' +
        'pass the cursor returned by the previous call to continue where you left off, and ' +
        'omit it to start from the beginning of the retained window. Requires Monitor ' +
        'entitlement on the organization.',
      inputSchema: {
        cursor: z
          .string()
          .optional()
          .describe('endCursor from a previous call. Omit to start at the earliest retained event.'),
        limit: z.number().int().min(1).max(2000).default(100),
        verbose: z.boolean().default(false),
      },
    },
    guard(async (args) => {
      const res = await apiRequest<{
        endCursor?: string;
        data?: Array<Record<string, unknown>>;
      }>('monitor', {
        method: 'GET',
        path: STREAM,
        query: { cursor: args.cursor, limit: args.limit },
      });
      const events = res.data ?? [];
      return ok({
        count: events.length,
        endCursor: res.endCursor,
        note: 'Pass endCursor back as `cursor` to page forward.',
        events: args.verbose
          ? events
          : events.map((e) =>
              pick(e, [
                'timestamp',
                'eventId',
                'site',
                'accountId',
                'userId',
                'object',
                'action',
                'email',
                'ipAddress',
              ] as const),
            ),
      });
    }),
  );
}
