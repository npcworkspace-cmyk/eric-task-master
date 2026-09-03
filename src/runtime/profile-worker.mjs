import { randomUUID } from 'node:crypto';
import { PROFILE_LAUNCH_TIMEOUT_MS } from '../contracts.mjs';
import { launchChromeProfile } from './browser-engine.mjs';
import { redactSensitiveText } from '../lib/redaction.mjs';

let processCleanupConfirmed = true;
let activeCleanupAck = null;

function send(message) {
  if (!process.connected || typeof process.send !== 'function') return;
  try {
    process.send(message, undefined, undefined, () => {});
  } catch {
    // Parent exit is also observed through disconnect.
  }
}

function sendCleanupWithAck(message, timeoutMs = 2_000) {
  return new Promise((resolve) => {
    if (!process.connected || typeof process.send !== 'function') return resolve(false);
    const cleanupId = `cleanup_${randomUUID().replaceAll('-', '')}`;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (activeCleanupAck?.id === cleanupId) activeCleanupAck = null;
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    activeCleanupAck = { id: cleanupId, finish };
    try {
      process.send({ ...message, cleanupId }, undefined, undefined, (error) => {
        if (error) finish(false);
      });
    } catch {
      finish(false);
    }
  });
}

async function closeContext(context, timeoutMs = 10_000) {
  if (!context) return false;
  let timer;
  try {
    await Promise.race([
      context.close(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('close timeout')), timeoutMs);
      })
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function runProfileWorker(profile, {
  loadPlaywright = () => import('playwright'),
  sendMessage = send,
  sendCleanup = sendCleanupWithAck,
  signal
} = {}) {
  processCleanupConfirmed = false;
  let context;
  let heartbeat;
  let stage = 'load-playwright';
  const sendHeartbeat = () => sendMessage({ type: 'heartbeat', stage, at: new Date().toISOString() });
  try {
    sendHeartbeat();
    heartbeat = setInterval(sendHeartbeat, 10_000);
    heartbeat.unref?.();
    const playwright = await loadPlaywright();
    stage = 'launch-chrome';
    context = await launchChromeProfile(playwright, profile, { timeout: PROFILE_LAUNCH_TIMEOUT_MS });
    stage = 'open-page';
    if (context.pages().length === 0) await context.newPage();
    stage = 'ready';
    sendMessage({ type: 'ready', at: new Date().toISOString() });
    if (!signal?.aborted) {
      await new Promise((resolve) => {
        signal?.addEventListener('abort', resolve, { once: true });
        context.once?.('close', resolve);
      });
    }
    return { ok: true };
  } catch (error) {
    sendMessage({
      type: 'error',
      error: {
        code: redactSensitiveText(error?.code || 'PROFILE_OPEN_FAILED').slice(0, 128),
        message: redactSensitiveText(error?.message || 'Profile failed to open').slice(0, 4_000),
        details: {
          stage,
          ...(error?.cause ? { cause: {
            code: redactSensitiveText(error.cause?.code || error.cause?.name || 'ERROR').slice(0, 128),
            message: redactSensitiveText(error.cause?.message || error.cause).slice(0, 2_000)
          } } : {})
        }
      }
    });
    return { ok: false, error };
  } finally {
    clearInterval(heartbeat);
    const browserClosed = await closeContext(context);
    const cleanupAcknowledged = await sendCleanup({
      type: 'closed', browserClosed, at: new Date().toISOString()
    });
    processCleanupConfirmed = browserClosed && cleanupAcknowledged;
  }
}

if (typeof process.send === 'function') {
  const controller = new AbortController();
  let started = false;
  process.on('message', (message) => {
    if (message?.type === 'open' && !started) {
      started = true;
      void runProfileWorker(message.profile, { signal: controller.signal }).finally(() => {
        if (processCleanupConfirmed) {
          if (process.connected) process.disconnect();
          const timer = setTimeout(() => process.exit(0), 25);
          timer.unref?.();
        }
      });
    }
    if (message?.type === 'close') controller.abort();
    if (message?.type === 'closed_ack' && activeCleanupAck?.id === message.cleanupId) {
      activeCleanupAck.finish(true);
    }
  });
  process.on('disconnect', () => controller.abort());
}
