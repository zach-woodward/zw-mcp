import { request } from 'undici';
import { getAccessToken, getAccount } from '../auth/jwt.js';
import { loadConfig } from '../lib/config.js';
import { logger } from '../lib/logger.js';

/**
 * CLM (formerly SpringCM) does not fit the shared product-client model, for two
 * reasons that are worth stating plainly:
 *
 * 1. Its hosts are DATA-CENTER SPECIFIC and not knowable up front. You discover
 *    them per account at runtime, and the Object, Task, Content-upload and
 *    Content-download APIs each get a DIFFERENT host.
 * 2. Its paths carry the account id after the version:
 *      https://{host}/{version}/{accountId}/{resource}
 *
 * Discovery endpoint (docs, "CLM API 101"):
 *   UAT  https://authuat.springcm.com/api/v2/{accountId}/account
 *   Prod https://auth.springcm.com/api/v2/{accountId}/account
 *
 * ---------------------------------------------------------------------------
 * UNVERIFIED -- this whole module is written from the documentation and has NOT
 * been exercised against a live account. The Woodward Systems demo account
 * cannot reach CLM: the UAT discovery endpoint answers 401 Access Denied and the
 * `spring_read` / `spring_write` scopes are not grantable there. This matches the
 * banner on every CLM docs page: "Developing with the CLM API is only available
 * for CLM customers with a production account."
 *
 * Before trusting anything here, run it against a CLM-entitled account and
 * replace this banner with a VERIFIED stamp.
 * CHECKED 2026-08-19 https://developers.docusign.com/docs/clm-api/clm101/
 * ---------------------------------------------------------------------------
 */

export interface ClmEndpoints {
  objectApi: string;
  taskApi: string;
  uploadApi: string;
  downloadApi: string;
  /** API version segment, e.g. v20180601. */
  version: string;
  clmAccountId: string;
}

let cached: ClmEndpoints | null = null;

/** Default version segment when discovery does not supply one. */
const DEFAULT_VERSION = 'v20180601';

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

export class ClmUnavailableError extends Error {
  constructor(status: number, detail: string) {
    super(
      `CLM is not reachable for this account (discovery returned ${status}). ` +
        `The CLM API requires a CLM-entitled account and the spring_read / spring_write ` +
        `scopes; developer/demo accounts generally cannot use it. Detail: ${detail.slice(0, 300)}`,
    );
    this.name = 'ClmUnavailableError';
  }
}

/** Discovers and caches this account's CLM hosts. */
export async function getClmEndpoints(): Promise<ClmEndpoints> {
  if (cached) return cached;
  const cfg = loadConfig();
  const account = await getAccount();
  const authHost = cfg.isDemo ? 'https://authuat.springcm.com' : 'https://auth.springcm.com';
  const url = `${authHost}/api/v2/${account.accountId}/account`;

  const res = await request(url, {
    headers: {
      authorization: `Bearer ${await getAccessToken()}`,
      accept: 'application/json',
    },
  });
  const text = await res.body.text();
  if (res.statusCode !== 200) throw new ClmUnavailableError(res.statusCode, text);

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // auth.springcm.com serves an HTML login page when the path is wrong, which
    // is a far more useful thing to say than "unexpected token <".
    throw new ClmUnavailableError(res.statusCode, 'discovery returned HTML, not JSON');
  }

  const object = firstString(data, ['ObjectApiUrl', 'ApiUrl', 'objectApiUrl']);
  if (!object) {
    throw new ClmUnavailableError(200, `discovery JSON had no API URL: ${text.slice(0, 200)}`);
  }

  cached = {
    objectApi: object.replace(/\/+$/, ''),
    taskApi: (firstString(data, ['TaskApiUrl', 'taskApiUrl']) ?? object).replace(/\/+$/, ''),
    uploadApi: (firstString(data, ['UploadApiUrl', 'ContentUploadUrl']) ?? object).replace(/\/+$/, ''),
    downloadApi: (firstString(data, ['DownloadApiUrl', 'ContentDownloadUrl']) ?? object).replace(
      /\/+$/,
      '',
    ),
    version: firstString(data, ['ApiVersion', 'Version']) ?? DEFAULT_VERSION,
    clmAccountId: firstString(data, ['Id', 'AccountId']) ?? account.accountId,
  };
  logger.info({ endpoints: cached }, 'discovered CLM endpoints');
  return cached;
}

export type ClmSurface = 'object' | 'task' | 'upload' | 'download';

/**
 * Sends a request to one of CLM's four surfaces.
 *
 * `path` is relative to `/{version}/{accountId}`, so pass `/documents/{id}` and
 * the version + account segments are prepended for you.
 */
export async function clmRequest<T = unknown>(opts: {
  surface?: ClmSurface;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  accept?: string;
  raw?: boolean;
  /** Absolute URL (e.g. a document's DownloadDocumentHref) bypassing path building. */
  absoluteUrl?: string;
}): Promise<T> {
  const e = await getClmEndpoints();
  const hosts: Record<ClmSurface, string> = {
    object: e.objectApi,
    task: e.taskApi,
    upload: e.uploadApi,
    download: e.downloadApi,
  };

  let url: string;
  if (opts.absoluteUrl) {
    url = opts.absoluteUrl;
  } else {
    const base = hosts[opts.surface ?? 'object'];
    const path = opts.path.startsWith('/') ? opts.path : `/${opts.path}`;
    url = `${base}/${e.version}/${e.clmAccountId}${path}`;
  }

  const u = new URL(url);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== '') u.searchParams.set(k, String(v));
  }

  const started = Date.now();
  const res = await request(u.toString(), {
    method: opts.method,
    headers: {
      authorization: `Bearer ${await getAccessToken()}`,
      accept: opts.accept ?? 'application/json',
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  logger.info(
    {
      product: 'clm',
      surface: opts.surface ?? 'object',
      method: opts.method,
      status: res.statusCode,
      durationMs: Date.now() - started,
    },
    'docusign api call',
  );

  if (res.statusCode >= 400) {
    throw new Error(`CLM ${res.statusCode} on ${opts.path}: ${(await res.body.text()).slice(0, 600)}`);
  }
  if (opts.raw) return Buffer.from(await res.body.arrayBuffer()) as T;
  const text = await res.body.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

/** Test hook. */
export function resetClm(): void {
  cached = null;
}
