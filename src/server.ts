import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig } from './lib/config.js';
import { registerAllTools } from './tools/index.js';
import { registerPrompts, registerResources } from './resources/index.js';
import type { ProductId } from './clients/products.js';

export const SERVER_NAME = 'zw-mcp';
export const SERVER_VERSION = '0.1.0';

/**
 * Builds a fully-populated MCP server.
 *
 * Called per HTTP request in stateless mode, so it must stay cheap: everything
 * expensive (tokens, account discovery, base URIs) lives in module-level caches
 * outside this function and is shared across all instances.
 */
export function buildServer(): McpServer {
  const cfg = loadConfig();
  const products = cfg.products as ProductId[];

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'ZW MCP exposes the DocuSign platform. Tools are namespaced by product ' +
        '(esign_*, nav_*, clm_*, ...). Each product also has a <product>_raw_request ' +
        'escape hatch that reaches any endpoint the curated tools do not cover. ' +
        'Read the docusign://apis/<product> resources to orient yourself, and run the ' +
        'demo_context prompt at the start of a demo session.',
    },
  );

  registerAllTools(server, products);
  registerResources(server, products);
  registerPrompts(server, products);

  return server;
}
