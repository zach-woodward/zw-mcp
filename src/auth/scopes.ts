/**
 * OAuth scope sets per DocuSign product API.
 *
 * A JWT consent grant is all-or-nothing: one scope the integration key is not
 * entitled to fails the whole consent URL. So scopes are grouped per product and
 * the union is built from the enabled-product list (DS_PRODUCTS), letting a demo
 * account that lacks, say, Rooms still consent for everything else.
 *
 * All strings below are quoted verbatim from the docs -- see specs/BASE_PATHS.md
 * for the full table and the verification stamps.
 * VERIFIED 2026-08-19 https://developers.docusign.com/platform/auth/reference/scopes/
 */

/** `impersonation` is mandatory for JWT user impersonation regardless of product. */
export const BASE_SCOPES = ['signature', 'impersonation'] as const;

export const PRODUCT_SCOPES: Record<string, string[]> = {
  esign: ['signature'],

  // `models_read` is deliberately NOT here. The docs recommend requesting it for
  // forward-compatibility, but it is not required by any Navigator endpoint today
  // and the Woodward Systems demo account cannot consent to it -- and because a
  // grant is all-or-nothing, including it made every Navigator call fail with
  // consent_required. Add it back only once an account proves it is grantable
  // (`npm run scopecheck` reports per-scope grantability).
  // VERIFIED 2026-08-19 scopecheck against demo account b99e0abc-…
  navigator: ['adm_store_unified_repo_read'],

  // `content` is deliberately omitted. The scopes reference lists it under the CLM
  // API ("read and write access to CLM document content"), but it is inert: a
  // consent grant covering it returns a token WITHOUT it (29 requested, 28
  // granted), and CLM document download works fine without it. Requesting it only
  // makes the granted-scope list look wrong.
  // VERIFIED 2026-08-19 against demo account b99e0abc-… (grant diff + live download).
  clm: ['spring_read', 'spring_write'],

  // VERIFIED 2026-08-19 https://developers.docusign.com/docs/maestro-api/how-to/trigger-workflow/
  maestro: ['aow_manage'],

  webforms: ['webforms_read', 'webforms_instance_read', 'webforms_instance_write'],

  rooms: [
    'dtr.rooms.read',
    'dtr.rooms.write',
    'dtr.documents.read',
    'dtr.documents.write',
    'dtr.profile.read',
    'dtr.company.read',
    'room_forms',
  ],

  click: ['click.manage', 'click.send'],

  admin: [
    'organization_read',
    'account_read',
    'user_read',
    'user_write',
    'group_read',
    'permission_read',
    'domain_read',
    'identity_provider_read',
  ],

  // UNVERIFIED: the scopes reference lists no Monitor-specific scope. Monitor is
  // assumed to ride on `signature` plus org access on the account. Confirm in Phase 3.
  monitor: ['signature'],

  notary: ['notary_read', 'notary_write'],

  // VERIFIED 2026-08-19 https://developers.docusign.com/docs/connected-fields-api/auth/
  // Connected Fields needs the Navigator repo scope *in addition to* `signature`.
  connectedfields: ['adm_store_unified_repo_read', 'signature'],

  // Workspaces shares the Rooms `dtr.*` scopes per the scopes reference
  // ("Rooms API and Workspaces API").
  workspaces: ['dtr.rooms.read', 'dtr.rooms.write', 'dtr.documents.write'],

  // UNVERIFIED: Trust Records appears in neither the scopes reference nor the
  // base-path table. Confirm in Phase 3 before enabling.
  trustrecords: ['signature'],
};

export const ALL_PRODUCTS = Object.keys(PRODUCT_SCOPES);

/** Union of base scopes plus every enabled product's scopes, deduped + sorted. */
export function scopesFor(products: readonly string[]): string[] {
  const set = new Set<string>(BASE_SCOPES);
  for (const p of products) {
    for (const s of PRODUCT_SCOPES[p] ?? []) set.add(s);
  }
  return [...set].sort();
}
