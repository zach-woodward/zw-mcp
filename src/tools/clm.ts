import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { clmRequest, getClmEndpoints } from '../clients/clm.js';
import { guard, ok, pick, saveDownload } from '../lib/respond.js';

/**
 * CLM curated tools.
 *
 * UNVERIFIED against a live account -- see the banner in src/clients/clm.ts.
 * Paths follow the documented Object/Task/Content API surfaces and are relative
 * to `/{version}/{accountId}`.
 * CHECKED 2026-08-19 https://developers.docusign.com/docs/clm-api/clm.cm/clm101/migrating-soap-to-rest/
 */

const DOC_KEYS = [
  'Id',
  'Name',
  'Href',
  'CreatedDate',
  'UpdatedDate',
  'PageCount',
  'NativeFileSize',
  'DownloadDocumentHref',
] as const;

const FOLDER_KEYS = ['Id', 'Name', 'Href', 'CreatedDate', 'UpdatedDate', 'ParentFolder'] as const;

/** CLM wraps collections as { Items: [...], Total, Offset, Limit }. */
interface ClmCollection<T = Record<string, unknown>> {
  Items?: T[];
  Total?: number;
  Offset?: number;
  Limit?: number;
}

export function registerClmTools(server: McpServer): void {
  server.registerTool(
    'clm_account_info',
    {
      title: 'Get CLM account + discovered endpoints',
      description:
        'Return this account\'s CLM API hosts (Object, Task, Content upload/download), API ' +
        'version and CLM account id, as discovered at runtime. Call this FIRST when any other ' +
        'clm_* tool fails -- CLM requires a CLM-entitled account and its hosts are data-center ' +
        'specific, so a failure here means CLM is unavailable rather than the call being wrong.',
      inputSchema: {},
    },
    guard(async () => ok(await getClmEndpoints())),
  );

  server.registerTool(
    'clm_search_documents',
    {
      title: 'Search CLM documents',
      description:
        'Full-text search across CLM documents. CLM runs search as an asynchronous task: this ' +
        'creates a documentsearchtask and returns it, including the Href to poll for results. ' +
        'For a document whose exact path you already know, clm_get_document with a path is faster.',
      inputSchema: {
        query: z.string().describe('Full-text search string.'),
        limit: z.number().int().min(1).max(100).default(20),
      },
    },
    guard(async (args) =>
      ok(
        await clmRequest({
          surface: 'task',
          method: 'POST',
          path: '/documentsearchtasks',
          body: { Query: args.query, PageSize: args.limit },
        }),
      ),
    ),
  );

  server.registerTool(
    'clm_get_document',
    {
      title: 'Get a CLM document',
      description:
        'Fetch a CLM document by its id, or by its full folder path (e.g. ' +
        '"/Contracts/Acme/MSA.pdf"). Returns the document object including its ' +
        'DownloadDocumentHref, which clm_download_document uses.',
      inputSchema: {
        document_id: z.string().optional(),
        path: z.string().optional().describe('Full CLM path; alternative to document_id.'),
        expand: z
          .string()
          .optional()
          .describe('Comma-separated related data to inline, e.g. "attributegroups,lock,versions".'),
        verbose: z.boolean().default(false),
      },
    },
    guard(async (args) => {
      if (!args.document_id && !args.path) {
        throw new Error('Provide either document_id or path.');
      }
      const doc = await clmRequest<Record<string, unknown>>({
        method: 'GET',
        path: args.document_id ? `/documents/${args.document_id}` : '/documents',
        query: { path: args.path, expand: args.expand },
      });
      return ok(args.verbose ? doc : pick(doc, DOC_KEYS));
    }),
  );

  server.registerTool(
    'clm_download_document',
    {
      title: 'Download a CLM document',
      description:
        'Download a CLM document and save it to the server\'s downloads directory, returning ' +
        'the file path. Request a different rendition with format: native (as uploaded), pdf, ' +
        'or text (the OCR text CLM extracts). PDF and text renditions are generated ' +
        'asynchronously after upload, so a very recent document may 404 for those.',
      inputSchema: {
        document_id: z.string(),
        filename: z.string().optional(),
        format: z.enum(['native', 'pdf', 'text']).default('pdf'),
      },
    },
    guard(async (args) => {
      const accept =
        args.format === 'pdf'
          ? 'application/pdf'
          : args.format === 'text'
            ? 'text/plain'
            : undefined;
      const buf = await clmRequest<Buffer>({
        surface: 'download',
        method: 'GET',
        path: `/documents/${args.document_id}`,
        accept,
        raw: true,
      });
      const ext = args.format === 'pdf' ? 'pdf' : args.format === 'text' ? 'txt' : 'bin';
      return ok({
        path: saveDownload(args.filename ?? `clm-${args.document_id}.${ext}`, buf),
        bytes: buf.length,
      });
    }),
  );

  server.registerTool(
    'clm_upload_document',
    {
      title: 'Upload a document to CLM',
      description:
        'Upload a local file into a CLM folder. Requires the target folder id and the name the ' +
        'document should take in CLM. Uses the Content upload host, which is separate from the ' +
        'Object API host.',
      inputSchema: {
        folder_id: z.string(),
        file_path: z.string().describe('Absolute path to a file on this server.'),
        name: z.string().describe('Document name in CLM, including extension.'),
      },
    },
    guard(async (args) => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const abs = path.resolve(args.file_path);
      if (!fs.existsSync(abs)) throw new Error(`file not found: ${abs}`);
      const content = fs.readFileSync(abs);
      return ok(
        await clmRequest({
          surface: 'upload',
          method: 'POST',
          path: `/folders/${args.folder_id}/documents`,
          query: { name: args.name },
          body: content.toString('base64'),
        }),
      );
    }),
  );

  server.registerTool(
    'clm_list_folders',
    {
      title: 'List CLM folders',
      description:
        'List the sub-folders of a CLM folder, or resolve a folder by path. Omit both arguments ' +
        'to start from the account root. Use to navigate the CLM filing structure before ' +
        'uploading or searching.',
      inputSchema: {
        folder_id: z.string().optional(),
        path: z.string().optional().describe('Full folder path, e.g. "/Contracts/Acme".'),
        verbose: z.boolean().default(false),
      },
    },
    guard(async (args) => {
      if (args.path) {
        const folder = await clmRequest<Record<string, unknown>>({
          method: 'GET',
          path: '/folders',
          query: { path: args.path },
        });
        return ok(args.verbose ? folder : pick(folder, FOLDER_KEYS));
      }
      const res = await clmRequest<ClmCollection>({
        method: 'GET',
        path: args.folder_id ? `/folders/${args.folder_id}/folders` : '/folders',
      });
      const items = res.Items ?? [];
      return ok({
        total: res.Total ?? items.length,
        folders: args.verbose ? items : items.map((f) => pick(f, FOLDER_KEYS)),
      });
    }),
  );

  server.registerTool(
    'clm_list_folder_documents',
    {
      title: 'List documents in a CLM folder',
      description: 'List the documents directly inside a CLM folder.',
      inputSchema: {
        folder_id: z.string(),
        limit: z.number().int().min(1).max(200).default(50),
        verbose: z.boolean().default(false),
      },
    },
    guard(async (args) => {
      const res = await clmRequest<ClmCollection>({
        method: 'GET',
        path: `/folders/${args.folder_id}/documents`,
        query: { limit: args.limit },
      });
      const items = res.Items ?? [];
      return ok({
        total: res.Total ?? items.length,
        documents: args.verbose ? items : items.map((d) => pick(d, DOC_KEYS)),
      });
    }),
  );

  server.registerTool(
    'clm_get_attributes',
    {
      title: 'Get a document\'s CLM attributes',
      description:
        'Read the metadata (attribute groups) attached to a CLM document -- contract value, ' +
        'counterparty, renewal date and whatever else the account has configured. This is where ' +
        'CLM keeps structured contract data.',
      inputSchema: { document_id: z.string() },
    },
    guard(async (args) =>
      ok(
        await clmRequest({
          method: 'GET',
          path: `/documents/${args.document_id}`,
          query: { expand: 'attributegroups' },
        }),
      ),
    ),
  );

  server.registerTool(
    'clm_set_attributes',
    {
      title: 'Set a document\'s CLM attributes',
      description:
        'Update the attribute-group metadata on a CLM document. Pass attributes as the ' +
        'AttributeGroups object CLM expects -- read the current shape with clm_get_attributes ' +
        'first and mirror it, since group and field names are account-specific.',
      inputSchema: {
        document_id: z.string(),
        attribute_groups: z
          .record(z.string(), z.unknown())
          .describe('AttributeGroups payload, matching the shape from clm_get_attributes.'),
      },
    },
    guard(async (args) =>
      ok(
        await clmRequest({
          method: 'PATCH',
          path: `/documents/${args.document_id}`,
          body: { AttributeGroups: args.attribute_groups },
        }),
      ),
    ),
  );

  server.registerTool(
    'clm_launch_workflow',
    {
      title: 'Start a CLM workflow',
      description:
        'Start a CLM workflow instance by name, optionally passing parameters and documents. ' +
        'This is CLM\'s own workflow engine, distinct from Maestro -- use maestro_* tools for ' +
        'Maestro/Workflow Builder.',
      inputSchema: {
        workflow_name: z.string(),
        params: z.record(z.string(), z.unknown()).default({}),
        document_ids: z.array(z.string()).optional(),
      },
    },
    guard(async (args) =>
      ok(
        await clmRequest({
          method: 'POST',
          path: '/workflows',
          body: {
            Name: args.workflow_name,
            Params: args.params,
            ...(args.document_ids?.length
              ? { WorkflowDocuments: args.document_ids.map((Id) => ({ Id })) }
              : {}),
          },
        }),
      ),
    ),
  );

  server.registerTool(
    'clm_get_workflow_status',
    {
      title: 'Get a CLM workflow instance',
      description: 'Fetch the status and current state of a running CLM workflow instance.',
      inputSchema: { instance_id: z.string() },
    },
    guard(async (args) =>
      ok(await clmRequest({ method: 'GET', path: `/workflows/${args.instance_id}` })),
    ),
  );

  server.registerTool(
    'clm_generate_document',
    {
      title: 'Generate a document from XML (CLM doc-gen)',
      description:
        'Run CLM document generation: merge an XML data payload into a template document to ' +
        'produce a new document. Creates an asynchronous documentxmlmergetask and returns it ' +
        'with an Href to poll for completion.',
      inputSchema: {
        template_document_id: z.string().describe('The CLM template document to merge into.'),
        xml_payload: z.string().describe('The XML data to merge.'),
        output_folder_id: z.string().optional(),
        output_name: z.string().optional(),
      },
    },
    guard(async (args) =>
      ok(
        await clmRequest({
          surface: 'task',
          method: 'POST',
          path: '/documentxmlmergetasks',
          body: {
            MergeDocument: { Id: args.template_document_id },
            Xml: args.xml_payload,
            ...(args.output_folder_id ? { DestinationFolder: { Id: args.output_folder_id } } : {}),
            ...(args.output_name ? { Name: args.output_name } : {}),
          },
        }),
      ),
    ),
  );
}
