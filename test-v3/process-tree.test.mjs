import assert from 'node:assert/strict';
import test from 'node:test';
import { commandLineUsesProfile } from '../src/lib/process-tree.mjs';

test('macOS ps command lines match an exact Profile path containing spaces', () => {
  const profile = '/Users/eric/Library/Application Support/Eric Task Master/profiles/profile_123';
  assert.equal(commandLineUsesProfile(
    `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-pipe --user-data-dir=${profile} --no-first-run about:blank`,
    profile,
    { caseInsensitive: false }
  ), true);
  assert.equal(commandLineUsesProfile(
    `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir ${profile} --remote-debugging-pipe`,
    profile,
    { caseInsensitive: false }
  ), true);
  assert.equal(commandLineUsesProfile(
    `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome "--user-data-dir=${profile}" --remote-debugging-pipe`,
    profile,
    { caseInsensitive: false }
  ), true);
});

test('Profile command-line matching rejects path prefixes and different Profiles', () => {
  const profile = '/Users/eric/Library/Application Support/Eric Task Master/profiles/profile_123';
  const base = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  assert.equal(commandLineUsesProfile(
    `${base} --user-data-dir=${profile} Copy --remote-debugging-pipe`,
    profile,
    { caseInsensitive: false }
  ), false);
  assert.equal(commandLineUsesProfile(
    `${base} --user-data-dir=${profile}-other --remote-debugging-pipe`,
    profile,
    { caseInsensitive: false }
  ), false);
  assert.equal(commandLineUsesProfile(
    `${base} --user-data-dir=/Users/eric/Library/Application Support/Eric Task Master/profiles/profile_999 --remote-debugging-pipe`,
    profile,
    { caseInsensitive: false }
  ), false);
  assert.equal(commandLineUsesProfile(
    `${base} --description=${profile} --remote-debugging-pipe`,
    profile,
    { caseInsensitive: false }
  ), false);
});

test('Windows Profile command-line matching is case-insensitive and space-safe', () => {
  const profile = 'C:\\Users\\Eric\\Task Master\\profiles\\profile_123';
  assert.equal(commandLineUsesProfile(
    '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" "--user-data-dir=c:\\users\\eric\\task master\\profiles\\PROFILE_123" --remote-debugging-pipe',
    profile,
    { caseInsensitive: true }
  ), true);
});
