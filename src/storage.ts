import * as fs from 'fs';
import * as path from 'path';

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function resolvePath(filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
}

export function writeTextFile(filePath: string, contents: string): string {
  const resolved = resolvePath(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, contents, 'utf8');
  return resolved;
}

export function loadPrompt(promptPath?: string): string {
  const loadBundledPrompt = () => {
    const bundledPath = path.join(__dirname, 'Nuntia.prompt');
    return fs.readFileSync(bundledPath, 'utf8');
  };

  if (!promptPath) {
    try {
      return loadBundledPrompt();
    } catch (bundledError) {
      const bundledMessage = getErrorMessage(bundledError);
      throw new Error(`Failed to load prompt. Bundled fallback: ${bundledMessage}`);
    }
  }

  try {
    const resolvedPath = resolvePath(promptPath);
    return fs.readFileSync(resolvedPath, 'utf8');
  } catch (error) {
    try {
      return loadBundledPrompt();
    } catch (bundledError) {
      const customMessage = getErrorMessage(error);
      const bundledMessage = getErrorMessage(bundledError);
      throw new Error(
        `Failed to load prompt. Custom path '${promptPath}': ${customMessage}. ` +
        `Bundled fallback: ${bundledMessage}`
      );
    }
  }
}
