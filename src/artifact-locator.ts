import { stat } from "node:fs/promises";

import fastGlob from "fast-glob";

export async function findNewestArtifact(
  worktreePath: string,
  artifactGlobs: readonly string[],
): Promise<string> {
  const matches = await fastGlob([...artifactGlobs], {
    cwd: worktreePath,
    absolute: true,
    onlyFiles: true,
    followSymbolicLinks: false,
  });
  if (matches.length === 0) {
    throw new Error(`没有找到安装包，已检查：${artifactGlobs.join(", ")}`);
  }

  const candidates = await Promise.all(
    matches.map(async (path) => ({ path, modifiedAt: (await stat(path)).mtimeMs })),
  );
  candidates.sort((left, right) => right.modifiedAt - left.modifiedAt);
  const newest = candidates[0];
  if (newest === undefined) {
    throw new Error("没有找到安装包");
  }
  return newest.path;
}
