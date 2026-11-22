// Meet de toonhoogtelijn van een scratch in een opname en maakt er een schone,
// opnieuw gesynthetiseerde versie van (geen audio uit de opname zelf).
// node resynth.js <in.wav mono 44.1k 16-bit> <start s> <eind s> <uit.wav>
const fs = require('fs');
const [,, inFile, t0s, t1s, outFile] = process.argv;
const T0 = parseFloat(t0s), T1 = parseFloat(t1s);

const b = fs.readFileSync(inFile);
const SR = b.readUInt32LE(24), off = b.indexOf('data') + 8, n = (b.length - off) >> 1;
const x = new Float32Array(n);
for (let i = 0; i < n; i++) x[i] = b.readInt16LE(off + i * 2) / 32768;

const WIN = 1024, NFFT = 4096, HOP = 128, BIN = SR / NFFT;
const hann = Float32Array.from({ length: WIN }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (WIN - 1)));

function fftMag(start) {
  const re = new Float64Array(NFFT), im = new Float64Array(NFFT);
  for (let i = 0; i < WIN; i++) re[i] = (x[start + i] || 0) * hann[i];
  for (let i = 1, j = 0; i < NFFT; i++) {
    let bit = NFFT >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const t = re[i]; re[i] = re[j]; re[j] = t; }
  }
  for (let len = 2; len <= NFFT; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < NFFT; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, c = a + len / 2;
        const tr = re[c] * cr - im[c] * ci, ti = re[c] * ci + im[c] * cr;
        re[c] = re[a] - tr; im[c] = im[a] - ti; re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
  const m = new Float32Array(NFFT / 2);
  for (let i = 0; i < NFFT / 2; i++) m[i] = Math.hypot(re[i], im[i]);
  return m;
}

// achtergrond per frequentie (mediaan over de hele opname): haalt stilstaande tonen weg
const bgFrames = [];
for (let s = 0; s + WIN < n; s += 1024) bgFrames.push(fftMag(s));
const bg = new Float32Array(NFFT / 2);
for (let k = 0; k < NFFT / 2; k++) {
  const col = bgFrames.map(f => f[k]).sort((a, c) => a - c);
  bg[k] = col[Math.floor(col.length * 0.6)];
}

const frames = [];
for (let s = Math.round(T0 * SR); s < T1 * SR; s += HOP) {
  const m = fftMag(s - WIN / 2);
  for (let k = 0; k < m.length; k++) m[k] = Math.max(0, m[k] - 1.6 * bg[k]);
  frames.push(m);
}
const at = (m, f) => { const p = f / BIN, i = Math.floor(p); return i + 1 < m.length ? m[i] * (1 - (p - i)) + m[i + 1] * (p - i) : 0; };

// kandidaat-toonhoogtes voor de sterkste deeltoon (rond 1-2 kHz)
const F = []; for (let f = 1150; f <= 2350; f += 6) F.push(f);
const W = [0.5, 1, 1, 1, 1];
const sal = frames.map(m => F.map(f => { let s = 0; for (let h = 1; h <= 5; h++) if (h * f < 10600) s += W[h - 1] * at(m, h * f); return s; }));
const smax = Math.max(...sal.map(r => Math.max(...r)));

// spoor volgen: zo sterk mogelijk, zonder wilde sprongen
const PEN = 0.0009 * smax;
let cost = sal[0].slice(), back = [];
for (let t = 1; t < frames.length; t++) {
  const nc = new Array(F.length), bk = new Array(F.length);
  for (let j = 0; j < F.length; j++) {
    let best = -Infinity, bi = 0;
    for (let i = Math.max(0, j - 25); i <= Math.min(F.length - 1, j + 25); i++) {
      const c = cost[i] - PEN * Math.abs(F[i] - F[j]);
      if (c > best) { best = c; bi = i; }
    }
    nc[j] = best + sal[t][j]; bk[j] = bi;
  }
  cost = nc; back.push(bk);
}
let j = cost.indexOf(Math.max(...cost));
const track = new Array(frames.length);
for (let t = frames.length - 1; t >= 0; t--) { track[t] = j; if (t > 0) j = back[t - 1][j]; }
const fRaw = track.map(i => F[i]);
const f = fRaw.map((_, t) => { let s = 0, c = 0; for (let d = -4; d <= 4; d++) if (fRaw[t + d]) { s += fRaw[t + d]; c++; } return s / c; });
const amp = track.map((i, t) => sal[t][i] / smax);

// klankkleur: gemiddelde sterkte per deeltoon (veelvouden van de halve toonhoogte)
const NH = 22, prof = new Float64Array(NH + 1);
let wsum = 0;
frames.forEach((m, t) => { if (amp[t] > 0.3) { for (let k = 1; k <= NH; k++) if (k * f[t] / 2 < 10800) prof[k] += at(m, k * f[t] / 2) * amp[t]; wsum += amp[t]; } });
const pmax = Math.max(...prof);
for (let k = 1; k <= NH; k++) prof[k] /= pmax || 1;

// halen: stukken waar de scratch duidelijk klinkt
const TH = 0.16, on = amp.map(a => a > TH);
const strokes = []; let s0 = -1;
on.forEach((v, t) => { if (v && s0 < 0) s0 = t; if ((!v || t === on.length - 1) && s0 >= 0) { if (t - s0 > 6) strokes.push([s0, t]); s0 = -1; } });
const ms = t => (T0 + t * HOP / SR).toFixed(3);
console.log('halen:', strokes.map(([a, c]) => `${ms(a)}-${ms(c)} (${Math.round(f[a])}>${Math.round(Math.max(...f.slice(a, c)))}>${Math.round(f[c - 1])} Hz)`).join('  '));
console.log('klankkleur (deeltonen 1-12):', Array.from(prof.slice(1, 13)).map(v => v.toFixed(2)).join(' '));

// opnieuw opbouwen
const first = strokes.length ? strokes[0][0] : 0, last = strokes.length ? strokes[strokes.length - 1][1] : frames.length;
const N = (last - first) * HOP + Math.round(0.03 * SR);
const y = new Float64Array(N);
let phase = 0, env = 0, seed = 5;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 * 2 - 1;
const inStroke = t => strokes.some(([a, c]) => t >= a && t < c);
for (let i = 0; i < N; i++) {
  const p = first + i / HOP, t = Math.min(frames.length - 2, Math.floor(p)), fr = p - t;
  const fi = f[t] * (1 - fr) + f[t + 1] * fr;
  const target = inStroke(t) ? Math.pow(amp[t] * (1 - fr) + amp[t + 1] * fr, 0.7) : 0;
  env += (target - env) * (target > env ? 0.02 : 0.006);
  phase += (fi / 2) / SR;
  let v = 0;
  for (let k = 1; k <= NH; k++) if (k * fi / 2 < 16000) v += prof[k] * Math.sin(2 * Math.PI * k * phase);
  y[i] = (v + 0.25 * rnd()) * env;
}
let peak = 0; for (const v of y) peak = Math.max(peak, Math.abs(v));
const out = Buffer.alloc(44 + N * 2);
out.write('RIFF', 0); out.writeUInt32LE(36 + N * 2, 4); out.write('WAVEfmt ', 8); out.writeUInt32LE(16, 16);
out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(SR, 24); out.writeUInt32LE(SR * 2, 28);
out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(N * 2, 40);
for (let i = 0; i < N; i++) out.writeInt16LE(Math.round(y[i] / peak * 0.89 * 32767), 44 + i * 2);
fs.writeFileSync(outFile, out);
console.log(`${outFile}: ${(N / SR).toFixed(3)} s, begint op ${ms(first)} s in de opname`);
