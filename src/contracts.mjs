export const VERSION = '0.0.1';
export const API_VERSION = 1;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 19946;
export const BEHAVIOR_MODES = Object.freeze(['fast', 'human', 'adaptive']);
export const PROFILE_STATES = Object.freeze(['idle', 'starting', 'open', 'leased', 'error']);
export const TASK_STATES = Object.freeze([
  'queued',
  'acquiring_profile',
  'starting_browser',
  'running',
  'waiting_user',
  'cooling_down',
  'recovering',
  'verifying',
  'completed',
  'failed',
  'cancelled'
]);
export const TERMINAL_TASK_STATES = new Set(['completed', 'failed', 'cancelled']);

export function isBehaviorMode(value) {
  return BEHAVIOR_MODES.includes(value);
}

export function publicProfile(profile) {
  const { userDataDir: _userDataDir, lease: _lease, ...safe } = profile;
  return safe;
}

export function publicTask(task) {
  const { modulePath: _modulePath, managerToken: _managerToken, ...safe } = task;
  return safe;
}
