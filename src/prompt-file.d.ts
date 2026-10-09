// The build bundles .prompt files with esbuild's text loader, and vitest.config.mts loads them the same way, so importing one gives its text.
declare module '*.prompt' {
  const text: string;
  export default text;
}
