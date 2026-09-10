import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { clmRequest, getClmEndpoints } from '../clients/clm.js';
import { guard, ok, pick, saveDownload } from '../lib/respond.js';

/**
 * CLM curated tools.
 *
 * Paths are relative to `/{version}/{accountId}` and taken from the CLM swagger
 * (declared version v2), not from the SOAP-migration table -- the two disagree.
 * Notably folder lookup by path is `/folders/path?path=`, NOT `/folders?path=`;
 * the latter is a 405 because /folders only accepts POST.
 * VERIFIED 2026-08-19 against a live CLM-entitled UAT account.
 */

/**
 * Real CLM document fields (VERIFIED 2026-08-19 against a live document object).
 * Note `Uid`, not `Id` -- CLM exposes the identifier as Uid and embeds it in Href.
 */
const DOC_KEYS = [
  'Uid',
  'Name',
  'Extension',
  'CreatedDate',
  'UpdatedDate',
  'CreatedBy',
  'PageCount',
  'NativeFileSize',
  'Href',
  'DownloadDocumentHref',
] as const;

const FOLDER_KEYS = ['Name', 'Href', 'CreatedDate', 'UpdatedDate'] as const;

/**
 * CLM objects do not carry an `Id` field -- the id lives in the `Href` tail:
 *   https://apiuatna11.springcm.com/v2/{account}/folders/{id}
 * VERIFIED 2026-08-19 against live folder + workflow-definition payloads.
 */
function idFromHref(obj: Record<string, unknown> | undefined): string | undefined {
  if (typeof obj?.Uid === 'string' && obj.Uid) return obj.Uid;
  const href = obj?.Href;
  if (typeof href !== 'string') return undefined;
  const tail = href.split('/').pop();
  return tail && tail.length > 8 ? tail : undefined;
}

/** Resolves the account's root folder id, used as the default search scope. */
async function rootFolderId(): Promise<string | undefined> {
  const root = await clmRequest<Record<string, unknown>>({
    method: 'GET',
    path: '/folders/type',
    query: { systemFolder: 'root' },
  });
  return idFromHref(root);
}

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
      title: 'Find CLM documents by name',
      description:
        'Find documents in CLM whose name contains the given text, walking down from a folder ' +
        '(the account root by default). Use to locate a contract before fetching, downloading ' +
        'or reading its attributes.\n\n' +
        'NOTE: this is a NAME search over the folder tree, not a full-text content search. ' +
        'CLM full-text search goes through the asynchronous documentsearchtasks endpoint, ' +
        'whose request-body schema Docusign does not publish -- reach it with clm_raw_request ' +
        'if you need content search.',
      inputSchema: {
        name_contains: z.string().describe('Substring to match against document names.'),
        folder_id: z
          .string()
          .optional()
          .describe('Folder to search from. Defaults to the account root.'),
        recursive: z.boolean().default(true).describe('Descend into sub-folders.'),
        max_folders: z
          .number()
          .int()
          .min(1)
          .max(300)
          .default(60)
          .describe('Cap on folders visited, so a big repository cannot run away.'),
        limit: z.number().int().min(1).max(200).default(50),
      },
    },
    guard(async (args) => {
      const start = args.folder_id ?? (await rootFolderId());
      if (!start) throw new Error('could not resolve a starting folder');

      const matches: Array<Record<string, unknown>> = [];
      const queue: string[] = [start];
      const seen = new Set<string>();
      let visited = 0;
      let truncated = false;

      while (queue.length && visited < args.max_folders && matches.length < args.limit) {
        const folderId = queue.shift()!;
        if (seen.has(folderId)) continue;
        seen.add(folderId);
        visited += 1;

        // Collection filtering is a documented Object API feature: filters do a
        // "contains" match by default, which is exactly the semantics we want.
        const docs = await clmRequest<ClmCollection>({
          method: 'GET',
          path: `/folders/${folderId}/documents`,
          query: {
            'pageSortParams.filter': `Name=${args.name_contains}`,
            'pageSortParams.limit': Math.min(100, args.limit - matches.length),
          },
        }).catch(() => ({ Items: [] }) as ClmCollection);

        for (const d of docs.Items ?? []) {
          matches.push({ id: idFromHref(d), folder_id: folderId, ...pick(d, DOC_KEYS) });
          if (matches.length >= args.limit) break;
        }

        if (args.recursive && visited < args.max_folders) {
          const kids = await clmRequest<ClmCollection>({
            method: 'GET',
            path: `/folders/${folderId}/folders`,
            query: { 'pageSortParams.limit': 100 },
          }).catch(() => ({ Items: [] }) as ClmCollection);
          for (const f of kids.Items ?? []) {
            const id = idFromHref(f);
            if (id && !seen.has(id)) queue.push(id);
          }
        }
      }
      if (queue.length || matches.length >= args.limit) truncated = true;

      return ok({
        name_contains: args.name_contains,
        folders_visited: visited,
        matched: matches.length,
        truncated,
        documents: matches,
      });
    }),
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
          .describe(
            'Comma-separated related data to inline. CLM expects capitalised names: ' +
              'AttributeGroups, Lock, Versions, ParentFolder, Path, HistoryItems.',
          ),
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
      title: 'Browse CLM folders',
      description:
        'Navigate the CLM filing structure. Give a folder_id to list its sub-folders, a path ' +
        'to resolve a folder by its full path, or a system_folder (root, home, "other sources", ' +
        'salesforce) to jump to a well-known starting point. With no arguments it resolves the ' +
        'account root, which is where you start when you do not yet know any folder ids.',
      inputSchema: {
        folder_id: z.string().optional(),
        path: z.string().optional().describe('Full folder path, e.g. "/Contracts/Acme".'),
        system_folder: z
          .enum(['root', 'home', 'other sources', 'salesforce'])
          .optional()
          .describe('Jump to a system folder.'),
        limit: z.number().int().min(1).max(200).default(50),
        verbose: z.boolean().default(false),
      },
    },
    guard(async (args) => {
      // Resolve which folder we are listing: an explicit id, a path, a system
      // folder, or (default) the account root.
      let folderId = args.folder_id;
      let folder: Record<string, unknown> | undefined;
      if (!folderId) {
        folder = args.path
          ? await clmRequest<Record<string, unknown>>({
              method: 'GET',
              path: '/folders/path',
              query: { path: args.path },
            })
          : await clmRequest<Record<string, unknown>>({
              method: 'GET',
              path: '/folders/type',
              query: { systemFolder: args.system_folder ?? 'root' },
            });
        // `expand=Folders` does NOT populate children on these lookups, so the
        // child listing is always a second call against the resolved id.
        folderId = idFromHref(folder);
        if (!folderId) return ok({ folder, child_folders: [], note: 'no folder id in Href' });
      }

      const res = await clmRequest<ClmCollection>({
        method: 'GET',
        path: `/folders/${folderId}/folders`,
        query: { 'pageSortParams.limit': args.limit },
      });
      const items = res.Items ?? [];
      return ok({
        folder: folder ? pick(folder, FOLDER_KEYS) : undefined,
        folder_id: folderId,
        total: res.Total ?? items.length,
        folders: items.map((f) => ({
          id: idFromHref(f),
          ...(args.verbose ? f : pick(f, FOLDER_KEYS)),
        })),
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
        query: { 'pageSortParams.limit': args.limit },
      });
      const items = res.Items ?? [];
      return ok({
        total: res.Total ?? items.length,
        documents: items.map((d) => ({ id: idFromHref(d), ...(args.verbose ? d : pick(d, DOC_KEYS)) })),
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
          query: { expand: 'AttributeGroups' },
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
    'clm_list_workflow_definitions',
    {
      title: 'List CLM workflow definitions',
      description:
        'List the CLM workflows available to start, with their names. clm_launch_workflow ' +
        'starts a workflow BY NAME, so call this first to get the exact name string.',
      inputSchema: { verbose: z.boolean().default(false) },
    },
    guard(async (args) => {
      const res = await clmRequest<ClmCollection>({
        method: 'GET',
        path: '/workflowdefinitions',
      });
      const items = res.Items ?? [];
      return ok({
        total: res.Total ?? items.length,
        workflows: args.verbose
          ? items
          : items.map((w) => ({ id: idFromHref(w), ...pick(w, ['Name', 'Href'] as const) })),
      });
    }),
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
