# Persistent operations CLI input

`taskmaster ops stream OP_ID --json` keeps one CLI process and HTTP client alive while the Agent makes successive decisions in an existing operation. It does not create a new execution mode, browser, Profile, daemon, or controller. The normal `ops command` interface remains available.

Write one existing command envelope per UTF-8 JSON line to stdin. Read one normal CLI JSON reply per nonblank line from stdout, in order. Keep stdin open while deciding the next action. `--wait-ms` has the same 0–30000 range and default 30000 as `ops command`. A zero wait may return a pending reservation; inspect that command through the ordinary CLI before further dependent writes.

```json
{"commandId":"inspect-1","kind":"observe","payload":{}}
{"commandId":"prepare-1","kind":"batch","payload":{"actions":[{"type":"fill","effect":false,"target":{"role":"textbox","name":"Note"},"value":"Authorized draft"}]}}
```

Only send the second envelope after reviewing the first reply. Generated IDs work as usual, but retain returned IDs for any unknown-result reconciliation. Do not send a replacement ID to repeat an uncertain effect.

The CLI verifies the Manager and selected driving guide at startup and again before each subsequent submitted line. A different Manager process/state/version or guide-refresh failure ends the stream, without reconnecting, resubmitting, restarting, or stopping the operation. Every request still passes through the same Manager command reservation and Worker authorization, durable initiated acknowledgement, verification, stop/revocation/takeover and replay protection.

Each line is bounded to 128 KiB before JSON parsing; an oversized line returns an error and ends the stream. Malformed JSON and ordinary Manager request rejections return the same `{ "ok": false, "error": ... }` shape on stdout so the Agent receives an ordered reply for that line. Fatal startup failures still use normal CLI stderr. Any line error makes the process exit nonzero at EOF. Blank lines are ignored, and a final line need not end in a newline.

Closing stdin ends only the CLI after already accepted lines finish. It does not pause, stop, resume, or destroy the operation or browser. A lost CLI response remains an uncertain result: reconnect only after inspecting the original command/action IDs and actual application outcome. The stream never retries an effect automatically.
