import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiRequest } from '../clients/base.js';
import { guard, ok, pick } from '../lib/respond.js';

const AGREEMENTS = '/v1/accounts/{accountId}/agreements';

/**
 * Navigator's query surface has an asymmetry worth knowing: FILTER params use the
 * nested snake_case path (`provisions.expiration_date`), but SORT takes the
 * top-level name (`expiration_date`). Sorting by `provisions.expiration_date`
 * returns a 400 listing the legal fields.
 * VERIFIED 2026-08-19 against a live demo account (live 400 response).
 */
const SORTABLE = [
  'expiration_date',
  'effective_date',
  'extraction_review_completed_at',
  'created_at',
] as const;

/** Statuses Navigator assigns to an agreement record. */
const STATUS = ['COMPLETE', 'PENDING', 'INACTIVE'] as const;

interface AgreementsResponse {
  data?: Array<Record<string, unknown>>;
  response_metadata?: Record<string, unknown>;
  _links?: { next?: { href?: string } };
}

const SUMMARY_KEYS = [
  'id',
  'title',
  'file_name',
  'type',
  'category',
  'status',
  'review_status',
  'document_id',
] as const;

/** Provisions an agent actually reasons about: dates, renewal, money, termination. */
const KEY_PROVISIONS = [
  'effective_date',
  'expiration_date',
  'execution_date',
  'term_length',
  'renewal_type',
  'renewal_notice_period',
  'renewal_notice_date',
  'auto_renewal_term_length',
  'total_agreement_value',
  'total_agreement_value_currency_code',
  'annual_agreement_value',
  'annual_agreement_value_currency_code',
  'liability_cap_fixed_amount',
  'liability_cap_currency_code',
  'payment_terms_due_date',
  'governing_law',
  'jurisdiction',
  'termination_period_for_convenience',
  'assignment_type',
] as const;

function compactAgreement(a: Record<string, unknown>) {
  const provisions = (a.provisions ?? {}) as Record<string, unknown>;
  const parties = (a.parties ?? []) as Array<Record<string, unknown>>;
  return {
    ...pick(a, SUMMARY_KEYS),
    parties: parties.map((p) => p.preferred_name ?? p.name_in_agreement),
    provisions: pick(provisions, KEY_PROVISIONS),
  };
}

/** Pulls pages until `max` records or the cursor runs out. */
async function fetchAgreements(
  query: Record<string, string | number | undefined>,
  max: number,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let ctoken: string | undefined;
  // Navigator caps a page at 50; loop the continuation token for larger asks.
  while (out.length < max) {
    const page: AgreementsResponse = await apiRequest('navigator', {
      method: 'GET',
      path: AGREEMENTS,
      query: { ...query, limit: Math.min(50, max - out.length), ctoken },
    });
    const batch = page.data ?? [];
    out.push(...batch);
    const next = page._links?.next?.href;
    if (!batch.length || !next) break;
    ctoken = new URL(next, 'https://api.docusign.com').searchParams.get('ctoken') ?? undefined;
    if (!ctoken) break;
  }
  return out.slice(0, max);
}

export function registerNavigatorTools(server: McpServer): void {
  server.registerTool(
    'nav_search_agreements',
    {
      title: 'Search Navigator agreements',
      description:
        'Search the Navigator agreement repository -- the system of record for executed ' +
        'agreements and their extracted terms. Use this for "what agreements do we have with ' +
        'X", "show me our MSAs", "which contracts are still pending review". Returns each ' +
        "agreement's key terms (dates, renewal, value, liability) rather than raw JSON. " +
        'For renewal/expiry questions prefer nav_expiring_agreements.',
      inputSchema: {
        party: z
          .string()
          .optional()
          .describe('Counterparty name as written in the agreement, e.g. "Acme Inc".'),
        agreement_type: z
          .string()
          .optional()
          .describe('Navigator type, e.g. Msa, Sow, Nda, Amendment. See nav_list_agreement_types.'),
        title: z.string().optional().describe('Match on agreement title.'),
        status: z.enum(STATUS).optional(),
        sort: z.enum(SORTABLE).optional().describe('Server-side sort field.'),
        direction: z.enum(['asc', 'desc']).default('desc'),
        limit: z.number().int().min(1).max(200).default(25),
        verbose: z.boolean().default(false).describe('Return raw agreement objects.'),
      },
    },
    guard(async (args) => {
      const agreements = await fetchAgreements(
        {
          'parties.name_in_agreement': args.party,
          type: args.agreement_type,
          title: args.title,
          status: args.status,
          sort: args.sort,
          direction: args.sort ? args.direction : undefined,
        },
        args.limit,
      );
      return ok({
        returned: agreements.length,
        agreements: args.verbose ? agreements : agreements.map(compactAgreement),
      });
    }),
  );

  server.registerTool(
    'nav_get_agreement',
    {
      title: 'Get one Navigator agreement',
      description:
        'Fetch a single agreement by its Navigator ID, including every extracted provision, ' +
        'all parties, custom provisions and source metadata. Use after nav_search_agreements ' +
        'when you need the full picture of one contract.',
      inputSchema: {
        agreement_id: z.string().describe('Navigator agreement id (a UUID).'),
        verbose: z
          .boolean()
          .default(true)
          .describe('Full record (default). Set false for just the key commercial terms.'),
      },
    },
    guard(async (args) => {
      const a = await apiRequest<Record<string, unknown>>('navigator', {
        method: 'GET',
        path: `${AGREEMENTS}/${args.agreement_id}`,
      });
      return ok(args.verbose ? a : compactAgreement(a));
    }),
  );

  server.registerTool(
    'nav_list_agreement_types',
    {
      title: 'List agreement types and categories',
      description:
        'Show which agreement types (Msa, Sow, Nda, Amendment, ...) and categories exist on ' +
        'this account, with a count of each. Navigator has no endpoint for this -- the counts ' +
        'are aggregated over agreements -- so treat them as a sample of the most recent ' +
        '`scan_limit` agreements, not an account-wide census. Call this first when you need ' +
        'the exact type string for nav_search_agreements.',
      inputSchema: {
        scan_limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(200)
          .describe('How many agreements to aggregate over.'),
      },
    },
    guard(async (args) => {
      const agreements = await fetchAgreements({}, args.scan_limit);
      const tally = (key: string) => {
        const counts = new Map<string, number>();
        for (const a of agreements) {
          const v = String(a[key] ?? '(none)');
          counts.set(v, (counts.get(v) ?? 0) + 1);
        }
        return Object.fromEntries([...counts].sort((x, y) => y[1] - x[1]));
      };
      return ok({
        scanned: agreements.length,
        note: 'Counts are over the scanned sample, not the whole account.',
        types: tally('type'),
        categories: tally('category'),
      });
    }),
  );

  server.registerTool(
    'nav_expiring_agreements',
    {
      title: 'Find agreements expiring or renewing soon',
      description:
        'The renewal-management tool: list agreements whose expiration date falls within the ' +
        'next N days, soonest first, with their renewal terms (auto-renew or not, notice ' +
        'period, notice date). Use for "what is up for renewal", "what expires this quarter", ' +
        '"which contracts auto-renew if we do nothing". Set include_expired to also report ' +
        'agreements already past their expiration date.',
      inputSchema: {
        within_days: z
          .number()
          .int()
          .min(1)
          .max(3650)
          .default(90)
          .describe('Window from today, in days.'),
        include_expired: z.boolean().default(false),
        auto_renew_only: z
          .boolean()
          .default(false)
          .describe('Only agreements that auto-renew -- the ones that bite if missed.'),
        max_scan: z
          .number()
          .int()
          .min(50)
          .max(2000)
          .default(1000)
          .describe('Safety cap on how many agreements to walk through.'),
      },
    },
    guard(async (args) => {
      const now = Date.now();
      const horizon = now + args.within_days * 86_400_000;

      /*
       * Walk the repository sorted by expiration date ascending and stop at the
       * horizon.
       *
       * The subtlety that makes this necessary: ascending order puts LONG-EXPIRED
       * agreements first (this account has 118 of them, back to 2015), so simply
       * taking the first N records and filtering returns nothing at all. We must
       * page past the expired prefix. Because the list is sorted, we can stop the
       * moment a record's expiration passes the horizon -- everything after it is
       * further out still.
       */
      const matched: Array<Record<string, unknown>> = [];
      let scanned = 0;
      let expiredSkipped = 0;
      let ctoken: string | undefined;
      let reachedHorizon = false;

      while (scanned < args.max_scan && !reachedHorizon) {
        const page: AgreementsResponse = await apiRequest('navigator', {
          method: 'GET',
          path: AGREEMENTS,
          query: {
            limit: Math.min(50, args.max_scan - scanned),
            sort: 'expiration_date',
            direction: 'asc',
            ctoken,
          },
        });
        const batch = page.data ?? [];
        scanned += batch.length;

        for (const a of batch) {
          const p = (a.provisions ?? {}) as Record<string, unknown>;
          const raw = p.expiration_date as string | undefined;
          if (!raw) continue;
          const expiresAt = Date.parse(raw);
          if (Number.isNaN(expiresAt)) continue;

          if (expiresAt > horizon) {
            reachedHorizon = true;
            break;
          }
          if (expiresAt < now && !args.include_expired) {
            expiredSkipped += 1;
            continue;
          }
          if (args.auto_renew_only && String(p.renewal_type ?? '') !== 'AUTO_RENEW') continue;

          matched.push({
            ...pick(a, ['id', 'title', 'type', 'status'] as const),
            parties: ((a.parties ?? []) as Array<Record<string, unknown>>).map(
              (x) => x.preferred_name ?? x.name_in_agreement,
            ),
            expiration_date: raw,
            days_until_expiry: Math.round((expiresAt - now) / 86_400_000),
            renewal: pick(p, [
              'renewal_type',
              'renewal_notice_period',
              'renewal_notice_date',
              'auto_renewal_term_length',
            ] as const),
          });
        }

        const next = page._links?.next?.href;
        if (!batch.length || !next) break;
        ctoken = new URL(next, 'https://api.docusign.com').searchParams.get('ctoken') ?? undefined;
        if (!ctoken) break;
      }

      return ok({
        window_days: args.within_days,
        matched: matched.length,
        scanned,
        already_expired_skipped: expiredSkipped,
        complete: reachedHorizon || scanned < args.max_scan,
        agreements: matched,
      });
    }),
  );

  server.registerTool(
    'nav_agreement_summary',
    {
      title: 'Summarize one agreement',
      description:
        "Condense a single agreement to the terms a business reader cares about: parties, " +
        'dates, renewal posture, value, liability cap, payment terms and governing law. ' +
        'Use when asked to "summarize" or "give me the key terms of" a contract.',
      inputSchema: { agreement_id: z.string() },
    },
    guard(async (args) => {
      const a = await apiRequest<Record<string, unknown>>('navigator', {
        method: 'GET',
        path: `${AGREEMENTS}/${args.agreement_id}`,
      });
      const p = (a.provisions ?? {}) as Record<string, unknown>;
      return ok({
        ...pick(a, ['id', 'title', 'type', 'category', 'status'] as const),
        summary: a.summary,
        parties: ((a.parties ?? []) as Array<Record<string, unknown>>).map((x) =>
          pick(x, ['name_in_agreement', 'preferred_name'] as const),
        ),
        term: pick(p, [
          'effective_date',
          'expiration_date',
          'execution_date',
          'term_length',
        ] as const),
        renewal: pick(p, [
          'renewal_type',
          'renewal_notice_period',
          'renewal_notice_date',
          'auto_renewal_term_length',
        ] as const),
        commercial: pick(p, [
          'total_agreement_value',
          'total_agreement_value_currency_code',
          'annual_agreement_value',
          'liability_cap_fixed_amount',
          'liability_cap_currency_code',
          'payment_terms_due_date',
        ] as const),
        legal: pick(p, [
          'governing_law',
          'jurisdiction',
          'assignment_type',
          'termination_period_for_convenience',
        ] as const),
        custom_provisions: a.custom_provisions,
      });
    }),
  );
}
