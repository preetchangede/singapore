// Build a self-contained artifact folder from the Vite build:
//   artifact/index.html   page fragment (no html/head/body tags), CSS + main JS inlined
//   artifact/assets/*     worker chunk(s)
//   artifact/data/**      map data
// and print a files map for publishing.
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const dist = join(root, 'dist');
const out = join(root, 'artifact');
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'assets'), { recursive: true });

const html = readFileSync(join(dist, 'index.html'), 'utf8');
const css = [...html.matchAll(/<link rel="stylesheet"[^>]*href="\.\/(assets\/[^"]+\.css)"[^>]*>/g)].map((m) => readFileSync(join(dist, m[1]), 'utf8')).join('\n');
const jsSrc = html.match(/<script type="module"[^>]*src="\.\/(assets\/[^"]+\.js)"[^>]*><\/script>/)[1];
let js = readFileSync(join(dist, jsSrc), 'utf8');
// keep relative URLs (worker, dynamic chunks) resolving from the page location
js = js.replaceAll('</script', '<\\/script');
for (const f of readdirSync(join(dist, 'assets'))) {
  if (f.endsWith('.css') || join('assets', f) === jsSrc) continue;
  cpSync(join(dist, 'assets', f), join(out, 'assets', f));
  // the main chunk is inlined into the page, so URLs it builds relative to its own
  // location (import.meta.url) must now include the assets/ folder
  js = js.replaceAll(`"${f}"`, `"assets/${f}"`).replaceAll(`'${f}'`, `'assets/${f}'`);
}
cpSync(join(dist, 'data'), join(out, 'data'), { recursive: true });

const fonts = 'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&family=Newsreader:ital,opsz,wght@0,6..72,300;0,6..72,400;1,6..72,400&display=swap';
const page = `<title>Singapore Reconstructed</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${fonts}">
<style>
${css}
</style>
<canvas id="world" tabindex="0" aria-label="3D view of Singapore"></canvas>
<script type="module">
${js}
</script>
`;
writeFileSync(join(out, 'index.html'), page);

// files map for the Artifact tool
const files = {};
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else {
      const rel = relative(out, p);
      if (rel === 'index.html') continue;
      files[rel] = rel.endsWith('.bin') ? { from: p, contentType: 'application/octet-stream' } : p;
    }
  }
};
walk(out);
writeFileSync(join(root, 'artifact-files.json'), JSON.stringify(files, null, 1));
const total = Object.values(files).reduce((s, f) => s + statSync(typeof f === 'string' ? f : f.from).size, 0);
console.log(`artifact: ${Object.keys(files).length} files + index.html (${(statSync(join(out, 'index.html')).size / 1e6).toFixed(2)} MB), data ${(total / 1e6).toFixed(1)} MB`);
