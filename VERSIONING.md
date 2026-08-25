# Versioning

The first version is `0.0.1`. Every delivered iteration must change the version before it is committed. Use semantic versioning:

- patch: compatible fixes or verified incremental capability;
- minor: a backward-compatible public capability;
- major: an incompatible public contract. Before `1.0.0`, a minor bump may also carry deliberate contract changes; from `1.0.0` onward, breaking changes require a new major version.

Run `npm run version:bump -- patch` (or `minor`, `major`, or an explicit higher semantic version) to keep package, runtime, base Skill contract, and README versions synchronized. Equal or lower explicit versions are rejected. `npm run check` rejects drift.

Every published version and tag is single-use. The manual Release workflow compares the candidate against all published releases, rejects an equal or lower version, rejects an existing tag or Release, and never overwrites assets; a correction is always a new higher version.
