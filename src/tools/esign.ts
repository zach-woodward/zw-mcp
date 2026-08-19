import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiRequest } from '../clients/base.js';
import { getAccount } from '../auth/jwt.js';
import { guard, ok, pick, saveDownload } from '../lib/respond.js';

const ACCT = '/v2.1/accounts/{accountId}';

const ENVELOPE_STATUS = [
  'created',
  'sent',
  'delivered',
  'signed',
  'completed',
  'declined',
  'voided',
] as const;

/** Compact envelope projection -- the fields an agent reasons over. */
const ENVELOPE_KEYS = [
  'envelopeId',
  'status',
  'emailSubject',
  'sentDateTime',
  'completedDateTime',
  'statusChangedDateTime',
  'createdDateTime',
  'expireDateTime',
  'voidedReason',
] as const;

const RECIPIENT_KEYS = [
  'recipientId',
  'name',
  'email',
  'roleName',
  'status',
  'routingOrder',
  'recipientType',
  'signedDateTime',
  'deliveredDateTime',
  'declinedReason',
  'clientUserId',
] as const;

interface EnvelopeList {
  envelopes?: Array<Record<string, unknown>>;
  resultSetSize?: string;
  totalSetSize?: string;
  nextUri?: string;
}

interface RecipientsResponse {
  signers?: Array<Record<string, unknown>>;
  carbonCopies?: Array<Record<string, unknown>>;
  agents?: Array<Record<string, unknown>>;
  certifiedDeliveries?: Array<Record<string, unknown>>;
  inPersonSigners?: Array<Record<string, unknown>>;
  editors?: Array<Record<string, unknown>>;
  intermediaries?: Array<Record<string, unknown>>;
  recipientCount?: string;
}

/** Flattens DocuSign's per-type recipient buckets into one labelled list. */
function flattenRecipients(r: RecipientsResponse) {
  const buckets: Array<[string, Array<Record<string, unknown>> | undefined]> = [
    ['signer', r.signers],
    ['carbonCopy', r.carbonCopies],
    ['agent', r.agents],
    ['certifiedDelivery', r.certifiedDeliveries],
    ['inPersonSigner', r.inPersonSigners],
    ['editor', r.editors],
    ['intermediary', r.intermediaries],
  ];
  return buckets.flatMap(([type, list]) =>
    (list ?? []).map((rec) => ({ recipientType: type, ...pick(rec, RECIPIENT_KEYS) })),
  );
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

export function registerEsignTools(server: McpServer): void {
  server.registerTool(
    'esign_list_envelopes',
    {
      title: 'List / search envelopes',
      description:
        'Search envelopes in the DocuSign eSignature account. Use this to answer ' +
        '"what did I send", "what is still out for signature", "what completed this week". ' +
        'Returns a compact list of envelopeId, status, subject and key timestamps -- pass ' +
        'verbose:true only when you need the full raw envelope objects. Defaults to the ' +
        'last 30 days; widen with from_days or narrow with status.',
      inputSchema: {
        from_days: z
          .number()
          .int()
          .min(1)
          .max(3650)
          .default(30)
          .describe('Look back this many days from now.'),
        status: z
          .array(z.enum(ENVELOPE_STATUS))
          .optional()
          .describe('Filter to these envelope statuses. Omit for all.'),
        search_text: z
          .string()
          .optional()
          .describe('Free-text match on subject, sender or recipient name/email.'),
        count: z.number().int().min(1).max(100).default(25).describe('Max envelopes to return.'),
        include_recipients: z
          .boolean()
          .default(false)
          .describe('Also return each envelope\'s recipients (costs more tokens).'),
        verbose: z.boolean().default(false).describe('Return raw DocuSign objects, untrimmed.'),
      },
    },
    guard(async (args) => {
      const include = args.include_recipients ? 'recipients' : undefined;
      const data = await apiRequest<EnvelopeList>('esign', {
        method: 'GET',
        path: `${ACCT}/envelopes`,
        query: {
          from_date: daysAgoIso(args.from_days),
          status: args.status?.join(','),
          search_text: args.search_text,
          count: args.count,
          order_by: 'last_modified',
          order: 'desc',
          include,
        },
      });
      const envelopes = data.envelopes ?? [];
      if (args.verbose) return ok({ total: data.totalSetSize, envelopes });
      return ok({
        returned: envelopes.length,
        totalMatching: data.totalSetSize,
        envelopes: envelopes.map((e) => ({
          ...pick(e, ENVELOPE_KEYS),
          ...(args.include_recipients
            ? { recipients: flattenRecipients((e.recipients ?? {}) as RecipientsResponse) }
            : {}),
        })),
      });
    }),
  );

  server.registerTool(
    'esign_get_envelope',
    {
      title: 'Get one envelope',
      description:
        'Fetch a single envelope by ID, optionally with its recipients and document list. ' +
        'Use after esign_list_envelopes when you need detail on one agreement -- who still ' +
        'has to sign, when it was sent, what documents it carries.',
      inputSchema: {
        envelope_id: z.string().describe('The envelopeId GUID.'),
        include_recipients: z.boolean().default(true),
        include_documents: z.boolean().default(true),
        verbose: z.boolean().default(false),
      },
    },
    guard(async (args) => {
      const envelope = await apiRequest<Record<string, unknown>>('esign', {
        method: 'GET',
        path: `${ACCT}/envelopes/${args.envelope_id}`,
      });
      const out: Record<string, unknown> = args.verbose
        ? envelope
        : pick(envelope, ENVELOPE_KEYS);

      if (args.include_recipients) {
        const r = await apiRequest<RecipientsResponse>('esign', {
          method: 'GET',
          path: `${ACCT}/envelopes/${args.envelope_id}/recipients`,
        });
        out.recipients = args.verbose ? r : flattenRecipients(r);
      }
      if (args.include_documents) {
        const d = await apiRequest<{ envelopeDocuments?: Array<Record<string, unknown>> }>(
          'esign',
          { method: 'GET', path: `${ACCT}/envelopes/${args.envelope_id}/documents` },
        );
        out.documents = (d.envelopeDocuments ?? []).map((doc) =>
          args.verbose ? doc : pick(doc, ['documentId', 'name', 'type', 'order', 'pages'] as const),
        );
      }
      return ok(out);
    }),
  );

  server.registerTool(
    'esign_list_recipients',
    {
      title: 'List envelope recipients',
      description:
        'List every recipient on an envelope with their signing status, routing order and ' +
        'timestamps. Use to answer "who has not signed yet".',
      inputSchema: {
        envelope_id: z.string(),
        verbose: z.boolean().default(false),
      },
    },
    guard(async (args) => {
      const r = await apiRequest<RecipientsResponse>('esign', {
        method: 'GET',
        path: `${ACCT}/envelopes/${args.envelope_id}/recipients`,
      });
      return ok(args.verbose ? r : { recipients: flattenRecipients(r) });
    }),
  );

  server.registerTool(
    'esign_download_document',
    {
      title: 'Download an envelope document',
      description:
        'Download a document from an envelope and save it to the server\'s downloads ' +
        'directory, returning the file path (never base64 -- signed PDFs are far too large ' +
        'for a model context). document_id accepts a numeric ID from esign_get_envelope, or ' +
        'the special values "combined" (all documents as one PDF), "archive" (a .zip), or ' +
        '"certificate" (the certificate of completion).',
      inputSchema: {
        envelope_id: z.string(),
        document_id: z
          .string()
          .default('combined')
          .describe('Numeric document ID, or combined | archive | certificate.'),
        filename: z.string().optional().describe('Override the saved filename.'),
      },
    },
    guard(async (args) => {
      const isZip = args.document_id === 'archive';
      const buf = await apiRequest<Buffer>('esign', {
        method: 'GET',
        path: `${ACCT}/envelopes/${args.envelope_id}/documents/${args.document_id}`,
        raw: true,
        accept: isZip ? 'application/zip' : 'application/pdf',
      });
      const name =
        args.filename ??
        `${args.envelope_id}-${args.document_id}.${isZip ? 'zip' : 'pdf'}`;
      const saved = saveDownload(name, buf);
      return ok({ path: saved, bytes: buf.length });
    }),
  );

  server.registerTool(
    'esign_list_templates',
    {
      title: 'List templates',
      description:
        'List eSignature templates available on the account, with their template IDs and ' +
        'role names. Call this before esign_create_envelope_from_template so you send the ' +
        'right template and address the right roles.',
      inputSchema: {
        search_text: z.string().optional(),
        count: z.number().int().min(1).max(100).default(25),
        verbose: z.boolean().default(false),
      },
    },
    guard(async (args) => {
      const data = await apiRequest<{
        envelopeTemplates?: Array<Record<string, unknown>>;
        totalSetSize?: string;
      }>('esign', {
        method: 'GET',
        path: `${ACCT}/templates`,
        query: { search_text: args.search_text, count: args.count, order_by: 'used' },
      });
      const templates = data.envelopeTemplates ?? [];
      if (args.verbose) return ok(data);
      return ok({
        total: data.totalSetSize,
        templates: templates.map((t) => ({
          ...pick(t, ['templateId', 'name', 'description', 'shared', 'lastModified'] as const),
          roles: ((t.recipients as RecipientsResponse | undefined)?.signers ?? []).map((s) =>
            pick(s, ['roleName', 'recipientId', 'routingOrder'] as const),
          ),
        })),
      });
    }),
  );

  server.registerTool(
    'esign_get_template',
    {
      title: 'Get one template',
      description:
        'Fetch a template definition by ID, including its roles and documents. Use when you ' +
        'need the exact roleName strings to fill in for esign_create_envelope_from_template.',
      inputSchema: { template_id: z.string(), verbose: z.boolean().default(false) },
    },
    guard(async (args) => {
      const t = await apiRequest<Record<string, unknown>>('esign', {
        method: 'GET',
        path: `${ACCT}/templates/${args.template_id}`,
      });
      if (args.verbose) return ok(t);
      return ok({
        ...pick(t, ['templateId', 'name', 'description', 'emailSubject', 'shared'] as const),
        roles: flattenRecipients((t.recipients ?? {}) as RecipientsResponse),
        documents: ((t.documents as Array<Record<string, unknown>>) ?? []).map((d) =>
          pick(d, ['documentId', 'name', 'order'] as const),
        ),
      });
    }),
  );

  server.registerTool(
    'esign_create_envelope_from_template',
    {
      title: 'Create/send an envelope from a template',
      description:
        'Create an envelope from an existing template and fill its roles with real people. ' +
        'This is the main "send an agreement" tool. Set status to "sent" to send immediately ' +
        'or "created" to leave it as a draft. Give a recipient a client_user_id to make them ' +
        'an embedded signer, then get their signing URL from esign_recipient_view.',
      inputSchema: {
        template_id: z.string(),
        roles: z
          .array(
            z.object({
              role_name: z.string().describe('Must match a roleName on the template.'),
              name: z.string(),
              email: z.string().email(),
              client_user_id: z
                .string()
                .optional()
                .describe('Set to make this recipient an embedded (in-app) signer.'),
            }),
          )
          .min(1),
        email_subject: z.string().optional(),
        email_blurb: z.string().optional(),
        status: z.enum(['sent', 'created']).default('sent'),
      },
    },
    guard(async (args) => {
      const res = await apiRequest<Record<string, unknown>>('esign', {
        method: 'POST',
        path: `${ACCT}/envelopes`,
        body: {
          templateId: args.template_id,
          status: args.status,
          ...(args.email_subject ? { emailSubject: args.email_subject } : {}),
          ...(args.email_blurb ? { emailBlurb: args.email_blurb } : {}),
          templateRoles: args.roles.map((r) => ({
            roleName: r.role_name,
            name: r.name,
            email: r.email,
            ...(r.client_user_id ? { clientUserId: r.client_user_id } : {}),
          })),
        },
      });
      return ok(pick(res, ['envelopeId', 'status', 'statusDateTime', 'uri'] as const));
    }),
  );

  server.registerTool(
    'esign_create_envelope',
    {
      title: 'Create/send an envelope from raw documents',
      description:
        'Create an envelope from documents you supply, without a template. Each document is ' +
        'given either as a local file path on the server or as base64. Signature placement ' +
        'uses anchor strings (anchor_string finds that text in the document and drops the tab ' +
        'there); omit anchors to place a signature at a fixed position on page 1. Prefer ' +
        'esign_create_envelope_from_template when a suitable template exists.',
      inputSchema: {
        email_subject: z.string(),
        email_blurb: z.string().optional(),
        status: z.enum(['sent', 'created']).default('sent'),
        documents: z
          .array(
            z.object({
              name: z.string(),
              file_path: z.string().optional().describe('Absolute path to a file on this server.'),
              base64: z.string().optional().describe('Base64 document content.'),
              file_extension: z.string().default('pdf'),
            }),
          )
          .min(1),
        signers: z
          .array(
            z.object({
              name: z.string(),
              email: z.string().email(),
              routing_order: z.number().int().min(1).default(1),
              client_user_id: z.string().optional(),
              anchor_string: z
                .string()
                .optional()
                .describe('Text in the document to anchor the signature tab to.'),
            }),
          )
          .min(1),
        carbon_copies: z
          .array(z.object({ name: z.string(), email: z.string().email() }))
          .optional(),
      },
    },
    guard(async (args) => {
      const documents = args.documents.map((d, i) => {
        let content = d.base64;
        if (!content) {
          if (!d.file_path) {
            throw new Error(`document "${d.name}" needs either file_path or base64`);
          }
          const abs = path.resolve(d.file_path);
          if (!fs.existsSync(abs)) throw new Error(`file not found: ${abs}`);
          content = fs.readFileSync(abs).toString('base64');
        }
        return {
          documentId: String(i + 1),
          name: d.name,
          fileExtension: d.file_extension,
          documentBase64: content,
        };
      });

      const signers = args.signers.map((s, i) => ({
        recipientId: String(i + 1),
        name: s.name,
        email: s.email,
        routingOrder: String(s.routing_order),
        ...(s.client_user_id ? { clientUserId: s.client_user_id } : {}),
        tabs: {
          signHereTabs: [
            s.anchor_string
              ? { anchorString: s.anchor_string, anchorUnits: 'pixels', anchorXOffset: '0', anchorYOffset: '0' }
              : { documentId: '1', pageNumber: '1', xPosition: '100', yPosition: '600' },
          ],
        },
      }));

      const res = await apiRequest<Record<string, unknown>>('esign', {
        method: 'POST',
        path: `${ACCT}/envelopes`,
        body: {
          emailSubject: args.email_subject,
          ...(args.email_blurb ? { emailBlurb: args.email_blurb } : {}),
          status: args.status,
          documents,
          recipients: {
            signers,
            ...(args.carbon_copies?.length
              ? {
                  carbonCopies: args.carbon_copies.map((c, i) => ({
                    recipientId: String(signers.length + i + 1),
                    name: c.name,
                    email: c.email,
                    routingOrder: String(signers.length + i + 1),
                  })),
                }
              : {}),
          },
        },
      });
      return ok(pick(res, ['envelopeId', 'status', 'statusDateTime', 'uri'] as const));
    }),
  );

  server.registerTool(
    'esign_send_reminder',
    {
      title: 'Send a reminder (resend) for an envelope',
      description:
        'Nudge the outstanding recipients of a sent envelope by resending the signing ' +
        'notification email. Only affects recipients who have not yet completed.',
      inputSchema: { envelope_id: z.string() },
    },
    guard(async (args) => {
      const res = await apiRequest<Record<string, unknown>>('esign', {
        method: 'PUT',
        path: `${ACCT}/envelopes/${args.envelope_id}`,
        query: { resend_envelope: true },
        body: {},
      });
      return ok({ envelopeId: args.envelope_id, resent: true, response: res });
    }),
  );

  server.registerTool(
    'esign_void_envelope',
    {
      title: 'Void an envelope',
      description:
        'Void a sent envelope so it can no longer be signed. This is irreversible and the ' +
        'reason is shown to recipients -- confirm with the user before calling it.',
      inputSchema: {
        envelope_id: z.string(),
        reason: z.string().min(1).describe('Shown to recipients. Required by DocuSign.'),
      },
    },
    guard(async (args) => {
      await apiRequest('esign', {
        method: 'PUT',
        path: `${ACCT}/envelopes/${args.envelope_id}`,
        body: { status: 'voided', voidedReason: args.reason },
      });
      return ok({ envelopeId: args.envelope_id, status: 'voided', reason: args.reason });
    }),
  );

  server.registerTool(
    'esign_recipient_view',
    {
      title: 'Get an embedded signing URL',
      description:
        'Mint a one-time embedded signing URL for a recipient, for opening in an iframe or ' +
        'browser inside a host app. The recipient must have been added with a client_user_id ' +
        'and the same value must be passed here. URLs expire in ~5 minutes and are single-use.',
      inputSchema: {
        envelope_id: z.string(),
        name: z.string(),
        email: z.string().email(),
        client_user_id: z.string().describe('Must match the value used when adding the recipient.'),
        return_url: z
          .string()
          .url()
          .default('https://www.docusign.com')
          .describe('Where the signer lands after finishing.'),
      },
    },
    guard(async (args) => {
      const res = await apiRequest<{ url?: string }>('esign', {
        method: 'POST',
        path: `${ACCT}/envelopes/${args.envelope_id}/views/recipient`,
        body: {
          returnUrl: args.return_url,
          authenticationMethod: 'none',
          userName: args.name,
          email: args.email,
          clientUserId: args.client_user_id,
        },
      });
      return ok({ url: res.url, expiresInSeconds: 300 });
    }),
  );

  server.registerTool(
    'esign_sender_view',
    {
      title: 'Get an embedded sending URL',
      description:
        'Mint an embedded sending (tagging) URL for a draft envelope, so a user can review, ' +
        'tag and send it from inside a host app. The envelope must be in "created" (draft) status.',
      inputSchema: {
        envelope_id: z.string(),
        return_url: z.string().url().default('https://www.docusign.com'),
      },
    },
    guard(async (args) => {
      const res = await apiRequest<{ url?: string }>('esign', {
        method: 'POST',
        path: `${ACCT}/envelopes/${args.envelope_id}/views/sender`,
        body: { returnUrl: args.return_url },
      });
      return ok({ url: res.url, expiresInSeconds: 300 });
    }),
  );

  server.registerTool(
    'esign_account_info',
    {
      title: 'Get the active DocuSign account',
      description:
        'Return the account this server is operating against: account ID, name, environment ' +
        'and eSignature base URI. Useful to confirm which demo account is live before a demo.',
      inputSchema: {},
    },
    guard(async () => {
      const account = await getAccount();
      const info = await apiRequest<Record<string, unknown>>('esign', {
        method: 'GET',
        path: ACCT,
      });
      return ok({
        ...account,
        ...pick(info, ['accountName', 'planName', 'suspensionStatus', 'connectPermission'] as const),
      });
    }),
  );
}
