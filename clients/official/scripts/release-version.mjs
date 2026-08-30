import { spawnSync } from "node:child_process";

const RELEASE_VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;

export function resolveReleaseVersion({ cwd, explicitVersion, fallbackVersion }) {
  const configured = explicitVersion?.trim();
  if (configured) return requireReleaseVersion(configured);

  const tags = spawnSync(
    "git",
    ["tag", "--merged", "HEAD", "--list", "v[0-9]*.[0-9]*.[0-9]*", "--sort=-version:refname"],
    { cwd, encoding: "utf8" },
  );
  if (!tags.error && tags.status === 0) {
    const tag = tags.stdout.split(/\r?\n/u).map((value) => value.trim()).find((value) => {
      return value.startsWith("v") && RELEASE_VERSION_PATTERN.test(value.slice(1));
    });
    if (tag) return tag.slice(1);
  }

  return requireReleaseVersion(fallbackVersion.trim());
}

function requireReleaseVersion(version) {
  if (!RELEASE_VERSION_PATTERN.test(version)) {
    throw new Error(`Release version must use MAJOR.MINOR.PATCH: ${version}`);
  }
  return version;
}
