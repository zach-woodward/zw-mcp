# ZW MCP + Claude Agent SDK

The pattern the skinned demo UIs use: your app owns the UI and the agent loop;
ZW MCP owns everything Docusign. This example holds no integration key, no JWT,
no base URIs -- just a URL and a bearer token.

## Why this needs no tunnel

The Agent SDK runs **in your process**, on your machine. It reaches ZW MCP over
`127.0.0.1` or your LAN address directly.

The public-HTTPS requirement applies only to **cloud-hosted** clients --
claude.ai and Claude Cowork connect from Anthropic's servers, which cannot route
to a private address. Anything you build yourself with the Agent SDK sidesteps
that entirely.

## Run it

```bash
npm install
export ZW_MCP_TOKEN=$(grep '^ZW_MCP_TOKEN=' ../../.env | cut -d= -f2)
npm start
# or with your own question:
npm start "Show me the Procurement Request workflow and its trigger inputs"
```

You also need Anthropic credentials for the agent itself (`ant auth login`, or
`ANTHROPIC_API_KEY`). That is separate from `ZW_MCP_TOKEN`: one authenticates you
to Claude, the other authenticates your app to ZW MCP.

## The two things that matter

```ts
mcpServers: {
  'zw-mcp': {
    type: 'http',                                  // streamable HTTP
    url: 'http://127.0.0.1:8787/mcp',
    headers: { Authorization: `Bearer ${token}` },
  },
},
allowedTools: ['mcp__zw-mcp__*'],                  // without this, tools are visible but unusable
```

The server name you choose becomes the tool prefix: `zw-mcp` gives
`mcp__zw-mcp__nav_expiring_agreements`.

## Notes for building a real skin

- **Tool search is on by default**, which matters here: 84 tool definitions would
  otherwise eat a large slice of the context window. Definitions load on demand.
- **Tool results over 25,000 tokens** get written to a file and replaced with a
  path. ZW MCP already trims responses and writes PDFs to disk rather than
  returning base64, so you should rarely hit this.
- **Keep the bearer token server-side.** In a web app, the Agent SDK belongs in
  your backend, not the browser.
- **Scope the tools.** `mcp__zw-mcp__*` grants all 84. A procurement skin might
  allow only `mcp__zw-mcp__nav_*`, `mcp__zw-mcp__maestro_*` and the read-only
  eSignature tools, so the agent cannot void an envelope mid-demo.
