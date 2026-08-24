import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { BEHAVIOR_MODES, PROFILE_KINDS, VERSION } from '../contracts.mjs';
import { TaskMasterClientError, toPublicError } from './errors.mjs';
import {
  MAX_ARTIFACT_CHUNK_BYTES,
  assertResultBound,
  publicArtifact,
  publicArtifactRead,
  publicProfile,
  publicStatus,
  publicTask,
  publicTaskType
} from './public-view.mjs';
import { assertSafeTaskInput, assertTaskMasterClient } from './taskmaster-client.mjs';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

const IdentifierSchema = z.string().regex(IDENTIFIER);
const IdempotencyKeySchema = z.string().regex(IDEMPOTENCY_KEY);
const JsonObjectSchema = z.record(z.string().max(128), z.json());
const RESUME_NOTICE = 'Inspect the checkpoint and current site state before repeating any action whose external outcome is unknown.';

const PublicErrorSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  nextAction: z.string().optional()
});

const ProfileSchema = z.strictObject({
  id: z.string(),
  name: z.string().optional(),
  kind: z.enum(PROFILE_KINDS).optional(),
  state: z.string().optional(),
  defaultBehavior: z.string().optional(),
  headless: z.boolean().optional(),
  browserChannel: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  lastOpenedAt: z.string().optional()
});

const ProgressSchema = z.strictObject({
  current: z.number().optional(),
  total: z.number().optional(),
  percent: z.number().optional(),
  phase: z.string().optional(),
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

const TaskSchema = z.strictObject({
  id: z.string(),
  profileId: z.string().optional(),
  taskType: z.string().optional(),
  behavior: z.string().optional(),
  attempt: z.number().int().optional(),
  history: z.array(AttemptHistorySchema).optional(),
  state: z.string().optional(),
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
    at: z.string().optional(),
    adaptive: z.strictObject({
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
  queuePosition: z.number().optional(),
  queueReason: z.string().optional(),
  cleanup: CleanupSchema.optional(),
  diagnostic: DiagnosticSchema.optional(),
  observation: ObservationSchema.optional(),
  userRequest: z.strictObject({
    id: z.string(),
    reason: z.string().optional(),
    instructions: z.string().optional(),
    requestedAt: z.string().optional(),
    expiresAt: z.string().optional(),
    status: z.string().optional(),
    screenshotAvailable: z.boolean().optional()
  }).optional(),
  checkpoint: z.strictObject({ available: z.literal(true), savedAt: z.string().optional() }).optional(),
  resumeAvailable: z.boolean().optional(),
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
  preferredBehavior: z.enum(BEHAVIOR_MODES).optional(),
  risk: z.enum(['read', 'write', 'mixed']).optional(),
  pack: z.strictObject({ name: z.string(), version: z.string() }).optional(),
  supportsResume: z.boolean().optional(),
  inputSchema: z.record(z.string(), z.json()).optional()
});
const TaskTypeSummarySchema = TaskTypeSchema.omit({ inputSchema: true });

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
      instructions: 'Use registered task types only. Start returns a durable task ID; poll or wait for progress. MCP cancellation stops waiting but does not cancel the browser task.'
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
      browserChannel: z.string().trim().min(1).max(64).optional()
    }),
    outputSchema: z.strictObject({ profile: ProfileSchema }),
    annotations: LOCAL_WRITE,
    handler: async (args, _ctx, api) => success({ profile: requireId(publicProfile(await api.createProfile(args)), 'profile') })
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
    name: 'taskmaster_tasks_start',
    title: 'Start registered browser task',
    description: 'Start one registered task and return its durable ID immediately. Never accepts code, module paths, cookies, or browser sessions.',
    inputSchema: z.strictObject({
      taskType: IdentifierSchema,
      profileId: IdentifierSchema,
      input: JsonObjectSchema.default({}),
      behavior: z.enum(BEHAVIOR_MODES).optional(),
      timeoutMs: z.number().int().min(1_000).max(24 * 60 * 60 * 1000).optional(),
      idempotencyKey: IdempotencyKeySchema
    }),
    outputSchema: z.strictObject({ task: TaskSchema }),
    annotations: OPEN_WORLD_TASK,
    handler: async (args, _ctx, api) => {
      assertSafeTaskInput(args.input);
      const task = requireId(publicTask(await api.startTask(args), { includeResult: false }), 'task');
      return success({ task }, `Started task ${task.id}. Use taskmaster_tasks_wait or taskmaster_tasks_get to follow it.`);
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
      if (data.encoding === 'base64' && data.artifact.mimeType?.startsWith('image/')) {
        content.push({ type: 'image', data: data.chunk, mimeType: data.artifact.mimeType });
      }
      const envelope = assertResultBound({ ok: true, data });
      return { content, structuredContent: envelope };
    }
  });

  return server;
}
