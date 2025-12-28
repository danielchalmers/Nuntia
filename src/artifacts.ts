import { DefaultArtifactClient } from '@actions/artifact';
import * as path from 'path';

function resolvePaths(filePaths: string[]): { files: string[]; rootDir: string } {
  const resolved = filePaths.map(filePath => path.resolve(filePath));
  const rootDir = resolved
    .map(filePath => path.dirname(filePath))
    .reduce((common, dir) => {
      if (!common) return dir;
      while (!dir.startsWith(common)) {
        const parent = path.dirname(common);
        if (parent === common) return common;
        common = parent;
      }
      return common;
    }, '');

  return { files: resolved, rootDir: rootDir || process.cwd() };
}

export async function uploadArtifact(name: string, filePaths: string[]): Promise<void> {
  const client = new DefaultArtifactClient();
  const { files, rootDir } = resolvePaths(filePaths);
  await client.uploadArtifact(name, files, rootDir);
}
