import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseChangelog } from './src/whatsnew/changelog.ts';

// Content-Security-Policy for the packaged app. WebView2 virtual hosts can't send headers,
// so the policy is injected as a <meta> tag at build time (the dev server keeps HMR working).
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://art.vystral.example https://media.vystral.example",
  // blob: lets the trailer player attach a MediaSource; its data still only comes from the media host.
  "media-src https://media.vystral.example blob:",
  "font-src 'self' data:",
  // The media host is the filtered trailer proxy (HLS playlists and segments are fetched, then appended to MSE).
  "connect-src 'self' https://art.vystral.example https://media.vystral.example",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ');

function csp(): Plugin {
  return {
    name: 'vystral-csp',
    apply: 'build',
    transformIndexHtml: (html) => html.replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
  };
}

// "What's new" source: CHANGELOG.md's newest sections, parsed at build time into a virtual module
// (the format of CHANGELOG.md doesn't change; see docs/RELEASING.md).
const CHANGELOG_ID = 'virtual:vystral-changelog';
function changelog(): Plugin {
  const file = fileURLToPath(new URL('../CHANGELOG.md', import.meta.url));
  return {
    name: 'vystral-changelog',
    resolveId: (id) => (id === CHANGELOG_ID ? '\0' + CHANGELOG_ID : undefined),
    load(id) {
      if (id !== '\0' + CHANGELOG_ID) return;
      this.addWatchFile(file);
      const releases = existsSync(file) ? parseChangelog(readFileSync(file, 'utf8')).slice(0, 8) : [];
      return `export const releases = ${JSON.stringify(releases)};`;
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), csp(), changelog()],
  build: {
    target: 'es2023',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: (id) => (id.includes('node_modules/three') ? 'three' : id.includes('node_modules/motion') ? 'motion' : undefined),
      },
    },
  },
  // Worker files are named without dots so the Windows resource indexer doesn't mistake
  // "palette.worker-<hash>" for a resource qualifier.
  worker: { format: 'es', rollupOptions: { output: { entryFileNames: 'assets/palette-worker-[hash].js' } } },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
} as Parameters<typeof defineConfig>[0]);
