import { spawnSync } from "node:child_process";

const RELEASE_VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-rc\.(0|[1-9][0-9]*))?$/u;

export function parseReleaseTag(tag) {
  if (typeof tag !== "string" || !tag.startsWith("v")) {
    throw new Error("Release tag must start with v, for example v0.2.14 or v0.2.14-rc.1");
  }
  const version = requireReleaseVersion(tag.slice(1));
  return { version, prerelease: version.includes("-rc.") };
}

export function resolveReleaseVersion({ cwd, explicitVersion, fallbackVersion }) {
  const configured = explicitVersion?.trim();
  if (configured) return requireReleaseVersion(configured);

  const tags = spawnSync(
    "git",
    ["tag", "--merged", "HEAD", "--list", "v[0-9]*.[0-9]*.[0-9]*"],
    { cwd, encoding: "utf8" },
  );
  if (!tags.error && tags.status === 0) {
    const versions = tags.stdout.split(/\r?\n/u).map((value) => value.trim())
      .filter((value) => value.startsWith("v") && RELEASE_VERSION_PATTERN.test(value.slice(1)))
      .map((value) => value.slice(1));
    // Git's version sort can put an RC after its final release and is user-configurable.
    versions.sort(compareReleaseVersionsDescending);
    if (versions[0]) return versions[0];
  }

  return requireReleaseVersion(fallbackVersion.trim());
}

function requireReleaseVersion(version) {
  if (!RELEASE_VERSION_PATTERN.test(version)) {
    throw new Error(`Release version must use MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-rc.N: ${version}`);
  }
  return version;
}

function compareReleaseVersionsDescending(left, right) {
  const a = RELEASE_VERSION_PATTERN.exec(left);
  const b = RELEASE_VERSION_PATTERN.exec(right);
  for (const index of [1, 2, 3]) {
    const x = BigInt(a[index]), y = BigInt(b[index]);
    if (x !== y) return x > y ? -1 : 1;
  }
  if (a[4] === undefined) return b[4] === undefined ? 0 : -1;
  if (b[4] === undefined) return 1;
  const x = BigInt(a[4]), y = BigInt(b[4]);
  return x === y ? 0 : x > y ? -1 : 1;
}
