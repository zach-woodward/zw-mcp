import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiRequest } from '../clients/base.js';
import { guard, ok } from '../lib/respond.js';

/**
 * Connected Fields exposes exactly one endpoint: the tab groups an account's
 * installed extension apps contribute. Those tab groups are what you attach to
 * an envelope tab to have a third party verify the data a signer enters.
 * VERIFIED 2026-08-19 against a live demo account (live 200).
 */
const TAB_GROUPS = '/v1/accounts/{accountId}/connected-fields/tab-groups';

export function registerConnectedFieldsTools(server: McpServer): void {
  server.registerTool(
    'connectedfields_list_tab_groups',
    {
      title: 'List Connected Fields tab groups',
      description:
        'List the data-verification tab groups available on this account, contributed by ' +
        'installed extension apps. Each entry gives an appId and the tabs it provides, which ' +
        'you reference when building an envelope whose fields are verified by an external ' +
        'system (address validation, ID lookup, and so on). Returns a compact view by default ' +
        'because the raw extensionData payloads are large.',
      inputSchema: { verbose: z.boolean().default(false) },
    },
    guard(async (args) => {
      const res = await apiRequest<Array<Record<string, unknown>>>('connectedfields', {
        method: 'GET',
        path: TAB_GROUPS,
      });
      const groups = Array.isArray(res) ? res : [];
      if (args.verbose) return ok(groups);
      return ok({
        count: groups.length,
        appGroups: groups.map((g) => ({
          appId: g.appId,
          tabs: ((g.tabs ?? []) as Array<Record<string, unknown>>).map((t) => {
            const ext = (t.extensionData ?? {}) as Record<string, unknown>;
            return {
              tabLabel: t.tabLabel ?? t.label,
              extensionGroupId: ext.extensionGroupId,
              applicationId: ext.applicationId,
              actionName: ext.actionName,
            };
          }),
        })),
      });
    }),
  );
}
