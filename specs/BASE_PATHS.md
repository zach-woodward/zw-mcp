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
| CLM | see CLM API 101 (per-account SpringCM host) | see CLM API 101 |
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
