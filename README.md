# ZW MCP

A universal DocuSign MCP server. One always-on service on the Mac mini exposing
**every DocuSign product API** -- eSignature, Navigator, CLM, Maestro, Web Forms,
Rooms, Click, Admin, Monitor, Notary, Connected Fields, Workspaces, Trust Records
-- to Claude Desktop, claude.ai, Claude Code, Claude Cowork, and the skinned demo
UIs that will front it later.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for diagrams and the design
rationale, and [`specs/BASE_PATHS.md`](specs/BASE_PATHS.md) for the verified base
URI and scope tables.

## Design in one paragraph

DocuSign has well over a thousand endpoints; one MCP tool each would drown every
client. So tools come in two tiers: **curated tools** (`esign_list_envelopes`,
`esign_create_envelope_from_template`, ...) hand-written for what demos actually
do, with trimmed responses and model-facing descriptions; and a **`<product>_raw_request`
escape hatch** per API that reaches every remaining endpoint with auth, base URI
and `{accountId}` substitution handled. Coverage is complete from day one.

## Setup

```bash
npm install
cp .env.example .env      # then fill it in -- see below
npm run consent           # prints the one-time consent URL; open it, click Accept
npm run smoke             # ✅/❌ table, one cheap call per enabled product
npm run dev               # tsx watch on :8787
```

### What goes in `.env`

| Variable | Where it comes from |
| --- | --- |
| `ZW_MCP_TOKEN` | You generate it: `openssl rand -hex 32`. Every MCP client sends it as a bearer token. |
| `DS_INTEGRATION_KEY` | DocuSign **Settings -> Apps and Keys -> your app -> Integration Key**. |
| `DS_USER_ID` | Same page, the **User ID** GUID of the user to impersonate. Not the account ID. |
| `DS_RSA_PRIVATE_KEY_PATH` | Path to the RSA **private** key you generate on that app. Save it outside git (`keys/` and `*.pem` are gitignored). |
| `DS_ACCOUNT_ID` | Optional -- auto-discovered from `/oauth/userinfo` when blank. |
| `DS_ENVIRONMENT` | `demo` (default) or `prod`. Flips every base URI at once. |
| `DS_PRODUCTS` | Comma-separated product list. Drives the consent scopes **and** which tools register. |

### Consent

JWT Grant impersonation only works after the impersonated user has consented once
per integration key. `npm run consent` prints the URL; open it, sign in **as that
user**, click Accept. The server also detects `consent_required` at startup and
prints the URL again.

A scope the account is not entitled to fails the *entire* consent grant. If
consent errors, remove the offending product from `DS_PRODUCTS` and re-run --
that is exactly why scopes are grouped per product.

## Connecting clients

All three need an HTTPS URL from outside this machine; see **Remote access** below.
Locally, `http://127.0.0.1:8787/mcp` works.

### Claude Code

```bash
claude mcp add zw-mcp \
  --transport http \
  --scope user \
  https://<your-tailnet-host>/mcp \
  --header "Authorization: Bearer <ZW_MCP_TOKEN>"
```

### Claude Desktop

Settings -> Connectors -> **Add custom connector**:

- **Name**: `ZW MCP`
- **URL**: `https://<your-tailnet-host>/mcp`
- **Header**: `Authorization: Bearer <ZW_MCP_TOKEN>`

Or edit `~/Library/Application Support/Claude/claude_desktop_config.json` directly:

```json
{
  "mcpServers": {
    "zw-mcp": {
      "type": "http",
      "url": "https://<your-tailnet-host>/mcp",
      "headers": { "Authorization": "Bearer <ZW_MCP_TOKEN>" }
    }
  }
}
```

### claude.ai

Settings -> Connectors -> **Add custom connector** -> paste
`https://<your-tailnet-host>/mcp` and add the `Authorization: Bearer <ZW_MCP_TOKEN>`
header. claude.ai **requires HTTPS** -- a bare `http://` or an IP address will not
be accepted, so the Tailscale step below is mandatory for this client.

### MCP Inspector (debugging)

```bash
npx @modelcontextprotocol/inspector          # then point it at /mcp with the bearer header
npx @modelcontextprotocol/inspector npx tsx src/stdio.ts   # or drive the stdio entrypoint
```

## Remote access

The server binds `127.0.0.1` on purpose. Do **not** port-forward it.

**Default -- Tailscale Serve** (private, tailnet-only HTTPS):

```bash
tailscale serve --bg 8787
tailscale serve status          # shows your https://<machine>.<tailnet>.ts.net URL
```

Only devices on your tailnet can reach that URL, and it already has a valid
HTTPS certificate -- which is what claude.ai's custom connectors require.

**Only if a genuinely public URL is ever needed -- Tailscale Funnel**:

```bash
tailscale funnel --bg 8787
```

That exposes the endpoint to the public internet. The bearer token becomes the
only thing standing in front of your DocuSign account, so rotate `ZW_MCP_TOKEN`
and prefer Serve.

## Always-on with launchd

```bash
npm run build
cp launchd/com.zw.mcp.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.zw.mcp.plist
launchctl print gui/$(id -u)/com.zw.mcp | head -20     # verify it is running
```

After a rebuild:

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.zw.mcp
```

To stop or remove it:

```bash
launchctl bootout gui/$(id -u)/com.zw.mcp
```

Logs land in `logs/zw-mcp.log` (structured, redacted) plus `logs/launchd.{out,err}.log`.

## Health

```bash
curl -s http://127.0.0.1:8787/health | jq
```

Reports uptime, environment, access-token expiry and granted scopes, the resolved
account, and the base URI of every enabled product. It is unauthenticated by
design so a monitor can poll it; it never returns the token itself.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | `tsx watch` on the HTTP server |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the built server |
| `npm run stdio` | stdio transport, for MCP Inspector / local debugging |
| `npm run consent` | Print the one-time DocuSign consent URL |
| `npm run smoke` | One cheap read per enabled product, ✅/❌ table |
| `npm run typecheck` | `tsc --noEmit` |

## Repository layout

```
src/
  index.ts          HTTP entrypoint: express, bearer auth, /mcp, /health
  stdio.ts          stdio entrypoint (debug)
  server.ts         MCP server assembly
  auth/jwt.ts       JWT Grant, token cache, userinfo discovery
  auth/scopes.ts    per-product OAuth scope sets
  clients/          products.ts (base URI registry) + base.ts (signed requests)
  tools/            per-product curated tools + raw.ts escape-hatch factory
  resources/        docusign://apis/* cheat sheets + demo_context prompt
  lib/              config, logging, response shaping and download handling
specs/              verified base-path/scope tables, vendored OpenAPI specs
scripts/            consent.ts, smoke.ts
launchd/            com.zw.mcp.plist
docs/ARCHITECTURE.md
```
