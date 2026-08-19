import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PRODUCTS, PRODUCT_IDS, type ProductId } from '../clients/products.js';
import { PRODUCT_SCOPES } from '../auth/scopes.js';
import { curatedToolsFor } from '../tools/index.js';
import { baseUriFor } from '../clients/base.js';
import { getAccount } from '../auth/jwt.js';
import { loadConfig } from '../lib/config.js';
import { apiRequest } from '../clients/base.js';
import { getClmEndpoints } from '../clients/clm.js';

/**
 * One resource per product API so a connected agent can orient itself: base path,
 * scopes, which curated tools exist, and the escape hatch's name.
 */
export function registerResources(server: McpServer, products: ProductId[]): void {
  // A single orientation document. An agent that reads nothing else should still
  // learn which products exist, which are switched on, and how the two tiers work.
  server.registerResource(
    'docusign-overview',
    'docusign://overview',
    {
      title: 'ZW MCP overview',
      description: 'Every Docusign product API this server can reach, and how tools are named.',
      mimeType: 'text/markdown',
    },
    async (uri) => {
      const cfg = loadConfig();
      const rows = PRODUCT_IDS.map((id) => {
        const spec = PRODUCTS[id];
        const on = products.includes(id);
        const curated = curatedToolsFor(id).length;
        return `| ${spec.label} | \`${spec.toolPrefix}_*\` | ${on ? 'enabled' : 'off'} | ${curated} | ${spec.status} |`;
      });
      const text = [
        '# ZW MCP -- Docusign platform access',
        '',
        `Environment: **${cfg.DS_ENVIRONMENT}**. Enabled products come from DS_PRODUCTS.`,
        '',
        '## How tools are named',
        '',
        'Every tool is prefixed by its product. Two tiers:',
        '',
        '1. **Curated tools** cover what demos actually do, with trimmed responses.',
        '   Prefer these.',
        '2. **`<prefix>_raw_request`** reaches any endpoint the curated tools miss:',
        '   `{ method, path, query?, body? }`, with `{accountId}` and',
        '   `{organizationId}` substituted for you.',
        '',
        '## Products',
        '',
        '| API | Tool prefix | State | Curated tools | Status |',
        '| --- | --- | --- | ---: | --- |',
        ...rows,
        '',
        'Read `docusign://apis/<product>` for a per-API cheat sheet.',
        '',
        '## Conventions worth knowing',
        '',
        '- Large binaries (signed PDFs) are written to a downloads directory; tools',
        '  return the file path, never base64.',
        '- Most list tools take `verbose: false` by default and return a projection.',
        '  Set `verbose: true` only when you need raw fields.',
        '- Admin and Workspaces answer in snake_case; eSignature and Rooms in camelCase.',
        '- Destructive actions (voiding envelopes, cancelling workflow instances)',
        '  should be confirmed with the user first.',
      ].join('\n');
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] };
    },
  );

  for (const id of products) {
    const spec = PRODUCTS[id];
    server.registerResource(
      `docusign-${id}`,
      `docusign://apis/${id}`,
      {
        title: `${spec.label} cheat sheet`,
        description: `Base path, scopes and available ZW MCP tools for the ${spec.label}.`,
        mimeType: 'text/markdown',
      },
      async (uri) => {
        const cfg = loadConfig();
        const base = await baseUriFor(id).catch((e) => `(unresolved: ${(e as Error).message})`);
        const curated = curatedToolsFor(id);
        const text = [
          `# ${spec.label}`,
          '',
          `- **Environment**: ${cfg.DS_ENVIRONMENT}`,
          `- **Base URI**: \`${base}\``,
          `- **Typical path**: \`${spec.pathHint}\` (\`{accountId}\` is substituted automatically)`,
          `- **OAuth scopes**: ${(PRODUCT_SCOPES[id] ?? []).map((s) => `\`${s}\``).join(', ')}`,
          `- **Status**: ${spec.status}`,
          `- **Docs**: ${spec.docsUrl}`,
          '',
          '## Curated tools',
          curated.length
            ? curated.map((t) => `- \`${t}\``).join('\n')
            : '_None yet for this API -- use the raw escape hatch below._',
          '',
          '## Escape hatch',
          `\`${spec.toolPrefix}_raw_request\` reaches every endpoint of this API: ` +
            `\`{ method, path, query?, body? }\`.`,
        ].join('\n');
        return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] };
      },
    );
  }
}

/**
 * A prompt that front-loads the demo account's context, so a demo session starts
 * knowing which account and templates it is working with instead of spending
 * turns discovering them.
 */
export function registerPrompts(server: McpServer, products: ProductId[]): void {
  server.registerPrompt(
    'demo_context',
    {
      title: 'Docusign demo context',
      description:
        'Loads the live demo-account board: account, enabled APIs, and what actually exists ' +
        'right now across eSignature, Navigator, Maestro and CLM. Run this at the start of a ' +
        'demo session so the model starts oriented instead of spending turns discovering.',
    },
    async () => {
      const cfg = loadConfig();
      const account = await getAccount();

      /**
       * Every lookup is best-effort and runs in parallel: a product the account
       * is not entitled to must degrade to a note, never fail the whole prompt.
       * That matters because this runs at the START of a demo.
       */
      const probe = async (label: string, fn: () => Promise<string>): Promise<string> => {
        try {
          return await fn();
        } catch (err) {
          return `${label}: unavailable (${(err as Error).message.slice(0, 90)})`;
        }
      };

      const jobs: Array<Promise<string>> = [];

      if (products.includes('esign')) {
        jobs.push(
          probe('Templates', async () => {
            const d = await apiRequest<{
              envelopeTemplates?: Array<{ templateId?: string; name?: string }>;
            }>('esign', {
              method: 'GET',
              path: '/v2.1/accounts/{accountId}/templates',
              query: { count: 15, order_by: 'used' },
            });
            const list = d.envelopeTemplates ?? [];
            return list.length
              ? `eSignature templates (${list.length} most-used):\n` +
                  list.map((t) => `  - ${t.name} [${t.templateId}]`).join('\n')
              : 'eSignature templates: none on this account';
          }),
        );
        jobs.push(
          probe('Envelopes', async () => {
            const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
            const d = await apiRequest<{ totalSetSize?: string }>('esign', {
              method: 'GET',
              path: '/v2.1/accounts/{accountId}/envelopes',
              query: { from_date: since, count: 1 },
            });
            return `Envelopes in the last 30 days: ${d.totalSetSize ?? '0'}`;
          }),
        );
      }

      if (products.includes('navigator')) {
        jobs.push(
          probe('Navigator', async () => {
            const d = await apiRequest<{ data?: Array<Record<string, unknown>> }>('navigator', {
              method: 'GET',
              path: '/v1/accounts/{accountId}/agreements',
              query: { limit: 50 },
            });
            const rows = d.data ?? [];
            const types = new Map<string, number>();
            for (const a of rows) {
              const t = String(a.type ?? 'Unknown');
              types.set(t, (types.get(t) ?? 0) + 1);
            }
            const top = [...types]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 6)
              .map(([t, n]) => `${t} x${n}`)
              .join(', ');
            return `Navigator agreements (first ${rows.length} sampled): ${top}`;
          }),
        );
      }

      if (products.includes('maestro')) {
        jobs.push(
          probe('Maestro', async () => {
            const d = await apiRequest<{ data?: Array<Record<string, unknown>> }>('maestro', {
              method: 'GET',
              path: '/v1/accounts/{accountId}/workflows',
            });
            const active = (d.data ?? []).filter((w) => w.status === 'active');
            return active.length
              ? `Maestro workflows (${active.length} active):\n` +
                  active
                    .slice(0, 10)
                    .map((w) => `  - ${w.name} [${w.id}]`)
                    .join('\n')
              : 'Maestro workflows: none active';
          }),
        );
      }

      if (products.includes('clm')) {
        jobs.push(
          probe('CLM', async () => {
            const e = await getClmEndpoints();
            return `CLM: reachable at ${e.objectApi} (version ${e.version})`;
          }),
        );
      }

      const sections = await Promise.all(jobs);

      const text = [
        'You are running a Docusign demo through the ZW MCP server.',
        '',
        `Environment: ${cfg.DS_ENVIRONMENT}`,
        `Account: ${account.accountName} (${account.accountId})`,
        `Organization: ${account.organizationId ?? 'n/a'}`,
        `eSignature base URI: ${account.baseUri}`,
        `Enabled product APIs: ${products.join(', ')}`,
        '',
        '--- live account state ---',
        '',
        ...sections,
        '',
        '--- how to work here ---',
        '',
        'Prefer curated tools; fall back to <prefix>_raw_request only when none fits.',
        'Read docusign://overview for the product map, or docusign://apis/<product>',
        'for one API in detail.',
        'Confirm with the user before anything destructive: voiding envelopes,',
        'cancelling workflow instances, deleting agreements.',
      ].join('\n');

      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
    },
  );
}
