import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiRequest } from '../clients/base.js';
import { guard, ok, pick } from '../lib/respond.js';

/** Base URI already carries /api/webforms; paths start at the version segment. */
const FORMS = '/v1.1/accounts/{accountId}/forms';

/**
 * A form's human-readable name lives in `formProperties.name`, not at the top
 * level, so a flat projection returns near-anonymous ids. `compactForm` flattens
 * the two nested objects that matter.
 * VERIFIED 2026-08-19 against demo account b99e0abc-… (live form payload).
 */
function compactForm(f: Record<string, unknown>) {
  const props = (f.formProperties ?? {}) as Record<string, unknown>;
  const meta = (f.formMetadata ?? {}) as Record<string, unknown>;
  return {
    ...pick(f, ['id', 'formState', 'isPublished', 'isEnabled', 'hasDraftChanges'] as const),
    name: props.name,
    isPrivateAccess: props.isPrivateAccess,
    createdDateTime: meta.createdDateTime,
    publishedSlug: meta.publishedSlug,
  };
}
const INSTANCE_KEYS = [
  'id',
  'formId',
  'instanceToken',
  'status',
  'createdDateTime',
  'lastModifiedDateTime',
  'envelopeId',
] as const;

interface ListResponse<T = Record<string, unknown>> {
  items?: T[];
  resultSetSize?: number;
  totalSetSize?: number;
}

export function registerWebFormsTools(server: McpServer): void {
  server.registerTool(
    'webforms_list_forms',
    {
      title: 'List web forms',
      description:
        'List the web form configurations on this account. Web Forms are the public-facing ' +
        'intake forms that collect data and then generate an envelope. Start here to get a ' +
        'form_id; only published forms can accept new instances.',
      inputSchema: {
        search: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(25),
        verbose: z.boolean().default(false),
      },
    },
    guard(async (args) => {
      const res = await apiRequest<ListResponse>('webforms', {
        method: 'GET',
        path: FORMS,
        query: { search: args.search, limit: args.limit },
      });
      const items = res.items ?? [];
      return ok({
        count: items.length,
        total: res.totalSetSize,
        forms: args.verbose ? items : items.map(compactForm),
      });
    }),
  );

  server.registerTool(
    'webforms_get_form',
    {
      title: 'Get a web form',
      description:
        'Fetch one web form configuration, including its field definitions. Read this before ' +
        'webforms_create_instance so you know which formValues the form expects.',
      inputSchema: { form_id: z.string(), verbose: z.boolean().default(true) },
    },
    guard(async (args) => {
      const f = await apiRequest<Record<string, unknown>>('webforms', {
        method: 'GET',
        path: `${FORMS}/${args.form_id}`,
      });
      return ok(args.verbose ? f : compactForm(f));
    }),
  );

  server.registerTool(
    'webforms_list_instances',
    {
      title: 'List web form instances',
      description:
        'List the instances (individual fill-outs) of a web form, with their status and the ' +
        'envelope each produced. Use to answer "how many people completed the intake form".',
      inputSchema: {
        form_id: z.string(),
        limit: z.number().int().min(1).max(100).default(25),
        verbose: z.boolean().default(false),
      },
    },
    guard(async (args) => {
      const res = await apiRequest<ListResponse>('webforms', {
        method: 'GET',
        path: `${FORMS}/${args.form_id}/instances`,
        query: { limit: args.limit },
      });
      const items = res.items ?? [];
      return ok({
        count: items.length,
        instances: args.verbose ? items : items.map((i) => pick(i, INSTANCE_KEYS)),
      });
    }),
  );

  server.registerTool(
    'webforms_create_instance',
    {
      title: 'Create a web form instance',
      description:
        'Start a new instance of a published web form and get back a URL plus instance token ' +
        'for embedding the form in a host app. Pass form_values to pre-fill fields. The ' +
        'returned token is short-lived; refresh it by calling this again if it expires.',
      inputSchema: {
        form_id: z.string(),
        client_user_id: z
          .string()
          .optional()
          .describe('Ties the instance to a user in your app, for embedded use.'),
        form_values: z
          .record(z.string(), z.unknown())
          .default({})
          .describe('Field name -> pre-filled value, matching the form definition.'),
        return_url: z.string().url().optional(),
      },
    },
    guard(async (args) => {
      const res = await apiRequest<Record<string, unknown>>('webforms', {
        method: 'POST',
        path: `${FORMS}/${args.form_id}/instances`,
        body: {
          ...(args.client_user_id ? { clientUserId: args.client_user_id } : {}),
          ...(args.return_url ? { returnUrl: args.return_url } : {}),
          formValues: args.form_values,
        },
      });
      return ok(res);
    }),
  );
}
