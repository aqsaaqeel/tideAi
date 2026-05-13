/** In-memory store: buildId → build state */
export const builds = new Map();

export function getBuild(buildId) {
  return builds.get(buildId);
}

export function setBuild(buildId, state) {
  builds.set(buildId, state);
}

export function patchBuild(buildId, partial) {
  const cur = builds.get(buildId);
  if (!cur) return;
  builds.set(buildId, { ...cur, ...partial });
}
