import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';
import { z } from 'zod';
import { ALL_PRODUCTS } from '../auth/scopes.js';

const schema = z.object({
  // --- transport ---
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default('127.0.0.1'),
  ZW_MCP_TOKEN: z.string().min(16, 'ZW_MCP_TOKEN must be at least 16 chars'),
  LOG_LEVEL: z.string().default('info'),

  // --- DocuSign ---
  DS_ENVIRONMENT: z.enum(['demo', 'prod']).default('demo'),
  DS_INTEGRATION_KEY: z.string().min(1),
  DS_USER_ID: z.string().min(1, 'DS_USER_ID is the impersonated user GUID'),
  DS_RSA_PRIVATE_KEY_PATH: z.string().min(1),
  DS_AUTH_SERVER: z.string().optional(),
  DS_ACCOUNT_ID: z.string().optional(),
  /**
   * Comma-separated list of product APIs to enable. Drives both the consent-URL
   * scope union and which tool modules get registered, so an account without
   * (say) Rooms entitlement can still consent for everything else.
   */
  DS_PRODUCTS: z.string().default('esign'),

  DOWNLOAD_DIR: z.string().default('./downloads'),
});

export type RawConfig = z.infer<typeof schema>;

export interface Config extends RawConfig {
  authServer: string;
  products: string[];
  isDemo: boolean;
  downloadDir: string;
  privateKey: string;
}

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;

  // .env.example ships optional keys as bare `KEY=`, which dotenv surfaces as ''.
  // An empty string is not `undefined` to zod, so `.optional()` fields would hold
  // '' and silently defeat every `??` fallback below. Drop blanks up front.
  const present = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => v !== undefined && v.trim() !== ''),
  );

  const parsed = schema.safeParse(present);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid configuration. Copy .env.example to .env and fill it in.\n${issues}`,
    );
  }
  const env = parsed.data;

  const keyPath = path.resolve(process.cwd(), env.DS_RSA_PRIVATE_KEY_PATH);
  if (!fs.existsSync(keyPath)) {
    throw new Error(
      `RSA private key not found at ${keyPath}. Generate one in DocuSign ` +
        `(Settings -> Apps and Keys -> your app -> Generate RSA) and save the ` +
        `PRIVATE key there, or point DS_RSA_PRIVATE_KEY_PATH somewhere else.`,
    );
  }

  const downloadDir = path.resolve(process.cwd(), env.DOWNLOAD_DIR);
  fs.mkdirSync(downloadDir, { recursive: true });

  const products = env.DS_PRODUCTS.split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  const unknown = products.filter((p) => !ALL_PRODUCTS.includes(p));
  if (unknown.length) {
    throw new Error(
      `DS_PRODUCTS lists unknown product(s): ${unknown.join(', ')}. ` +
        `Known products: ${ALL_PRODUCTS.join(', ')}`,
    );
  }

  cached = {
    ...env,
    products,
    authServer:
      env.DS_AUTH_SERVER ??
      (env.DS_ENVIRONMENT === 'prod' ? 'account.docusign.com' : 'account-d.docusign.com'),
    isDemo: env.DS_ENVIRONMENT === 'demo',
    downloadDir,
    privateKey: fs.readFileSync(keyPath, 'utf8'),
  };
  return cached;
}

/** Test/reload hook -- forces the next loadConfig() to re-read the environment. */
export function resetConfig(): void {
  cached = null;
}
