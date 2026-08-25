function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function indicesOf(source, needle) {
  const indices = [];
  let offset = 0;
  while (offset < source.length) {
    const index = source.indexOf(needle, offset);
    if (index < 0) break;
    indices.push(index);
    offset = index + needle.length;
  }
  return indices;
}

function topLevelMap(source, name) {
  const match = new RegExp(`^${name}:\\r?\\n((?: {2}[^\\r\\n]+(?:\\r?\\n|$))+)`, 'm').exec(source);
  invariant(match, `release workflow lacks a top-level ${name} block`);
  const entries = match[1]
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => /^ {2}([^:]+):\s*(.*?)\s*$/.exec(line))
    .map((entry) => {
      invariant(entry, `release workflow has malformed ${name} policy`);
      return [entry[1], entry[2]];
    });
  const result = new Map(entries);
  invariant(result.size === entries.length, `release workflow has duplicate ${name} keys`);
  return result;
}

function normalizedShell(source) {
  return source.replace(/\\\r?\n[ \t]*/g, ' ');
}

function matchingShellLines(source, needle) {
  return normalizedShell(source)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes(needle));
}

function includesTokens(command, tokens) {
  return tokens.every((token) => command.includes(token));
}

export function assertReleaseWorkflowPolicy(source) {
  invariant(typeof source === 'string' && source.length > 0, 'release workflow source is required');

  const permissions = topLevelMap(source, 'permissions');
  invariant(
    permissions.size === 2 && permissions.get('actions') === 'read' && permissions.get('contents') === 'write',
    'release workflow permissions must be exactly actions:read and contents:write'
  );

  const concurrency = topLevelMap(source, 'concurrency');
  invariant(
    concurrency.get('group') === 'manual-release-${{ github.repository }}' &&
      concurrency.get('cancel-in-progress') === 'false' &&
      concurrency.size === 2,
    'release workflow must serialize every repository release without cancelling an active publication'
  );

  invariant(
    indicesOf(source, 'persist-credentials: false').length === 1 &&
      !source.includes('persist-credentials: true'),
    'release checkout must disable persisted Git credentials'
  );

  const releaseCreation = source.indexOf('gh release create');
  const releaseCommands = matchingShellLines(source, 'gh release create');
  invariant(releaseCreation >= 0 && releaseCommands.length === 1, 'release workflow must have one Release creation command');
  invariant(
    includesTokens(releaseCommands[0], [
      'gh release create "${TAG}"',
      'dist/*',
      '--draft',
      '--target "${RELEASE_SHA}"'
    ]) && !releaseCommands[0].includes('--clobber'),
    'Release creation must atomically upload every asset to a draft bound to the exact SHA'
  );

  const mainPublicationRecheck = source.indexOf('MAIN_SHA_NOW=');
  const releaseVersionChecks = indicesOf(source, 'scripts/assert-release-version.mjs');
  invariant(
    releaseVersionChecks.length >= 2 &&
      releaseVersionChecks.at(-1) > mainPublicationRecheck &&
      releaseVersionChecks.at(-1) < releaseCreation,
    'published versions must be rechecked after main and immediately before Release creation'
  );

  const checksumIndex = source.indexOf('(cd dist && sha256sum ./*.zip > SHA256SUMS)');
  const immutableChecks = indicesOf(source, 'repos/${GITHUB_REPOSITORY}/immutable-releases');
  invariant(
    checksumIndex >= 0 && immutableChecks.length >= 2 &&
      immutableChecks.at(-1) > checksumIndex && immutableChecks.at(-1) < releaseCreation,
    'Release immutability must be rechecked after archive completion and before Release creation'
  );

  invariant(
    source.includes('ARCHIVE_MTIME="@$(git show -s --format=%ct "${RELEASE_SHA}")"'),
    'release archive time must derive from the exact Release SHA'
  );
  const archiveCommands = matchingShellLines(source, 'git archive --format=zip');
  const expectedArchives = [
    {
      tokens: ['--mtime="${ARCHIVE_MTIME}"', '--prefix="eric-task-master-v${VERSION}/"', '--output="dist/eric-task-master-v${VERSION}.zip"'],
      tree: 'HEAD'
    },
    {
      tokens: ['--mtime="${ARCHIVE_MTIME}"', '--prefix="eric-task-master-v${VERSION}/"', '--output="dist/eric-task-master-v${VERSION}.repro.zip"'],
      tree: 'HEAD'
    },
    {
      tokens: ['--mtime="${ARCHIVE_MTIME}"', '--prefix="eric-task-master-skill-v${VERSION}/"', '--output="dist/eric-task-master-skill-v${VERSION}.zip"'],
      tree: 'HEAD:skills/eric-task-master'
    },
    {
      tokens: ['--mtime="${ARCHIVE_MTIME}"', '--prefix="eric-task-master-skill-v${VERSION}/"', '--output="dist/eric-task-master-skill-v${VERSION}.repro.zip"'],
      tree: 'HEAD:skills/eric-task-master'
    }
  ];
  invariant(
    archiveCommands.length === expectedArchives.length &&
      expectedArchives.every(({ tokens, tree }) => archiveCommands.some((command) => (
        includesTokens(command, tokens) && command.endsWith(` ${tree}`)
      ))),
    'source and Skill archives must each be built twice from Git with the fixed Release timestamp'
  );
  const reproducibilityProofs = [
    {
      archives: [
        '--output="dist/eric-task-master-v${VERSION}.zip"',
        '--output="dist/eric-task-master-v${VERSION}.repro.zip"'
      ],
      compare: 'cmp "dist/eric-task-master-v${VERSION}.zip" "dist/eric-task-master-v${VERSION}.repro.zip"',
      remove: 'rm "dist/eric-task-master-v${VERSION}.repro.zip"'
    },
    {
      archives: [
        '--output="dist/eric-task-master-skill-v${VERSION}.zip"',
        '--output="dist/eric-task-master-skill-v${VERSION}.repro.zip"'
      ],
      compare: 'cmp "dist/eric-task-master-skill-v${VERSION}.zip" "dist/eric-task-master-skill-v${VERSION}.repro.zip"',
      remove: 'rm "dist/eric-task-master-skill-v${VERSION}.repro.zip"'
    }
  ];
  invariant(
    reproducibilityProofs.every((proof) => {
      const archiveIndices = proof.archives.map((needle) => source.indexOf(needle));
      const compareIndex = source.indexOf(proof.compare);
      const removeIndex = source.indexOf(proof.remove);
      return archiveIndices.every((index) => index >= 0) &&
        Math.max(...archiveIndices) < compareIndex && compareIndex < removeIndex && removeIndex < checksumIndex;
    }),
    'both reproducibility proofs must compare and remove their temporary archives before checksums'
  );

  return true;
}
