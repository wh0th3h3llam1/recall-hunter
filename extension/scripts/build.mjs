// Builds Recall Guard: esbuild bundles -> dist/, then dist-chrome/ and dist-firefox/ with their own manifests.
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const DIST = join(ROOT, 'dist');

if (!existsSync(join(ROOT, 'static', 'icons', 'icon-128.png'))) {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'icons.mjs')], { stdio: 'inherit' });
}

rmSync(DIST, { recursive: true, force: true });
await build({
  entryPoints: {
    background: join(ROOT, 'src', 'background.ts'),
    content: join(ROOT, 'src', 'content.ts'),
    popup: join(ROOT, 'src', 'popup.ts'),
  },
  outdir: DIST,
  bundle: true,
  format: 'iife', // classic scripts: MV3 content scripts can't be modules; works for both backgrounds
  target: ['chrome110', 'firefox121'],
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
});
cpSync(join(ROOT, 'static'), DIST, { recursive: true });

const HOSTS = [
  '*://*.amazon.com/*',
  '*://*.ebay.com/*',
  '*://*.walmart.com/*',
  '*://*.target.com/*',
  'https://*.ondigitalocean.app/*',
  'http://localhost:8000/*',
  'http://127.0.0.1:8000/*',
  '<all_urls>', // generic schema.org fallback + a configurable (deployed) API base
];

const icons = { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' };
const base = {
  manifest_version: 3,
  name: 'Recall Guard',
  version: pkg.version,
  description: 'Tags products that match U.S. CPSC recalls while you shop, and warns you before you buy.',
  icons,
  action: { default_popup: 'popup.html', default_title: 'Recall Guard', default_icon: icons },
  permissions: ['storage'],
  host_permissions: HOSTS,
  content_scripts: [{ matches: ['<all_urls>'], js: ['content.js'], run_at: 'document_idle', all_frames: false }],
  // Explicit CSP without upgrade-insecure-requests so http://localhost:8000 works from extension pages.
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
};

const targets = {
  'dist-chrome': { ...base, background: { service_worker: 'background.js' }, minimum_chrome_version: '110' },
  'dist-firefox': {
    ...base,
    background: { scripts: ['background.js'] },
    browser_specific_settings: { gecko: { id: 'recall-guard@recallhunter.dev', strict_min_version: '121.0' } },
  },
};

for (const [dir, manifest] of Object.entries(targets)) {
  const out = join(ROOT, dir);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(DIST, out, { recursive: true });
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`built ${dir}/`);
}
