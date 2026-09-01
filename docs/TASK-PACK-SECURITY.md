# Task Pack trust and permissions

## Boundary

A Task Pack is executable, trusted local Node.js code. Installing a Pack is closer to installing an application or build plugin than importing a data file. The module inspector, immutable snapshots, read-only Playwright observation facade, Human Journey contract, output limits, and Worker process are defense-in-depth controls for reviewed code; they are not a hostile-code sandbox.

Code running under the same operating-system account may be able to read that account's files, environment, network, and process-visible data through ordinary Node.js capabilities unless the operating system provides a stronger sandbox. Mutually untrusted Pack authors require separate OS users, containers, virtual machines, or computers.

## Effective permissions

A reviewed Pack may receive only the task-scoped runtime surfaces documented by Task Master, but its Node.js module still executes with the Worker process's operating-system authority. Before installation, review and record:

| Permission area | Required declaration |
| --- | --- |
| Websites and network | exact domains, purpose, request direction, rate policy, and whether login is required |
| Profile data | persistent or ephemeral Profile requirement and the minimum account role |
| Local files | allowed input files and output names; no broad home-directory reads |
| External services | provider, authorization owner, data sent, cost ceiling, idempotency, receipts, and stop conditions |
| Browser extensions | extension name, required permission, cooperative handoff contract, and failure behavior |
| External effects | every create/update/submit/publish action and its verification/idempotency rule |
| Retention | checkpoint fields, artifact contents, deletion or recovery window, and sensitive-data handling |

The base runtime does not grant a generic paid-provider budget, credential store, CAPTCHA solver, shell executor, second browser client, or unrestricted page-mutation API.

## Required review before installation

1. Obtain source from a known owner and pin the exact distributed hash.
2. Review every manifest and module, including top-level imports and initialization.
3. Reject subprocess launch, shell execution, a second browser/control plane, direct Playwright imports, dynamic code generation, hidden network destinations, credential harvesting, broad filesystem traversal, or undeclared paid calls.
4. Confirm every visible page change uses `journey` and every external effect has a bounded verification and replay policy.
5. Confirm task input contains business intent only—not cookies, tokens, Profile paths, Agent credentials, or behavior mechanics.
6. Run `task-packs validate`, one representative surface probe when required, and one bounded pilot before scale.
7. Record the Pack owner, source hash, reviewed version, domains, Profile requirement, declared effects, and rollback task type.

Static checks cannot prove the absence of malicious intent. A passing validation means the Pack satisfies the runtime contract on the inspected source; it does not make unknown code trustworthy.

## Prohibited assumptions

- “Agent discoverable” does not mean approved for every Agent or account.
- A persistent Profile does not grant permission to export or synchronize its login state.
- Page visibility does not grant authorization to collect, republish, or commercialize data.
- Human Journey behavior does not guarantee invisibility or protection from platform enforcement.
- A cooperative browser extension is not authenticated merely because it can emit the expected DOM event.
- A successful task is not permission to repeat an external effect without its idempotency proof.

## Incident response

Deprecate the affected task types immediately, stop new tasks, preserve immutable snapshots and task evidence, revoke external credentials outside Task Master, and inspect all Profiles that ran the Pack. Do not delete retained tasks or checkpoints until the incident scope is known. Publish a new versioned task type after review; never replace divergent code under an existing name.

The implementation and authoring conventions remain in [`skills/eric-task-master/references/task-packs.md`](../skills/eric-task-master/references/task-packs.md).
