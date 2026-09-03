#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/contracts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function exists(relative) {
  try {
    await access(path.join(ROOT, ...relative.split('/')));
    return true;
  } catch {
    return false;
  }
}

async function filesUnder(relative, predicate = () => true) {
  const root = path.join(ROOT, ...relative.split('/'));
  if (!(await exists(relative))) return [];
  const result = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && predicate(candidate)) result.push(candidate);
    }
  }
  return result.sort();
}

async function run(name, command, args, env = {}) {
  process.stdout.write(`\n== ${name} ==\n`);
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: 'inherit',
      windowsHide: true
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${name} exited with ${signal || code}`));
    });
  });
}

async function staticChecks() {
  const packageJson = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const changelog = await readFile(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const cli = await readFile(path.join(ROOT, 'src', 'cli.mjs'), 'utf8');
  const manager = await readFile(path.join(ROOT, 'src', 'manager.mjs'), 'utf8');
  const worker = await readFile(path.join(ROOT, 'src', 'runtime', 'task-worker.mjs'), 'utf8');
  const browser = await readFile(path.join(ROOT, 'src', 'runtime', 'browser-engine.mjs'), 'utf8');
  const skill = await readFile(path.join(ROOT, 'skills', 'eric-task-master', 'SKILL.md'), 'utf8');
  const workflow = await readFile(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

  invariant(packageJson.version === VERSION, 'package.json and runtime versions differ');
  invariant(lock.version === VERSION && lock.packages?.['']?.version === VERSION, 'package-lock version differs');
  invariant(/^3\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(VERSION), 'v3 release must use a stable semantic version');
  invariant(packageJson.bin?.taskmaster === './src/cli.mjs', 'CLI binary contract changed');
  invariant(JSON.stringify(Object.keys(packageJson.dependencies || {})) === JSON.stringify(['playwright']),
    'Playwright must be the only production dependency');
  invariant(Object.keys(packageJson.devDependencies || {}).length === 0, 'v3 has no development dependency requirement');
  invariant(changelog.replaceAll('\r\n', '\n').startsWith(`# Changelog\n\n## ${VERSION} - `),
    'Changelog does not lead with the current release version');

  const forbidden = [
    'src/mcp',
    'src/registration',
    'extension',
    'docs/MCP.md',
    'docs/MCP-HOSTS.md',
    'docs/TASK-PACK-SECURITY.md',
    'skills/eric-task-master/runtime.json',
    'skills/eric-task-master/references',
    'skills/eric-task-master/scripts',
    'examples/tasks'
  ];
  for (const relative of forbidden) {
    const remains = path.extname(relative)
      ? await exists(relative)
      : (await filesUnder(relative)).length > 0;
    invariant(!remains, `obsolete v2 surface remains: ${relative}`);
  }

  const skillEntries = (await readdir(path.join(ROOT, 'skills', 'eric-task-master'), { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  invariant(JSON.stringify(skillEntries) === JSON.stringify(['LICENSE', 'SKILL.md']), 'portable Skill must contain one guide and its license');
  invariant(skill.split(/\r?\n/u).length <= 70, 'portable Skill is no longer one-page');
  invariant(!/@modelcontextprotocol|surface-probe|full-human|journey|task type|task pack/iu.test(skill),
    'portable Skill exposes a removed v2 concept');
  invariant(cli.includes("if (command === 'run')") && cli.includes("if (command === 'panel')"),
    'CLI fast path is missing');
  invariant(!/connect|register-mcp|modelcontextprotocol/iu.test(cli), 'CLI contains a removed connection path');
  invariant(manager.includes("pathname === '/v1/tasks'") && manager.includes("pathname === '/v1/profiles'"),
    'minimal Manager API is missing');
  invariant(worker.includes('page,') && worker.includes('playwright,') && worker.includes('wait: waitForResume'),
    'raw task runtime is incomplete');
  invariant(browser.includes("channel: 'chrome'") && browser.includes("ignoreDefaultArgs: ['--disable-extensions']"),
    'stable Chrome or extension support changed');

  for (const target of ['windows-x64', 'macos-arm64', 'macos-x64', 'linux-x64', 'linux-arm64']) {
    invariant(workflow.includes(`target: ${target}`), `CI lacks ${target}`);
  }
  invariant(workflow.includes('npm run check'), 'CI must execute the complete source gate');
  process.stdout.write(`${JSON.stringify({ ok: true, stage: 'static', version: VERSION })}\n`);
}

await staticChecks();
const syntaxFiles = [
  ...await filesUnder('src', (file) => file.endsWith('.mjs')),
  ...await filesUnder('scripts', (file) => file.endsWith('.mjs')),
  ...await filesUnder('test-v3', (file) => file.endsWith('.mjs'))
];
for (const file of syntaxFiles) {
  await run(`syntax ${path.relative(ROOT, file)}`, process.execPath, ['--check', file]);
}

const testFiles = await filesUnder('test-v3', (file) => file.endsWith('.test.mjs'));
invariant(testFiles.length >= 5, 'v3 test suite is unexpectedly small');
await run('v3 unit and integration tests', process.execPath, ['--test', '--test-concurrency=1', ...testFiles]);
await run('real Chrome acceptance', process.execPath, [path.join(ROOT, 'scripts', 'acceptance.mjs')]);
await run('real Dashboard acceptance', process.execPath, [path.join(ROOT, 'scripts', 'dashboard-acceptance.mjs')]);
await run('distribution policy', process.execPath, [path.join(ROOT, 'scripts', 'build', 'check-distribution.mjs')]);

process.stdout.write(`\n${JSON.stringify({
  ok: true,
  version: VERSION,
  stages: ['static', 'syntax', 'tests', 'real-chrome', 'dashboard', 'distribution']
})}\n`);
