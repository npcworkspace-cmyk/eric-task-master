# Versioning

The first version is `0.0.1`. Every delivered iteration must change the version before it is committed. Use semantic versioning while the product is pre-1.0:

- patch: compatible fixes or verified incremental capability;
- minor: a new public capability or contract;
- major: an incompatible public contract.

Run `npm run version:bump -- patch` (or `minor`, `major`, or an explicit `x.y.z`) to keep package, runtime, extension, and README versions synchronized. `npm run check` rejects drift.
