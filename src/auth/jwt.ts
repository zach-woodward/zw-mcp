import jwt from 'jsonwebtoken';
import { request } from 'undici';
import { loadConfig } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { scopesFor } from './scopes.js';

/** Refresh this far ahead of expiry so an in-flight call never races the clock. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** DocuSign caps JWT assertion lifetime at one hour. */
const ASSERTION_TTL_SEC = 3600;

export interface TokenState {
  accessToken: string;
  expiresAt: number;
  scopes: string[];
}

export interface AccountInfo {
  accountId: string;
  accountName: string;
  /** e.g. https://demo.docusign.net -- the eSignature host, before /restapi. */
  baseUri: string;
  isDefault: boolean;
  /**
   * Organization GUID. The Admin, Monitor and Notary APIs are organization-scoped
   * rather than account-scoped, and this is the only place it is discoverable
   * without an extra call.
   */
  organizationId?: string;
}

export interface UserInfo {
  sub: string;
  name?: string;
  email?: string;
  accounts: AccountInfo[];
}

export class ConsentRequiredError extends Error {
  readonly consentUrl: string;
  constructor(consentUrl: string, cause?: string) {
    super(
      `DocuSign consent has not been granted for this integration key + user.\n` +
        `Open this URL in a browser, sign in as the impersonated user, and click Accept:\n\n` +
        `  ${consentUrl}\n\n` +
        (cause ? `(auth server said: ${cause})` : ''),
    );
    this.name = 'ConsentRequiredError';
    this.consentUrl = consentUrl;
  }
}

let token: TokenState | null = null;
let userInfo: UserInfo | null = null;
/** Coalesces concurrent refreshes so N parallel tool calls mint one token. */
let inFlight: Promise<TokenState> | null = null;

/**
 * The one-time consent URL for the configured integration key.
 *
 * `products` defaults to what DS_PRODUCTS enables, but can be widened to grant
 * consent for scopes a later phase will need (see scripts/consent.ts).
 */
export function consentUrl(products?: readonly string[]): string {
  const cfg = loadConfig();
  const scopes = scopesFor(products ?? cfg.products);
  const params = new URLSearchParams({
    response_type: 'code',
    scope: scopes.join(' '),
    client_id: cfg.DS_INTEGRATION_KEY,
    // Any registered redirect URI works -- consent is granted before the redirect,
    // so the URI never has to resolve to a running server.
    redirect_uri: 'https://developers.docusign.com/platform/auth/consent',
  });
  return `https://${cfg.authServer}/oauth/auth?${params.toString()}`;
}

function signAssertion(): string {
  const cfg = loadConfig();
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      iss: cfg.DS_INTEGRATION_KEY,
      sub: cfg.DS_USER_ID,
      // aud is the bare host, no scheme.
      aud: cfg.authServer,
      iat: now,
      exp: now + ASSERTION_TTL_SEC,
      scope: scopesFor(cfg.products).join(' '),
    },
    cfg.privateKey,
    { algorithm: 'RS256' },
  );
}

async function requestToken(): Promise<TokenState> {
  const cfg = loadConfig();
  const assertion = signAssertion();

  const res = await request(`https://${cfg.authServer}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });

  const raw = await res.body.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    /* non-JSON error body -- fall through to the generic error below */
  }

  if (res.statusCode !== 200) {
    const err = String(parsed.error ?? '');
    // DocuSign signals "the user has never consented" with this exact error code;
    // it is the single most common first-run failure, so we make it actionable.
    if (err === 'consent_required') {
      throw new ConsentRequiredError(consentUrl(), err);
    }
    throw new Error(
      `DocuSign token request failed (${res.statusCode}): ${err || raw.slice(0, 500)}` +
        (err === 'invalid_grant'
          ? `\nHint: invalid_grant usually means DS_USER_ID is not the impersonated ` +
            `user's GUID, the RSA key does not match the integration key, or the ` +
            `key belongs to the other environment (demo vs prod).`
          : ''),
    );
  }

  const accessToken = String(parsed.access_token ?? '');
  const expiresIn = Number(parsed.expires_in ?? 3600);
  if (!accessToken) throw new Error('DocuSign token response contained no access_token');

  const state: TokenState = {
    accessToken,
    expiresAt: Date.now() + expiresIn * 1000,
    scopes: String(parsed.scope ?? '').split(' ').filter(Boolean),
  };
  logger.info(
    { expiresInSec: expiresIn, scopeCount: state.scopes.length },
    'minted DocuSign access token',
  );
  return state;
}

/**
 * Returns a valid access token, minting one if the cache is empty, stale, or
 * within the refresh margin. Concurrent callers share a single in-flight mint.
 */
export async function getAccessToken(opts: { force?: boolean } = {}): Promise<string> {
  if (!opts.force && token && Date.now() < token.expiresAt - REFRESH_MARGIN_MS) {
    return token.accessToken;
  }
  if (!inFlight) {
    inFlight = requestToken().finally(() => {
      inFlight = null;
    });
  }
  token = await inFlight;
  return token.accessToken;
}

/** Current token metadata for /health. Never exposes the token itself. */
export function tokenStatus(): { hasToken: boolean; expiresAt: string | null; scopes: string[] } {
  return {
    hasToken: Boolean(token),
    expiresAt: token ? new Date(token.expiresAt).toISOString() : null,
    scopes: token?.scopes ?? [],
  };
}

/**
 * Calls /oauth/userinfo to discover the account ID and the account's eSignature
 * base URI. Cached for the process lifetime -- the docs explicitly say to fetch
 * this once at first authentication and cache it, not per request.
 */
export async function getUserInfo(): Promise<UserInfo> {
  if (userInfo) return userInfo;
  const cfg = loadConfig();
  const accessToken = await getAccessToken();

  const res = await request(`https://${cfg.authServer}/oauth/userinfo`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (res.statusCode !== 200) {
    throw new Error(`/oauth/userinfo failed (${res.statusCode}): ${await res.body.text()}`);
  }
  const data = (await res.body.json()) as {
    sub: string;
    name?: string;
    email?: string;
    accounts?: Array<{
      account_id: string;
      account_name: string;
      base_uri: string;
      is_default: boolean;
      organization?: { organization_id?: string };
    }>;
  };

  userInfo = {
    sub: data.sub,
    name: data.name,
    email: data.email,
    accounts: (data.accounts ?? []).map((a) => ({
      accountId: a.account_id,
      accountName: a.account_name,
      baseUri: a.base_uri,
      isDefault: a.is_default,
      organizationId: a.organization?.organization_id,
    })),
  };
  logger.info(
    { accounts: userInfo.accounts.map((a) => ({ id: a.accountId, name: a.accountName })) },
    'discovered DocuSign accounts',
  );
  return userInfo;
}

/**
 * The account every tool operates against: DS_ACCOUNT_ID when set, otherwise the
 * user's default account.
 */
export async function getAccount(): Promise<AccountInfo> {
  const cfg = loadConfig();
  const info = await getUserInfo();
  if (!info.accounts.length) {
    throw new Error('The impersonated DocuSign user has no accounts.');
  }
  if (cfg.DS_ACCOUNT_ID) {
    const match = info.accounts.find((a) => a.accountId === cfg.DS_ACCOUNT_ID);
    if (!match) {
      throw new Error(
        `DS_ACCOUNT_ID=${cfg.DS_ACCOUNT_ID} is not among this user's accounts: ` +
          info.accounts.map((a) => a.accountId).join(', '),
      );
    }
    return match;
  }
  return info.accounts.find((a) => a.isDefault) ?? info.accounts[0]!;
}

/** Test/restart hook -- drops the token and discovery caches. */
export function resetAuth(): void {
  token = null;
  userInfo = null;
  inFlight = null;
}
