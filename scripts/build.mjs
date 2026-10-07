// Builds the extension into dist/. `--watch` rebuilds TS and re-copies static/ on change.
import * as esbuild from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { watch as fsWatch } from 'node:fs';

const watch = process.argv.includes('--watch');
const outdir = 'dist';
// Fixed for the whole process: in watch mode it is the time `pnpm dev` started.
const buildTime = new Date().toISOString();

async function copyStatic() {
  await cp('static', outdir, { recursive: true });
  // Show the build time on the chrome://extensions card (unpacked reloads don't need a
  // version bump, so `version` itself stays as written in static/manifest.json).
  const manifestPath = `${outdir}/manifest.json`;
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.version_name = `${manifest.version} (build ${buildTime.slice(0, 16).replace('T', ' ')} UTC)`;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}
`);
}

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await copyStatic();

const ctx = await esbuild.context({
  entryPoints: {
    background: 'src/background/index.ts',
    picker: 'src/picker/picker.ts',
    diagnostics: 'src/diagnostics/diagnostics.ts',
  },
  bundle: true,
  format: 'esm',
  target: 'chrome127',
  outdir,
  sourcemap: 'linked',
  logLevel: 'info',
  define: { __BUILD_TIME__: JSON.stringify(buildTime) },
});

if (watch) {
  await ctx.watch();
  let timer;
  fsWatch('static', { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      copyStatic().then(
        () => console.log('[static] copied'),
        (err) => console.error('[static] copy failed', err),
      );
    }, 100);
  });
  console.log('Watching for changes…');
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
