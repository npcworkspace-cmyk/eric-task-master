#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/contracts.mjs';
import { commandLineUsesProfile } from '../src/lib/process-tree.mjs';

const execFile = promisify(execFileCallback);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli.mjs');
const checks = [];

function add(name, passed, detail = '') {
  checks.push({ name, passed: Boolean(passed), ...(detail ? { detail } : {}) });
  if (!passed) throw new Error(`${name}: ${detail || 'failed'}`);
}

function parseLines(source) {
  return String(source)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function reservePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function inspectManualChromeSandbox(userDataDir) {
  const command = process.platform === 'win32' ? 'powershell.exe' : 'ps';
  const args = process.platform === 'win32'
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; $OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process -Filter \"Name = 'chrome.exe'\" | ForEach-Object { $_.CommandLine }"]
    : ['-Aww', '-o', 'command='];
  const { stdout } = await execFile(command, args, {
    windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024
  });
  // Inspect only the Chrome launched for this temporary acceptance Profile;
  // never include command lines or user Profile data in the report.
  const browsers = stdout.split(/\r?\n/u).filter((line) => (
    line.includes('--remote-debugging-pipe') && !/(?:^|[\s"])--type=/u.test(line) &&
    commandLineUsesProfile(line, userDataDir)
  ));
  return {
    matchedBrowsers: browsers.length,
    noSandbox: browsers.some((line) => /(?:^|[\s"])--no-sandbox(?:$|[\s"=])/u.test(line))
  };
}

async function createFixture() {
  const server = http.createServer((request, response) => {
    if (request.url === '/download') {
      response.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': 'attachment; filename="acceptance-download.txt"'
      });
      response.end('download-ok');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end([
      '<!doctype html><html><head><title>Task Master Acceptance</title></head><body>',
      '<label>Name <input id="name"></label>',
      '<label>Mode <select id="mode"><option value="a">A</option><option value="b">B</option></select></label>',
      '<label>Ready <input id="ready" type="checkbox"></label>',
      '<input id="upload" type="file">',
      '<button id="apply" type="button">Apply</button>',
      '<a id="download" href="/download">Download</a>',
      '<output id="result"></output>',
      '<script>document.querySelector("#apply").addEventListener("click",()=>{document.querySelector("#result").textContent=[document.querySelector("#name").value,document.querySelector("#mode").value,document.querySelector("#ready").checked].join("|")})</script>',
      '</body></html>'
    ].join(''));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

async function main() {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'eric-task-master-v3-acceptance-'));
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'eric-task-master-v3-jobs-'));
  const port = await reservePort();
  const env = {
    ...process.env,
    ERIC_TASK_MASTER_HOME: stateDir,
    ERIC_TASK_MASTER_PORT: String(port),
    NODE_OPTIONS: ''
  };
  const fixture = await createFixture();
  const taskIds = [];
  let profileA;
  let profileB;

  const cli = async (args, timeout = 120_000, { allowExpectedTaskFailure = false } = {}) => {
    try {
      const result = await execFile(process.execPath, [CLI, ...args], {
        cwd: ROOT,
        env,
        windowsHide: true,
        timeout,
        maxBuffer: 16 * 1024 * 1024
      });
      return { ...result, records: parseLines(result.stdout) };
    } catch (error) {
      if (!allowExpectedTaskFailure || error.code !== 1 || error.killed || error.signal) throw error;
      return {
        stdout: error.stdout || '',
        stderr: error.stderr || '',
        exitCode: error.code,
        records: parseLines(error.stdout || '')
      };
    }
  };
  const taskFrom = (result) => {
    const task = [...result.records].reverse().find((record) => record?.task)?.task;
    assert.ok(task, 'CLI output did not contain a task');
    return task;
  };
  const waitState = async (id, expected, timeout = 30_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const task = taskFrom(await cli(['status', id, '--json']));
      if (expected.includes(task.state)) return task;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`Timed out waiting for ${id} to enter ${expected.join('/')}`);
  };

  const browserJob = path.join(workDir, 'browser-job.mjs');
  const waitJob = path.join(workDir, 'wait-job.mjs');
  const quickJob = path.join(workDir, 'quick-job.mjs');
  const failingJob = path.join(workDir, 'failing-job.mjs');
  const endlessJob = path.join(workDir, 'endless-job.mjs');
  const inputPath = path.join(workDir, 'input.json');
  const uploadPath = path.join(workDir, 'upload.txt');

  await writeFile(uploadPath, 'upload-ok');
  await writeFile(inputPath, JSON.stringify({ url: fixture.url, name: 'Eric', uploadPath }));
  await writeFile(browserJob, [
    "import { chromium } from 'playwright';",
    "import { appendFile, readFile, writeFile } from 'node:fs/promises';",
    "import path from 'node:path';",
    'export async function run({ page, context, input, outputDir, progress }) {',
    "  const partial = path.join(outputDir, 'progress.jsonl');",
    "  await page.goto(input.url, { waitUntil: 'domcontentloaded' });",
    "  await appendFile(partial, JSON.stringify({ step: 'navigate' }) + '\\n');",
    "  await progress({ current: 1, total: 6, message: 'navigated' });",
    "  await page.locator('#name').fill(input.name);",
    "  await page.locator('#mode').selectOption('b');",
    "  await page.locator('#ready').check();",
    "  await page.locator('#upload').setInputFiles(input.uploadPath);",
    "  await progress({ current: 2, total: 6, message: 'form ready' });",
    "  await page.locator('#apply').click();",
    "  const rendered = await page.locator('#result').textContent();",
    "  const evaluated = await page.evaluate(() => document.title);",
    "  await progress({ current: 3, total: 6, message: 'DOM evaluated' });",
    '  const cdp = await context.newCDPSession(page);',
    "  const cdpValue = await cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });",
    '  const versionPage = await context.newPage();',
    '  let chromeCommandLine;',
    '  try {',
    "    await versionPage.goto('chrome://version');",
    "    chromeCommandLine = await versionPage.locator('#command_line').textContent();",
    '  } finally { await versionPage.close(); }',
    "  await progress({ current: 4, total: 6, message: 'CDP evaluated' });",
    "  const downloadEvent = page.waitForEvent('download');",
    "  await page.locator('#download').click();",
    '  const download = await downloadEvent;',
    "  await download.saveAs(path.join(outputDir, 'download.txt'));",
    "  await progress({ current: 5, total: 6, message: 'downloaded' });",
    '  const report = {',
    '    barePlaywrightImport: typeof chromium?.launchPersistentContext === \'function\',',
    "    sandboxEnabled: chromeCommandLine.includes('--remote-debugging-pipe') && !/(?:^|[\\s\"])--no-sandbox(?:$|[\\s\"=])/u.test(chromeCommandLine),",
    "    rendered, evaluated, cdp: cdpValue.result.value,",
    "    upload: await readFile(input.uploadPath, 'utf8'),",
    "    download: await readFile(path.join(outputDir, 'download.txt'), 'utf8')",
    '  };',
    "  await writeFile(path.join(outputDir, 'result.json'), JSON.stringify(report));",
    "  await progress({ current: 6, total: 6, message: 'complete' });",
    '  return report;',
    '}',
    ''
  ].join('\n'));
  await writeFile(waitJob, [
    "import { writeFile } from 'node:fs/promises';",
    "import path from 'node:path';",
    'export async function run({ page, input, outputDir, progress, wait }) {',
    "  await page.goto(input.url, { waitUntil: 'domcontentloaded' });",
    "  await progress({ current: 1, total: 2, message: 'waiting' });",
    "  const resumedWith = await wait({ reason: 'acceptance pause', data: { step: 1 } });",
    "  await writeFile(path.join(outputDir, 'resume.json'), JSON.stringify(resumedWith));",
    "  await progress({ current: 2, total: 2, message: 'resumed' });",
    '  return { resumedWith };',
    '}',
    ''
  ].join('\n'));
  await writeFile(quickJob, [
    'export async function run({ page, input, progress }) {',
    "  await page.goto(input.url, { waitUntil: 'domcontentloaded' });",
    "  await progress({ current: 1, total: 1, message: 'quick' });",
    '  return { title: await page.title() };',
    '}',
    ''
  ].join('\n'));
  await writeFile(failingJob, [
    "import { writeFile } from 'node:fs/promises';",
    "import path from 'node:path';",
    'export async function run({ page, input, outputDir }) {',
    "  await page.goto(input.url, { waitUntil: 'domcontentloaded' });",
    "  await writeFile(path.join(outputDir, 'partial.json'), JSON.stringify({ processed: 1 }));",
    "  throw Object.assign(new Error('intentional acceptance failure'), { code: 'ACCEPTANCE_INTENTIONAL' });",
    '}',
    ''
  ].join('\n'));
  await writeFile(endlessJob, [
    'export async function run({ page, input, progress, signal }) {',
    "  await page.goto(input.url, { waitUntil: 'domcontentloaded' });",
    "  await progress({ current: 1, total: null, message: 'running until deleted' });",
    '  await new Promise((resolve, reject) => {',
    "    signal.addEventListener('abort', () => reject(signal.reason), { once: true });",
    '  });',
    '  return { unreachable: true };',
    '}',
    ''
  ].join('\n'));

  try {
    const status = (await cli(['status', '--json'])).records.at(-1);
    add('CLI auto-starts the loopback Manager', status.ok && status.state === 'ready');
    const dashboard = await fetch(`http://127.0.0.1:${port}/dashboard`).then((response) => response.text());
    add('fixed Dashboard is served', dashboard.includes('Eric Task Master'));

    profileA = (await cli(['profiles', 'create', 'Acceptance Primary', '--json'])).records.at(-1).profile;
    profileB = (await cli(['profiles', 'create', 'Acceptance Default', '--json'])).records.at(-1).profile;
    await cli(['profiles', 'rename', profileB.id, '--name', 'Acceptance Renamed', '--json']);
    await cli(['profiles', 'default', profileB.id, '--json']);
    const profiles = (await cli(['profiles', 'list', '--json'])).records.at(-1).profiles;
    add('Profile create, rename, and default selection', profiles.length === 2 &&
      profiles.some((profile) => profile.id === profileB.id && profile.name === 'Acceptance Renamed' && profile.isDefault));

    await cli(['profiles', 'open', profileA.id, '--json'], 120_000);
    const opened = (await cli(['profiles', 'list', '--json'])).records.at(-1).profiles.find((profile) => profile.id === profileA.id);
    const manualSandbox = await inspectManualChromeSandbox(path.join(stateDir, 'profiles', profileA.id));
    await cli(['profiles', 'close', profileA.id, '--json'], 60_000);
    const closed = (await cli(['profiles', 'list', '--json'])).records.at(-1).profiles.find((profile) => profile.id === profileA.id);
    add('visible Profile open and close with Chrome sandbox',
      opened.state === 'open' && closed.state === 'idle' && manualSandbox.matchedBrowsers === 1 && !manualSandbox.noSandbox,
      JSON.stringify(manualSandbox));

    const browserRun = await cli(['run', browserJob, '--input', `@${inputPath}`, '--json'], 120_000,
      { allowExpectedTaskFailure: true });
    const browserTask = taskFrom(browserRun);
    taskIds.push(browserTask.id);
    const browserResult = browserTask.result;
    add('sandboxed Chrome, raw Playwright, evaluate, CDP, upload, and download', browserTask.state === 'finished' &&
      browserResult.sandboxEnabled === true &&
      browserResult.barePlaywrightImport && browserResult.rendered === 'Eric|b|true' &&
      browserResult.evaluated === 'Task Master Acceptance' &&
      browserResult.cdp === 'Task Master Acceptance' &&
      browserResult.upload === 'upload-ok' && browserResult.download === 'download-ok',
      browserTask.error ? JSON.stringify({ error: browserTask.error, progress: browserTask.progress }).slice(0, 5_000) : '');
    const resultRead = (await cli(['files', browserTask.id, '--read', 'result.json', '--json'])).records.at(-1).artifact;
    add('incremental output is readable through CLI', JSON.parse(Buffer.from(resultRead.data, 'base64')).download === 'download-ok');

    const waitingCreated = taskFrom(await cli([
      'run', waitJob, '--input', JSON.stringify({ url: fixture.url }), '--detach', '--json'
    ]));
    taskIds.push(waitingCreated.id);
    await waitState(waitingCreated.id, ['waiting']);
    const queuedCreated = taskFrom(await cli([
      'run', quickJob, '--input', JSON.stringify({ url: fixture.url }), '--detach', '--json'
    ]));
    taskIds.push(queuedCreated.id);
    const queued = await waitState(queuedCreated.id, ['queued']);
    add('same Profile has one writer and queues the next task', queued.state === 'queued');
    await cli(['resume', waitingCreated.id, '--value', JSON.stringify({ approved: true }), '--json']);
    const resumed = taskFrom(await cli(['follow', waitingCreated.id, '--json'], 120_000));
    const queuedFinished = taskFrom(await cli(['follow', queuedCreated.id, '--json'], 120_000));
    add('generic wait and explicit resume work', resumed.state === 'finished' && resumed.result.resumedWith.approved === true);
    add('queued task starts after lease release', queuedFinished.state === 'finished');

    const failed = taskFrom(await cli([
      'run', failingJob, '--input', JSON.stringify({ url: fixture.url }), '--json'
    ], 120_000, { allowExpectedTaskFailure: true }));
    taskIds.push(failed.id);
    const failedFiles = (await cli(['files', failed.id, '--json'])).records.at(-1).artifacts.map((item) => item.path);
    add('failure preserves partial output and captures the page', failed.state === 'error' &&
      failed.error.code === 'ACCEPTANCE_INTENTIONAL' &&
      failedFiles.includes('partial.json') && failedFiles.includes('failure.png'));

    const endless = taskFrom(await cli([
      'run', endlessJob, '--input', JSON.stringify({ url: fixture.url }), '--detach', '--json'
    ]));
    taskIds.push(endless.id);
    await waitState(endless.id, ['running']);
    await cli(['delete', endless.id, '--json'], 60_000);
    await cli(['delete', endless.id, '--json'], 60_000);
    taskIds.splice(taskIds.indexOf(endless.id), 1);
    const releasedProfile = (await cli(['profiles', 'list', '--json'])).records.at(-1).profiles
      .find((profile) => profile.id === profileB.id);
    add('deleting a running task kills it and releases the Profile', releasedProfile.state === 'idle');

    for (const id of [...taskIds]) await cli(['delete', id, '--json'], 60_000);
    taskIds.length = 0;
    await cli(['profiles', 'delete', profileA.id, '--json'], 60_000);
    profileA = null;
    await cli(['profiles', 'delete', profileB.id, '--json'], 60_000);
    profileB = null;
    const empty = (await cli(['profiles', 'list', '--json'])).records.at(-1).profiles;
    add('task and Profile deletion are complete and retry-safe', empty.length === 0);

    await cli(['manager', 'stop', '--json'], 30_000);
    let stopped = false;
    try {
      await fetch(`http://127.0.0.1:${port}/v1/health`, { signal: AbortSignal.timeout(1_000) });
    } catch {
      stopped = true;
    }
    add('Manager stops without leaving its listener behind', stopped);
  } finally {
    for (const id of taskIds) await cli(['delete', id, '--json'], 30_000).catch(() => {});
    if (profileA?.id) await cli(['profiles', 'delete', profileA.id, '--json'], 30_000).catch(() => {});
    if (profileB?.id) await cli(['profiles', 'delete', profileB.id, '--json'], 30_000).catch(() => {});
    await cli(['manager', 'stop', '--json'], 30_000).catch(() => {});
    await fixture.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  }
}

let failure = null;
try {
  await main();
} catch (error) {
  failure = { code: error.code || 'ACCEPTANCE_FAILED', message: error.message };
}

const report = {
  ok: !failure && checks.every((check) => check.passed),
  version: VERSION,
  passed: checks.filter((check) => check.passed).length,
  total: checks.length,
  checks,
  ...(failure ? { error: failure } : {}),
  checkedAt: new Date().toISOString()
};
if (process.env.TASKMASTER_ACCEPTANCE_REPORT) {
  const reportPath = path.resolve(process.env.TASKMASTER_ACCEPTANCE_REPORT);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.ok) process.exitCode = 1;
