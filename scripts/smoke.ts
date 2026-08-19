/**
 * Calls one cheap read-only endpoint per enabled product and prints a pass/fail
 * table. This is the per-phase acceptance check: if a product's row is red, its
 * scope, base URI or entitlement is wrong and no curated tool for it will work.
 */
import { loadConfig } from '../src/lib/config.js';
import { getAccessToken, getAccount, tokenStatus } from '../src/auth/jwt.js';
import { apiRequest } from '../src/clients/base.js';
import { PRODUCTS, type ProductId } from '../src/clients/products.js';

interface Probe {
  path: string;
  query?: Record<string, string | number>;
  /** Short description of what a pass proves. */
  proves: string;
}

/** One cheap GET per product. Deliberately read-only -- smoke never mutates. */
const PROBES: Partial<Record<ProductId, Probe>> = {
  esign: {
    path: '/v2.1/accounts/{accountId}',
    proves: 'account read',
  },
  navigator: {
    path: '/v1/accounts/{accountId}/agreements',
    query: { limit: 1 },
    proves: 'agreement search',
  },
  maestro: {
    path: '/v1/accounts/{accountId}/workflows',
    proves: 'workflow list',
  },
  webforms: {
    path: '/v1.1/accounts/{accountId}/forms',
    query: { limit: 1 },
    proves: 'form list',
  },
  rooms: { path: '/v2/accounts/{accountId}/rooms', query: { count: 1 }, proves: 'room list' },
  click: { path: '/v1/accounts/{accountId}/clickwraps', proves: 'clickwrap list' },
  monitor: { path: '/stream', query: { limit: 1 }, proves: 'event stream' },
  notary: { path: '/restapi/v1/accounts/{accountId}/notary/journals', proves: 'notary journal' },
  connectedfields: {
    path: '/v1/accounts/{accountId}/connected-fields/tab-groups',
    proves: 'tab groups',
  },
  workspaces: { path: '/v1/accounts/{accountId}/workspaces', proves: 'workspace list' },
};

function pad(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n);
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const products = cfg.products as ProductId[];

  console.log(`\nZW MCP smoke test -- ${cfg.DS_ENVIRONMENT} environment\n`);

  try {
    await getAccessToken();
    const account = await getAccount();
    const t = tokenStatus();
    console.log(`Account : ${account.accountName} (${account.accountId})`);
    console.log(`Base URI: ${account.baseUri}`);
    console.log(`Token   : expires ${t.expiresAt}, ${t.scopes.length} scopes granted\n`);
  } catch (err) {
    console.error(`❌ auth failed: ${(err as Error).message}\n`);
    process.exit(1);
  }

  console.log(`${pad('PRODUCT', 16)} ${pad('PROBE', 30)} RESULT`);
  console.log('-'.repeat(78));

  let failures = 0;
  for (const id of products) {
    const probe = PROBES[id];
    if (!probe) {
      console.log(`${pad(id, 16)} ${pad('(no probe defined)', 30)} ➖ skipped`);
      continue;
    }
    try {
      await apiRequest(id, { method: 'GET', path: probe.path, query: probe.query });
      console.log(`${pad(id, 16)} ${pad(probe.proves, 30)} ✅`);
    } catch (err) {
      failures += 1;
      const msg = (err as Error).message.replace(/\s+/g, ' ').slice(0, 100);
      console.log(`${pad(id, 16)} ${pad(probe.proves, 30)} ❌ ${msg}`);
    }
  }

  console.log('-'.repeat(78));
  console.log(
    `${products.length} product(s) enabled, ${failures} failing. ` +
      `Products not enabled: ${Object.keys(PRODUCTS)
        .filter((p) => !products.includes(p as ProductId))
        .join(', ') || '(none)'}\n`,
  );
  process.exit(failures > 0 ? 1 : 0);
}

void main();
