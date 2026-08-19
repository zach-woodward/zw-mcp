import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProductId } from '../clients/products.js';
import { registerEsignTools } from './esign.js';
import { registerNavigatorTools } from './navigator.js';
import { registerMaestroTools } from './maestro.js';
import { registerClmTools } from './clm.js';
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
  navigator: {
    register: registerNavigatorTools,
    curated: [
      'nav_search_agreements',
      'nav_get_agreement',
      'nav_list_agreement_types',
      'nav_expiring_agreements',
      'nav_agreement_summary',
    ],
  },

  maestro: {
    register: registerMaestroTools,
    curated: [
      'maestro_list_workflows',
      'maestro_get_trigger_requirements',
      'maestro_trigger_workflow',
      'maestro_list_instances',
      'maestro_get_instance',
      'maestro_cancel_instance',
      'maestro_pause_workflow',
      'maestro_resume_workflow',
    ],
  },

  // CLM tools are written from the docs but UNVERIFIED -- no demo account can
  // reach the CLM API. See the banner in src/clients/clm.ts.
  clm: {
    register: registerClmTools,
    curated: [
      'clm_account_info',
      'clm_search_documents',
      'clm_get_document',
      'clm_download_document',
      'clm_upload_document',
      'clm_list_folders',
      'clm_list_folder_documents',
      'clm_get_attributes',
      'clm_set_attributes',
      'clm_launch_workflow',
      'clm_get_workflow_status',
      'clm_generate_document',
    ],
  },

  // Phase 3 adds the rest. Until then each enabled product still gets its
  // raw_request tool, so nothing is unreachable.
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
