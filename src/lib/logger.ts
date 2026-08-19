import fs from 'node:fs';
import path from 'node:path';
import { pino, destination, multistream, type Level, type StreamEntry } from 'pino';

const LOG_DIR = path.resolve(process.cwd(), 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

/**
 * Keys whose values must never reach the log file. DocuSign responses are full
 * of signer names/emails and the token endpoint returns bearer tokens, so we
 * redact by key name rather than trying to sniff values.
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'headers.authorization',
  'authorization',
  'access_token',
  'accessToken',
  'assertion',
  'privateKey',
  'body.assertion',
  '*.email',
  '*.signerEmail',
  '*.userName',
  '*.signerName',
  '*.recipientEmail',
];

// stdio transport must keep stdout clean for JSON-RPC, so in that mode every
// log line goes to the file only.
const stdioMode = process.env.ZW_MCP_TRANSPORT === 'stdio';

const fileStream = destination({
  dest: path.join(LOG_DIR, 'zw-mcp.log'),
  append: true,
  sync: false,
});

const streams: StreamEntry[] = [{ level: 'trace', stream: fileStream }];
if (!stdioMode) {
  streams.push({
    level: (process.env.LOG_LEVEL as Level) ?? 'info',
    stream: process.stdout,
  });
}

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? 'info',
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    base: { svc: 'zw-mcp' },
  },
  multistream(streams),
);

export type Logger = typeof logger;
