#!/usr/bin/env node

import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { pathToFileURL } from 'node:url';
import { diagnosticLine } from './errors.mjs';
import { createMcpServer } from './server.mjs';
import { createDefaultTaskMasterClient } from './taskmaster-client.mjs';

export function startStdioServer({ clientFactory = () => createDefaultTaskMasterClient(), stderr = process.stderr } = {}) {
  const handle = serveStdio(
    () => createMcpServer({ client: clientFactory() }),
    {
      legacy: 'serve',
      onerror(error) {
        stderr.write(diagnosticLine(error));
      }
    }
  );
  return handle;
}

function isDirectRun() {
  const entry = process.argv[1];
  return typeof entry === 'string' && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  let handle;
  try {
    handle = startStdioServer();
  } catch (error) {
    process.stderr.write(diagnosticLine(error));
    process.exitCode = 1;
  }

  if (handle) {
    const close = () => {
      handle.close().catch(() => {}).finally(() => {
        process.exitCode = 0;
      });
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  }
}
