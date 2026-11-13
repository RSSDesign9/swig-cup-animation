// Procedural sound for the Swig cup: an ambient waiting-room bed, the fountain-tap spurt, and the big eruption.
// One synth for both outputs: make-audio.mjs mixes it into the videos, swig-cup.html plays it live.
// Plain script (not a module) so it still loads when the page is opened from file://.
(function factory(root) {
  'use strict';
  const TAU = Math.PI * 2;
  const LOOP = 16;                             // ambient loop length; matches the video period
  const LEAD = { pop: 0.05, torrent: 0.6 };    // seconds of sound before the spurt leaves the straw
  const LEVEL = { ambient: -29, pop: -16, torrent: -10 };   // LUFS-ish: whole loop for the bed, loudest 400ms for the one-shots

  // ───────────────────────────── building blocks
  function rng(seed) {   // mulberry32: same seed, same sound, in node and the browser
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const stereo = (sr, sec) => { const n = Math.round(sr * sec); return { sr, n, L: new Float32Array(n), R: new Float32Array(n) }; };
  const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const white = r => r() * 2 - 1;
  const panGains = p => [Math.cos((p + 1) * Math.PI / 4), Math.sin((p + 1) * Math.PI / 4)];   // equal power, p in [-1, 1]

  function biquad(sr) {   // RBJ cookbook; set() can be called mid-stream for sweeps
    let b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0, x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    const f = {
      set(type, freq, q = 0.707) {
        const w = TAU * Math.min(freq, sr * 0.45) / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q), d = 1 + al;
        let n0, n1, n2;
        if (type === 'lp') { n0 = (1 - c) / 2; n1 = 1 - c; n2 = n0; }
        else if (type === 'hp') { n0 = (1 + c) / 2; n1 = -(1 + c); n2 = n0; }
        else { n0 = al; n1 = 0; n2 = -al; }   // band-pass, 0 dB at the centre
        b0 = n0 / d; b1 = n1 / d; b2 = n2 / d; a1 = -2 * c / d; a2 = (1 - al) / d;
        return f;
      },
      run(x) { const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; },
    };
    return f;
  }
  const filt = (sr, type, freq, q) => biquad(sr).set(type, freq, q);
  function pinkGen(r) { let b0 = 0, b1 = 0, b2 = 0; return () => { const w = white(r); b0 = .99765 * b0 + w * .099046; b1 = .963 * b1 + w * .2965164; b2 = .57 * b2 + w * 1.0526913; return (b0 + b1 + b2 + w * .1848) * .2; }; }
  function brownGen(r) { let y = 0; return () => { y = (y + white(r) * .02) * .998; return y * 3.5; }; }

  // Freeverb. `loop` runs the buffer through twice and keeps the second pass, so the tail wraps seamlessly.
  function reverb(b, { size = .5, damp = .4, wet = .2, loop = false }) {
    const sc = b.sr / 44100, fb = .7 + .28 * size;
    const make = spread => ({
      c: [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map(d => ({ b: new Float32Array(Math.round((d + spread) * sc)), i: 0, s: 0 })),
      a: [556, 441, 341, 225].map(d => ({ b: new Float32Array(Math.round((d + spread) * sc)), i: 0 })),
    });
    const proc = (st, x) => {
      let o = 0;
      for (const c of st.c) { const y = c.b[c.i]; c.s = y * (1 - damp) + c.s * damp; c.b[c.i] = x + c.s * fb; if (++c.i === c.b.length) c.i = 0; o += y; }
      for (const a of st.a) { const y = a.b[a.i]; a.b[a.i] = o + y * .5; if (++a.i === a.b.length) a.i = 0; o = y - o; }
      return o;
    };
    const sl = make(0), sr_ = make(23), { n, L, R } = b, g = wet * 3;
    for (let pass = loop ? 0 : 1; pass < 2; pass++) for (let i = 0; i < n; i++) {
      const x = (L[i] + R[i]) * .015, wl = proc(sl, x), wr = proc(sr_, x);
      if (pass === 1) { L[i] += wl * g; R[i] += wr * g; }
    }
  }

  // Loudness over the whole buffer, or its loudest `win` seconds, through a rough K-weighting
  // (low cut + presence lift) so a low roar doesn't read as loud as it measures.
  function setLevel(b, lufs, win) {
    const { n, L, R, sr } = b, p = new Float64Array(n);
    for (const ch of [L, R]) {
      const lo = filt(sr, 'hp', 60, .5), hi = filt(sr, 'hp', 1500);
      for (let i = 0; i < n; i++) { const x = lo.run(ch[i]), k = x + .58 * hi.run(x); p[i] += k * k; }
    }
    let ms = 0;
    if (!win) { for (let i = 0; i < n; i++) ms += p[i]; ms /= n; }
    else { const w = Math.round(win * sr); let acc = 0; for (let i = 0; i < n; i++) { acc += p[i]; if (i >= w) acc -= p[i - w]; if (i >= w - 1) ms = Math.max(ms, acc / w); } }
    const g = Math.pow(10, (lufs + .691 - 10 * Math.log10(ms || 1e-12)) / 20);
    for (let i = 0; i < n; i++) { L[i] *= g; R[i] *= g; }
    return b;
  }

  // Look-ahead peak limiter: the gain dips just before a peak and recovers over `rel` seconds.
  function limit(b, ceilDb = -1, rel = .08) {
    const { n, L, R, sr } = b, c = Math.pow(10, ceilDb / 20), w = Math.max(1, Math.round(.004 * sr)), g = new Float32Array(n);
    for (let i = 0; i < n; i++) g[i] = Math.min(1, c / (Math.max(Math.abs(L[i]), Math.abs(R[i])) || 1e-9));
    const m = new Float32Array(n), q = [];   // sliding minimum over the next w samples
    for (let i = n - 1; i >= 0; i--) { while (q.length && g[q[q.length - 1]] >= g[i]) q.pop(); q.push(i); while (q[0] > i + w) q.shift(); m[i] = g[q[0]]; }
    let s = 1, acc = w; const k = Math.exp(-1 / (rel * sr));
    for (let i = 0; i < n; i++) {
      acc += m[i] - (i >= w ? m[i - w] : 1);   // moving average smooths the attack
      s = Math.min(acc / w, s * k + (1 - k)); L[i] *= s; R[i] *= s;
    }
    return b;
  }

  // ───────────────────────────── fountain parts
  // The tap: plastic button clunk, then the valve solenoid's tick a beat later.
  function click(b, at, { size = 1, amp = 1, pan = 0 }, r) {
    const { sr, L, R } = b, i0 = Math.round(at * sr), len = Math.round(.09 * size * sr), [gl, gr] = panGains(pan);
    const tick = filt(sr, 'bp', 2700 / size, 1.1), valve = filt(sr, 'bp', 4800 / size, 1.4), f = 165 / size;
    for (let i = 0; i < len && i0 + i < b.n; i++) {
      const t = i / sr;
      let v = tick.run(white(r) * Math.exp(-t / .0025)) * .9;
      v += Math.sin(TAU * f * (t + .6 * .008 * (1 - Math.exp(-t / .008)))) * Math.exp(-t / (.022 * size)) * .4;
      v += valve.run(t > .017 * size ? white(r) * Math.exp(-(t - .017 * size) / .0016) : 0) * .7;
      L[i0 + i] += v * amp * gl; R[i0 + i] += v * amp * gr;
    }
  }

  // A single gas bubble ringing in the liquid (Minnaert resonance with the van den Doel upward chirp).
  function bubble(b, at, f0, amp, pan) {
    const { sr, L, R } = b, i0 = Math.round(at * sr), d = .043 * f0 + .0014 * Math.pow(f0, 1.5), sig = .1 * d;
    const len = Math.max(0, Math.min(Math.round(5 / d * sr), b.n - i0)), [gl, gr] = panGains(pan);
    for (let i = 0; i < len; i++) {
      const t = i / sr, v = Math.sin(TAU * f0 * (t + sig * t * t / 2)) * (1 - Math.exp(-t / .0008)) * Math.exp(-d * t) * amp;
      L[i0 + i] += v * gl; R[i0 + i] += v * gr;
    }
  }
  function bubbles(b, at, dur, rate, fLo, fHi, amp, spread, r) {   // rate(te) per second, amp(te)
    for (let te = 0; te < dur;) {
      const k = rate(te); if (k <= 0) { te += .005; continue; }
      te += -Math.log(1 - r() * .999) / k; if (te >= dur) break;
      const f0 = Math.exp(Math.log(fLo) + r() * Math.log(fHi / fLo));
      bubble(b, at + te, f0, amp(te) * (.35 + .65 * r()) * Math.sqrt(900 / f0), (r() * 2 - 1) * spread);
    }
  }

  // Carbonation: tiny bright ticks as bubbles burst at the surface.
  function fizz(b, at, dur, rate, amp, r) {
    const { sr, L, R } = b, i0 = Math.round(at * sr), len = Math.min(Math.round(dur * sr), b.n - i0);
    const bl = new Float32Array(len), br = new Float32Array(len);
    for (let te = 0; ;) {
      te += -Math.log(1 - r() * .999) / Math.max(rate(te), 1); const i = Math.round(te * sr); if (i >= len) break;
      const a = amp(te) * (.2 + .8 * r() * r()) * (r() < .5 ? -1 : 1), p = r(); bl[i] += a * (1 - p); br[i] += a * p;
    }
    const fl = filt(sr, 'bp', 5200, .8), fr = filt(sr, 'bp', 5200, .8), hl = filt(sr, 'hp', 2500), hr = filt(sr, 'hp', 2500);
    for (let i = 0; i < len; i++) { L[i0 + i] += hl.run(fl.run(bl[i])) * 4; R[i0 + i] += hr.run(fr.run(br[i])) * 4; }
  }

  // The pressurised pour: syrup-and-CO2 sputter, the hiss of the stream, liquid body, and (for the big one) a roar.
  function pour(b, at, dur, o, r) {
    const { sr, L, R } = b, i0 = Math.round(at * sr), len = Math.min(Math.round((dur + .2) * sr), b.n - i0);
    const hiss = biquad(sr).set('bp', o.hissF, .6), sizzle = filt(sr, 'hp', 6000), body = filt(sr, 'bp', o.bodyF, .8), body2 = filt(sr, 'lp', 1400);
    const roar = filt(sr, 'lp', o.roarF || 160), rush = filt(sr, 'lp', 650), spit = filt(sr, 'hp', 2500), turb = filt(sr, 'lp', 9);
    const pink = pinkGen(r), brown = brownGen(r), brown2 = brownGen(r);
    for (let i = 0; i < len; i++) {
      const te = i / sr, e = o.env(te), sway = o.sway ? Math.sin(TAU * .55 * te) * o.sway : 0;
      if ((i & 31) === 0) hiss.set('bp', o.hissF * (1 + (o.sway ? .25 * Math.sin(TAU * 2.1 * te) : 0)), .6);
      const tb = 1 + 6 * turb.run(white(r));   // slow turbulence wobble
      let v = hiss.run(white(r)) * o.hiss * tb + sizzle.run(white(r)) * o.sizzle + body2.run(body.run(pink())) * o.body * tb;
      if (o.roar) v += Math.tanh(roar.run(brown()) * 1.6) * o.roar * (.8 + .3 * tb) + rush.run(brown2()) * o.roar * .5;
      v *= e;
      v += spit.run(white(r) * (Math.exp(-te / .028) + .6 * (te > .05 ? Math.exp(-(te - .05) / .02) : 0))) * o.sputter;   // the "pfft" as the valve opens
      const [gl, gr] = panGains(sway);
      L[i0 + i] += v * gl; R[i0 + i] += v * gr;
    }
  }

  // Liquid raining back down: droplets slapping the surface, some leaving a bubble behind.
  function rain(b, at, dur, rate, amp, r) {
    const { sr, L, R } = b;
    for (let te = 0; ;) {
      te += -Math.log(1 - r() * .999) / Math.max(rate(te), 1); if (te >= dur) break;
      const i0 = Math.round((at + te) * sr), f = filt(sr, 'bp', 700 + r() * r() * 3800, 1.4), tau = .002 + r() * .005;
      const a = amp(te) * (.25 + .75 * r()), [gl, gr] = panGains((r() * 2 - 1) * .8), len = Math.min(Math.round(tau * 6 * sr), b.n - i0);
      for (let i = 0; i < len; i++) { const v = f.run(white(r) * Math.exp(-i / sr / tau)) * a; L[i0 + i] += v * gl; R[i0 + i] += v * gr; }
      if (r() < .3) bubble(b, at + te + .004, 900 + r() * 2200, a * .25, (r() * 2 - 1) * .6);
    }
  }

  // ───────────────────────────── the three sounds
  // Ambient: a slow Dmaj9 ↔ Gmaj9 pad, a few soft electric-piano notes, faint room tone. Seamless 16s loop.
  function renderAmbient(sr, seed = 7) {
    const r = rng(seed), b = stereo(sr, LOOP), { n, L, R } = b;
    const q = f => Math.round(f * LOOP) / LOOP;   // whole cycles per loop
    const wave = new Float32Array(2049);           // one cycle of a soft pad partial mix
    for (let i = 0; i <= 2048; i++) { const p = TAU * i / 2048; wave[i] = (Math.sin(p) + .22 * Math.sin(2 * p) + .07 * Math.sin(3 * p)) / 1.29; }
    // [Hz, weight in Dmaj9, weight in Gmaj9]
    const notes = [[98.00, 0, 1], [146.83, 1, .9], [220.00, 1, 0], [246.94, 0, .8], [329.63, .8, 0], [369.99, .7, .7], [440.00, 0, .5], [554.37, .45, 0]];
    const detune = [[-3, 0, 2], [-2, 1, 3]];       // in 1/16 Hz steps per channel: slow chorus that still loops
    const BLK = 64;
    for (const [f, wa, wb] of notes) {
      const ph = [r(), r(), r(), r(), r(), r()], k = 1 + Math.floor(r() * 3), bp = r() * TAU, pan = (r() * 2 - 1) * .45, [gl, gr] = panGains(pan);
      const inc = Float64Array.from([...detune[0], ...detune[1]], d => (q(f) + d / LOOP) / sr), p = Float64Array.from(ph);
      for (let i0 = 0; i0 < n; i0 += BLK) {
        const t = i0 / sr, ca = .5 + .5 * Math.cos(TAU * t / LOOP);
        const a = (wa * ca + wb * (1 - ca)) * (.78 + .22 * Math.sin(TAU * k * t / LOOP + bp)) / 3, al = a * gl, ar = a * gr;
        for (let i = i0, end = Math.min(i0 + BLK, n); i < end; i++) {
          let l = 0, rr = 0;
          for (let j = 0; j < 6; j++) {
            const x = p[j] * 2048, x0 = x | 0, v = wave[x0] + (wave[x0 + 1] - wave[x0]) * (x - x0);
            if (j < 3) l += v; else rr += v;
            if ((p[j] += inc[j]) >= 1) p[j] -= 1;
          }
          L[i] += l * al; R[i] += rr * ar;
        }
      }
    }
    // electric piano: sparse notes in the gaps between the video's spurts
    for (const [t0, f, pan] of [[2.4, 880.00, .3], [3.3, 739.99, -.2], [10.2, 587.33, -.3], [11.0, 493.88, .25], [14.6, 659.25, 0]]) {
      const i0 = Math.round(t0 * sr), len = Math.round(5 * sr), [gl, gr] = panGains(pan);
      for (let i = 0; i < len; i++) {
        const t = i / sr, I = 1.4 * Math.exp(-t / .12) + .25, c = TAU * f * t;
        const v = Math.sin(c + I * Math.sin(c)) * Math.min(1, t / .004) * Math.exp(-t / 1.3) * .32, j = (i0 + i) % n;
        L[j] += v * gl; R[j] += v * gr;
      }
    }
    // room tone: dark pink noise, filtered around the loop twice so it wraps cleanly
    const pink = pinkGen(r), ns = new Float32Array(n); for (let i = 0; i < n; i++) ns[i] = pink();
    const lp = filt(sr, 'lp', 900), hp = filt(sr, 'hp', 70);
    for (let i = 0; i < 2 * n; i++) { const v = hp.run(lp.run(ns[i % n])) * .1; if (i >= n) { L[i - n] += v; R[i - n] += v * .9; } }
    reverb(b, { size: .85, damp: .5, wet: .35, loop: true });
    return setLevel(b, LEVEL.ambient);
  }

  // Small spurt: exactly the fountain tap — click, "pfft-sshhh" for the 0.62s spurt, button release, fizz in the cup.
  function renderPop(sr, seed = 1) {
    const r = rng(seed), b = stereo(sr, 2.4), a = LEAD.pop, D = .62;
    click(b, 0, { size: 1 + .06 * (r() - .5), amp: .9 }, r);
    pour(b, a, D, { env: te => smooth(0, .02, te) * (1 - smooth(D - .07, D + .03, te)), hissF: 2400, hiss: .55, sizzle: .2, bodyF: 800, body: .5, sputter: .7 }, r);
    bubbles(b, a, D, te => 260 * smooth(0, .05, te), 450, 2200, () => .1, .4, r);
    click(b, a + D + .03, { size: 1.15, amp: .4 }, r);
    fizz(b, a + .1, 2.2, te => 520 * Math.exp(-te / .5), te => .42 * smooth(0, .1, te) * Math.exp(-te / .9), r);
    reverb(b, { size: .35, damp: .55, wet: .12 });
    return limit(setLevel(b, LEVEL.pop, .4));
  }

  // Big eruption: the same tap, opened all the way — pressure rumble, a volcanic boom and roar, the gush, then it rains back down.
  function renderTorrent(sr, seed = 2) {
    const r = rng(seed), b = stereo(sr, 7.4), a = LEAD.torrent, D = 2.4, { L, R } = b;
    // build-up under the lid (the cup's squash): rising rumble, gurgles, pressure hiss
    const lp = filt(sr, 'lp', 110), ph = filt(sr, 'bp', 3200, 2), brown = brownGen(r);
    for (let i = 0, len = Math.round((a + .5) * sr); i < len; i++) {
      const t = i / sr, e = t < a ? Math.pow(t / a, 2) : Math.exp(-(t - a) / .15);
      const v = lp.run(brown()) * .3 * e + ph.run(white(r)) * .1 * Math.pow(Math.min(t / a, 1), 3) * (t < a ? 1 : 0);
      L[i] += v; R[i] += v;
    }
    bubbles(b, 0, a, te => 15 + 110 * te / a, 120, 420, te => .22 * (.4 + te / a), .3, r);
    click(b, a - .02, { size: 1.7, amp: 1.1 }, r);
    // the boom
    const bn = filt(sr, 'lp', 350);
    for (let i = 0, i0 = Math.round(a * sr), len = Math.round(1.2 * sr); i < len; i++) {
      const t = i / sr, v = Math.sin(TAU * (42 * t + 53 * .06 * (1 - Math.exp(-t / .06)))) * Math.exp(-t / .35) * .9 + bn.run(white(r)) * Math.exp(-t / .12) * 1.4;
      L[i0 + i] += v; R[i0 + i] += v;
    }
    // the gush follows the jet's speed curve in swig-cup.html (KINDS.torrent.speed / torrentFx)
    const env = te => smooth(0, .12, te) * (1 - smooth(D - .45, D, te)) * (1 + .07 * Math.sin(TAU * 2.1 * te) + .04 * Math.sin(TAU * 5.3 * te));
    pour(b, a, D, { env, hissF: 2000, hiss: 1.4, sizzle: .55, bodyF: 600, body: .9, roar: .8, roarF: 170, sway: .3, sputter: 1 }, r);
    bubbles(b, a, D, te => 700 * env(te), 250, 2600, te => .13 * (.5 + .5 * env(te)), .7, r);
    click(b, a + D + .03, { size: 1.3, amp: .5 }, r);
    rain(b, a + .9, 4, te => 260 * smooth(0, .5, te) * Math.exp(-Math.max(0, te - 1.2) / .7), te => 2.6 * Math.exp(-Math.max(0, te - 1.6) / .9), r);
    fizz(b, a + .3, 6.2, te => 900 * Math.exp(-te / 1.2), te => 1.1 * smooth(0, .2, te) * Math.exp(-te / 1.6), r);
    reverb(b, { size: .55, damp: .45, wet: .18 });
    return limit(setLevel(b, LEVEL.torrent, .4));
  }

  // Browser: render the page's sound bank in a worker (built from this very file) so the cup never stutters.
  // counts = how many variants of each one-shot; variant i uses seed i + 1, same as make-audio.mjs.
  const bank = (S, sr, counts) => {
    const out = { ambient: S.renderAmbient(sr), pop: [], torrent: [] };
    for (let i = 0; i < counts.pop; i++) out.pop.push(S.renderPop(sr, i + 1));
    for (let i = 0; i < counts.torrent; i++) out.torrent.push(S.renderTorrent(sr, i + 1));
    return out;
  };
  function renderBank(sr, counts) {
    return new Promise(resolve => {
      const fallback = () => setTimeout(() => resolve(bank(api, sr, counts)), 0);
      try {
        const src = `(${factory})(self); const bank = ${bank};
          self.onmessage = e => { const o = bank(self.SwigSFX, e.data.sr, e.data.counts); self.postMessage(o, [o.ambient, ...o.pop, ...o.torrent].flatMap(b => [b.L.buffer, b.R.buffer])); };`;
        const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' })), w = new Worker(url);
        w.onmessage = e => { resolve(e.data); w.terminate(); URL.revokeObjectURL(url); };
        w.onerror = e => { e.preventDefault(); w.terminate(); fallback(); };
        w.postMessage({ sr, counts });
      } catch { fallback(); }
    });
  }

  const api = { LOOP, LEAD, LEVEL, renderAmbient, renderPop, renderTorrent, limit, renderBank };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.SwigSFX = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
