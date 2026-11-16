// Command-local bounded timing evidence. Never records page text, input values,
// selectors, URLs, credentials or error messages. No timers or background work.
export function createOperationsDiagnostics({ limit = 96, clock = () => performance.now() } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 4 || limit > 256) throw new TypeError('Invalid diagnostic ring bound');
  const started = clock(), entries = [];
  let dropped = 0, failure = null;
  const clean = (value) => typeof value === 'string' ? value.slice(0, 160) : undefined;
  function mark(stage, event = 'point', metadata = {}) {
    const entry = { stage: clean(stage), event, atMs: Math.max(0, Math.round((clock() - started) * 1000) / 1000) };
    for (const name of ['actionId', 'actionType', 'code']) if (metadata[name] !== undefined) entry[name] = clean(metadata[name]);
    if (Number.isFinite(metadata.elapsedMs)) entry.elapsedMs = Math.max(0, Math.round(metadata.elapsedMs * 1000) / 1000);
    if (event === 'fail' && !failure) failure = { phase: entry.stage, code: entry.code || 'FAILED', actionId: entry.actionId };
    entries.push(entry);
    if (entries.length > limit) { entries.shift(); dropped++; }
  }
  return {
    mark,
    async measure(stage, run, metadata = {}) {
      const at = clock(); mark(stage, 'begin', metadata);
      try { const result = await run(); mark(stage, 'end', { ...metadata, elapsedMs: clock() - at }); return result; }
      catch (error) { mark(stage, 'fail', { ...metadata, code: error.code || 'FAILED', elapsedMs: clock() - at }); throw error; }
    },
    summary() { return { ...(failure || {}), elapsedMs: Math.max(0, Math.round((clock() - started) * 1000) / 1000), entries: entries.length, dropped }; },
    snapshot() { return { version: 1, ...this.summary(), recordedThrough: 'pre-result-commit', stages: entries.map((entry) => ({ ...entry })) }; }
  };
}
