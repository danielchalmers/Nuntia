import { DefaultArtifactClient } from '@actions/artifact';
import * as path from 'path';

export async function uploadArtifact(name: string, filePath: string): Promise<void> {
  const client = new DefaultArtifactClient();
  const resolved = path.resolve(filePath);
  const rootDir = path.dirname(resolved);
  await client.uploadArtifact(name, [resolved], rootDir);
}
