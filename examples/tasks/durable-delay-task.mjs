import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const meta = Object.freeze({
  name: 'durable-delay',
  version: '1.0.0',
  description: 'Deterministic long-task fixture for progress, disconnect, and recovery acceptance.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      steps: { type: 'integer', minimum: 1, maximum: 120 },
      delayMs: { type: 'integer', minimum: 10, maximum: 30_000 }
    }
  }
});

export async function run({ input, outputDir, action, progress, checkpoint }) {
  const steps = Number.isSafeInteger(input?.steps) ? input.steps : 6;
  const delayMs = Number.isSafeInteger(input?.delayMs) ? input.delayMs : 250;
  if (steps < 1 || steps > 120 || delayMs < 10 || delayMs > 30_000) {
    throw new TypeError('durable-delay input is outside its bounded range');
  }

  await mkdir(outputDir, { recursive: true });
  const previous = await checkpoint.read();
  const canResume = previous?.stage === 'delay' &&
    previous.total === steps && previous.delayMs === delayMs &&
    Number.isSafeInteger(previous.current) && previous.current >= 0 && previous.current <= steps &&
    Array.isArray(previous.events) && previous.events.length === previous.current;
  const events = canResume ? previous.events : [];
  for (let current = events.length + 1; current <= steps; current += 1) {
    await action.wait(delayMs);
    const event = { current, total: steps, at: new Date().toISOString() };
    events.push(event);
    await checkpoint({ stage: 'delay', current, total: steps, delayMs, events });
    await progress({ current, total: steps, message: `Completed step ${current} of ${steps}` });
  }

  const artifactName = 'durable-delay.json';
  await writeFile(path.join(outputDir, artifactName), `${JSON.stringify({ steps, delayMs, events }, null, 2)}\n`, {
    mode: 0o600
  });
  return {
    summary: `Completed ${steps} durable progress steps`,
    evidence: [{ kind: 'artifact', file: artifactName, count: events.length }]
  };
}
