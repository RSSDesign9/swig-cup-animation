// Renders swig-cup.html frame-by-frame and encodes MP4s.
//   node render.mjs                     → 16s torrent loop @60fps + 32s (two torrents) + poster
//   node render.mjs --seq calm          → the 8s two-pop loop instead
//   node render.mjs --preview 1.9,5.9   → just those timestamps as PNGs (for checking)
//   node render.mjs --handle "@yourname"
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const seq = arg('--seq', 'torrent');
// torrent cut opens on a pop at 0.8s and erupts at 4.8s, so the payoff lands before people scroll
const W = +arg('--w', 1080), H = +arg('--h', 1350), FPS = +arg('--fps', 60), LOOP = seq === 'torrent' ? 16 : 8, T0 = seq === 'torrent' ? 4.8 : 0.8;
const handle = arg('--handle', 'RSS DESIGN');
const preview = arg('--preview', null);
const outDir = path.join(here, 'output');
const framesDir = arg('--frames', path.join(here, '.frames'));
mkdirSync(outDir, { recursive: true });

const exe = path.join(process.env.HOME, 'Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const browser = await chromium.launch({ channel: 'chromium', executablePath: existsSync(exe) ? exe : undefined, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('console', m => { if (m.type() === 'error') console.error('[page]', m.text()); });
page.on('pageerror', e => console.error('[pageerror]', e.message));
const url = pathToFileURL(path.join(here, 'swig-cup.html')).href + `?capture=1&seq=${seq}&w=${W}&h=${H}&handle=${encodeURIComponent(handle)}` + (arg('--fov') ? `&fov=${arg('--fov')}` : '') + (arg('--ty') ? `&ty=${arg('--ty')}` : '') + (process.argv.includes('--nosig') ? '&sig=0' : '');
await page.goto(url);
await page.waitForFunction(() => window.__ready, null, { timeout: 120000 });
await page.evaluate(() => window.__ready);
console.log('renderer:', await page.evaluate(() => { const gl = document.getElementById('gl').getContext('webgl2'); const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; }));

const grab = async (t, file) => {
  const data = await page.evaluate(tt => window.renderFrame(tt), t);
  writeFileSync(file, Buffer.from(data.split(',')[1], 'base64'));
};

if (preview) {
  const dir = path.join(here, 'preview'); mkdirSync(dir, { recursive: true });
  for (const t of preview.split(',').map(Number)) { const f = path.join(dir, `t${t.toFixed(2)}.png`); await grab(t, f); console.log(f); }
  await browser.close(); process.exit(0);
}

if (existsSync(framesDir)) rmSync(framesDir, { recursive: true });
mkdirSync(framesDir, { recursive: true });
const N = LOOP * FPS, started = Date.now();
for (let i = 0; i < N; i++) {
  await grab(T0 + i / FPS, path.join(framesDir, `f${String(i).padStart(4, '0')}.png`));
  if (i % 30 === 0) console.log(`frame ${i}/${N}  ${((Date.now() - started) / 1000).toFixed(0)}s`);
}
await grab(seq === 'torrent' ? 10.5 : 2.05, path.join(outDir, seq === 'torrent' ? 'swig-cup-poster.png' : 'swig-cup-calm-poster.png'));
await browser.close();

const ff = (args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });
const x264 = ['-c:v', 'libx264', '-preset', 'slow', '-crf', '15', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
const name = seq === 'torrent' ? 'swig-cup-torrent' : 'swig-cup-calm';
const loop = path.join(outDir, `${arg('--name', name)}-loop-${LOOP}s-${W}x${H}.mp4`);
ff(['-framerate', String(FPS), '-i', path.join(framesDir, 'f%04d.png'), ...x264, loop]);
ff(['-stream_loop', '1', '-i', loop, '-c', 'copy', '-movflags', '+faststart', path.join(outDir, `${arg('--name', name)}-${LOOP * 2}s-${W}x${H}.mp4`)]);
console.log('done in', ((Date.now() - started) / 1000).toFixed(0), 's');
