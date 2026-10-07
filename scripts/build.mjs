// Builds the extension into dist/. `--watch` rebuilds TS and re-copies static/ on change.
import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { watch as fsWatch } from 'node:fs';

const watch = process.argv.includes('--watch');
const outdir = 'dist';

async function copyStatic() {
  await cp('static', outdir, { recursive: true });
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
  define: { __BUILD_TIME__: JSON.stringify(new Date().toISOString()) },
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
