# Task Pack trust and permissions

A Task Pack is executable trusted-local Node.js code, not a data file and not hostile-code sandboxed. The Worker process, immutable snapshot, module inspector, read-only Playwright observation surface, Human Journey contract, output limits, and completion gate are defense in depth for reviewed code. They do not remove the operating-system authority of code running under the user's account.

Before installation, require a written declaration of:

- exact website and network domains, purpose, rate policy, and login requirement;
- persistent or ephemeral Profile requirement and minimum account role;
- allowed local inputs and stable output files;
- every external create/update/submit/publish effect and its idempotency proof;
- any browser-extension dependency and cooperative handoff behavior;
- any paid provider, authorization owner, cost ceiling, receipt, and stop condition;
- checkpoint contents, retention, sensitive-data handling, Pack owner, source hash, and rollback task type.

Review every module and top-level import. Reject subprocess or shell launch, a second browser/control plane, direct Playwright imports, dynamic code generation, hidden destinations, credential harvesting, broad filesystem traversal, undeclared paid calls, or any attempt to bypass `journey`. Keep cookies, tokens, Profile paths, Agent credentials, and behavior mechanics out of task input, progress, evidence, and errors.

Run `task-packs validate`, the mandatory representative surface probe when applicable, and one bounded pilot before scale. A passing validator confirms the runtime contract for the inspected bytes; it does not make an unknown author trustworthy. Mutually untrusted Packs require separate operating-system users, containers, virtual machines, or computers.

If a Pack is suspected of unsafe behavior, deprecate it, stop new tasks, retain immutable snapshots and task evidence, revoke external credentials outside Task Master, and inspect every Profile that ran it. Never overwrite divergent code under an existing task-type name.

Repository maintainers use the expanded policy in `docs/TASK-PACK-SECURITY.md`.
