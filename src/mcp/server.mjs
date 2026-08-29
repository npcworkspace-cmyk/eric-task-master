import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { BEHAVIOR_MODES, BROWSER_ENGINES, PROFILE_KINDS, VERSION } from '../contracts.mjs';
import { TaskMasterClientError, toPublicError } from './errors.mjs';
import {
  MAX_ARTIFACT_CHUNK_BYTES,
  assertResultBound,
  publicArtifact,
  publicArtifactRead,
  publicProfile,
  publicStatus,
  publicTask,
  publicTaskPack,
  publicTaskType
} from './public-view.mjs';
import { assertSafeTaskInput, assertTaskMasterClient } from './taskmaster-client.mjs';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

const IdentifierSchema = z.string().regex(IDENTIFIER);
const IdempotencyKeySchema = z.string().regex(IDEMPOTENCY_KEY);
const JsonObjectSchema = z.record(z.string().max(128), z.json());
const HttpUrlSchema = z.string().url().max(4_096).refine((value) => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}, { message: 'URL must use HTTP or HTTPS' });
const RESUME_NOTICE = 'Inspect the checkpoint and current site state before repeating any action whose external outcome is unknown.';

const PublicErrorSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  nextAction: z.string().optional(),
  requestId: z.string().optional(),
  details: z.json().optional()
});

const ProfileSchema = z.strictObject({
  id: z.string(),
  name: z.string().optional(),
  kind: z.enum(PROFILE_KINDS).optional(),
  state: z.string().optional(),
  defaultBehavior: z.string().optional(),
  headless: z.boolean().optional(),
  browserEngine: z.enum(BROWSER_ENGINES).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  lastUsedAt: z.string().nullable().optional(),
  lastOpenedAt: z.string().nullable().optional()
});

const ProgressSchema = z.strictObject({
  current: z.number().optional(),
  total: z.number().optional(),
  percent: z.number().optional(),
  phase: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).optional(),
  message: z.string().optional(),
  updatedAt: z.string().optional()
});

const CleanupSchema = z.strictObject({
  browserClosed: z.boolean().optional(),
  leaseReleased: z.boolean().optional(),
  workerExited: z.boolean().optional(),
  settled: z.boolean().optional(),
  managerRestartObserved: z.boolean().optional()
});

const DiagnosticSchema = z.strictObject({
  kind: z.literal('screenshot'),
  reason: z.string().optional(),
  at: z.string().optional(),
  artifactsAvailable: z.literal(true)
});
const ObservationSchema = z.strictObject({
  kind: z.literal('semantic-observation'),
  reason: z.string().optional(),
  at: z.string().optional(),
  artifactsAvailable: z.literal(true)
});

const AttemptHistorySchema = z.strictObject({
  attempt: z.number().int(),
  resumed: z.boolean().optional(),
  behavior: z.enum(BEHAVIOR_MODES).optional(),
  state: z.string().optional(),
  errorCode: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  checkpointSavedAt: z.string().optional()
});

const EvidenceSchema = z.strictObject({
  kind: z.enum(['artifact', 'count', 'hash', 'message', 'note', 'url']),
  label: z.string().optional(),
  value: z.union([z.string(), z.number()]).optional(),
  artifactId: z.string().optional()
});

const AgentSchema = z.strictObject({
  clientId: z.string(),
  name: z.string()
});

const ExternalCostDeclarationSchema = z.strictObject({
  currency: z.string().regex(/^[A-Z]{3}$/),
  maxAmountPerRun: z.number().positive().finite()
});

const ExternalCostBudgetSchema = z.strictObject({
  currency: z.string().regex(/^[A-Z]{3}$/),
  maxAmount: z.number().positive().finite()
});

const ExternalCostUsageSchema = z.strictObject({
  currency: z.string().regex(/^[A-Z]{3}$/),
  estimatedTotal: z.number().nonnegative().finite(),
  actualTotal: z.number().nonnegative().finite(),
  remainingAmount: z.number().nonnegative().finite()
});

const TaskCommandSchema = z.strictObject({
  commandId: IdentifierSchema,
  kind: z.enum(['ask', 'modify', 'pause', 'resume_pause', 'terminate', 'revise_input']),
  status: z.enum(['pending', 'delivered', 'acknowledged', 'applied', 'rejected']),
  expectedRevision: z.number().int().positive().optional(),
  message: z.string().optional(),
  response: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional()
});

const TaskReportSchema = z.strictObject({
  reportId: IdentifierSchema,
  status: z.enum(['draft', 'final']),
  title: z.string(),
  summary: z.string(),
  sections: z.array(z.strictObject({ heading: z.string(), body: z.string() })),
  publishedAt: z.string().optional()
});
const InboxEntrySchema = z.strictObject({
  taskId: IdentifierSchema,
  revision: z.number().int().positive(),
  command: TaskCommandSchema
});

const TaskSchema = z.strictObject({
  id: z.string(),
  jobId: z.string().optional(),
  revision: z.number().int().positive().optional(),
  profileId: z.string().optional(),
  taskType: z.string().optional(),
  taskLabel: z.string().max(80).optional(),
  displayName: z.string().max(200).optional(),
  createdBy: z.string().optional(),
  agent: AgentSchema.optional(),
  behavior: z.string().optional(),
  interactionContract: z.literal('full-human-v1').optional(),
  externalCostUsage: ExternalCostUsageSchema.optional(),
  attempt: z.number().int().optional(),
  history: z.array(AttemptHistorySchema).optional(),
  state: z.string().optional(),
  currentActivity: z.strictObject({
    phase: z.string().optional(),
    status: z.string().optional(),
    updatedAt: z.string().optional()
  }).optional(),
  progress: ProgressSchema.optional(),
  createdAt: z.string().optional(),
  startedAt: z.string().optional(),
  updatedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  heartbeatAt: z.string().optional(),
  progressAt: z.string().optional(),
  health: z.strictObject({
    status: z.string().optional(),
    since: z.string().optional(),
    checkedAt: z.string().optional(),
    diagnosticRequested: z.boolean().optional()
  }).optional(),
  behaviorState: z.strictObject({
    configured: z.string().optional(),
    effective: z.string().optional(),
    source: z.enum(['profile', 'worker']).optional(),
    confirmed: z.boolean().optional(),
    at: z.string().optional(),
    auto: z.strictObject({
      level: z.number().optional(),
      label: z.string().optional(),
      actionsRemaining: z.number().optional(),
      signal: z.string().optional()
    }).optional()
  }).optional(),
  cooldown: z.strictObject({
    status: z.string().optional(),
    durationMs: z.number().optional(),
    resumeAt: z.string().optional(),
    reason: z.string().optional(),
    updatedAt: z.string().optional()
  }).optional(),
  timing: z.strictObject({
    recorded: z.boolean(),
    runDurationMs: z.number().nonnegative().nullable(),
    cooldownDurationMs: z.number().nonnegative().nullable(),
    totalDurationMs: z.number().nonnegative()
  }).optional(),
  queuePosition: z.number().optional(),
  queueReason: z.string().optional(),
  cleanup: CleanupSchema.optional(),
  diagnostic: DiagnosticSchema.optional(),
  observation: ObservationSchema.optional(),
  userRequest: z.strictObject({
    id: z.string(),
    kind: z.enum(['instruction', 'human_verification']).optional(),
    reason: z.string().optional(),
    instructions: z.string().optional(),
    requestedAt: z.string().optional(),
    expiresAt: z.string().optional(),
    status: z.string().optional(),
    claimedAt: z.string().optional(),
    screenshotAvailable: z.boolean().optional()
  }).optional(),
  checkpoint: z.strictObject({ available: z.literal(true), savedAt: z.string().optional() }).optional(),
  resumeAvailable: z.boolean().optional(),
  commands: z.array(TaskCommandSchema).optional(),
  report: TaskReportSchema.optional(),
  summary: z.string().optional(),
  evidence: z.array(EvidenceSchema).optional(),
  error: z.strictObject({ code: z.string(), message: z.string().optional() }).optional()
});

const TaskTypeSchema = z.strictObject({
  id: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  version: z.string().optional(),
  readOnly: z.boolean().optional(),
  domains: z.array(z.string()).optional(),
  intents: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  outputs: z.array(z.string()).optional(),
  risk: z.enum(['read', 'write', 'mixed']).optional(),
  lifecycle: z.enum(['active', 'deprecated']).optional(),
  deprecatedAt: z.string().optional(),
  replacedBy: z.string().optional(),
  externalCost: ExternalCostDeclarationSchema.optional(),
  pack: z.strictObject({
    name: z.string(),
    version: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    lifecycle: z.enum(['active', 'deprecated']).optional(),
    discoverable: z.boolean().optional(),
    protected: z.boolean().optional(),
    transient: z.boolean().optional()
  }).optional(),
  interactionContract: z.literal('full-human-v1').optional(),
  supportsResume: z.boolean().optional(),
  inputSchema: z.record(z.string(), z.json()).optional()
});
const TaskTypeSummarySchema = TaskTypeSchema.omit({ inputSchema: true });

const TaskPackSchema = z.strictObject({
  id: z.string().max(240),
  name: z.string().max(80),
  version: z.string().max(64),
  title: z.string().max(120),
  description: z.string().max(2_000).optional(),
  lifecycle: z.enum(['active', 'deprecated']),
  discoverable: z.boolean(),
  protected: z.boolean(),
  transient: z.boolean(),
  fileCount: z.number().int().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
  installedAt: z.string().optional(),
  deprecatedAt: z.string().optional(),
  usage: z.strictObject({
    runCount: z.number().int().nonnegative(),
    activeCount: z.number().int().nonnegative(),
    lastUsedAt: z.string().optional()
  }),
  taskTypes: z.array(z.strictObject({
    name: z.string().max(80),
    title: z.string().max(120).optional(),
    lifecycle: z.string().max(16).optional(),
    discoverable: z.boolean().optional()
  })).max(64),
  deletable: z.boolean(),
  deleteBlockerCodes: z.array(z.string().max(64)).max(8)
});

const ArtifactSchema = z.strictObject({
  id: z.string(),
  name: z.string().optional(),
  kind: z.string().optional(),
  mimeType: z.string().optional(),
  sizeBytes: z.number().optional(),
  sha256: z.string().optional(),
  createdAt: z.string().optional()
});

const ErrorEnvelopeSchema = z.strictObject({ ok: z.literal(false), error: PublicErrorSchema });
const successEnvelope = (dataSchema) => z.union([
  z.strictObject({ ok: z.literal(true), data: dataSchema }),
  ErrorEnvelopeSchema
]);

const READ_ONLY = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
});
const LOCAL_WRITE = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
});
const LOCAL_IDEMPOTENT_WRITE = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
});
const LOCAL_DESTRUCTIVE = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false
});
const OPEN_WORLD_TASK = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true
});
const OPEN_WORLD_NONDESTRUCTIVE_TASK = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
});
const OPEN_WORLD_CONTINUE = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true
});

function requireId(value, kind) {
  if (!value || typeof value.id !== 'string' || !value.id) {
    throw new TaskMasterClientError('INVALID_MANAGER_RESPONSE', `Task Master returned an invalid ${kind}.`);
  }
  return value;
}

function publicCommand(value) {
  if (!value || typeof value !== 'object') {
    throw new TaskMasterClientError('INVALID_MANAGER_RESPONSE', 'Task Master returned an invalid task command.');
  }
  const command = {
    commandId: value.commandId,
    kind: value.kind,
    status: value.status,
    ...(Number.isSafeInteger(value.expectedRevision) ? { expectedRevision: value.expectedRevision } : {}),
    ...(typeof value.message === 'string' ? { message: value.message } : {}),
    ...(typeof value.payload?.message === 'string' ? { message: value.payload.message } : {}),
    ...(typeof value.response === 'string' ? { response: value.response } : {}),
    ...(typeof value.createdAt === 'string' ? { createdAt: value.createdAt } : {}),
    ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {})
  };
  if (!IDENTIFIER.test(command.commandId ?? '') || typeof command.kind !== 'string' || typeof command.status !== 'string') {
    throw new TaskMasterClientError('INVALID_MANAGER_RESPONSE', 'Task Master returned an invalid task command.');
  }
  return command;
}

function success(data, text) {
  const envelope = assertResultBound({ ok: true, data });
  return {
    content: [{ type: 'text', text: text ?? JSON.stringify(envelope) }],
    structuredContent: envelope
  };
}

function failure(error) {
  const envelope = { ok: false, error: toPublicError(error) };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    structuredContent: envelope
  };
}

async function runTool(operation) {
  try {
    return await operation();
  } catch (error) {
    return failure(error);
  }
}

async function sendProgress(ctx, progress) {
  const progressToken = ctx.mcpReq._meta?.progressToken;
  if (progressToken === undefined) return;
  const current = typeof progress?.current === 'number'
    ? progress.current
    : typeof progress?.percent === 'number'
      ? progress.percent
      : 0;
  const total = typeof progress?.total === 'number'
    ? progress.total
    : typeof progress?.percent === 'number'
      ? 100
      : undefined;
  await ctx.mcpReq.notify({
    method: 'notifications/progress',
    params: {
      progressToken,
      progress: current,
      ...(total === undefined ? {} : { total }),
      ...(typeof progress?.message === 'string' ? { message: progress.message.slice(0, 512) } : {})
    }
  }).catch(() => {});
}

export function completeImageContent(data) {
  const mimeType = data?.artifact?.mimeType;
  if (
    data?.encoding !== 'base64'
    || data?.offset !== 0
    || data?.eof !== true
    || typeof data?.chunk !== 'string'
    || typeof mimeType !== 'string'
    || !mimeType.startsWith('image/')
  ) {
    return null;
  }
  return { type: 'image', data: data.chunk, mimeType };
}

function register(server, client, definition) {
  server.registerTool(
    definition.name,
    {
      title: definition.title,
      description: definition.description,
      inputSchema: definition.inputSchema,
      outputSchema: successEnvelope(definition.outputSchema),
      annotations: definition.annotations
    },
    (args, ctx) => runTool(() => definition.handler(args, ctx, client))
  );
}

export function createMcpServer({ client, version = VERSION } = {}) {
  const taskMaster = assertTaskMasterClient(client);
  const server = new McpServer(
    { name: 'eric-task-master', version },
    {
      instructions: 'Use registered task types only. Claim the durable Owner inbox once after connecting. If no specialized type covers large work, call taskmaster_scale_prepare instead of inventing a probe or controller. Every task start returns the fixed Owner Console link and durable task ID; poll or wait for progress. MCP cancellation stops waiting but does not cancel the browser task. On AGENT_HOST_RELOAD_REQUIRED reload the host before any retry. Publish a concise human report after interpreting task evidence.'
    }
  );

  register(server, taskMaster, {
    name: 'taskmaster_status',
    title: 'Task Master status',
    description: 'Read the scoped Task Master manager status.',
    inputSchema: z.strictObject({}),
    outputSchema: z.strictObject({
      status: z.strictObject({
        ok: z.boolean().optional(),
        service: z.string().optional(),
        version: z.string().optional(),
        apiVersion: z.number().optional(),
        state: z.string().optional(),
        startedAt: z.string().optional(),
        counts: z.record(z.string(), z.json()).optional()
      })
    }),
    annotations: READ_ONLY,
    handler: async (_args, _ctx, api) => success({ status: publicStatus(await api.getStatus()) })
  });

  register(server, taskMaster, {
    name: 'taskmaster_dashboard_open',
    title: 'Open Task Master Owner Console',
    description: 'Return a local Owner Console link, optionally focused on one task. The first link silently establishes the persistent Owner session. Does not open an operating-system browser.',
    inputSchema: z.strictObject({ taskId: IdentifierSchema.optional() }),
    outputSchema: z.strictObject({ taskId: IdentifierSchema.optional(), dashboardUrl: z.string().url() }),
    annotations: LOCAL_WRITE,
    handler: async ({ taskId }, _ctx, api) => {
      const result = await api.openDashboard(taskId);
      if (typeof result?.dashboardUrl !== 'string') {
        throw new TaskMasterClientError('INVALID_MANAGER_RESPONSE', 'Task Master returned an invalid Dashboard link.');
      }
      return success(
        { ...(taskId ? { taskId } : {}), dashboardUrl: result.dashboardUrl },
        `[打开 Task Master 任务面板](${result.dashboardUrl})${taskId ? `\n聚焦任务 ${taskId}。` : ''}`
      );
    }
  });

  register(server, taskMaster, {
    name: 'taskmaster_profiles_list',
    title: 'List browser profiles',
    description: 'List persistent and task-scoped ephemeral Playwright Profiles without filesystem paths or credentials.',
    inputSchema: z.strictObject({}),
    outputSchema: z.strictObject({ profiles: z.array(ProfileSchema), truncated: z.boolean() }),
    annotations: READ_ONLY,
    handler: async (_args, _ctx, api) => {
      const profiles = (await api.listProfiles()).map(publicProfile).map((item) => requireId(item, 'profile'));
      return success({ profiles: profiles.slice(0, 100), truncated: profiles.length > 100 });
    }
  });

  register(server, taskMaster, {
    name: 'taskmaster_profiles_create',
    title: 'Create browser profile',
    description: 'Create one managed Playwright profile. This operation is intentionally non-idempotent.',
    inputSchema: z.strictObject({
      name: z.string().trim().min(1).max(80),
      kind: z.enum(PROFILE_KINDS).default('persistent'),
      defaultBehavior: z.enum(BEHAVIOR_MODES).optional(),
      headless: z.boolean().optional(),
      browserEngine: z.enum(BROWSER_ENGINES).optional()
    }),
    outputSchema: z.strictObject({ profile: ProfileSchema }),
    annotations: LOCAL_WRITE,
    handler: async (args, _ctx, api) => success({ profile: requireId(publicProfile(await api.createProfile(args)), 'profile') })
  });

  register(server, taskMaster, {
    name: 'taskmaster_profiles_update',
    title: 'Update browser profile',
    description: 'Update one globally shared local Profile. Behavior changes are confirmed live by any running task Worker without restarting the task.',
    inputSchema: z.strictObject({
      profileId: IdentifierSchema,
      name: z.string().trim().min(1).max(80).optional(),
      defaultBehavior: z.enum(BEHAVIOR_MODES).optional(),
      headless: z.boolean().optional()
    }).refine(
      ({ profileId: _profileId, ...patch }) => Object.keys(patch).length > 0,
      { message: 'At least one Profile field must be supplied' }
    ),
    outputSchema: z.strictObject({ profile: ProfileSchema }),
    annotations: LOCAL_WRITE,
    handler: async ({ profileId, ...patch }, _ctx, api) => success({
      profile: requireId(publicProfile(await api.updateProfile(profileId, patch)), 'profile')
    })
  });

  for (const action of ['open', 'close']) {
    register(server, taskMaster, {
      name: `taskmaster_profiles_${action}`,
      title: `${action === 'open' ? 'Open' : 'Close'} browser profile`,
      description: `${action === 'open' ? 'Open' : 'Close'} a managed Playwright profile.`,
      inputSchema: z.strictObject({ profileId: IdentifierSchema }),
      outputSchema: z.strictObject({ profile: ProfileSchema }),
      annotations: action === 'open' ? LOCAL_WRITE : LOCAL_DESTRUCTIVE,
      handler: async ({ profileId }, _ctx, api) => {
        const profile = action === 'open' ? await api.openProfile(profileId) : await api.closeProfile(profileId);
        return success({ profile: requireId(publicProfile(profile), 'profile') });
      }
    });
  }

  register(server, taskMaster, {
    name: 'taskmaster_task_types_list',
    title: 'List registered task types',
    description: 'Search compact task summaries by text, domain, or intent. Call taskmaster_task_types_describe only for the selected task.',
    inputSchema: z.strictObject({
      query: z.string().trim().max(120).optional(),
      domain: z.string().trim().max(253).optional(),
      intent: z.string().trim().max(80).optional()
    }),
    outputSchema: z.strictObject({ taskTypes: z.array(TaskTypeSummarySchema), truncated: z.boolean() }),
    annotations: READ_ONLY,
    handler: async (args, _ctx, api) => {
      const taskTypes = (await api.listTaskTypes(args))
        .map((item) => publicTaskType(item, { includeSchema: false }))
        .map((item) => requireId(item, 'task type'));
      return success({ taskTypes: taskTypes.slice(0, 100), truncated: taskTypes.length > 100 });
    }
  });

  register(server, taskMaster, {
    name: 'taskmaster_task_packs_list',
    title: 'List installed Task Packs',
    description: 'Read compact Task Pack lifecycle, usage, and deletion-blocker status. This tool never mutates or exposes task-instance names.',
    inputSchema: z.strictObject({
      cursor: z.string().min(1).max(256).optional(),
      limit: z.number().int().min(1).max(100).optional()
    }),
    outputSchema: z.strictObject({
      taskPacks: z.array(TaskPackSchema),
      truncated: z.boolean(),
      nextCursor: z.string().optional()
    }),
    annotations: READ_ONLY,
    handler: async ({ cursor, limit = 100 }, _ctx, api) => {
      const taskPacks = (await api.listTaskPacks())
        .map(publicTaskPack)
        .map((item) => requireId(item, 'Task Pack'))
        .sort((left, right) => left.id.localeCompare(right.id));
      const start = cursor === undefined
        ? 0
        : taskPacks.findIndex((item) => item.id.localeCompare(cursor) > 0);
      const normalizedStart = start < 0 ? taskPacks.length : start;
      const page = taskPacks.slice(normalizedStart, normalizedStart + limit);
      const truncated = normalizedStart + page.length < taskPacks.length;
      return success({
        taskPacks: page,
        truncated,
        ...(truncated && page.length ? { nextCursor: page.at(-1).id } : {})
      });
    }
  });

  register(server, taskMaster, {
    name: 'taskmaster_task_types_describe',
    title: 'Describe registered task type',
    description: 'Read the full input contract only after selecting one compact task summary.',
    inputSchema: z.strictObject({ taskType: IdentifierSchema }),
    outputSchema: z.strictObject({ taskType: TaskTypeSchema }),
    annotations: READ_ONLY,
    handler: async ({ taskType }, _ctx, api) => success({
      taskType: requireId(publicTaskType(await api.describeTaskType(taskType)), 'task type')
    })
  });

  register(server, taskMaster, {
    name: 'taskmaster_scale_prepare',
    title: 'Prepare an unknown large browser task',
    description: 'When no specialized registered task type covers a large request, run one bounded built-in surface probe before authoring or scaling a Task Pack.',
    inputSchema: z.strictObject({
      profileId: IdentifierSchema,
      url: HttpUrlSchema,
      taskLabel: z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]+$/u).optional(),
      idempotencyKey: IdempotencyKeySchema
    }),
    outputSchema: z.strictObject({ taskId: IdentifierSchema, dashboardUrl: z.string().url(), task: TaskSchema }),
    annotations: OPEN_WORLD_NONDESTRUCTIVE_TASK,
    handler: async (args, _ctx, api) => {
      const started = await api.startTask({
        taskType: 'surface-probe',
        profileId: args.profileId,
        ...(args.taskLabel ? { taskLabel: args.taskLabel } : {}),
        input: { url: args.url },
        idempotencyKey: args.idempotencyKey
      });
      const task = requireId(publicTask(started?.task, { includeResult: false }), 'task');
      if (started?.taskId !== task.id || typeof started?.dashboardUrl !== 'string') {
        throw new TaskMasterClientError('INVALID_MANAGER_RESPONSE', 'Task Master returned an inconsistent surface probe start envelope.');
      }
      return success(
        { taskId: task.id, dashboardUrl: started.dashboardUrl, task },
        `[打开任务面板](${started.dashboardUrl})\nStarted bounded surface probe ${task.id}. Wait for its evidence before building a pilot or scaling the task.`
      );
    }
  });

  register(server, taskMaster, {
    name: 'taskmaster_tasks_start',
    title: 'Start registered browser task',
    description: 'Start one registered task and return its durable ID immediately. Never accepts code, module paths, cookies, or browser sessions.',
    inputSchema: z.strictObject({
      taskType: IdentifierSchema,
      profileId: IdentifierSchema,
      taskLabel: z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]+$/u).optional(),
      input: JsonObjectSchema.default({}),
      timeoutMs: z.number().int().min(1_000).max(24 * 60 * 60 * 1000).optional(),
      externalCostBudget: ExternalCostBudgetSchema.optional(),
      idempotencyKey: IdempotencyKeySchema
    }),
    outputSchema: z.strictObject({ taskId: IdentifierSchema, dashboardUrl: z.string().url(), task: TaskSchema }),
    annotations: OPEN_WORLD_TASK,
    handler: async (args, _ctx, api) => {
      assertSafeTaskInput(args.input);
      const started = await api.startTask(args);
      const task = requireId(publicTask(started?.task, { includeResult: false }), 'task');
      if (started?.taskId !== task.id || typeof started?.dashboardUrl !== 'string') {
        throw new TaskMasterClientError('INVALID_MANAGER_RESPONSE', 'Task Master returned an inconsistent task start envelope.');
      }
      return success(
        { taskId: task.id, dashboardUrl: started.dashboardUrl, task },
        `[打开任务面板](${started.dashboardUrl})\nStarted task ${task.id}. Use taskmaster_tasks_wait or taskmaster_tasks_get to follow it.`
      );
    }
  });

  register(server, taskMaster, {
    name: 'taskmaster_tasks_list',
    title: 'List browser tasks',
    description: 'List durable tasks owned by this scoped agent connection.',
    inputSchema: z.strictObject({
      cursor: z.string().min(1).max(512).optional(),
      limit: z.number().int().min(1).max(100).default(50)
    }),
    outputSchema: z.strictObject({ tasks: z.array(TaskSchema), nextCursor: z.string().optional() }),
    annotations: READ_ONLY,
    handler: async (args, _ctx, api) => {
      const result = await api.listTasks(args);
      const tasks = result.tasks.map((task) => requireId(publicTask(task, { includeResult: false }), 'task'));
      if (tasks.length > args.limit) {
        throw new TaskMasterClientError('INVALID_MANAGER_RESPONSE', 'Task Master returned more tasks than requested.');
      }
      return success({ tasks, ...(result.nextCursor ? { nextCursor: result.nextCursor.slice(0, 512) } : {}) });
    }
  });

  register(server, taskMaster, {
    name: 'taskmaster_tasks_get',
    title: 'Read browser task',
    description: 'Read one durable task with bounded progress, summary, and safe evidence.',
    inputSchema: z.strictObject({ taskId: IdentifierSchema }),
    outputSchema: z.strictObject({ task: TaskSchema }),
    annotations: READ_ONLY,
    handler: async ({ taskId }, _ctx, api) => success({ task: requireId(publicTask(await api.getTask(taskId)), 'task') })
  });

  register(server, taskMaster, {
    name: 'taskmaster_tasks_wait',
    title: 'Wait briefly for browser task progress',
    description: 'Wait up to 30 seconds for progress. Request cancellation stops this wait only; the durable task continues.',
    inputSchema: z.strictObject({
      taskId: IdentifierSchema,
      waitMs: z.number().int().min(0).max(30_000).default(30_000)
    }),
    outputSchema: z.strictObject({ task: TaskSchema, timedOut: z.boolean() }),
    annotations: READ_ONLY,
    handler: async ({ taskId, waitMs }, ctx, api) => {
      const result = await api.waitTask(taskId, {
        waitMs,
        signal: ctx.mcpReq.signal,
        onProgress: (progress) => sendProgress(ctx, progress)
      });
      return success({
        task: requireId(publicTask(result.task), 'task'),
        timedOut: result.timedOut === true
      });
    }
  });

  register(server, taskMaster, {
    name: 'taskmaster_agent_inbox_claim',
    title: 'Claim durable Owner messages',
    description: 'Deliver pending Owner questions and task-change requests for this Agent. Claim once after connect and whenever a task wait returns commands; offline messages remain durable.',
    inputSchema: z.strictObject({ limit: z.number().int().min(1).max(200).default(100) }),
    outputSchema: z.strictObject({ commands: z.array(InboxEntrySchema), total: z.number().int() }),
    annotations: LOCAL_WRITE,
    handler: async ({ limit }, _ctx, api) => {
      const result = await api.claimInbox({ limit });
      const commands = (Array.isArray(result?.commands) ? result.commands : []).map((entry) => ({
        taskId: entry.taskId,
        revision: entry.revision,
        command: publicCommand(entry.command)
      }));
      return success(
        { commands, total: commands.length },
        commands.length
          ? `Received ${commands.length} durable Owner command(s). Acknowledge each commandId before replanning.`
          : 'No pending Owner commands.'
      );
    }
  });

  register(server, taskMaster, {
    name: 'taskmaster_task_command_respond',
    title: 'Acknowledge or resolve Owner command',
    description: 'Record that this Agent acknowledged, applied, or rejected one durable Owner command. expectedRevision prevents applying stale instructions twice.',
    inputSchema: z.strictObject({
      taskId: IdentifierSchema,
      commandId: IdentifierSchema,
      expectedRevision: z.number().int().positive(),
      status: z.enum(['acknowledged', 'applied', 'rejected']),
      message: z.string().max(8_000).optional()
    }),
    outputSchema: z.strictObject({ task: TaskSchema, command: TaskCommandSchema }),
    annotations: LOCAL_WRITE,
    handler: async (args, _ctx, api) => {
      const result = await api.respondTaskCommand(args);
      return success({
        task: requireId(publicTask(result.task, { includeResult: false }), 'task'),
        command: publicCommand(result.command)
      });
    }
  });

  register(server, taskMaster, {
    name: 'taskmaster_task_report_publish',
    title: 'Publish human-readable task report',
    description: 'Publish the Agent interpretation that the Owner Console shows by default. This does not replace machine evidence or completion gates.',
    inputSchema: z.strictObject({
      taskId: IdentifierSchema,
      reportId: IdentifierSchema,
      expectedRevision: z.number().int().positive(),
      status: z.enum(['draft', 'final']),
      title: z.string().trim().min(1).max(200),
      summary: z.string().trim().min(1).max(20_000),
      sections: z.array(z.strictObject({
        heading: z.string().trim().min(1).max(200),
        body: z.string().trim().min(1).max(20_000)
      })).max(24).default([])
    }),
    outputSchema: z.strictObject({ task: TaskSchema }),
    annotations: LOCAL_WRITE,
    handler: async (args, _ctx, api) => {
      const result = await api.publishTaskReport(args);
      return success({ task: requireId(publicTask(result.task), 'task') });
    }
  });

  register(server, taskMaster, {
    name: 'taskmaster_tasks_focus',
    title: 'Focus a task browser page',
    description: 'Bring the live browser page for one task to the foreground, for example before a human-verification handoff. Fails clearly when no live page exists.',
    inputSchema: z.strictObject({ taskId: IdentifierSchema }),
    outputSchema: z.strictObject({ task: TaskSchema, focusedAt: z.string() }),
    annotations: LOCAL_IDEMPOTENT_WRITE,
    handler: async ({ taskId }, _ctx, api) => {
      const result = await api.focusTask(taskId);
      if (typeof result?.focusedAt !== 'string' || !result.focusedAt) {
        throw new TaskMasterClientError('INVALID_MANAGER_RESPONSE', 'Task Master did not confirm when browser focus was applied.');
      }
      return success({
        task: requireId(publicTask(result.task, { includeResult: false }), 'task'),
        focusedAt: result.focusedAt
      });
    }
  });

  register(server, taskMaster, {
    name: 'taskmaster_tasks_continue',
    title: 'Continue a task waiting for instruction',
    description: 'Continue the same live task after inspecting its request, screenshot, semantic observation, and current page. The task module must verify page state before acting.',
    inputSchema: z.strictObject({
      taskId: IdentifierSchema,
      requestId: IdentifierSchema.optional(),
      note: z.string().max(2_000).optional()
    }),
    outputSchema: z.strictObject({ task: TaskSchema }),
    annotations: OPEN_WORLD_CONTINUE,
    handler: async (args, _ctx, api) => success({
      task: requireId(publicTask(await api.continueTask(args), { includeResult: false }), 'task')
    })
  });

  register(server, taskMaster, {
    name: 'taskmaster_tasks_resume',
    title: 'Resume failed browser task from checkpoint',
    description: 'Explicitly start a new attempt on the same failed task ID from its preserved checkpoint. Requires a stable resume key and never blindly replays an unknown external action outcome.',
    inputSchema: z.strictObject({
      taskId: IdentifierSchema,
      resumeKey: IdempotencyKeySchema
    }),
    outputSchema: z.strictObject({ task: TaskSchema, notice: z.string() }),
    annotations: OPEN_WORLD_TASK,
    handler: async (args, _ctx, api) => {
      const result = await api.resumeTask(args);
      const task = requireId(publicTask(result.task, { includeResult: false }), 'task');
      const notice = typeof result.notice === 'string' ? result.notice.slice(0, 512) : RESUME_NOTICE;
      return success({ task, notice }, `Resumed task ${task.id} as attempt ${task.attempt}. ${notice}`);
    }
  });

  register(server, taskMaster, {
    name: 'taskmaster_tasks_cancel',
    title: 'Cancel browser task',
    description: 'Explicitly request cancellation of a durable browser task. This is separate from cancelling a wait call.',
    inputSchema: z.strictObject({ taskId: IdentifierSchema }),
    outputSchema: z.strictObject({ task: TaskSchema }),
    annotations: LOCAL_DESTRUCTIVE,
    handler: async ({ taskId }, _ctx, api) => success({ task: requireId(publicTask(await api.cancelTask(taskId)), 'task') })
  });

  register(server, taskMaster, {
    name: 'taskmaster_artifacts_list',
    title: 'List task artifacts',
    description: 'List artifacts explicitly marked safe for the scoped agent. Filesystem paths are never returned.',
    inputSchema: z.strictObject({ taskId: IdentifierSchema }),
    outputSchema: z.strictObject({ artifacts: z.array(ArtifactSchema), truncated: z.boolean() }),
    annotations: READ_ONLY,
    handler: async ({ taskId }, _ctx, api) => {
      const artifacts = (await api.listArtifacts(taskId)).map(publicArtifact).filter(Boolean).map((item) => requireId(item, 'artifact'));
      return success({ artifacts: artifacts.slice(0, 100), truncated: artifacts.length > 100 });
    }
  });

  register(server, taskMaster, {
    name: 'taskmaster_artifacts_read',
    title: 'Read bounded task artifact chunk',
    description: `Read at most ${MAX_ARTIFACT_CHUNK_BYTES} bytes from an artifact explicitly marked safe for the scoped agent.`,
    inputSchema: z.strictObject({
      taskId: IdentifierSchema,
      artifactId: IdentifierSchema,
      offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
      maxBytes: z.number().int().min(1).max(MAX_ARTIFACT_CHUNK_BYTES).default(MAX_ARTIFACT_CHUNK_BYTES)
    }),
    outputSchema: z.strictObject({
      artifact: ArtifactSchema,
      offset: z.number(),
      nextOffset: z.number(),
      eof: z.boolean(),
      encoding: z.enum(['utf8', 'base64']),
      chunk: z.string()
    }),
    annotations: READ_ONLY,
    handler: async (args, _ctx, api) => {
      const data = publicArtifactRead(await api.readArtifact(args), args.artifactId);
      const content = [{
        type: 'text',
        text: data.encoding === 'utf8'
          ? data.chunk
          : `Artifact ${data.artifact.id} returned a bounded base64 chunk in structuredContent.`
      }];
      const imageContent = completeImageContent(data);
      if (imageContent) content.push(imageContent);
      const envelope = assertResultBound({ ok: true, data });
      return { content, structuredContent: envelope };
    }
  });

  return server;
}
