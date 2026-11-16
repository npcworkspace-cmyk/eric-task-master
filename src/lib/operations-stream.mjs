// Bound each JSON line before decoding or parsing. The input iterator applies
// backpressure: the next command is not read/dispatched until its reply is sent.
export async function* operationCommandLines(input, maxBytes = 128 * 1024) {
  let pending = Buffer.alloc(0);
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(10, offset);
      const end = newline < 0 ? bytes.length : newline;
      const fragment = bytes.subarray(offset, end);
      if (pending.length + fragment.length > maxBytes) {
        throw Object.assign(new Error(`Operation command line exceeds ${maxBytes} bytes`), { code: 'COMMAND_TOO_LARGE' });
      }
      pending = pending.length ? Buffer.concat([pending, fragment]) : fragment;
      if (newline < 0) break;
      yield pending.toString('utf8').replace(/\r$/u, '');
      pending = Buffer.alloc(0);
      offset = newline + 1;
    }
  }
  if (pending.length) yield pending.toString('utf8').replace(/\r$/u, '');
}
