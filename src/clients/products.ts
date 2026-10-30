import type { AccountInfo } from '../auth/jwt.js';

/**
 * Registry of every DocuSign product API: how to build its base URI, what a
 * caller's path looks like underneath it, and how trustworthy our knowledge is.
 *
 * Base URIs are transcribed from the official endpoint table -- see
 * specs/BASE_PATHS.md, which carries the VERIFIED stamps. Production hosts for
 * eSignature and Click are account-specific ({server}.docusign.net), so those
 * derive from the `base_uri` that /oauth/userinfo returns rather than being
 * hardcoded; that is what makes the demo/prod flip a single env var.
 */
export type ProductId =
  | 'esign'
  | 'navigator'
  | 'clm'
  | 'maestro'
  | 'webforms'
  | 'rooms'
  | 'click'
  | 'admin'
  | 'monitor'
  | 'notary'
  | 'connectedfields'
  | 'workspaces'
  | 'trustrecords'
  | 'agreementdesk';

export type SpecSource = 'openapi' | 'hand-built' | 'unverified';
export type ProductStatus = 'ga' | 'beta' | 'unverified';

export interface ProductSpec {
  id: ProductId;
  label: string;
  /**
   * Tool-name prefix. Usually the product id, but a few read better shortened
   * (`nav_search_agreements`, not `navigator_search_agreements`).
   */
  toolPrefix: string;
  /** Base URI with no trailing slash. `account` comes from /oauth/userinfo. */
  baseUri: (env: 'demo' | 'prod', account: AccountInfo) => string;
  /** Shape of a path underneath the base URI, for tool descriptions. */
  pathHint: string;
  status: ProductStatus;
  specSource: SpecSource;
  docsUrl: string;
  /**
   * A cheap, read-only request that proves whether this account can actually
   * reach the product. Presence in this registry says only that the API exists;
   * it says nothing about entitlement, which is a per-account question and the
   * thing people actually need to know. Omit for products with no safe cheap
   * read, and they will report as unprobed rather than as working.
   */
  probe?: { path: string; query?: Record<string, string | number> };
}

/** api.docusign.com hosts the newer "IAM" APIs: Navigator, Maestro, Workspaces, Connected Fields. */
const iamHost = (env: 'demo' | 'prod') =>
  env === 'prod' ? 'https://api.docusign.com' : 'https://api-d.docusign.com';

export const PRODUCTS: Record<ProductId, ProductSpec> = {
  esign: {
    id: 'esign',
    toolPrefix: 'esign',
    label: 'eSignature REST API v2.1',
    // account.baseUri is e.g. https://demo.docusign.net (demo) or
    // https://na4.docusign.net (prod) -- never hardcode the data center.
    baseUri: (_env, account) => `${account.baseUri}/restapi`,
    pathHint: '/v2.1/accounts/{accountId}/envelopes',
    status: 'ga',
    specSource: 'openapi',
    docsUrl: 'https://developers.docusign.com/docs/esign-rest-api/',
    probe: { path: '/v2.1/accounts/{accountId}' },
  },
  navigator: {
    id: 'navigator',
    toolPrefix: 'nav',
    label: 'Navigator API',
    baseUri: (env) => iamHost(env),
    pathHint: '/v1/accounts/{accountId}/agreements',
    status: 'beta',
    specSource: 'openapi',
    docsUrl: 'https://developers.docusign.com/docs/navigator-api/',
    probe: { path: '/v1/accounts/{accountId}/agreements', query: { limit: 1 } },
  },
  clm: {
    id: 'clm',
    toolPrefix: 'clm',
    label: 'CLM API',
    // CLM (SpringCM) lives on a per-account host discovered at runtime -- this
    // value is only a fallback for display; src/clients/clm.ts does the real
    // discovery and owns every CLM request.
    baseUri: (env) =>
      env === 'prod' ? 'https://api-na11.springcm.com' : 'https://apiuatna11.springcm.com',
    pathHint: '/v2/{accountId}/documents',
    status: 'ga',
    specSource: 'hand-built',
    docsUrl: 'https://developers.docusign.com/docs/clm-api/',
  },
  maestro: {
    id: 'maestro',
    toolPrefix: 'maestro',
    // The brief asked whether "Workflow Builder" is a distinct API. It is not:
    // workflowbuilder.rest.swagger-1.0.0.json declares the same 8 paths on the
    // same servers as maestro.rest.swagger-v1.0.0.json -- it is Maestro renamed.
    // VERIFIED 2026-08-19 by diffing the two vendored specs.
    label: 'Maestro API (a.k.a. Workflow Builder)',
    baseUri: (env) => iamHost(env),
    pathHint: '/v1/accounts/{accountId}/workflows',
    status: 'beta',
    specSource: 'openapi',
    docsUrl: 'https://developers.docusign.com/docs/maestro-api/',
    probe: { path: '/v1/accounts/{accountId}/workflows' },
  },
  webforms: {
    id: 'webforms',
    toolPrefix: 'webforms',
    label: 'Web Forms API',
    baseUri: (env) =>
      env === 'prod'
        ? 'https://apps.docusign.com/api/webforms'
        : 'https://apps-d.docusign.com/api/webforms',
    pathHint: '/v1.1/accounts/{accountId}/forms',
    status: 'ga',
    specSource: 'openapi',
    docsUrl: 'https://developers.docusign.com/docs/web-forms-api/',
    probe: { path: '/v1.1/accounts/{accountId}/forms', query: { limit: 1 } },
  },
  rooms: {
    id: 'rooms',
    toolPrefix: 'rooms',
    label: 'Rooms API v2',
    baseUri: (env) =>
      env === 'prod'
        ? 'https://rooms.docusign.com/restapi'
        : 'https://demo.rooms.docusign.com/restapi',
    pathHint: '/v2/accounts/{accountId}/rooms',
    status: 'ga',
    specSource: 'openapi',
    docsUrl: 'https://developers.docusign.com/docs/rooms-api/',
    probe: { path: '/v2/accounts/{accountId}/rooms', query: { count: 1 } },
  },
  click: {
    id: 'click',
    toolPrefix: 'click',
    label: 'Click API',
    // The docs base-path table lists Click under /restapi, but the vendored spec's
    // own basePath is /clickapi and its paths are /v1/accounts/... -- the spec wins.
    // VERIFIED 2026-08-19 specs/click.rest.swagger-v2.json (host+basePath)
    baseUri: (_env, account) => `${account.baseUri}/clickapi`,
    pathHint: '/v1/accounts/{accountId}/clickwraps',
    status: 'ga',
    specSource: 'openapi',
    docsUrl: 'https://developers.docusign.com/docs/click-api/',
    probe: { path: '/v1/accounts/{accountId}/clickwraps' },
  },
  admin: {
    id: 'admin',
    toolPrefix: 'admin',
    label: 'Admin API',
    baseUri: (env) =>
      env === 'prod'
        ? 'https://api.docusign.net/management'
        : 'https://api-d.docusign.net/management',
    pathHint: '/v2/organizations/{organizationId}/users',
    status: 'ga',
    specSource: 'openapi',
    docsUrl: 'https://developers.docusign.com/docs/admin-api/',
    probe: { path: '/v2/organizations' },
  },
  monitor: {
    id: 'monitor',
    toolPrefix: 'monitor',
    label: 'Monitor API',
    // The docs base-path table and the vendored spec disagree. Settled by live
    // probe on 2026-08-19: the spec's host+path is the live one.
    //   api-d.docusign.com/v1/organizations/{orgId}/stream
    //     -> 403 {"error":"Organization does not have Monitor entitlement"}
    //        (routed correctly, evaluated entitlement -- this is the real endpoint)
    //   lens-d.docusign.net/api/v2.0/datasets/monitor/stream
    //     -> 403 with an empty body (older Monitor generation)
    baseUri: (env) => iamHost(env),
    pathHint: '/v1/organizations/{organizationId}/stream',
    status: 'ga',
    specSource: 'openapi',
    docsUrl: 'https://developers.docusign.com/docs/monitor-api/',
    probe: { path: '/v1/organizations/{organizationId}/stream', query: { limit: 1 } },
  },
  notary: {
    id: 'notary',
    toolPrefix: 'notary',
    label: 'Notary API',
    baseUri: (env) =>
      // VERIFIED 2026-08-19 https://developers.docusign.com/docs/notary-api/notary101/concepts/
      // "https://notary-d.docusign.net/restapi/..." -- the base carries /restapi.
      env === 'prod'
        ? 'https://na-notary.docusign.net/restapi'
        : 'https://notary-d.docusign.net/restapi',
    pathHint: '/v1.0/accounts/{accountId}/notaries',
    status: 'ga',
    specSource: 'openapi',
    docsUrl: 'https://developers.docusign.com/docs/notary-api/',
    probe: { path: '/v1.0/accounts/{accountId}/notaries' },
  },
  connectedfields: {
    id: 'connectedfields',
    toolPrefix: 'connectedfields',
    label: 'Connected Fields API',
    baseUri: (env) => iamHost(env),
    pathHint: '/v1/accounts/{accountId}/connected-fields/tab-groups',
    status: 'ga',
    specSource: 'openapi',
    docsUrl: 'https://developers.docusign.com/docs/connected-fields-api/',
    probe: { path: '/v1/accounts/{accountId}/connected-fields/tab-groups' },
  },
  workspaces: {
    id: 'workspaces',
    toolPrefix: 'workspaces',
    label: 'Workspaces API',
    baseUri: (env) => iamHost(env),
    pathHint: '/v1/accounts/{accountId}/workspaces',
    status: 'beta',
    specSource: 'openapi',
    docsUrl: 'https://developers.docusign.com/docs/workspaces-api/',
    probe: { path: '/v1/accounts/{accountId}/workspaces' },
  },
  /**
   * Agreement Desk — the IAM intake surface where business users submit agreement
   * requests and they get routed, tracked and discussed.
   *
   * Not documented anywhere in the Developer Center index (searching it returns
   * nothing), and it has no published OpenAPI spec. The route surface below was
   * established empirically.
   *
   * VERIFIED 2026-10-27 against a live demo account:
   *   GET /v1/accounts/{accountId}/requests       -> 403 "The feature is disabled
   *                                                  for this account."
   *   GET /v1/accounts/{accountId}/request-types  -> 403 (same)
   *
   * A *feature-level* 403 rather than a 404 is the proof the routes exist and were
   * evaluated — the same signal that settled Monitor's host. It also means the
   * existing granted scopes are sufficient to reach it: this is an account
   * entitlement gate, not a consent gate, so no new consent is required.
   *
   * Enablement is request-based (an internal form naming the account ID). Once
   * granted, these tools should work with no code change — run `npm run smoke`.
   */
  agreementdesk: {
    id: 'agreementdesk',
    toolPrefix: 'desk',
    label: 'Agreement Desk API',
    baseUri: (env) => iamHost(env),
    pathHint: '/v1/accounts/{accountId}/requests',
    status: 'unverified',
    specSource: 'hand-built',
    docsUrl: 'https://developers.docusign.com/docs/',
    probe: { path: '/v1/accounts/{accountId}/request-types' },
  },

  /**
   * NO SUCH PUBLIC API, as far as can be established.
   *
   * The build brief listed "Trust Records" among the product APIs to cover, but:
   *   - it appears in no Docusign OpenAPI spec,
   *   - it appears in neither the endpoint base-path table nor the scopes reference,
   *   - repeated Developer Center searches return nothing about it, and
   *   - six candidate endpoint shapes all return 404 on a live account
   *     (VERIFIED 2026-08-19: /v1/accounts/{id}/trust-records, /trustrecords,
   *      /v1/organizations/{org}/trust-records, /trust/records,
   *      restapi/v2.1/.../trust_records, management/v2/.../trust-records).
   *
   * The entry is kept so the name resolves and the raw hatch exists if Docusign
   * ships it (or if it turns out to be an internal/private surface), but it is
   * NOT in the default DS_PRODUCTS and has no curated tools. "Trust records" in
   * Docusign marketing most likely refers to the certificate-of-completion and
   * audit-trail data, which the eSignature API already exposes via
   * envelopes/{id}/audit_events and the "certificate" document.
   */
  trustrecords: {
    id: 'trustrecords',
    toolPrefix: 'trustrecords',
    label: 'Trust Records API (not a published API -- see comment)',
    baseUri: (env) => iamHost(env),
    pathHint: '/v1/accounts/{accountId}/trust-records',
    status: 'unverified',
    specSource: 'unverified',
    docsUrl: 'https://developers.docusign.com/docs/',
  },
};

export const PRODUCT_IDS = Object.keys(PRODUCTS) as ProductId[];
