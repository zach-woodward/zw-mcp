import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PRODUCTS, type ProductId } from '../clients/products.js';
import { PRODUCT_SCOPES } from '../auth/scopes.js';
import { curatedToolsFor } from '../tools/index.js';
import { baseUriFor } from '../clients/base.js';
import { getAccount } from '../auth/jwt.js';
import { loadConfig } from '../lib/config.js';
import { apiRequest } from '../clients/base.js';

/**
 * One resource per product API so a connected agent can orient itself: base path,
 * scopes, which curated tools exist, and the escape hatch's name.
 */
export function registerResources(server: McpServer, products: ProductId[]): void {
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
          `\`${id}_raw_request\` reaches every endpoint of this API: ` +
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
      title: 'DocuSign demo context',
      description:
        'Loads the current DocuSign demo account context: account ID, environment, enabled ' +
        'product APIs and the templates available to send. Run this at the start of a demo.',
    },
    async () => {
      const cfg = loadConfig();
      const account = await getAccount();

      let templateSummary = '(templates unavailable)';
      if (products.includes('esign')) {
        try {
          const data = await apiRequest<{
            envelopeTemplates?: Array<{ templateId?: string; name?: string }>;
          }>('esign', {
            method: 'GET',
            path: '/v2.1/accounts/{accountId}/templates',
            query: { count: 25, order_by: 'used' },
          });
          const list = data.envelopeTemplates ?? [];
          templateSummary = list.length
            ? list.map((t) => `- ${t.name} (${t.templateId})`).join('\n')
            : '(no templates on this account)';
        } catch (err) {
          templateSummary = `(template lookup failed: ${(err as Error).message})`;
        }
      }

      const text = [
        'You are running a DocuSign demo through the ZW MCP server.',
        '',
        `Environment: ${cfg.DS_ENVIRONMENT}`,
        `Account: ${account.accountName} (${account.accountId})`,
        `eSignature base URI: ${account.baseUri}`,
        `Enabled product APIs: ${products.join(', ')}`,
        '',
        'Templates available to send:',
        templateSummary,
        '',
        'Prefer the curated tools; fall back to <product>_raw_request only when no curated',
        'tool fits. Confirm with the user before any destructive action (voiding envelopes).',
      ].join('\n');

      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
    },
  );
}
