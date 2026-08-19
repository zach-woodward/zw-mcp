/**
 * Diagnostic: ask the token endpoint for one specific scope string at a time and
 * report whether the grant succeeds.
 *
 * Consent is granted per scope, and DocuSign will happily record a consent that
 * silently omits a scope the account is not entitled to -- so "I clicked Accept"
 * is not proof a scope is usable. This narrows a consent_required failure down to
 * the exact offending scope instead of guessing at a whole product's set.
 *
 *   npm run scopecheck -- "signature" "signature adm_store_unified_repo_read"
 *
 * With no arguments it probes each product's scope set from src/auth/scopes.ts.
 */
import jwt from 'jsonwebtoken';
import { request } from 'undici';
import { loadConfig } from '../src/lib/config.js';
import { PRODUCT_SCOPES, BASE_SCOPES } from '../src/auth/scopes.js';

const cfg = loadConfig();

async function probe(scope: string): Promise<{ ok: boolean; detail: string }> {
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    {
      iss: cfg.DS_INTEGRATION_KEY,
      sub: cfg.DS_USER_ID,
      aud: cfg.authServer,
      iat: now,
      exp: now + 3600,
      scope,
    },
    cfg.privateKey,
    { algorithm: 'RS256' },
  );
  const res = await request(`https://${cfg.authServer}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });
  const text = await res.body.text();
  if (res.statusCode === 200) return { ok: true, detail: 'granted' };
  let err = text.slice(0, 120);
  try {
    err = String((JSON.parse(text) as { error?: string }).error ?? err);
  } catch {
    /* keep raw text */
  }
  return { ok: false, detail: err };
}

const args = process.argv.slice(2).filter((a) => a !== '--');

const candidates: Array<[string, string]> = args.length
  ? args.map((a) => [a, a] as [string, string])
  : [
      ['(base only)', BASE_SCOPES.join(' ')],
      ...Object.entries(PRODUCT_SCOPES).map(
        ([id, scopes]) =>
          [id, [...new Set([...BASE_SCOPES, ...scopes])].join(' ')] as [string, string],
      ),
      // Each individual scope on its own, to pinpoint a single bad entry.
      ...[...new Set(Object.values(PRODUCT_SCOPES).flat())].map(
        (s) => [`  scope: ${s}`, `${BASE_SCOPES.join(' ')} ${s}`] as [string, string],
      ),
    ];

console.log(`\nScope check -- ${cfg.DS_ENVIRONMENT} (${cfg.authServer})`);
console.log(`Integration key: ${cfg.DS_INTEGRATION_KEY}\n`);

for (const [label, scope] of candidates) {
  const { ok, detail } = await probe(scope);
  console.log(`${ok ? '✅' : '❌'}  ${label.padEnd(34)} ${ok ? '' : detail}`);
}
console.log('');
