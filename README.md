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

A scope the account is not entitled to fails the *entire* consent grant, and
DocuSign will record a consent that silently omits it -- so "I clicked Accept" is
not proof a scope works. When a product returns `consent_required`, run:

```bash
npm run scopecheck        # probes every scope individually, ✅/❌ per scope
```

That pinpoints the offending scope instead of guessing at a whole product's set.
Read it in the negative direction only: DocuSign silently ignores unknown scopes,
so a ✅ does not prove a scope is real -- but `consent_required` does prove it is
recognised and simply not yet granted.
Then drop it (or the product) from `DS_PRODUCTS` and re-run consent. This is not
hypothetical: Navigator's documented-best-practice `models_read` scope is not
grantable on the Woodward Systems demo account, and including it broke every
Navigator call until `scopecheck` isolated it.

To consent for a later phase's scopes in the same click:

```bash
npm run consent -- --products esign,navigator,maestro
```

## Connecting clients

All three need an HTTPS URL from outside this machine; see **Remote access** below.
Locally, `http://127.0.0.1:8787/mcp` works.

### Claude Code

On this machine:

```bash
claude mcp add zw-mcp \
  --transport http \
  --scope user \
  http://127.0.0.1:8787/mcp \
  --header "Authorization: Bearer <ZW_MCP_TOKEN>"
```

From another machine on the LAN, swap in the host's address:

```bash
claude mcp add zw-mcp \
  --transport http \
  --scope user \
  http://ZWs-Mac-mini.local:8787/mcp \
  --header "Authorization: Bearer <ZW_MCP_TOKEN>"
```

### Claude Desktop

Settings -> Connectors -> **Add custom connector**:

- **Name**: `ZW MCP`
- **URL**: `http://ZWs-Mac-mini.local:8787/mcp` (or `http://127.0.0.1:8787/mcp` on the host itself)
- **Header**: `Authorization: Bearer <ZW_MCP_TOKEN>`

Or edit `~/Library/Application Support/Claude/claude_desktop_config.json` directly:

```json
{
  "mcpServers": {
    "zw-mcp": {
      "type": "http",
      "url": "http://ZWs-Mac-mini.local:8787/mcp",
      "headers": { "Authorization": "Bearer <ZW_MCP_TOKEN>" }
    }
  }
}
```

### claude.ai and Claude Cowork

Settings -> Connectors -> **Add custom connector**:

- **URL**: `https://zws-mac-mini.tail9e5da0.ts.net/mcp`
- **Header**: `Authorization: Bearer <ZW_MCP_TOKEN>`

Both connect from Anthropic's servers, not from your browser or machine, so they
need a **public HTTPS URL**. A LAN IP, `*.local` name, `localhost`, or a
tailnet-only Tailscale *Serve* address will not work for them -- only *Funnel*
(or another public tunnel) does. See **Remote access**.

Verified reachable from outside the tailnet: `GET /health` returns 200 from
Anthropic's infrastructure, `POST /mcp` without a bearer returns 401, and with one
returns all 84 tools. Port 8788 (the admin console) is deliberately NOT funnelled.

### Your own app (Claude Agent SDK)

The Agent SDK runs in **your** process, so it reaches ZW MCP over localhost or the
LAN with no tunnel:

```ts
mcpServers: {
  'zw-mcp': {
    type: 'http',
    url: 'http://127.0.0.1:8787/mcp',
    headers: { Authorization: `Bearer ${process.env.ZW_MCP_TOKEN}` },
  },
},
allowedTools: ['mcp__zw-mcp__*'],
```

A runnable starter is in [`examples/agent-sdk/`](examples/agent-sdk/). This is the
pattern the skinned demo UIs use -- they hold no Docusign logic, just a URL and a
token.

### MCP Inspector (debugging)

```bash
npx @modelcontextprotocol/inspector          # then point it at /mcp with the bearer header
npx @modelcontextprotocol/inspector npx tsx src/stdio.ts   # or drive the stdio entrypoint
```

## Remote access

Which clients can reach ZW MCP depends on where the client actually runs:

| Client | Runs where | LAN IP works? |
| --- | --- | --- |
| Claude Code | your machine | ✅ |
| Claude Desktop | your machine | ✅ |
| claude.ai custom connector | Anthropic's servers | ❌ needs public HTTPS |
| Claude Cowork | Anthropic's servers | ❌ needs public HTTPS |

**This is the trap.** Tailscale *Serve* publishes to your tailnet only, so it works
for Claude Desktop and Claude Code but NOT for claude.ai or Cowork -- those connect
from Anthropic's infrastructure, which is not on your tailnet and cannot resolve a
`*.ts.net` name. For those you need genuinely public HTTPS: Tailscale **Funnel**,
Cloudflare Tunnel, or similar.

### LAN access (no tunnel)

`HOST=0.0.0.0` in `.env` makes the server reachable from other machines on your
network at `http://<lan-ip>:8787/mcp`. Every request still requires the
`ZW_MCP_TOKEN` bearer, which is exactly what that token is for -- an unauthenticated
request gets a `401`.

Set `HOST=127.0.0.1` to restrict it to this machine again.

### Public HTTPS (for claude.ai / Cowork) -- Tailscale Funnel

Do **not** raw port-forward. This host uses Tailscale Funnel, which terminates TLS
and gives a real public hostname:

```
https://zws-mac-mini.tail9e5da0.ts.net/mcp
```

Setup, for reference or rebuilding:

```bash
brew install tailscale        # CLI formula; the GUI cask needs an interactive sudo password

# Userspace mode needs no root. Funnel works fine this way.
tailscaled --tun=userspace-networking \
  --socket=$HOME/.tailscale/tailscaled.sock \
  --statedir=$HOME/.tailscale/state &

tailscale --socket=$HOME/.tailscale/tailscaled.sock up --hostname=zws-mac-mini
tailscale --socket=$HOME/.tailscale/tailscaled.sock funnel --bg 8787
```

Two things must be enabled in the Tailscale **admin console** first, or the funnel
command hangs silently with no error:

1. **HTTPS Certificates** -- https://login.tailscale.com/admin/dns
2. **The `funnel` node attribute** -- https://login.tailscale.com/admin/acls:

```json
"nodeAttrs": [
  {"target": ["autogroup:member"], "attr": ["funnel"]}
]
```

Check both landed with:

```bash
tailscale --socket=$HOME/.tailscale/tailscaled.sock status --json \
  | python3 -c "import sys,json; d=json.load(sys.stdin); \
      print('funnel:', any('funnel' in str(c).lower() for c in (d['Self'].get('CapMap') or {}))); \
      print('certs :', d.get('CertDomains'))"
```

**The daemon does not survive a reboot** -- it runs as a background user process,
not a service. Relaunch the `tailscaled` line above after a restart, or add a
launchd agent for it alongside the other two.

Tunnel **8787 only**. Never tunnel 8788: the admin console has no password and can
send and void envelopes.

Behind a public tunnel, `ZW_MCP_TOKEN` is the only thing between the internet and
your Docusign account. Rotate it before going public:

```bash
openssl rand -hex 32      # put in .env, then:
launchctl kickstart -k gui/$(id -u)/com.zw.mcp
```

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

Two agents: the MCP server and the admin console. They are separate so either can
be restarted alone.

```bash
npm run build
cp launchd/com.zw.mcp.plist launchd/com.zw.mcp.admin.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.zw.mcp.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.zw.mcp.admin.plist
```

Verify:

```bash
launchctl print gui/$(id -u)/com.zw.mcp | grep -E 'state|pid'
launchctl print gui/$(id -u)/com.zw.mcp.admin | grep -E 'state|pid'
curl -s http://127.0.0.1:8787/health | jq .status
```

After a rebuild (`npm run build` writes `dist/`, which is what launchd runs):

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.zw.mcp
launchctl kickstart -k gui/$(id -u)/com.zw.mcp.admin
```

To stop or remove:

```bash
launchctl bootout gui/$(id -u)/com.zw.mcp
launchctl bootout gui/$(id -u)/com.zw.mcp.admin
```

Both have `KeepAlive` (restarted if they die) and `ThrottleInterval` 10s, so a bad
`.env` backs off instead of hot-looping.

The admin plist sets `ADMIN_BIND=0.0.0.0` and `ADMIN_ALLOW_INSECURE=1`, making the
console reachable at `http://ZWs-Mac-mini.local:8788` with no password. That is a
deliberate choice for a demo account -- see the warning under **Admin console**.

Logs: `logs/zw-mcp.log` (structured, redacted), `logs/launchd.{out,err}.log`, and
`logs/launchd.admin.{out,err}.log`.

## Admin console

A local operations console for seeing what exists, exercising it, and tracking
what is left:

```bash
npm run dev      # terminal 1 -- ZW MCP on :8787
npm run admin    # terminal 2 -- console on :8788
open http://127.0.0.1:8788
```

Four tabs:

- **Status** -- server health, token expiry, granted scopes, resolved account and
  organization, plus a per-product card. "Probe every product" fires one cheap
  read-only tool per API and turns each card green or red, which is `npm run smoke`
  with a UI.
- **Tools** -- every registered tool grouped by product, filterable, each showing
  its model-facing description and full JSON input schema.
- **Run** -- pick any tool, edit its arguments as JSON (pre-filled from the schema
  defaults), execute it, and read the result with timing.
- **Next** -- phase status, open items with the action each needs, and the
  standing gotchas worth remembering.

It is a **separate app** on purpose. ZW MCP itself stays UI-free (see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §7), and the console drives it over
exactly the same bearer-authed `/mcp` endpoint that Claude Desktop or claude.ai
uses -- so anything the console can do, a real MCP client can do. The bearer token
stays in the console's server process and never reaches the browser.

### Reaching the console from other machines

By default the console binds `127.0.0.1`. To open it to your LAN:

```bash
npm run admin:lan          # binds 0.0.0.0, no password (ADMIN_ALLOW_INSECURE=1)
```

Then browse to `http://<mac-mini-lan-ip>:8788` or `http://ZWs-Mac-mini.local:8788`.

**Understand what that exposes.** The console holds the ZW MCP bearer token
server-side and its Run tab can send and void real envelopes, so reaching the
console is reaching DocuSign. On a trusted LAN with a demo account that is a
reasonable trade; with a production account it is not.

The server **fails closed**: binding anywhere but loopback without a password
refuses to start unless you set `ADMIN_ALLOW_INSECURE=1`, so it can never be
exposed by accident. To add a password instead:

```bash
ADMIN_BIND=0.0.0.0 ADMIN_PASSWORD=$(openssl rand -hex 24) npm run admin
# browser prompts for HTTP Basic; default user is "zw" (override with ADMIN_USER)
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `ADMIN_PORT` | `8788` | Listen port |
| `ADMIN_BIND` | `127.0.0.1` | Bind address; `0.0.0.0` for LAN |
| `ADMIN_PASSWORD` | _(unset)_ | Enables HTTP Basic auth |
| `ADMIN_USER` | `zw` | Basic auth username |
| `ADMIN_ALLOW_INSECURE` | _(unset)_ | Deliberately skip auth on a non-loopback bind |
| `ZW_MCP_URL` | `http://$HOST:$PORT/mcp` | Which ZW MCP to drive |

Basic auth over plain HTTP base64-encodes credentials rather than encrypting
them. For anything leaving your network, put Tailscale Serve in front (see
**Remote access**) rather than relying on that.

## MCP resources and prompts

Beyond tools, the server exposes:

- `docusign://overview` -- the product map: every API, its tool prefix, whether it
  is enabled, and how the two tiers work. Start here.
- `docusign://apis/<product>` -- a per-API cheat sheet: base URI, path shape,
  scopes, curated tool list, and the raw hatch.
- `demo_context` (prompt) -- loads the live demo board at the start of a session:
  account and organization, enabled APIs, most-used eSignature templates, envelope
  count for the last 30 days, a Navigator agreement-type breakdown, active Maestro
  workflows, and CLM reachability. Every lookup is best-effort and degrades to a
  note, so an unentitled product never fails the prompt.

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
| `npm run scopecheck` | Probe each OAuth scope individually to find one the account has not granted |
| `npm run admin` | Admin console on :8788, loopback only |
| `npm run admin:lan` | Admin console bound to `0.0.0.0`, no password |
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
admin/              local ops console (separate app; ZW MCP stays UI-free)
examples/agent-sdk/ minimal Claude Agent SDK app -- the pattern demo skins use
specs/              verified base-path/scope tables, vendored OpenAPI specs
scripts/            consent.ts, smoke.ts
launchd/            com.zw.mcp.plist
docs/ARCHITECTURE.md
```
