# DocuSign API base paths + scopes (verified reference)

Source of truth for `src/clients/products.ts`. Do not edit by guesswork -- re-verify
against the live pages below, which win over any vendored OpenAPI spec.

## Base URIs

VERIFIED 2026-08-19 https://developers.docusign.com/platform/api-endpoint-base-paths/

| API | Developer environment | Production |
| --- | --- | --- |
| eSignature (REST) | `https://demo.docusign.net/restapi/` | `https://{server}.docusign.net/restapi/` |
| eSignature (SOAP) | `https://demo.docusign.net/api/3.0/api.asmx/` | `https://www.docusign.net/api/3.0/api.asmx/` |
| Admin | `https://api-d.docusign.net/management/` | `https://api.docusign.net/management/` |
| Authentication | `https://account-d.docusign.com/` | `https://account.docusign.com/` |
| Click | `https://demo.docusign.net/restapi/` | `https://{server}.docusign.net/restapi/` |
| Connected Fields | `https://api-d.docusign.com/v1/` | `https://api.docusign.com/v1/` |
| ID Evidence | `https://proof-d.docusign.net/api/` | `https://{server}.proof.docusign.net/api/` |
| Maestro | `https://api-d.docusign.com/v1/` | `https://api.docusign.com/v1/` |
| Monitor | `https://lens-d.docusign.net/api/v2.0/datasets/monitor/` | `https://lens.docusign.net/api/v2.0/datasets/monitor/` |
| Navigator | `https://api-d.docusign.com/v1/` | `https://api.docusign.com/v1/` |
| Notary | `https://notary-d.docusign.net/` | `https://na-notary.docusign.net/` |
| Rooms | `https://demo.rooms.docusign.com/restapi/v2/` | `https://rooms.docusign.com/restapi/v2/` |
| Web Forms | `https://apps-d.docusign.com/` | `https://apps.docusign.com/` |
| Workspaces | `https://api-d.docusign.com/v1/` | `https://api.docusign.com/v1/` |
| CLM | discovered per account, e.g. `https://apiuatna11.springcm.com` | discovered per account |
| Trust Records | NOT in the table -- verify before Phase 3 | -- |

`{server}` in production is the account's data center (NA2, EU, CA, ...). Never
hardcode it: take `base_uri` from `/oauth/userinfo` once at startup and cache it.
That is exactly what `src/auth/jwt.ts` does, which is why prod "just works".

## Scopes

VERIFIED 2026-08-19 https://developers.docusign.com/platform/auth/reference/scopes/

| Scope | API |
| --- | --- |
| `signature` | eSignature REST (and the base scope Maestro/Monitor/Workspaces ride on) |
| `impersonation` | required by JWT Grant user impersonation, every product |
| `click.manage`, `click.send` | Click |
| `spring_read`, `spring_write`, `content` | CLM |
| `organization_read`, `group_read`, `permission_read`, `user_read`, `user_write`, `account_read`, `domain_read`, `identity_provider_read` | Admin |
| `dtr.rooms.read`, `dtr.rooms.write`, `dtr.documents.read`, `dtr.documents.write`, `dtr.profile.read`, `dtr.profile.write`, `dtr.company.read`, `dtr.company.write`, `room_forms` | Rooms (`dtr.rooms.*` + `dtr.documents.write` are shared with Workspaces) |
| `notary_read`, `notary_write` | Notary |
| `webforms_read`, `webforms_instance_read`, `webforms_instance_write` | Web Forms |
| `adm_store_unified_repo_read` | Navigator (and Connected Fields, alongside `signature`) |
| `models_read` | Navigator -- not required by any endpoint today, requested for forward-compatibility as documented best practice |
| `aow_manage` | Maestro |

VERIFIED 2026-08-19 https://developers.docusign.com/docs/maestro-api/how-to/trigger-workflow/
> "you must request the `signature` scope and one or more Maestro scopes ... the
> Maestro-specific `aow_manage` scope"

VERIFIED 2026-08-19 https://developers.docusign.com/docs/connected-fields-api/auth/
> Connected Fields needs `adm_store_unified_repo_read` **in addition to** `signature`.

### Still unverified (resolve before the phase that ships them)
- Monitor: no Monitor-specific scope appears in the scopes reference; assumed to
  ride on `signature` plus org access. Confirm in Phase 3.
- Trust Records: neither scope nor base path documented in the pages above.
  Confirm in Phase 3; may not be a separately addressable API.

## Maestro endpoints

VERIFIED 2026-08-19 Maestro API OpenAPI (beta) v1.0.7, servers `api-d.docusign.com` / `api.docusign.com`

| Operation | Method | Path |
| --- | --- | --- |
| GetWorkflowsList | GET | `/v1/accounts/{accountId}/workflows` |
| GetWorkflowTriggerRequirements | GET | `/v1/accounts/{accountId}/workflows/{workflowId}/trigger-requirements` |
| TriggerWorkflow | POST | `/v1/accounts/{accountId}/workflows/{workflowId}/actions/trigger` |
| getWorkflowInstancesList | GET | `/v1/accounts/{accountId}/workflows/{workflowId}/instances` |
| pauseNewWorkflowInstances | POST | `/v1/accounts/{accountId}/workflows/{workflowId}/actions/pause` |
| resumePausedWorkflow | POST | `/v1/accounts/{accountId}/workflows/{workflowId}/actions/resume` |
| getWorkflowInstance | GET | `/v1/accounts/{accountId}/workflows/{workflowId}/instances/{instanceId}` |
| cancelWorkflowInstance | POST | `/v1/accounts/{accountId}/workflows/{workflowId}/instances/{instanceId}/actions/cancel` |

Note: triggering is a two-step dance -- GET trigger-requirements returns a `url`
carrying `mtid`/`mtsec` query params minted at publish time, and the POST goes to
*that* URL, not to the `/actions/trigger` path directly.

---

## Findings from the vendored specs (2026-08-19)

Downloaded from https://github.com/docusign/OpenAPI-Specifications. These settle
three open questions from the build brief.

### 1. Click's base path is `/clickapi`, not `/restapi`

The docs base-path table lists Click under `https://demo.docusign.net/restapi/`.
The spec disagrees and the spec is specific:

```
click.rest.swagger-v2.json:  host = www.demo.docusign.net,  basePath = /clickapi
                             paths = /v1/accounts/{accountId}/clickwraps
```

`src/clients/products.ts` uses `{base_uri}/clickapi`. The docs table is treated as
imprecise here -- it groups Click with eSignature because they share a host.

### 2. "Workflow Builder API" is Maestro renamed, not a distinct API

The brief asked to verify this. Diffing the two specs:

- `maestro.rest.swagger-v1.0.0.json` -- title "Maestro API", version 1.0.7
- `workflowbuilder.rest.swagger-1.0.0.json` -- title "Workflow Builder API", version 1.0.0

Both declare **the same 8 paths** on **the same servers** (`api.docusign.com`,
`api-d.docusign.com`), with zero divergence. So ZW MCP ships one product entry,
`maestro`, and no separate `workflowbuilder` product. Revisit only if the two
specs ever diverge.

### 3. Monitor: the spec and the docs table describe different API generations

| Source | Host | Path |
| --- | --- | --- |
| Docs base-path table | `lens-d.docusign.net/api/v2.0/datasets/monitor` | `/stream` |
| `monitor.rest.swagger-v2.0.json` | `api.docusign.com` (basePath `/`) | `/v1/organizations/{organizationId}/stream` |

Unresolved. The registry currently uses the docs table (lens-d) and Monitor is
marked `unverified`; settle it with a live call in Phase 3.

### Vendored spec inventory

| File | Version | Paths | Product |
| --- | --- | ---: | --- |
| `esignature.rest.swagger-v2.1.json` | Swagger 2.0 | 213 | eSignature |
| `admin.rest.swagger-v2.1.json` | Swagger 2.0 | 53 | Admin (basePath `/Management`) |
| `rooms.rest.swagger-v2.json` | Swagger 2.0 | 70 | Rooms (basePath `/restapi`, paths `/v2/...`) |
| `click.rest.swagger-v2.json` | Swagger 2.0 | 12 | Click |
| `webforms.rest.swagger-v1.1.0.json` | Swagger 2.0 | 5 | Web Forms (basePath `/api/webforms`) |
| `monitor.rest.swagger-v2.0.json` | Swagger 2.0 | 1 | Monitor |
| `navigator.rest.swagger.json` | OpenAPI 3.1.0 | 5 | Navigator |
| `maestro.rest.swagger-v1.0.0.json` | OpenAPI 3.1.0 | 8 | Maestro |
| `workflowbuilder.rest.swagger-1.0.0.json` | OpenAPI 3.0.3 | 8 | (duplicate of Maestro) |
| `workspaces.rest.swagger.json` | OpenAPI 3.0.4 | 16 | Workspaces |
| `connected-fields.rest.swagger.json` | OpenAPI 3.1.0 | 1 | Connected Fields |
| `agreementmanager.rest.swagger-1.0.0.json` | OpenAPI 3.0.3 | 7 | Agreement Manager |
| `connect.schema-v2.json` | JSON Schema | -- | Connect webhook payloads |

**No spec is published for CLM, Notary, or Trust Records** -- those stay hand-built
from the Developer Center docs.

Note the repo mixes Swagger 2.0 and OpenAPI 3.x. `openapi-typescript` only reads
3.x, so generating types across the whole set needs a `swagger2openapi` conversion
step first. Deferred: the curated tools hand-type their own narrow projections,
and the value of generated types is mostly for future curation work, not runtime.


---

## CLM specifics (verified against a live UAT account)

VERIFIED 2026-08-19 against a live demo account (`{accountId}`), UAT.

CLM does not behave like the other products and does not use the shared client.

**Discovery.** `GET https://authuat.springcm.com/api/v2/{accountId}/account`
(prod: `auth.springcm.com`) with a token carrying `spring_read`/`spring_write`.
Live response keys:

```
Id, ApiBaseUrl, ApiBaseDownloadUrl, ApiBaseUploadUrl, SftpUrl,
WebLandingPageUrl, OfficeAddInUrl, DocumentPreviewUrl, EformUrl
```

There is **no** `TaskApiUrl`: task endpoints live on `ApiBaseUrl`. There is also
no version field in the response.

**Version segment is `v2`.** The CLM swagger declares version v2 with paths
rooted at `/{accountId}/...`, so a full URL is
`{ApiBaseUrl}/v2/{accountId}/{resource}`. Empirically `v20180601`, `v201411` and
`v20160301` all 404 on this account; only `v2` routes.

**"Production account" in the docs means entitlement, not environment.** Every
CLM docs page says "Developing with the CLM API is only available for CLM
customers with a production account." A CLM-provisioned account works fine in
UAT. A 401 from discovery means the token lacks `spring_read`/`spring_write`.

**Path corrections over the SOAP-migration table**, which is misleading:

| Operation | SOAP-migration table says | Actually |
| --- | --- | --- |
| Folder by path | `GET /folders?path=` | `GET /folders/path?path=` (`/folders` is POST-only, so the former 405s) |
| System folder | not listed | `GET /folders/type?systemFolder=root\|home\|other sources\|salesforce` |
| Attribute groups | `GET /accounts/current/attributegroups` | `GET /attributegroups` (`/accounts/current` 404s) |

**Objects carry `Uid`, not `Id`.** Folder objects expose neither -- their id is
only the tail of `Href`. `idFromHref()` in `src/tools/clm.ts` handles both.

**Collections** use `pageSortParams.*` query params (`limit`, `offset`, `filter`,
`sortProperty`, `sortDirection`, `filterExact`, `caseInsensitive`). `filter` does
a contains-match by default and takes `Name=value` pairs.

**`expand` values are capitalised** (`AttributeGroups`, `Lock`, `Versions`,
`ParentFolder`, `Path`, `HistoryItems`). Lowercase is ignored. Note that `expand`
does NOT populate children on the `/folders/path` and `/folders/type` lookups --
child folders always need a second call to `/folders/{id}/folders`.

### Unresolved: full-text search body schema

`POST /{accountId}/documentsearchtasks` returns
`422 "No valid search parameters were found"` for every body shape tried
(`Query`, `FullText`, `Keyword`, `Name`, `DocumentName`, `SearchText`,
`FullTextSearch`, nested variants, folder-scoped variants). The swagger documents
the endpoint but not its request schema, and the Developer Center does not
publish it. `clm_search_documents` therefore does a NAME search over the folder
tree using documented collection filtering, and says so in its description.
Full-text search remains reachable via `clm_raw_request` once the schema is known.
