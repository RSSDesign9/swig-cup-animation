// Builds the soundtrack from sfx/swig-sfx.js and muxes it into the rendered torrent-cut videos.
//   node make-audio.mjs                    → output/audio/*.wav + a -sound.mp4 next to every silent mp4 in output/
//   node make-audio.mjs output/foo.mp4     → just that video
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const SFX = createRequire(import.meta.url)('./sfx/swig-sfx.js');
const SR = 48000, LOOP = SFX.LOOP, T0 = 4.8;   // torrent cut: video 0s is animation 4.8s (render.mjs)
// swig-cup.html's SCHEDULE for seq=torrent, with the seeds its eventsNear() hands out (101 + i * 977)
const EVENTS = [{ s: 1.6, type: 'pop', seed: 101 }, { s: 5.6, type: 'pop', seed: 1078 }, { s: 9.6, type: 'torrent', seed: 2055 }];
const VARIANTS = { pop: 3, torrent: 2 };       // same pick as the live page: seed % count
const render = (type, seed) => type === 'pop' ? SFX.renderPop(SR, 1 + seed % VARIANTS.pop) : SFX.renderTorrent(SR, 1 + seed % VARIANTS.torrent);

// mix around a circular 16s buffer so tails wrap and the loop is seamless
const N = SR * LOOP, mix = { sr: SR, n: N, L: new Float32Array(N), R: new Float32Array(N) };
const place = (b, at) => { const i0 = Math.round(at * SR); for (let i = 0; i < b.n; i++) { const j = ((i0 + i) % N + N) % N; mix.L[j] += b.L[i]; mix.R[j] += b.R[i]; } };
place(SFX.renderAmbient(SR), 0);
const oneShots = {};
for (const e of EVENTS) place(oneShots[e.seed] = render(e.type, e.seed), e.s - SFX.LEAD[e.type] - T0);

SFX.limit(mix, -1);   // the mix lands around -16 LUFS; this just catches overlapping peaks
let peak = 0; for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(mix.L[i]), Math.abs(mix.R[i]));

function wav(file, b) {   // 16-bit PCM with TPDF dither
  const buf = Buffer.alloc(44 + b.n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + b.n * 4, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(b.sr, 24); buf.writeUInt32LE(b.sr * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(b.n * 4, 40);
  const q = x => Math.max(-32768, Math.min(32767, Math.round(x * 32767 + Math.random() - Math.random())));
  for (let i = 0; i < b.n; i++) { buf.writeInt16LE(q(b.L[i]), 44 + i * 4); buf.writeInt16LE(q(b.R[i]), 46 + i * 4); }
  writeFileSync(file, buf); console.log(file);
}
const audioDir = path.join(here, 'output', 'audio'); mkdirSync(audioDir, { recursive: true });
const track = path.join(audioDir, `swig-soundtrack-torrent-loop-${LOOP}s.wav`);
wav(track, mix);
wav(path.join(audioDir, `swig-ambient-loop-${LOOP}s.wav`), SFX.renderAmbient(SR));
wav(path.join(audioDir, 'swig-spurt-small.wav'), oneShots[EVENTS[0].seed]);
wav(path.join(audioDir, 'swig-eruption-big.wav'), oneShots[EVENTS[2].seed]);
console.log('soundtrack peak', (20 * Math.log10(peak)).toFixed(1), 'dBFS');

const args = process.argv.slice(2).filter(a => a.endsWith('.mp4'));
const videos = args.length ? args : readdirSync(path.join(here, 'output')).filter(f => f.endsWith('.mp4') && !f.endsWith('-sound.mp4')).map(f => path.join(here, 'output', f));
for (const v of videos) {
  const dur = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', v]).toString().trim();
  const out = v.replace(/\.mp4$/, '-sound.mp4');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', v, '-stream_loop', '-1', '-i', track, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', dur, '-movflags', '+faststart', out], { stdio: 'inherit' });
  console.log(out);
}
