/**
 * Prints the one-time consent URL for the configured integration key + scopes.
 *
 * JWT Grant impersonation only works after the impersonated user has granted
 * consent once. Run `npm run consent`, open the URL, sign in AS THAT USER, Accept.
 */
import { consentUrl } from '../src/auth/jwt.js';
import { loadConfig } from '../src/lib/config.js';
import { scopesFor } from '../src/auth/scopes.js';

const cfg = loadConfig();
const scopes = scopesFor(cfg.products);

console.log('');
console.log('ZW MCP -- DocuSign consent');
console.log('==========================');
console.log(`Environment    : ${cfg.DS_ENVIRONMENT} (${cfg.authServer})`);
console.log(`Integration key: ${cfg.DS_INTEGRATION_KEY}`);
console.log(`Impersonated   : ${cfg.DS_USER_ID}`);
console.log(`Products       : ${cfg.products.join(', ')}`);
console.log(`Scopes (${scopes.length})     : ${scopes.join(' ')}`);
console.log('');
console.log('Open this URL, sign in as the impersonated user, and click Accept:');
console.log('');
console.log(`  ${consentUrl()}`);
console.log('');
console.log('If consent fails on a scope your account is not entitled to, drop that');
console.log('product from DS_PRODUCTS in .env and re-run.');
console.log('');
