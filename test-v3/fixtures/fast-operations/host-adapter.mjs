// Explicit isolated plumbing fixture, not a native Codex wake-up integration.
let source = '';
for await (const chunk of process.stdin) source += chunk;
const { event } = JSON.parse(source);
process.stdout.write(JSON.stringify({ accepted: true, received: true, eventId: event.id, deliveryId: `fixture-delivery-${event.id}` }));
