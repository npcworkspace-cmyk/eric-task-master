# Security policy

## Supported versions

Security fixes are made against the current release line. Upgrade to the latest published version before reporting a problem that is already fixed there. Older release assets remain immutable and are not silently replaced.

## Report a vulnerability privately

Use the repository's **Security → Advisories → Report a vulnerability** flow. Do not open a public Issue for a suspected vulnerability. If private vulnerability reporting is unavailable, contact the repository owner privately and provide only the minimum information needed to establish a secure follow-up channel.

Include:

- the affected version and operating system;
- the smallest reproducible sequence;
- the expected and observed security boundary;
- whether Manager identity, Profile data, task artifacts, or Agent scope may be affected.

Do not attach cookies, tokens, private keys, complete Profile directories, account data, or unredacted task outputs. Replace them with synthetic fixtures.

## Security boundary

Task Master is a trusted-local automation runtime. Its loopback Manager, scoped Agent credentials, durable tasks, Profile leases, output validation, and browser-action boundaries are designed to reduce accidental collision and data disclosure. Processes running as the same operating-system user remain trusted peers.

Task Packs and standalone task modules are executable Node.js code. They are not untrusted data and are not isolated by a hostile-code sandbox. Install only reviewed code from a known source and verify the distributed hash. The exact permissions and review checklist are defined in [Task Pack trust and permissions](./docs/TASK-PACK-SECURITY.md).

User-installed browser extensions run inside persistent Profiles under their own declared browser permissions. Task Master does not authenticate, inspect, synchronize, or universally serialize arbitrary extensions. CAPTCHA, press-and-hold, account challenges, platform authorization, and paid external providers are not bypassed or delegated by the base runtime.

## Operational safety

- Keep the Manager bound to loopback only.
- Keep the state directory private; it contains Manager identity, Profile login state, task checkpoints, and artifacts.
- Stop Manager cleanly before backup and encrypt any copy before it leaves the machine.
- Never publish `config.json`, Profile data, task output, `.env` files, logs, or release-evidence directories.
- Treat Secret Scanning, push protection, Dependabot, and CodeQL as detection layers, not proof that a release is vulnerability-free.

The supported backup and recovery procedure is documented in [State backup and recovery](./docs/STATE-BACKUP-RECOVERY.md).
