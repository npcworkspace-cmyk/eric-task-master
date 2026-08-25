import { writeFile } from 'node:fs/promises';
import path from 'node:path';

export const meta = Object.freeze({
  name: 'handoff-acceptance',
  version: '1.0.0',
  description: 'Built-in acceptance task for waiting_user continuation and diagnostic capture.',
  intents: ['accept-handoff'],
  tags: ['acceptance', 'builtin'],
  outputs: ['json'],
  risk: 'read',
  readOnly: true,
  supportsResume: false,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['url'],
    properties: { url: { type: 'string', minLength: 8, maxLength: 4096 } }
  }
});

export async function run({ page, input, outputDir, action, handoff, progress, checkpoint }) {
  await action.goto(input.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await progress({ current: 1, total: 3, message: 'Handoff fixture loaded' });
  const instruction = await handoff.request({
    reason: 'Acceptance requires one explicit continuation',
    instructions: 'Inspect the screenshot and semantic observation, then continue this same task.',
    timeoutMs: 60_000
  });
  await progress({ current: 2, total: 3, message: 'Continuation received; verifying page' });
  const title = await page.title();
  const passed = title === 'Task Master acceptance fixture' && instruction.note === 'acceptance-continue';
  const report = {
    passed,
    requestId: instruction.requestId,
    continuedAt: instruction.continuedAt,
    title
  };
  const file = 'handoff-acceptance.json';
  await writeFile(path.join(outputDir, file), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await checkpoint({ stage: 'handoff-complete', artifact: file });
  await progress({ current: 3, total: 3, message: passed ? 'Handoff verified' : 'Handoff verification failed' });
  if (!passed) throw Object.assign(new Error('Handoff acceptance verification failed'), { code: 'HANDOFF_ACCEPTANCE_FAILED' });
  return {
    summary: 'waiting_user handoff continued the same live browser task',
    evidence: [
      { kind: 'message', value: 'handoff-continued' },
      { kind: 'artifact', file, agentVisible: true }
    ]
  };
}
