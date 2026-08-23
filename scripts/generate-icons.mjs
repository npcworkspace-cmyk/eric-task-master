#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'extension', 'icons');
const sizes = [16, 32, 48, 128];

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data = Buffer.alloc(0)) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function pixel(size, x, y) {
  const center = (size - 1) / 2;
  const dx = x - center;
  const dy = y - center;
  const radius = size * 0.46;
  if (dx * dx + dy * dy > radius * radius) return [0, 0, 0, 0];

  const purple = [92, 64, 219, 255];
  const ink = [246, 248, 255, 255];
  const signal = [92, 226, 154, 255];
  const normalizedX = x / size;
  const normalizedY = y / size;

  const stem = normalizedX >= 0.45 && normalizedX <= 0.55 && normalizedY >= 0.27 && normalizedY <= 0.72;
  const bar = normalizedX >= 0.28 && normalizedX <= 0.72 && normalizedY >= 0.24 && normalizedY <= 0.36;
  const badgeDx = normalizedX - 0.72;
  const badgeDy = normalizedY - 0.72;
  if (badgeDx * badgeDx + badgeDy * badgeDy <= 0.10 * 0.10) return signal;
  if (stem || bar) return ink;
  return purple;
}

function png(size) {
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    const row = [0];
    for (let x = 0; x < size; x += 1) row.push(...pixel(size, x, y));
    rows.push(Buffer.from(row));
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND')
  ]);
}

await mkdir(output, { recursive: true });
for (const size of sizes) await writeFile(resolve(output, `icon-${size}.png`), png(size));
process.stdout.write(`${JSON.stringify({ ok: true, sizes })}\n`);
