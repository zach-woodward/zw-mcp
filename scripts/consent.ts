/**
 * Prints the one-time consent URL for the configured integration key + scopes.
 *
 * JWT Grant impersonation only works after the impersonated user has granted
 * consent once. Run `npm run consent`, open the URL, sign in AS THAT USER, Accept.
 *
 * Pass --products to consent for a WIDER set than DS_PRODUCTS currently enables,
 * so a later phase that turns those products on needs no second consent click:
 *
 *   npm run consent -- --products esign,navigator,maestro
 *
 * Consent is granted per scope, not per enabled tool, so granting ahead is safe.
 * The catch: one scope the account is not entitled to fails the WHOLE grant, so
 * widen deliberately rather than passing every product at once.
 */
import { consentUrl } from '../src/auth/jwt.js';
import { loadConfig } from '../src/lib/config.js';
import { scopesFor } from '../src/auth/scopes.js';

const cfg = loadConfig();

const flagIndex = process.argv.indexOf('--products');
const override =
  flagIndex !== -1 && process.argv[flagIndex + 1]
    ? process.argv[flagIndex + 1]!.split(',').map((p) => p.trim()).filter(Boolean)
    : null;
const products = override ?? cfg.products;
const scopes = scopesFor(products);

console.log('');
console.log('ZW MCP -- DocuSign consent');
console.log('==========================');
console.log(`Environment    : ${cfg.DS_ENVIRONMENT} (${cfg.authServer})`);
console.log(`Integration key: ${cfg.DS_INTEGRATION_KEY}`);
console.log(`Impersonated   : ${cfg.DS_USER_ID}`);
console.log(`Products       : ${products.join(', ')}${override ? '  (overridden via --products)' : ''}`);
console.log(`Scopes (${scopes.length})     : ${scopes.join(' ')}`);
console.log('');
console.log('Open this URL, sign in as the impersonated user, and click Accept:');
console.log('');
console.log(`  ${consentUrl(products)}`);
console.log('');
console.log('If consent fails on a scope your account is not entitled to, drop that');
console.log('product from DS_PRODUCTS in .env and re-run.');
console.log('');
