import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { download, exists } from '../scripts/build/lib.mjs';
import { removeTestTree } from './test-fs.mjs';

async function fixture(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}/runtime`
  };
}

test('runtime download retries a transient server failure and writes only the complete response', async (t) => {
  let requests = 0;
  const { server, url } = await fixture((_request, response) => {
    requests += 1;
    if (requests === 1) {
      response.writeHead(503);
      response.end('temporary failure');
      return;
    }
    response.end('complete runtime');
  });
  const root = await mkdtemp(join(tmpdir(), 'taskmaster-download-'));
  const output = join(root, 'node-runtime.tar.gz');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await removeTestTree(root);
  });

  await download(url, output, { attempts: 2, timeoutMs: 1_000, retryDelaysMs: [1] });

  assert.equal(requests, 2);
  assert.equal(await readFile(output, 'utf8'), 'complete runtime');
});

test('runtime download times out with a bounded error and removes its partial file', async (t) => {
  let requests = 0;
  const { server, url } = await fixture((_request, response) => {
    requests += 1;
    response.writeHead(200, { 'Content-Length': '1000' });
    response.write('partial');
  });
  const root = await mkdtemp(join(tmpdir(), 'taskmaster-download-timeout-'));
  const output = join(root, 'node-runtime.tar.gz');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await removeTestTree(root);
  });

  await assert.rejects(
    download(url, output, { attempts: 2, timeoutMs: 100, retryDelaysMs: [1] }),
    /Download failed after 2 attempts[\s\S]*each attempt limited to 100 ms/u
  );
  assert.equal(requests, 2);
  assert.equal(await exists(output), false);
});
