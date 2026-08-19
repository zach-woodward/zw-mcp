import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiRequest, baseUriFor } from '../clients/base.js';
import { guard, ok, pick } from '../lib/respond.js';

const WORKFLOWS = '/v1/accounts/{accountId}/workflows';

interface ListResponse<T = Record<string, unknown>> {
  data?: T[];
  response_metadata?: Record<string, unknown>;
}

interface TriggerRequirements {
  trigger_id?: string;
  trigger_event_type?: string;
  trigger_http_config?: { method?: string; url?: string };
  trigger_input_schema?: Array<{ field_name?: string; field_data_type?: string }>;
}

const WORKFLOW_KEYS = ['id', 'name', 'status', 'account_id'] as const;
/**
 * Field names taken from a live instance, not the spec: the OpenAPI document
 * models an instance as instance_name/instance_state/workflow_id, but the API
 * actually returns name/workflow_status/template_id. Projecting on the spec's
 * names silently returned near-empty objects.
 * VERIFIED 2026-08-19 against demo account b99e0abc-… (live instance payload).
 */
const INSTANCE_KEYS = [
  'id',
  'name',
  'workflow_status',
  'template_id',
  'started_at',
  'ended_at',
  'expires_at',
  'last_modified_at',
] as const;

/**
 * The trigger endpoint's URL comes from the workflow's own trigger requirements.
 * Older docs describe that URL as carrying `mtid`/`mtsec` query params minted at
 * publish time; the live API returns a plain /actions/trigger URL instead.
 * Honouring whatever the API hands back keeps us right either way.
 * VERIFIED 2026-08-19 against demo account b99e0abc-… (live response had no mtid/mtsec).
 */
async function resolveTriggerPath(workflowId: string): Promise<string> {
  const reqs = await apiRequest<TriggerRequirements>('maestro', {
    method: 'GET',
    path: `${WORKFLOWS}/${workflowId}/trigger-requirements`,
  });
  const url = reqs.trigger_http_config?.url;
  const base = await baseUriFor('maestro');
  if (url?.startsWith(base)) return url.slice(base.length);
  return `${WORKFLOWS}/${workflowId}/actions/trigger`;
}

export function registerMaestroTools(server: McpServer): void {
  server.registerTool(
    'maestro_list_workflows',
    {
      title: 'List Maestro workflow definitions',
      description:
        'List the Maestro (Workflow Builder) workflow definitions on this account with their ' +
        'IDs and status. Start here for anything workflow-related -- you need a workflow_id ' +
        'for every other maestro_* tool. Only workflows in "active" status can be triggered.',
      inputSchema: { verbose: z.boolean().default(false) },
    },
    guard(async (args) => {
      const res = await apiRequest<ListResponse>('maestro', { method: 'GET', path: WORKFLOWS });
      const data = res.data ?? [];
      return ok({
        count: data.length,
        workflows: args.verbose ? data : data.map((w) => pick(w, WORKFLOW_KEYS)),
      });
    }),
  );

  server.registerTool(
    'maestro_get_trigger_requirements',
    {
      title: 'Get a workflow\'s trigger inputs',
      description:
        'Describe what a workflow needs in order to start: the list of trigger input fields ' +
        'and their data types (String, Date, User, ...). ALWAYS call this before ' +
        'maestro_trigger_workflow so you supply the right field names -- they are defined by ' +
        'whoever built the workflow and cannot be guessed.',
      inputSchema: { workflow_id: z.string() },
    },
    guard(async (args) => {
      const reqs = await apiRequest<TriggerRequirements>('maestro', {
        method: 'GET',
        path: `${WORKFLOWS}/${args.workflow_id}/trigger-requirements`,
      });
      return ok({
        trigger_id: reqs.trigger_id,
        trigger_event_type: reqs.trigger_event_type,
        inputs: (reqs.trigger_input_schema ?? []).map((f) => ({
          name: f.field_name,
          type: f.field_data_type,
        })),
      });
    }),
  );

  server.registerTool(
    'maestro_trigger_workflow',
    {
      title: 'Trigger a Maestro workflow',
      description:
        'Start a new instance of a published workflow. Pass trigger_inputs as an object keyed ' +
        'by the field names from maestro_get_trigger_requirements. Returns the instance ID and ' +
        'a workflow URL that can be embedded in an iframe to present the first step to a user. ' +
        'This starts real work (it can send envelopes) -- confirm with the user first.',
      inputSchema: {
        workflow_id: z.string(),
        instance_name: z.string().describe('A human-readable name for this run.'),
        trigger_inputs: z
          .record(z.string(), z.unknown())
          .default({})
          .describe('Field name -> value, matching the workflow\'s trigger input schema.'),
      },
    },
    guard(async (args) => {
      const path = await resolveTriggerPath(args.workflow_id);
      const res = await apiRequest<Record<string, unknown>>('maestro', {
        method: 'POST',
        path,
        body: { instance_name: args.instance_name, trigger_inputs: args.trigger_inputs },
      });
      return ok(res);
    }),
  );

  server.registerTool(
    'maestro_list_instances',
    {
      title: 'List workflow instances',
      description:
        'List the runs of a workflow with their state and timestamps. Use to answer "is that ' +
        'workflow still running", "how many procurement requests are in flight".',
      inputSchema: { workflow_id: z.string(), verbose: z.boolean().default(false) },
    },
    guard(async (args) => {
      const res = await apiRequest<ListResponse>('maestro', {
        method: 'GET',
        path: `${WORKFLOWS}/${args.workflow_id}/instances`,
      });
      const data = res.data ?? [];
      return ok({
        count: data.length,
        instances: args.verbose ? data : data.map((i) => pick(i, INSTANCE_KEYS)),
      });
    }),
  );

  server.registerTool(
    'maestro_get_instance',
    {
      title: 'Get one workflow instance',
      description:
        'Fetch the full state of a single workflow run, including which step it is on and the ' +
        'values collected so far. Use to diagnose a stuck workflow.',
      inputSchema: { workflow_id: z.string(), instance_id: z.string() },
    },
    guard(async (args) =>
      ok(
        await apiRequest('maestro', {
          method: 'GET',
          path: `${WORKFLOWS}/${args.workflow_id}/instances/${args.instance_id}`,
        }),
      ),
    ),
  );

  server.registerTool(
    'maestro_cancel_instance',
    {
      title: 'Cancel a running workflow instance',
      description:
        'Cancel one in-flight run of a workflow. Affects only that instance, not the workflow ' +
        'definition. Irreversible -- confirm with the user before calling.',
      inputSchema: { workflow_id: z.string(), instance_id: z.string() },
    },
    guard(async (args) => {
      const res = await apiRequest('maestro', {
        method: 'POST',
        path: `${WORKFLOWS}/${args.workflow_id}/instances/${args.instance_id}/actions/cancel`,
        body: {},
      });
      return ok(res ?? { instance_id: args.instance_id, cancelled: true });
    }),
  );

  server.registerTool(
    'maestro_pause_workflow',
    {
      title: 'Pause new instances of a workflow',
      description:
        'Stop a workflow from starting NEW instances. Runs already in flight continue. Use ' +
        'this to take a workflow out of service without deleting it; reverse with ' +
        'maestro_resume_workflow.',
      inputSchema: { workflow_id: z.string() },
    },
    guard(async (args) =>
      ok(
        await apiRequest('maestro', {
          method: 'POST',
          path: `${WORKFLOWS}/${args.workflow_id}/actions/pause`,
          body: {},
        }),
      ),
    ),
  );

  server.registerTool(
    'maestro_resume_workflow',
    {
      title: 'Resume a paused workflow',
      description: 'Allow a paused workflow to start new instances again.',
      inputSchema: { workflow_id: z.string() },
    },
    guard(async (args) =>
      ok(
        await apiRequest('maestro', {
          method: 'POST',
          path: `${WORKFLOWS}/${args.workflow_id}/actions/resume`,
          body: {},
        }),
      ),
    ),
  );
}
