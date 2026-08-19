import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProductId } from '../clients/products.js';
import { registerEsignTools } from './esign.js';
import { registerRawTool } from './raw.js';

/**
 * Which curated tools exist per product. The name list is declared here rather
 * than scraped off the server so MCP resources can describe a product's tools
 * without instantiating anything, and so a phase that adds tools has exactly one
 * place to update.
 */
export interface ToolModule {
  register: (server: McpServer) => void;
  curated: string[];
}

export const TOOL_MODULES: Partial<Record<ProductId, ToolModule>> = {
  esign: {
    register: registerEsignTools,
    curated: [
      'esign_list_envelopes',
      'esign_get_envelope',
      'esign_list_recipients',
      'esign_download_document',
      'esign_list_templates',
      'esign_get_template',
      'esign_create_envelope_from_template',
      'esign_create_envelope',
      'esign_send_reminder',
      'esign_void_envelope',
      'esign_recipient_view',
      'esign_sender_view',
      'esign_account_info',
    ],
  },
  // Phase 2 adds navigator, clm, maestro. Phase 3 adds the rest. Until then each
  // enabled product still gets its raw_request tool, so nothing is unreachable.
};

export function curatedToolsFor(product: ProductId): string[] {
  return TOOL_MODULES[product]?.curated ?? [];
}

/** Registers curated tools (where they exist) plus the raw tool for each product. */
export function registerAllTools(server: McpServer, products: ProductId[]): void {
  for (const product of products) {
    TOOL_MODULES[product]?.register(server);
    registerRawTool(server, product);
  }
}
