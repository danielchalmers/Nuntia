import * as fs from 'fs';
import * as path from 'path';

// Indirect process.cwd() through a helper so ncc's static asset relocation does
// not fold path.join(process.cwd(), ...) into a dist/-rooted bundled asset path
// on Windows. Keeps the committed bundle byte-identical across Windows and Linux
// so the dist drift check (npm run check:dist) is meaningful on both.
function getWorkingDirectory(): string {
  return process.cwd();
}

export function resolvePath(filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(getWorkingDirectory(), filePath);
}

export function writeTextFile(filePath: string, contents: string): string {
  const resolved = resolvePath(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, contents, 'utf8');
  return resolved;
}
