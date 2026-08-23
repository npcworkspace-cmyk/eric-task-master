import { appendFile } from 'node:fs/promises';
import { RegistrationLock } from '../../src/registration/lock.mjs';

const [lockPath, logPath, holdText = '150'] = process.argv.slice(2);
const holdMs = Number(holdText);
const lock = new RegistrationLock(lockPath, { timeoutMs: 10_000 });
await lock.acquire();
const enteredAt = Date.now();
await appendFile(logPath, `${JSON.stringify({ event: 'enter', pid: process.pid, at: enteredAt })}\n`);
await new Promise((resolve) => setTimeout(resolve, holdMs));
await appendFile(logPath, `${JSON.stringify({ event: 'exit', pid: process.pid, at: Date.now() })}\n`);
await lock.release();
