const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;

export function parseSemver(value) {
  const match = SEMVER.exec(String(value ?? ''));
  if (!match) throw new Error(`Invalid semantic version: ${value}`);
  return {
    source: match[0],
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : []
  };
}

function compareIdentifier(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left.localeCompare(right, 'en');
}

export function compareSemver(leftValue, rightValue) {
  const left = parseSemver(leftValue);
  const right = parseSemver(rightValue);
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length ? -1 : 1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (left.prerelease[index] === undefined) return -1;
    if (right.prerelease[index] === undefined) return 1;
    const compared = compareIdentifier(left.prerelease[index], right.prerelease[index]);
    if (compared !== 0) return compared < 0 ? -1 : 1;
  }
  return 0;
}

export function assertVersionIncrease(current, next) {
  parseSemver(current);
  parseSemver(next);
  if (compareSemver(next, current) <= 0) {
    throw new Error(`Version must increase monotonically: ${next} is not greater than ${current}`);
  }
  return next;
}

export function nextVersion(current, instruction) {
  const parsed = parseSemver(current);
  let next;
  if (SEMVER.test(String(instruction ?? ''))) next = String(instruction);
  else if (instruction === 'patch') next = `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
  else if (instruction === 'minor') next = `${parsed.major}.${parsed.minor + 1}.0`;
  else if (instruction === 'major') next = `${parsed.major + 1}.0.0`;
  else throw new Error(`Invalid bump: ${instruction}`);
  return assertVersionIncrease(current, next);
}
