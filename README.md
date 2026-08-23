# eric-task-master

`eric-task-master` is a Playwright-first browser task runtime. Agents submit goals and task modules; Playwright owns every browser action. A lightweight extension in the user's everyday Chromium browser acts only as a control panel and an explicit session-transfer bridge.

Version: **0.0.1**

## Product boundary

- Playwright is the only web execution layer.
- The real-browser extension never clicks, types, scrapes, or navigates on behalf of a task.
- Persistent Playwright profiles isolate accounts and concurrent agents.
- The local manager owns profile locks, task lifecycle, progress, recovery, outputs, and cleanup.
- Site-specific logic belongs in specialized Skills or task modules, not in the core runtime.

## First local run

```bash
node scripts/taskmaster.mjs connect --json
```

This one fixed command installs the lockfile-pinned Node dependencies and Playwright Chromium when missing, starts the local manager, and runs the built-in acceptance suite. Load `extension/` as an unpacked Chromium extension to use the real-browser control panel.

Agents use this same launcher from the project root. The bundled Skill exposes the identical command from its own directory, so a new Agent never needs to discover a second entry point.

The Manager uses the independent fixed address `http://127.0.0.1:19946`. In the extension, click **Discover**, then **Pair**. Create a persistent Profile or select an existing one. To reuse a website login, open that signed-in website in the everyday browser and click **Sync current site login**; session-only cookies are retained in the destination Profile for at most 12 hours and the site may invalidate them sooner.

The control panel can create, rename, open, close, and configure Profiles. Browser tasks run in isolated Playwright windows and close those windows during task cleanup. The Manager itself can be stopped safely with:

```bash
node scripts/taskmaster.mjs manager stop --json
```

Run the complete delivery gate with `npm run check`.

Read [ARCHITECTURE.md](./ARCHITECTURE.md) for the component contract. Agents should use the bundled Skill at `skills/eric-task-master/` instead of reconstructing the protocol.
