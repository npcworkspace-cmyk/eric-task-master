export const meta = { name: 'task-template', version: 1 };

export async function run({ page, input, outputDir, action, progress, checkpoint }) {
  await page.goto(input.url, { waitUntil: 'domcontentloaded' });
  await progress({ current: 1, total: 1, message: 'Target loaded' });
  await checkpoint({ stage: 'loaded', url: page.url() });

  return {
    summary: 'Loaded the requested page',
    evidence: [
      { kind: 'url', value: page.url() },
      { kind: 'output-directory', value: outputDir },
      { kind: 'behavior-mode', value: action.mode }
    ]
  };
}
