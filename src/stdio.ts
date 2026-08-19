/**
 * Local debugging entrypoint. The HTTP transport in src/index.ts is the real
 * deployment; this exists so `npx @modelcontextprotocol/inspector` and a local
 * `claude mcp add` can drive the same server as a subprocess.
 *
 * Note ZW_MCP_TRANSPORT=stdio keeps the logger off stdout -- stdout is the
 * JSON-RPC channel here and any stray line corrupts the stream.
 */
process.env.ZW_MCP_TRANSPORT = 'stdio';

const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
const { buildServer } = await import('./server.js');
const { logger } = await import('./lib/logger.js');

const server = buildServer();
await server.connect(new StdioServerTransport());
logger.info('ZW MCP connected over stdio');
