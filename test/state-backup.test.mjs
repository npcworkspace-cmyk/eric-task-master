import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createStateBackup,
  restoreStateBackup,
  verifyStateBackup
} from '../src/operations/state-backup.mjs';

test('state backup is immutable, hash-verified, and restores only into an absent directory', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-state-backup-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const source = path.join(root, 'state');
  const backup = path.join(root, 'backup');
  const restored = path.join(root, 'restored');
  await mkdir(path.join(source, 'profiles', 'profile_fixture'), { recursive: true });
  await writeFile(path.join(source, 'config.json'), '{"identity":"fixture"}\n');
  await writeFile(path.join(source, 'profiles', 'profile_fixture', 'Cookies'), 'cookie-state');

  const manifest = await createStateBackup({ sourceDir: source, backupDir: backup });
  assert.equal(manifest.fileCount, 2);
  assert.equal((await verifyStateBackup({ backupDir: backup })).backupId, manifest.backupId);
  await restoreStateBackup({ backupDir: backup, destinationDir: restored });
  assert.equal(await readFile(path.join(restored, 'profiles', 'profile_fixture', 'Cookies'), 'utf8'), 'cookie-state');

  await assert.rejects(
    restoreStateBackup({ backupDir: backup, destinationDir: restored }),
    { code: 'STATE_RESTORE_DESTINATION_EXISTS' }
  );
  await writeFile(path.join(backup, 'payload', 'config.json'), 'tampered');
  await assert.rejects(verifyStateBackup({ backupDir: backup }), { code: 'STATE_BACKUP_CONTENT_MISMATCH' });
});

test('state backup rejects live Manager locks, overlapping roots, and links', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-state-backup-guard-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const source = path.join(root, 'state');
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'config.json'), '{}\n');
  await writeFile(path.join(source, '.manager.lock'), '{}\n');
  await assert.rejects(
    createStateBackup({ sourceDir: source, backupDir: path.join(root, 'locked-backup') }),
    { code: 'STATE_BACKUP_MANAGER_ACTIVE' }
  );
  await rm(path.join(source, '.manager.lock'));
  await assert.rejects(
    createStateBackup({ sourceDir: source, backupDir: path.join(source, 'nested') }),
    { code: 'STATE_BACKUP_PATH_OVERLAP' }
  );
  try {
    await symlink(path.join(source, 'config.json'), path.join(source, 'config-link.json'));
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error?.code)) return;
    throw error;
  }
  await assert.rejects(
    createStateBackup({ sourceDir: source, backupDir: path.join(root, 'link-backup') }),
    { code: 'STATE_BACKUP_LINK_UNSUPPORTED' }
  );
});
