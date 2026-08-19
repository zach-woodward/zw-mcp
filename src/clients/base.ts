import { request } from 'undici';
import { getAccessToken, getAccount } from '../auth/jwt.js';
import { loadConfig } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { PRODUCTS, type ProductId } from './products.js';

export interface ApiRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Path under the product base URI. `{accountId}` is substituted for you. */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Set for binary endpoints (document downloads) to get a Buffer back. */
  raw?: boolean;
  accept?: string;
  contentType?: string;
}

export class DocuSignApiError extends Error {
  readonly status: number;
  readonly product: ProductId;
  readonly path: string;
  readonly detail: unknown;

  constructor(product: ProductId, path: string, status: number, detail: unknown) {
    const message =
      typeof detail === 'object' && detail !== null
        ? ((detail as Record<string, unknown>).message as string) ??
          JSON.stringify(detail).slice(0, 600)
        : String(detail).slice(0, 600);
    super(`${PRODUCTS[product].label} ${status} on ${path}: ${message}`);
    this.name = 'DocuSignApiError';
    this.status = status;
    this.product = product;
    this.path = path;
    this.detail = detail;
  }
}

/** Resolved base URI per product, cached after the first call. */
const baseUriCache = new Map<ProductId, string>();

export async function baseUriFor(product: ProductId): Promise<string> {
  const cached = baseUriCache.get(product);
  if (cached) return cached;
  const cfg = loadConfig();
  const account = await getAccount();
  const uri = PRODUCTS[product].baseUri(cfg.DS_ENVIRONMENT, account).replace(/\/+$/, '');
  baseUriCache.set(product, uri);
  return uri;
}

function buildUrl(base: string, path: string, query?: ApiRequest['query']): string {
  const url = new URL(base + (path.startsWith('/') ? path : `/${path}`));
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  return url.toString();
}

/**
 * Signs and sends one request against a product API.
 *
 * Handles the two things every DocuSign call needs and nobody should re-implement
 * per tool: `{accountId}` substitution, and a single transparent retry with a
 * freshly minted token when the platform answers 401 (which happens when a token
 * is revoked or the account's session is invalidated ahead of our expiry math).
 */
export async function apiRequest<T = unknown>(
  product: ProductId,
  req: ApiRequest,
): Promise<T> {
  const account = await getAccount();
  const base = await baseUriFor(product);
  const path = req.path.replace(/\{accountId\}/g, account.accountId);
  const url = buildUrl(base, path, req.query);
  const started = Date.now();

  const send = async (token: string) => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: req.accept ?? 'application/json',
    };
    let payload: string | Buffer | undefined;
    if (req.body !== undefined) {
      if (Buffer.isBuffer(req.body)) {
        payload = req.body;
        headers['content-type'] = req.contentType ?? 'application/octet-stream';
      } else {
        payload = JSON.stringify(req.body);
        headers['content-type'] = req.contentType ?? 'application/json';
      }
    }
    return request(url, { method: req.method, headers, body: payload });
  };

  let res = await send(await getAccessToken());
  if (res.statusCode === 401) {
    logger.warn({ product, path }, '401 from DocuSign -- retrying once with a fresh token');
    res.body.dump().catch(() => {});
    res = await send(await getAccessToken({ force: true }));
  }

  const durationMs = Date.now() - started;
  const ok = res.statusCode >= 200 && res.statusCode < 300;

  logger.info(
    { product, method: req.method, path, status: res.statusCode, durationMs },
    'docusign api call',
  );

  if (!ok) {
    const text = await res.body.text();
    let detail: unknown = text;
    try {
      detail = JSON.parse(text);
    } catch {
      /* keep the raw text */
    }
    throw new DocuSignApiError(product, path, res.statusCode, detail);
  }

  if (req.raw) return Buffer.from(await res.body.arrayBuffer()) as T;

  const text = await res.body.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

/** Test hook -- drops resolved base URIs (used after an environment flip). */
export function resetClients(): void {
  baseUriCache.clear();
}
