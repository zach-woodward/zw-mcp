import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { DocuSignApiError } from '../clients/base.js';
import { ConsentRequiredError } from '../auth/jwt.js';

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

/** Successful tool result. Objects are pretty-printed; strings pass through. */
export function ok(data: unknown): ToolResult {
  const text =
    typeof data === 'string' ? data : JSON.stringify(data, null, 2) ?? String(data);
  return { content: [{ type: 'text', text }] };
}

/**
 * Error tool result. MCP clients show this to the model rather than aborting, so
 * the text is written to be actionable: what failed, and what to try instead.
 */
export function fail(err: unknown): ToolResult {
  if (err instanceof ConsentRequiredError) {
    logger.error('consent required');
    return { content: [{ type: 'text', text: err.message }], isError: true };
  }
  if (err instanceof DocuSignApiError) {
    logger.warn({ status: err.status, path: err.path }, 'docusign api error surfaced to client');
    return {
      content: [
        {
          type: 'text',
          text:
            `${err.message}\n\n` +
            JSON.stringify(err.detail, null, 2).slice(0, 4000),
        },
      ],
      isError: true,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ err: message }, 'tool error');
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Wraps a tool handler so no exception ever escapes as a transport-level error. */
export function guard<A>(fn: (args: A) => Promise<ToolResult>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return await fn(args);
    } catch (err) {
      return fail(err);
    }
  };
}

/** Narrow an object to the listed keys, dropping undefined values. */
export function pick<T extends Record<string, unknown>, K extends keyof T>(
  obj: T | undefined | null,
  keys: readonly K[],
): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  if (!obj) return out;
  for (const k of keys) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

/** Filesystem-safe filename fragment. */
function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'file';
}

/**
 * Writes a binary payload to ./downloads and returns its absolute path.
 *
 * Tools return this path instead of base64: a signed PDF is routinely megabytes,
 * and dropping that into an MCP response burns the client's whole context window.
 */
export function saveDownload(filename: string, data: Buffer): string {
  const cfg = loadConfig();
  const target = path.join(cfg.downloadDir, slug(filename));
  fs.writeFileSync(target, data);
  logger.info({ target, bytes: data.length }, 'saved download');
  return target;
}
