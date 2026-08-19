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
  | 'trustrecords';

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
  },
  clm: {
    id: 'clm',
    toolPrefix: 'clm',
    label: 'CLM API',
    // CLM (SpringCM) lives on a per-account host discovered at runtime; see
    // src/clients/clm.ts. This placeholder is replaced in Phase 2.
    baseUri: (env) =>
      env === 'prod' ? 'https://api-na11.springcm.com' : 'https://apiuatna11.springcm.com',
    pathHint: '/v2/{clmAccountId}/documents',
    status: 'unverified',
    specSource: 'unverified',
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
  },
  monitor: {
    id: 'monitor',
    toolPrefix: 'monitor',
    label: 'Monitor API',
    baseUri: (env) =>
      env === 'prod'
        ? 'https://lens.docusign.net/api/v2.0/datasets/monitor'
        : 'https://lens-d.docusign.net/api/v2.0/datasets/monitor',
    // CONFLICT: the docs base-path table says lens-d.docusign.net/api/v2.0/datasets/monitor
    // (used here), while monitor.rest.swagger-v2.0.json declares api.docusign.com
    // with /v1/organizations/{organizationId}/stream. Two API generations. Resolve
    // against a live call in Phase 3 before shipping curated Monitor tools.
    pathHint: '/stream?cursor=&limit=',
    status: 'unverified',
    specSource: 'openapi',
    docsUrl: 'https://developers.docusign.com/docs/monitor-api/',
  },
  notary: {
    id: 'notary',
    toolPrefix: 'notary',
    label: 'Notary API',
    baseUri: (env) =>
      env === 'prod' ? 'https://na-notary.docusign.net' : 'https://notary-d.docusign.net',
    pathHint: '/restapi/v1/accounts/{accountId}/notary/journals',
    status: 'ga',
    specSource: 'openapi',
    docsUrl: 'https://developers.docusign.com/docs/notary-api/',
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
  },
  trustrecords: {
    id: 'trustrecords',
    toolPrefix: 'trustrecords',
    label: 'Trust Records API',
    // UNVERIFIED: Trust Records appears in neither the endpoint base-path table
    // nor the scopes reference. Confirm in Phase 3 before relying on this.
    baseUri: (env) => iamHost(env),
    pathHint: '/v1/accounts/{accountId}/trust-records',
    status: 'unverified',
    specSource: 'unverified',
    docsUrl: 'https://developers.docusign.com/docs/',
  },
};

export const PRODUCT_IDS = Object.keys(PRODUCTS) as ProductId[];
