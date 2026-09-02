import { createHash } from 'node:crypto';
import { TERMINAL_TASK_STATES } from '../contracts.mjs';
import { FULL_HUMAN_INTERACTION_CONTRACT } from '../lib/interaction-contract.mjs';
import { redactSensitiveText } from '../lib/redaction.mjs';
import {
  callerIdentity,
  clone,
  COMMAND_ID_PATTERN,
  filterTaskTypes
} from './task-record-policy.mjs';
import { TaskServiceError } from './task-service-error.mjs';

const MAX_TASK_ASSET_BATCH = 100;
const MAX_TASK_ASSET_BLOCKING_TASKS = 8;
const TRANSIENT_ASSET_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export function createTaskAssetManager({
  registry,
  tasks,
  children,
  finalizationFailures,
  awaitReady,
  requireServiceOpen,
  serializeMutation,
  refreshResumeCheckpointState,
  forceDetachTaskAssetReferences,
  persist
}) {
  if (
    !registry || !tasks || !children || !finalizationFailures ||
    typeof awaitReady !== 'function' || typeof requireServiceOpen !== 'function' ||
    typeof serializeMutation !== 'function' || typeof refreshResumeCheckpointState !== 'function' ||
    typeof forceDetachTaskAssetReferences !== 'function' ||
    typeof persist !== 'function'
  ) {
    throw new TypeError('Task asset manager dependencies are incomplete');
  }
  async function installTaskType(input, suppliedCaller = {}) {
    requireServiceOpen();
    const caller = callerIdentity(suppliedCaller);
    if (caller.role !== 'manager-admin') {
      throw new TaskServiceError('TASK_TYPE_INSTALL_FORBIDDEN', 'Only Manager admin can install task types', 403);
    }
    const allowed = new Set(['name', 'modulePath', 'transient', 'note']);
    const unknown = Object.keys(input || {}).filter((key) => !allowed.has(key));
    if (unknown.length) {
      throw new TaskServiceError('INVALID_TASK_TYPE_INSTALL', `Unsupported task type fields: ${unknown.join(', ')}`);
    }
    if (input.transient !== undefined && typeof input.transient !== 'boolean') {
      throw new TaskServiceError('INVALID_TASK_TYPE_INSTALL', 'transient must be a boolean');
    }
    return registry.install({
      name: input.name,
      modulePath: input.modulePath,
      assetKind: 'standalone',
      discoverable: true,
      protected: false,
      transient: input.transient === true,
      note: input.note || ''
    });
  }

  async function installTaskPack(input = {}, suppliedCaller = {}) {
    requireServiceOpen();
    const caller = callerIdentity(suppliedCaller);
    if (caller.role !== 'manager-admin') {
      throw new TaskServiceError('TASK_PACK_INSTALL_FORBIDDEN', 'Only Manager admin can install Task Packs', 403);
    }
    const allowed = new Set(['name', 'version', 'title', 'description', 'interactionContract', 'modules']);
    const unknown = Object.keys(input).filter((key) => !allowed.has(key));
    if (unknown.length) {
      throw new TaskServiceError('INVALID_TASK_PACK', `Unsupported Task Pack fields: ${unknown.join(', ')}`);
    }
    if (
      typeof input.name !== 'string' || !/^[a-z][a-z0-9._-]{0,79}$/.test(input.name) ||
      typeof input.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input.version) ||
      input.interactionContract !== FULL_HUMAN_INTERACTION_CONTRACT
    ) {
      throw new TaskServiceError(
        'INVALID_TASK_PACK',
        `Task Pack name, semantic version, or ${FULL_HUMAN_INTERACTION_CONTRACT} interaction contract is invalid`
      );
    }
    if (!Array.isArray(input.modules) || input.modules.length < 1 || input.modules.length > 64) {
      throw new TaskServiceError('INVALID_TASK_PACK', 'Task Pack must contain 1 to 64 modules');
    }
    const modules = input.modules.map((item) => {
      if (
        !item || typeof item !== 'object' || Array.isArray(item) ||
        Object.keys(item).some((key) => !['name', 'modulePath'].includes(key)) ||
        typeof item.name !== 'string' || typeof item.modulePath !== 'string'
      ) {
        throw new TaskServiceError('INVALID_TASK_PACK', 'Every Task Pack module must contain name and modulePath');
      }
      return { name: item.name, modulePath: item.modulePath };
    });
    const taskTypes = await registry.installBatch(modules, {
      pack: {
        name: input.name,
        version: input.version,
        ...(typeof input.title === 'string' ? { title: input.title } : {}),
        ...(typeof input.description === 'string' ? { description: input.description } : {}),
        interactionContract: FULL_HUMAN_INTERACTION_CONTRACT
      }
    });
    return {
      name: input.name,
      version: input.version,
      interactionContract: FULL_HUMAN_INTERACTION_CONTRACT,
      ...(typeof input.title === 'string' ? { title: input.title.slice(0, 120) } : {}),
      ...(typeof input.description === 'string' ? { description: input.description.slice(0, 2_000) } : {}),
      taskTypes
    };
  }

  async function listTaskTypes(filters = {}, suppliedCaller = undefined) {
    const legacyCaller = suppliedCaller === undefined && (filters.role || filters.clientId);
    const caller = legacyCaller ? filters : suppliedCaller;
    callerIdentity(caller || {});
    const requestedFilters = legacyCaller ? {} : filters;
    const taskTypes = filterTaskTypes(await registry.listSummaries(), requestedFilters);
    return { taskTypes, total: taskTypes.length };
  }

  async function describeTaskType(name, suppliedCaller = {}) {
    callerIdentity(suppliedCaller);
    if (typeof name !== 'string' || !name) {
      throw new TaskServiceError('TASK_TYPE_REQUIRED', 'Task type is required');
    }
    return registry.describe(name);
  }

  async function deprecateTaskType(name, input = {}, suppliedCaller = {}) {
    requireServiceOpen();
    const caller = callerIdentity(suppliedCaller);
    if (caller.role !== 'manager-admin') {
      throw new TaskServiceError('TASK_TYPE_LIFECYCLE_FORBIDDEN', 'Only Manager admin can change task type lifecycle', 403);
    }
    const unknown = Object.keys(input).filter((key) => key !== 'replacedBy');
    if (unknown.length) {
      throw new TaskServiceError('INVALID_TASK_TYPE_LIFECYCLE', `Unsupported fields: ${unknown.join(', ')}`);
    }
    return registry.deprecate(name, { replacedBy: input.replacedBy ?? null });
  }

  async function restoreTaskType(name, suppliedCaller = {}) {
    requireServiceOpen();
    const caller = callerIdentity(suppliedCaller);
    if (caller.role !== 'manager-admin') {
      throw new TaskServiceError('TASK_TYPE_LIFECYCLE_FORBIDDEN', 'Only Manager admin can change task type lifecycle', 403);
    }
    return registry.restore(name);
  }

  function taskMatchesAsset(task, typeNames, hashes) {
    if (task.taskTypeAssetDetached === true) return false;
    if (typeof task.taskTypeSha256 === 'string') return hashes.has(task.taskTypeSha256);
    return typeNames.has(task.taskType);
  }

  function taskAssetId(record) {
    return record.pack
      ? `pack:${record.pack.name}@${record.pack.version}`
      : `type:${record.name}`;
  }

  function snapshotAssetId(snapshot) {
    const suffix = createHash('sha256').update(snapshot.snapshotName).digest('hex').slice(0, 12);
    return `snapshot:${snapshot.sha256}:${suffix}`;
  }

  function publicTaskAsset(asset) {
    const {
      typeNames: _typeNames,
      snapshotNames: _snapshotNames,
      hashes: _hashes,
      modifiedAt: _modifiedAt,
      ...safe
    } = asset;
    return clone(safe);
  }

  function taskLastUsedAt(task) {
    const timestamps = [task.createdAt, task.startedAt, task.finishedAt];
    for (const attempt of Array.isArray(task.history) ? task.history : []) {
      timestamps.push(attempt?.startedAt, attempt?.workerStartedAt, attempt?.finishedAt);
    }
    let latest = null;
    let latestTime = -1;
    for (const value of timestamps) {
      const time = Date.parse(value);
      if (!Number.isFinite(time) || time <= latestTime) continue;
      latest = value;
      latestTime = time;
    }
    return latest;
  }

  function taskAssetBlocker(task, blockerCode) {
    return {
      taskId: task.id,
      revision: task.revision,
      title: redactSensitiveText(task.displayName || task.taskLabel || task.id).slice(0, 200),
      state: task.state,
      blockerCode,
      cleanupSettled: task.cleanup?.settled === true,
      canForceDeleteTask: TERMINAL_TASK_STATES.has(task.state) && !children.has(task.id),
      canDeleteRecord: TERMINAL_TASK_STATES.has(task.state) && task.cleanup?.settled === true &&
        !children.has(task.id) && task.leaseHeld !== true && !finalizationFailures.has(task.id)
    };
  }

  async function buildTaskAssets() {
    for (const task of tasks.values()) {
      if (
        task.deletedAt || task.state !== 'failed' || task.supportsResume !== true ||
        task.cleanup?.settled !== true
      ) continue;
      const before = JSON.stringify({
        checkpoint: task.checkpoint ?? null,
        resumeCheckpointValid: task.resumeCheckpointValid === true,
        resumeCheckpointError: task.resumeCheckpointError ?? null
      });
      await refreshResumeCheckpointState(task);
      const after = JSON.stringify({
        checkpoint: task.checkpoint ?? null,
        resumeCheckpointValid: task.resumeCheckpointValid === true,
        resumeCheckpointError: task.resumeCheckpointError ?? null
      });
      if (before !== after) await persist(task);
    }
    const [records, snapshots] = await Promise.all([
      registry.listManagement(),
      registry.snapshotInventory()
    ]);
    const groups = new Map();
    for (const record of records) {
      const id = taskAssetId(record);
      const current = groups.get(id) || {
        id,
        kind: record.assetKind,
        source: record.assetKind === 'pack' ? 'task-pack' : record.assetKind,
        name: record.pack?.name || record.name,
        version: record.pack?.version || record.version || '',
        title: record.pack?.title || record.title || record.name,
        description: record.pack?.description || record.description || '',
        note: record.note || '',
        lifecycle: 'deprecated',
        discoverable: false,
        protected: false,
        transient: false,
        taskTypes: [],
        typeNames: [],
        snapshotNames: [],
        hashes: [],
        fileCount: 0,
        sizeBytes: 0,
        installedAt: record.installedAt,
        deprecatedAt: record.deprecatedAt || null,
        modifiedAt: record.installedAt
      };
      current.taskTypes.push({
        name: record.name,
        title: record.title,
        lifecycle: record.lifecycle,
        discoverable: record.discoverable
      });
      current.typeNames.push(record.name);
      current.snapshotNames.push(record.snapshotName);
      current.hashes.push(record.sha256);
      current.fileCount += 1;
      current.sizeBytes += Number(record.size) || 0;
      current.lifecycle = record.lifecycle === 'active' ? 'active' : current.lifecycle;
      current.discoverable ||= record.discoverable === true && record.lifecycle === 'active';
      current.protected ||= record.protected === true;
      current.transient ||= record.transient === true;
      if (record.note && !current.note) current.note = record.note;
      if (record.deprecatedAt && (!current.deprecatedAt || record.deprecatedAt < current.deprecatedAt)) {
        current.deprecatedAt = record.deprecatedAt;
      }
      groups.set(id, current);
    }

    const registeredSnapshots = new Set(records.map((record) => record.snapshotName));
    for (const snapshot of snapshots) {
      if (registeredSnapshots.has(snapshot.snapshotName)) continue;
      const references = [...tasks.values()].filter((task) => (
        !task.deletedAt && task.taskTypeSha256 === snapshot.sha256
      ));
      const fallbackName = snapshot.snapshotName.replace(/-[a-f0-9]{64}\.mjs$/u, '');
      groups.set(snapshotAssetId(snapshot), {
        id: snapshotAssetId(snapshot),
        kind: references.length ? 'history' : 'orphan',
        source: references.length ? 'task-history' : 'orphan-snapshot',
        name: fallbackName,
        version: '',
        title: references.length ? `${fallbackName}（历史快照）` : `${fallbackName}（孤立快照）`,
        description: references.length
          ? '曾被任务使用、现已不在执行器注册表中的只读历史文件。'
          : '没有注册记录或任务引用的遗留文件，可安全清理。',
        note: '',
        lifecycle: 'retired',
        discoverable: false,
        protected: false,
        transient: false,
        taskTypes: [...new Set(references.map((task) => task.taskType))].map((name) => ({
          name, title: name, lifecycle: 'retired', discoverable: false
        })),
        typeNames: [],
        snapshotNames: [snapshot.snapshotName],
        hashes: [snapshot.sha256],
        fileCount: 1,
        sizeBytes: Number(snapshot.size) || 0,
        installedAt: snapshot.modifiedAt,
        deprecatedAt: null,
        modifiedAt: snapshot.modifiedAt
      });
    }

    const assets = [];
    for (const asset of groups.values()) {
      const typeNames = new Set(asset.typeNames);
      const hashes = new Set(asset.hashes);
      const related = [...tasks.values()].filter((task) => !task.deletedAt && taskMatchesAsset(task, typeNames, hashes));
      const states = {};
      let lastUsedAt = null;
      const blockers = [];
      const blockerCodes = [];
      const blockingTasks = [];
      for (const task of related) {
        states[task.state] = (states[task.state] || 0) + 1;
        const usedAt = taskLastUsedAt(task);
        if (usedAt && (!lastUsedAt || Date.parse(usedAt) > Date.parse(lastUsedAt))) lastUsedAt = usedAt;
        if (!TERMINAL_TASK_STATES.has(task.state) || task.cleanup?.settled !== true) {
          blockers.push(`任务 ${task.displayName || task.id} 尚未完成安全清理`);
          const blockerCode = TERMINAL_TASK_STATES.has(task.state) ? 'cleanup_pending' : 'active_task';
          blockerCodes.push(blockerCode);
          blockingTasks.push(taskAssetBlocker(task, blockerCode));
        } else if (
          task.state === 'failed' && task.supportsResume === true && task.checkpoint &&
          task.resumeCheckpointValid !== false
        ) {
          blockers.push(`任务 ${task.displayName || task.id} 仍可从检查点恢复`);
          blockerCodes.push('resume_available');
          blockingTasks.push(taskAssetBlocker(task, 'resume_available'));
        }
      }
      if (asset.protected) {
        blockers.push('系统验收或基础能力受保护');
        blockerCodes.push('protected');
      }
      asset.usage = {
        runCount: related.length,
        successCount: states.completed || 0,
        failureCount: states.failed || 0,
        activeCount: related.filter((task) => !TERMINAL_TASK_STATES.has(task.state)).length,
        states,
        lastUsedAt
      };
      asset.canEditNote = asset.typeNames.length > 0;
      asset.canChangeLifecycle = asset.typeNames.length > 0 && !asset.protected;
      asset.deletable = blockers.length === 0;
      asset.deleteBlockers = [...new Set(blockers)].slice(0, 8);
      asset.deleteBlockerCodes = [...new Set(blockerCodes)].slice(0, 8);
      asset.blockingTaskCount = blockingTasks.length;
      asset.blockingTasks = blockingTasks.slice(0, MAX_TASK_ASSET_BLOCKING_TASKS);
      asset.taskTypes.sort((left, right) => left.name.localeCompare(right.name));
      assets.push(asset);
    }
    return assets.sort((left, right) => (
      Number(right.discoverable) - Number(left.discoverable) ||
      Number(left.protected) - Number(right.protected) ||
      (right.usage.lastUsedAt || '').localeCompare(left.usage.lastUsedAt || '') ||
      left.title.localeCompare(right.title)
    ));
  }

  async function listTaskAssets(suppliedCaller = {}) {
    await awaitReady();
    const caller = callerIdentity(suppliedCaller);
    if (caller.role !== 'manager-admin') {
      throw new TaskServiceError('TASK_ASSET_LIST_FORBIDDEN', 'Only the Owner Dashboard can list task assets', 403);
    }
    const assets = (await buildTaskAssets()).map(publicTaskAsset);
    return { assets, total: assets.length };
  }

  async function listTaskPacks(suppliedCaller = {}) {
    await awaitReady();
    callerIdentity(suppliedCaller);
    const taskPacks = (await buildTaskAssets())
      .filter((asset) => asset.kind === 'pack')
      .map((asset) => ({
        id: asset.id,
        name: asset.name,
        version: asset.version,
        title: asset.title,
        ...(asset.description ? { description: asset.description } : {}),
        lifecycle: asset.lifecycle,
        discoverable: asset.discoverable,
        protected: asset.protected,
        transient: asset.transient,
        fileCount: asset.fileCount,
        sizeBytes: asset.sizeBytes,
        installedAt: asset.installedAt,
        ...(asset.deprecatedAt ? { deprecatedAt: asset.deprecatedAt } : {}),
        usage: {
          runCount: asset.usage.runCount,
          activeCount: asset.usage.activeCount,
          ...(asset.usage.lastUsedAt ? { lastUsedAt: asset.usage.lastUsedAt } : {})
        },
        taskTypes: asset.taskTypes.map((taskType) => ({ ...taskType })),
        deletable: asset.deletable,
        deleteBlockerCodes: [...asset.deleteBlockerCodes]
      }));
    return { taskPacks, total: taskPacks.length };
  }

  function validateTaskAssetAction(input) {
    const allowed = new Set(['action', 'assetIds', 'note', 'confirm', 'commandId']);
    const unknown = Object.keys(input || {}).filter((key) => !allowed.has(key));
    if (unknown.length) throw new TaskServiceError('INVALID_TASK_ASSET_ACTION', `Unsupported fields: ${unknown.join(', ')}`);
    if (!['deprecate', 'restore', 'delete', 'force-delete', 'note'].includes(input?.action)) {
      throw new TaskServiceError('INVALID_TASK_ASSET_ACTION', 'Action must be deprecate, restore, delete, force-delete, or note');
    }
    if (
      !Array.isArray(input.assetIds) || input.assetIds.length < 1 || input.assetIds.length > MAX_TASK_ASSET_BATCH ||
      input.assetIds.some((id) => typeof id !== 'string' || id.length < 3 || id.length > 240)
    ) {
      throw new TaskServiceError('INVALID_TASK_ASSET_BATCH', `Select 1 to ${MAX_TASK_ASSET_BATCH} task assets`);
    }
    if (input.action === 'note' && (typeof input.note !== 'string' || input.note.length > 1_000)) {
      throw new TaskServiceError('INVALID_TASK_ASSET_NOTE', 'Asset note must contain at most 1000 characters');
    }
    if (input.action === 'force-delete') {
      if (input.confirm !== true) {
        throw new TaskServiceError(
          'TASK_ASSET_FORCE_DELETE_CONFIRMATION_REQUIRED',
          'Owner confirmation is required before executor assets can be force-deleted',
          409
        );
      }
      if (typeof input.commandId !== 'string' || !COMMAND_ID_PATTERN.test(input.commandId)) {
        throw new TaskServiceError(
          'INVALID_TASK_ASSET_ACTION',
          'commandId must contain 8-128 letters, numbers, dots, underscores, colons, or hyphens'
        );
      }
    }
    return { ...input, assetIds: [...new Set(input.assetIds)] };
  }

  async function applyTaskAssetAction(input = {}, suppliedCaller = {}) {
    requireServiceOpen();
    return serializeMutation(() => applyTaskAssetActionSerialized(input, suppliedCaller));
  }

  async function applyTaskAssetActionSerialized(input = {}, suppliedCaller = {}) {
    await awaitReady();
    requireServiceOpen();
    const caller = callerIdentity(suppliedCaller);
    if (caller.role !== 'manager-admin') {
      throw new TaskServiceError('TASK_ASSET_MANAGE_FORBIDDEN', 'Only the Owner Dashboard can manage task assets', 403);
    }
    const request = validateTaskAssetAction(input);
    const assets = await buildTaskAssets();
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    const selected = request.assetIds.map((id) => byId.get(id));
    const missingIndex = selected.findIndex((asset) => !asset);
    if (missingIndex >= 0) {
      throw new TaskServiceError('TASK_ASSET_NOT_FOUND', `Task asset ${request.assetIds[missingIndex]} was not found`, 404);
    }
    if (request.action === 'delete' || request.action === 'force-delete') {
      if (request.action === 'force-delete') {
        const protectedAsset = selected.find((asset) => asset.protected);
        if (protectedAsset) {
          throw new TaskServiceError(
            'TASK_ASSET_PROTECTED',
            `${protectedAsset.title} is a protected system asset`,
            409
          );
        }
        const taskIds = [...new Set(selected.flatMap((asset) => {
          const typeNames = new Set(asset.typeNames);
          const hashes = new Set(asset.hashes);
          return [...tasks.values()]
            .filter((task) => !task.deletedAt && taskMatchesAsset(task, typeNames, hashes))
            .map((task) => task.id);
        }))];
        await forceDetachTaskAssetReferences(taskIds, {
          commandId: request.commandId,
          actor: { role: caller.role, clientId: caller.clientId }
        });
        const refreshedById = new Map((await buildTaskAssets()).map((asset) => [asset.id, asset]));
        for (let index = 0; index < selected.length; index += 1) {
          selected[index] = refreshedById.get(selected[index].id);
        }
      }
      const blocked = selected.find((asset) => !asset.deletable);
      if (blocked) {
        throw new TaskServiceError(
          'TASK_ASSET_DELETE_BLOCKED',
          `${blocked.title} cannot be deleted: ${blocked.deleteBlockers.join('; ')}`,
          409
        );
      }
      const typeNames = selected.flatMap((asset) => asset.typeNames);
      const snapshotNames = selected.flatMap((asset) => asset.snapshotNames);
      if (typeNames.length) await registry.removeMany(typeNames);
      const current = await registry.snapshotInventory();
      const unregistered = new Set(current.filter((item) => !item.registered).map((item) => item.snapshotName));
      const leftovers = snapshotNames.filter((name) => unregistered.has(name));
      if (leftovers.length) await registry.removeSnapshots(leftovers);
    } else {
      const unsupported = selected.find((asset) => (
        asset.typeNames.length === 0 || (request.action !== 'note' && !asset.canChangeLifecycle)
      ));
      if (unsupported) {
        throw new TaskServiceError(
          'TASK_ASSET_ACTION_UNSUPPORTED',
          `${unsupported.title} does not support ${request.action}`,
          409
        );
      }
      const typeNames = selected.flatMap((asset) => asset.typeNames);
      if (request.action === 'note') await registry.setNoteMany(typeNames, request.note);
      else await registry.setLifecycleMany(typeNames, request.action === 'restore' ? 'active' : 'deprecated');
    }
    const refreshed = (await buildTaskAssets()).map(publicTaskAsset);
    return { assets: refreshed, total: refreshed.length, changed: selected.length };
  }

  async function retireTransientTaskType(task) {
    if (!TERMINAL_TASK_STATES.has(task.state) || task.cleanup?.settled !== true) return;
    const record = (await registry.listManagement()).find((item) => (
      item.name === task.taskType && item.sha256 === task.taskTypeSha256
    ));
    if (!record?.transient || record.lifecycle === 'deprecated') return;
    await registry.setLifecycleMany([record.name], 'deprecated');
  }

  async function maintainTaskAssets() {
    const assets = await buildTaskAssets();
    const cutoff = Date.now() - TRANSIENT_ASSET_RETENTION_MS;
    const transientTypes = assets
      .filter((asset) => (
        asset.transient && asset.lifecycle === 'deprecated' && asset.deletable &&
        Date.parse(asset.deprecatedAt || asset.installedAt) < cutoff
      ))
      .flatMap((asset) => asset.typeNames);
    if (transientTypes.length) await registry.removeMany(transientTypes);
    const orphanSnapshots = assets
      .filter((asset) => asset.kind === 'orphan' && asset.deletable && Date.parse(asset.modifiedAt) < cutoff)
      .flatMap((asset) => asset.snapshotNames);
    if (orphanSnapshots.length) await registry.removeSnapshots(orphanSnapshots);
  }


  return Object.freeze({
    applyTaskAssetAction,
    deprecateTaskType,
    describeTaskType,
    installTaskPack,
    installTaskType,
    listTaskAssets,
    listTaskPacks,
    listTaskTypes,
    maintainTaskAssets,
    restoreTaskType,
    retireTransientTaskType
  });
}
