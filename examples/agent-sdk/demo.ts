/**
 * Minimal Claude Agent SDK app that drives ZW MCP.
 *
 * This is the pattern the skinned demo UIs are meant to use: the app holds NO
 * Docusign logic -- no integration key, no JWT, no base URIs. It registers ZW MCP
 * as an MCP server and lets the agent call whichever of the 84 tools it needs.
 *
 * Crucially, the Agent SDK runs HERE, in your process. So it reaches ZW MCP over
 * localhost or your LAN directly -- no public tunnel, no HTTPS requirement. That
 * constraint only applies to cloud-hosted clients like claude.ai and Cowork.
 *
 * Run:
 *   npm install
 *   ZW_MCP_TOKEN=<token from ../../.env> npm start
 */
import { query } from '@anthropic-ai/claude-agent-sdk';

const ZW_MCP_URL = process.env.ZW_MCP_URL ?? 'http://127.0.0.1:8787/mcp';
const ZW_MCP_TOKEN = process.env.ZW_MCP_TOKEN;

if (!ZW_MCP_TOKEN) {
  console.error(
    'ZW_MCP_TOKEN is required.\n' +
      "  export ZW_MCP_TOKEN=$(grep '^ZW_MCP_TOKEN=' ../../.env | cut -d= -f2)",
  );
  process.exit(1);
}

const prompt =
  process.argv.slice(2).join(' ') ||
  'Which agreements expire in the next 120 days, and which of those auto-renew? ' +
    'Give me a short list with the counterparty and the notice deadline.';

for await (const message of query({
  prompt,
  options: {
    mcpServers: {
      // The server name here determines the tool prefix the agent sees:
      // "zw-mcp" -> mcp__zw-mcp__nav_expiring_agreements, and so on.
      'zw-mcp': {
        type: 'http',
        url: ZW_MCP_URL,
        headers: { Authorization: `Bearer ${ZW_MCP_TOKEN}` },
      },
    },
    // Without this the agent can SEE the tools but is not allowed to call them.
    // The wildcard grants exactly this one server and nothing else.
    allowedTools: ['mcp__zw-mcp__*'],
  },
})) {
  if (message.type === 'system' && message.subtype === 'init') {
    const servers = message.mcp_servers ?? [];
    for (const s of servers) console.log(`[mcp] ${s.name}: ${s.status}`);
    const tools = (message.tools ?? []).filter((t: string) => t.startsWith('mcp__'));
    console.log(`[mcp] ${tools.length} tools available`);
    const unusable = servers.filter(
      (s: { status: string }) => s.status === 'failed' || s.status === 'needs-auth',
    );
    if (unusable.length) console.warn('[mcp] unusable servers:', unusable);
  }

  if (message.type === 'assistant') {
    for (const block of message.message.content) {
      if (block.type === 'tool_use' && block.name.startsWith('mcp__')) {
        console.log(`[tool] ${block.name}`);
      }
    }
  }

  if (message.type === 'result' && message.subtype === 'success') {
    console.log('\n--- result ---\n');
    console.log(message.result);
  }
}
