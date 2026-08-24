# Versioning

The first version is `0.0.1`. Every delivered iteration must change the version before it is committed. Use semantic versioning:

- patch: compatible fixes or verified incremental capability;
- minor: a backward-compatible public capability;
- major: an incompatible public contract. Before `1.0.0`, a minor bump may also carry deliberate contract changes; from `1.0.0` onward, breaking changes require a new major version.

Run `npm run version:bump -- patch` (or `minor`, `major`, or an explicit `x.y.z`) to keep package, runtime, extension, and README versions synchronized. `npm run check` rejects drift.
