// Cross-platform production build. Replaces the old `rm -rf / mkdir / cp`
// shell chain (which fails in cmd.exe/PowerShell) with node:fs + the esbuild JS API.
import { build } from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';

const outdir = 'dist';

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

// The server reads the MSW service worker from dist/ at startup.
await copyFile(
  'framework/mock-server/mockServiceWorker.js',
  `${outdir}/mockServiceWorker.js`,
);

const shared = {
  bundle: true,
  minify: true,
  sourcemap: true,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' },
};

await Promise.all([
  build({
    ...shared,
    entryPoints: ['framework/server/index.ts'],
    platform: 'node',
    target: 'node22',
    outfile: `${outdir}/server.js`,
  }),
  build({
    ...shared,
    entryPoints: ['framework/client/index.tsx'],
    platform: 'browser',
    target: 'es2020',
    outfile: `${outdir}/client.js`,
  }),
]);
