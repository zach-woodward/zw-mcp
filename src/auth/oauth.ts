import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { logger } from '../lib/logger.js';

/**
 * A minimal OAuth 2.1 authorization server, colocated with the MCP resource
 * server. The MCP authorization spec permits this ("It may be hosted with the
 * resource server or a separate entity").
 *
 * Why this exists at all: Claude custom connectors (claude.ai, Claude Cowork)
 * offer no field for a static bearer header. They connect, get a 401, and then
 * follow the discovery chain -- protected-resource metadata, AS metadata,
 * dynamic client registration, authorization code + PKCE. Observed verbatim in
 * our own request log:
 *
 *   POST /                                          -> 401
 *   GET  /.well-known/oauth-protected-resource/mcp  -> 404
 *   GET  /.well-known/oauth-protected-resource      -> 404
 *   GET  /.well-known/oauth-authorization-server    -> 404
 *   POST /register                                  -> 404
 *
 * So a static token cannot work there, and this is the smallest thing that can.
 *
 * Design notes:
 * - Tokens are OPAQUE and stored server-side. That avoids signing-key management
 *   and makes audience validation a lookup rather than a JWT claim check.
 * - The resource owner is authenticated by knowledge of ZW_MCP_TOKEN. This is a
 *   single-operator server; introducing a second credential store would add
 *   surface without adding a security boundary.
 * - State is persisted to disk so a server restart does not silently log every
 *   connector out.
 *
 * VERIFIED against https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
 */

const STATE_DIR = path.resolve(process.cwd(), '.oauth');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_SEC = 30 * 24 * 60 * 60; // 30 days
const REFRESH_TOKEN_TTL_SEC = 90 * 24 * 60 * 60;

export interface RegisteredClient {
  client_id: string;
  client_secret?: string;
  client_name?: string;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  grant_types: string[];
  response_types: string[];
  created_at: number;
}

interface AuthCode {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  resource?: string;
  scope?: string;
  expires_at: number;
}

interface IssuedToken {
  token: string;
  client_id: string;
  /** RFC 8707 audience this token is bound to. */
  audience: string;
  scope?: string;
  expires_at: number;
  refresh_token?: string;
  refresh_expires_at?: number;
}

interface OAuthState {
  clients: Record<string, RegisteredClient>;
  tokens: Record<string, IssuedToken>;
  refresh: Record<string, string>;
}

let state: OAuthState = { clients: {}, tokens: {}, refresh: {} };
/** Auth codes are short-lived and deliberately NOT persisted. */
const codes = new Map<string, AuthCode>();
let stateMtimeMs = 0;

/**
 * Loads state, and reloads it when the file changes underneath us.
 *
 * The admin console runs as a SEPARATE process and revokes grants by rewriting
 * this file. Without an mtime check, this process would keep honouring tokens
 * from its in-memory copy and a revoke would silently do nothing until restart.
 */
function load(force = false): void {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const mtime = fs.statSync(STATE_FILE).mtimeMs;
    if (!force && mtime === stateMtimeMs) return;
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as OAuthState;
    state.clients ??= {};
    state.tokens ??= {};
    state.refresh ??= {};
    stateMtimeMs = mtime;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'could not read oauth state; starting empty');
  }
}

function persist(): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
    stateMtimeMs = fs.statSync(STATE_FILE).mtimeMs;
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'could not persist oauth state');
  }
}

load();

const rand = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/** Drops anything expired. Cheap enough to run on every touch. */
function sweep(): void {
  // Pick up out-of-process changes (admin console revokes) before deciding.
  load();
  const now = Date.now();
  for (const [k, v] of codes) if (v.expires_at < now) codes.delete(k);
  let changed = false;
  for (const [k, v] of Object.entries(state.tokens)) {
    const refreshDead = !v.refresh_expires_at || v.refresh_expires_at * 1000 < now;
    if (v.expires_at * 1000 < now && refreshDead) {
      delete state.tokens[k];
      changed = true;
    }
  }
  if (changed) persist();
}

/**
 * The canonical URI clients must use as the `resource` parameter, and that this
 * server validates tokens against. Configure ZW_MCP_PUBLIC_URL when behind a
 * proxy; the metadata documents must agree with what the client actually calls.
 */
export function publicBaseUrl(hostHeader?: string, proto?: string): string {
  const configured = process.env.ZW_MCP_PUBLIC_URL;
  if (configured) return configured.replace(/\/+$/, '');
  const host = hostHeader ?? `127.0.0.1:${loadConfig().PORT}`;
  const scheme = proto ?? (host.includes('127.0.0.1') || host.includes('localhost') ? 'http' : 'https');
  return `${scheme}://${host}`;
}

export function canonicalResource(base: string): string {
  return `${base}/mcp`;
}

// --- RFC 7591: dynamic client registration -----------------------------------

export function registerClient(body: Record<string, unknown>): RegisteredClient {
  const redirectUris = Array.isArray(body.redirect_uris)
    ? (body.redirect_uris as string[]).filter((u) => typeof u === 'string')
    : [];
  if (!redirectUris.length) throw new Error('redirect_uris is required');

  // Every redirect target must be HTTPS or loopback (OAuth 2.1 §1.5).
  for (const uri of redirectUris) {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      throw new Error(`invalid redirect_uri: ${uri}`);
    }
    const loopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !loopback) {
      throw new Error(`redirect_uri must be https or loopback: ${uri}`);
    }
  }

  const authMethod = String(body.token_endpoint_auth_method ?? 'none');
  const client: RegisteredClient = {
    client_id: rand(24),
    ...(authMethod === 'none' ? {} : { client_secret: rand(32) }),
    client_name: typeof body.client_name === 'string' ? body.client_name : undefined,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: authMethod,
    grant_types: (body.grant_types as string[]) ?? ['authorization_code', 'refresh_token'],
    response_types: (body.response_types as string[]) ?? ['code'],
    created_at: Math.floor(Date.now() / 1000),
  };
  state.clients[client.client_id] = client;
  persist();
  logger.info(
    { client_id: client.client_id, name: client.client_name, redirectUris },
    'registered oauth client',
  );
  return client;
}

export function getClient(clientId: string): RegisteredClient | undefined {
  return state.clients[clientId];
}

// --- authorization code + PKCE ------------------------------------------------

export function createAuthCode(input: {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  resource?: string;
  scope?: string;
}): string {
  sweep();
  const code = rand(32);
  codes.set(code, { code, ...input, expires_at: Date.now() + AUTH_CODE_TTL_MS });
  return code;
}

function verifyPkce(verifier: string, challenge: string, method: string): boolean {
  if (method === 'S256') {
    const hash = crypto.createHash('sha256').update(verifier).digest('base64url');
    // Length-equal before timingSafeEqual, which throws on mismatched lengths.
    return hash.length === challenge.length &&
      crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(challenge));
  }
  // OAuth 2.1 drops "plain"; accepted only if a client insists on it.
  return verifier === challenge;
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

export function exchangeCode(input: {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_verifier: string;
  resource?: string;
  defaultAudience: string;
}): TokenResponse {
  sweep();
  const entry = codes.get(input.code);
  if (!entry) throw new Error('invalid_grant: unknown or expired authorization code');
  // Single use, whatever happens next.
  codes.delete(input.code);

  if (entry.client_id !== input.client_id) throw new Error('invalid_grant: client mismatch');
  if (entry.redirect_uri !== input.redirect_uri) {
    throw new Error('invalid_grant: redirect_uri mismatch');
  }
  if (!input.code_verifier) throw new Error('invalid_request: code_verifier is required');
  if (!verifyPkce(input.code_verifier, entry.code_challenge, entry.code_challenge_method)) {
    throw new Error('invalid_grant: PKCE verification failed');
  }

  return issueToken({
    client_id: entry.client_id,
    audience: entry.resource ?? input.resource ?? input.defaultAudience,
    scope: entry.scope,
  });
}

function issueToken(input: {
  client_id: string;
  audience: string;
  scope?: string;
}): TokenResponse {
  const now = Math.floor(Date.now() / 1000);
  const token = rand(32);
  const refresh = rand(32);
  const issued: IssuedToken = {
    token,
    client_id: input.client_id,
    audience: input.audience,
    scope: input.scope,
    expires_at: now + ACCESS_TOKEN_TTL_SEC,
    refresh_token: refresh,
    refresh_expires_at: now + REFRESH_TOKEN_TTL_SEC,
  };
  state.tokens[token] = issued;
  state.refresh[refresh] = token;
  persist();
  logger.info({ client_id: input.client_id, audience: input.audience }, 'issued access token');
  return {
    access_token: token,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SEC,
    refresh_token: refresh,
    scope: input.scope,
  };
}

export function refreshAccessToken(refreshToken: string, clientId: string): TokenResponse {
  sweep();
  const oldTokenKey = state.refresh[refreshToken];
  const old = oldTokenKey ? state.tokens[oldTokenKey] : undefined;
  if (!old) throw new Error('invalid_grant: unknown refresh token');
  if (old.client_id !== clientId) throw new Error('invalid_grant: client mismatch');

  // OAuth 2.1 requires refresh-token rotation for public clients.
  delete state.tokens[oldTokenKey!];
  delete state.refresh[refreshToken];
  return issueToken({ client_id: old.client_id, audience: old.audience, scope: old.scope });
}

/**
 * Validates a presented bearer token and enforces audience binding, which the
 * spec calls out explicitly: a server MUST reject tokens not issued for it.
 */
export function validateAccessToken(
  token: string,
  expectedAudience: string,
): { valid: boolean; reason?: string; client_id?: string } {
  sweep();
  const found = state.tokens[token];
  if (!found) return { valid: false, reason: 'unknown token' };
  if (found.expires_at * 1000 < Date.now()) return { valid: false, reason: 'expired token' };
  // Tolerate the trailing-slash variance the spec warns about.
  const norm = (s: string) => s.replace(/\/+$/, '');
  if (norm(found.audience) !== norm(expectedAudience)) {
    return { valid: false, reason: `token audience ${found.audience} != ${expectedAudience}` };
  }
  return { valid: true, client_id: found.client_id };
}

/** For the admin console: what has been granted, without exposing the tokens. */
export function listGrants(): Array<{
  client_id: string;
  client_name?: string;
  audience: string;
  issued_at_iso: string;
  expires_at_iso: string;
}> {
  sweep();
  return Object.values(state.tokens).map((t) => ({
    client_id: t.client_id,
    client_name: state.clients[t.client_id]?.client_name,
    audience: t.audience,
    issued_at_iso: new Date((t.expires_at - ACCESS_TOKEN_TTL_SEC) * 1000).toISOString(),
    expires_at_iso: new Date(t.expires_at * 1000).toISOString(),
  }));
}

/** Revokes every issued token and registered client. */
export function revokeAll(): number {
  const n = Object.keys(state.tokens).length;
  state = { clients: {}, tokens: {}, refresh: {} };
  persist();
  logger.warn({ revoked: n }, 'revoked all oauth grants');
  return n;
}
