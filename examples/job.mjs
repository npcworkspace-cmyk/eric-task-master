import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function run({ page, input, outputDir, progress }) {
  await page.goto(input.url, { waitUntil: 'domcontentloaded' });
  const result = {
    url: page.url(),
    title: await page.title()
  };
  await writeFile(join(outputDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  await progress({ current: 1, total: 1, message: 'Page collected' });
  return result;
}
