// Audio math shared by the browser and the Node self-test. No DOM or Node APIs in this file.

export const SR = 48000;

export const dbToGain = (db) => 10 ** (db / 20);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const SPEECH = /[\p{L}\p{N}]/u;
const PAUSE_MARK = /[.,;:!?…—–]/;
const ALWAYS_BREAKS = /[—–…]/;

// Phrases split at punctuation that usually carries a pause. `chars` is the per-timestamp
// character list from ElevenLabs, so indices match `starts`/`ends` even when an entry holds
// more than one code unit.
export const phrases = (chars) => {
  const out = [];
  let first = -1;
  let last = -1;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (SPEECH.test(c)) {
      if (first < 0) first = i;
      last = i;
      continue;
    }
    const next = chars[i + 1];
    const breaks = c.includes("\n") || (PAUSE_MARK.test(c) && (ALWAYS_BREAKS.test(c) || next === undefined || /^\s/.test(next)));
    if (breaks && first >= 0) {
      out.push({ first, last });
      first = -1;
      last = -1;
    }
  }
  if (first >= 0) out.push({ first, last });
  return out;
};

// Where speech starts and ends inside a take, in seconds from its first sample.
export const speechSpan = (align) => {
  const runs = phrases(align.chars);
  if (!runs.length) return null;
  return { start: align.starts[runs[0].first], end: align.ends[runs[runs.length - 1].last] };
};

// Words with their character ranges. Punctuation stays attached to its word.
export const wordRanges = (chars) => {
  const out = [];
  let first = -1;
  for (let i = 0; i <= chars.length; i++) {
    const blank = i === chars.length || /^\s+$/.test(chars[i]);
    if (!blank && first < 0) first = i;
    if (blank && first >= 0) {
      out.push({ first, last: i - 1, text: chars.slice(first, i).join("") });
      first = -1;
    }
  }
  return out;
};

const sameChars = (a, b) => a.length === b.length && a.every((c, i) => c === b[i]);

// 10 ms RMS envelope in dBFS over 20 ms windows, with the level speech sits at and the floor
// under which the take counts as silent.
export const envelope = (pcm, sr = SR) => {
  const hop = Math.round(sr * 0.01);
  const win = hop * 2;
  const n = Math.max(0, Math.floor((pcm.length - win) / hop) + 1);
  const db = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    const o = f * hop;
    for (let i = 0; i < win; i++) s += pcm[o + i] * pcm[o + i];
    db[f] = 10 * Math.log10(s / win + 1e-12);
  }
  const sorted = Float32Array.from(db).sort();
  const level = sorted.length ? sorted[Math.floor(sorted.length * 0.9)] : -20;
  return { db, step: 0.01, level, floor: Math.max(level - 35, -62) };
};

// Speech edges from the waveform. ElevenLabs' timing marks where a phrase's letters start and
// end, not where its sound starts and fades, so a cut placed from timing alone can clip a word.
const acousticSpans = (take, runs) => {
  const env = take.env;
  return runs.map((r, j) => {
    let s = take.starts[r.first];
    let e = take.ends[r.last];
    if (!env) return { s, e };
    const { db, step, floor } = env;
    const last = db.length - 1;
    const frame = (t) => clamp(Math.floor(t / step), 0, last);
    const prevEnd = j > 0 ? take.ends[runs[j - 1].last] : 0;
    const nextStart = j + 1 < runs.length ? take.starts[runs[j + 1].first] : take.length;
    let f = frame(e);
    const fMax = frame(Math.min(e + 0.3, nextStart));
    while (f < fMax && db[f + 1] > floor) f++;
    e = Math.min(Math.max(e, (f + 2) * step), nextStart);
    let g = frame(s);
    if (db[g] <= floor) {
      const gMax = frame(Math.min(s + 0.25, e));
      while (g < gMax && db[g] <= floor) g++;
      s = g * step;
    } else {
      const gMin = frame(Math.max(s - 0.15, prevEnd));
      while (g > gMin && db[g - 1] > floor) g--;
      s = Math.max(Math.min(s, g * step), prevEnd);
    }
    return { s, e };
  });
};

// The quietest 20 ms between two instants; among equally quiet spots, the one nearest the middle.
const quietest = (env, a, b) => {
  const f0 = Math.max(0, Math.ceil(a / env.step));
  const f1 = Math.min(env.db.length - 1, Math.floor(b / env.step) - 2);
  if (f1 < f0) return null;
  let min = Infinity;
  for (let f = f0; f <= f1; f++) min = Math.min(min, env.db[f]);
  const mid = (f0 + f1) / 2;
  let best = f0;
  for (let f = f0; f <= f1; f++) if (env.db[f] <= min + 1 && Math.abs(f - mid) < Math.abs(best - mid)) best = f;
  return { t: best * env.step + env.step, db: env.db[best] };
};

const SECTION_LEAD = 0.12;
const SECTION_TAIL = 0.25;
const MIN_PAUSE = 0.15;
const KEEP_PAUSE = 0.75;
const MAX_ADDED_PAUSE = 0.4;

/**
 * Lays a new take onto the video timeline.
 *   take:  { chars, starts, ends, length, env? }  seconds from the take's first sample; env from envelope()
 *   orig:  { chars, starts, ends } | null          the take the picture was timed to
 *   opts:  { at, notBefore, limit, mode, rateMax }
 * `at` is where the section's audio starts on the video (the original take's sample 0).
 * `notBefore` is the earliest its first word may start, so sections never talk over each other.
 * `limit` is where the next section's first word starts; running past it is reported as overflow.
 * Modes: "natural" plays the take exactly as generated, first word on the original's first word.
 * "phrase" also starts each phrase near where the original phrase started, but only cuts in real
 * silences, keeps at least 75% of every natural pause, and never lets phrases overlap. "tight"
 * additionally nudges phrase lengths toward the original's (0.92–1.1x).
 */
export const planSection = (take, orig, opts) => {
  const { at, notBefore = -Infinity, limit = Infinity, rateMax = 1.12 } = opts;
  const mode = { anchor: "phrase", off: "natural" }[opts.mode] ?? opts.mode ?? "natural";
  const runs = phrases(take.chars);
  if (!runs.length) return { segments: [], stats: null };
  const spans = acousticSpans(take, runs);
  const aligned = Boolean(orig) && sameChars(orig.chars, take.chars);
  const origSpan = orig ? speechSpan(orig) : null;
  const newSpan = speechSpan(take);
  const common = { spanNew: newSpan.end - newSpan.start, spanOrig: origSpan ? origSpan.end - origSpan.start : null };

  if (mode === "natural" || !aligned) {
    const S = spans[0].s;
    const E = spans[spans.length - 1].e;
    const ref = take.starts[runs[0].first];
    const A = origSpan ? at + origSpan.start : at + ref;
    const refT = Math.max(A, notBefore + (ref - S));
    const startAt = refT - (ref - S);
    const endAt = refT + (E - ref);
    const src0 = Math.max(0, S - SECTION_LEAD);
    const src1 = Math.min(take.length, E + SECTION_TAIL);
    return {
      segments: [{ src0, src1, rate: 1, dst: refT - (ref - src0) }],
      stats: { mode: "natural", phrases: 1, cuts: 0, rateLo: 1, rateHi: 1, drift: refT - A, early: 0, overflow: Math.max(0, endAt - limit), startAt, endAt, ...common },
    };
  }

  // Phrases with no clean silence between them stay together.
  const env = take.env;
  const groups = [{ first: 0, last: 0 }];
  const cuts = [];
  for (let j = 0; j + 1 < runs.length; j++) {
    const gap = spans[j + 1].s - spans[j].e;
    let cut = null;
    if (env) {
      const q = gap >= 0.1 ? quietest(env, spans[j].e, spans[j + 1].s) : null;
      if (q && q.db <= env.floor) cut = q.t;
    } else if (gap >= 0.15) {
      cut = (spans[j].e + spans[j + 1].s) / 2;
    }
    if (cut === null) groups[groups.length - 1].last = j + 1;
    else {
      cuts.push(cut);
      groups.push({ first: j + 1, last: j + 1 });
    }
  }

  const G = groups.map((g) => {
    const ref = take.starts[runs[g.first].first];
    const oS = orig.starts[runs[g.first].first];
    const nd = take.ends[runs[g.last].last] - ref;
    const od = Math.max(0.05, orig.ends[runs[g.last].last] - oS);
    return { S: spans[g.first].s, E: spans[g.last].e, ref, A: at + oS, base: mode === "tight" ? clamp(nd / od, 0.92, 1.1) : 1 };
  });

  const lay = (k) => {
    let prevEnd = -Infinity;
    let prevE = 0;
    return G.map((g, i) => {
      const rate = Math.min(rateMax, g.base * k);
      const lead = (g.ref - g.S) / rate;
      let refT;
      if (i === 0) refT = Math.max(g.A, notBefore + lead);
      else {
        const natural = g.S - prevE;
        const lo = prevEnd + Math.max(Math.min(natural, MIN_PAUSE), KEEP_PAUSE * natural) + lead;
        const hi = prevEnd + natural + MAX_ADDED_PAUSE + lead;
        refT = clamp(g.A, lo, Math.max(lo, hi));
      }
      const end = refT + (g.E - g.ref) / rate;
      prevEnd = end;
      prevE = g.E;
      return { rate, refT, start: refT - lead, end };
    });
  };
  const endOf = (k) => {
    const l = lay(k);
    return l[l.length - 1].end;
  };
  let k = 1;
  if (endOf(1) > limit) {
    let lo = 1;
    let hi = rateMax / Math.min(...G.map((g) => g.base));
    if (endOf(hi) > limit) k = hi;
    else {
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (endOf(mid) > limit) lo = mid;
        else hi = mid;
      }
      k = hi;
    }
  }
  const laid = lay(k);

  const win = G.map((g, i) => ({
    src0: i === 0 ? Math.max(0, g.S - SECTION_LEAD) : cuts[i - 1],
    src1: i === G.length - 1 ? Math.min(take.length, g.E + SECTION_TAIL) : cuts[i],
  }));
  // Where two phrases sit closer than in the take, drop silence from both sides of the cut so the
  // tail of one never plays over the start of the next.
  for (let i = 0; i + 1 < G.length; i++) {
    const a = laid[i];
    const b = laid[i + 1];
    const tail = (win[i].src1 - G[i].E) / a.rate;
    const head = (G[i + 1].S - win[i + 1].src0) / b.rate;
    const room = b.start - a.end;
    if (tail + head > room) {
      const f = Math.max(0, room) / (tail + head);
      win[i].src1 = G[i].E + tail * f * a.rate;
      win[i + 1].src0 = G[i + 1].S - head * f * b.rate;
    }
  }
  const end = laid[laid.length - 1].end;
  return {
    segments: G.map((g, i) => ({ src0: win[i].src0, src1: win[i].src1, rate: laid[i].rate, dst: laid[i].refT - (g.ref - win[i].src0) / laid[i].rate })),
    stats: {
      mode,
      phrases: G.length,
      cuts: cuts.length,
      rateLo: Math.min(...laid.map((l) => l.rate)),
      rateHi: Math.max(...laid.map((l) => l.rate)),
      drift: Math.max(...laid.map((l, i) => l.refT - G[i].A)),
      early: Math.min(...laid.map((l, i) => l.refT - G[i].A)),
      overflow: Math.max(0, end - limit),
      startAt: laid[0].start,
      endAt: end,
      ...common,
    },
  };
};

// Video time of an instant in a take, through a plan's segments.
export const mapTime = (segments, t) => {
  let near = null;
  for (const s of segments) {
    if (t >= s.src0 && t <= s.src1) return s.dst + (t - s.src0) / s.rate;
    const d = t < s.src0 ? s.src0 - t : t - s.src1;
    if (!near || d < near.d) near = { s, d };
  }
  if (!near) return t;
  const s = near.s;
  return s.dst + (clamp(t, s.src0, s.src1) - s.src0) / s.rate;
};

// Every word of a take with the video times it is heard at.
export const wordTimes = (take, plan) =>
  wordRanges(take.chars).map((w, i) => {
    const start = mapTime(plan.segments, take.starts[w.first]);
    return {
      ...w,
      start: i === 0 && plan.stats ? Math.max(start, plan.stats.startAt) : start,
      end: mapTime(plan.segments, take.ends[w.last]),
    };
  });

const hann = (n) => {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
};

const bestOffset = (x, ref, center, tol, len, maxPos) => {
  const lo = Math.max(0, center - tol);
  const hi = Math.min(maxPos, center + tol);
  let best = Math.min(Math.max(center, lo), hi);
  let score = -Infinity;
  for (let p = lo; p <= hi; p += 4) {
    let s = 0;
    for (let i = 0; i < len; i += 4) s += x[ref + i] * x[p + i];
    if (s > score) {
      score = s;
      best = p;
    }
  }
  const r0 = Math.max(lo, best - 3);
  const r1 = Math.min(hi, best + 3);
  score = -Infinity;
  for (let p = r0; p <= r1; p++) {
    let s = 0;
    for (let i = 0; i < len; i++) s += x[ref + i] * x[p + i];
    if (s > score) {
      score = s;
      best = p;
    }
  }
  return best;
};

// Pitch-preserving time stretch (WSOLA). rate > 1 plays faster and returns a shorter signal.
export const timeStretch = (x, rate, sr = SR) => {
  const outLen = Math.max(0, Math.round(x.length / rate));
  const N = 2 * Math.round(sr * 0.0125);
  const Hs = N / 2;
  if (x.length < 2 * N || Math.abs(rate - 1) < 0.002) {
    const y = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) y[i] = x[Math.min(x.length - 1, Math.round(i * rate))] ?? 0;
    return y;
  }
  const tol = Math.round(sr * 0.0075);
  const win = hann(N);
  const y = new Float32Array(outLen + N);
  const wsum = new Float32Array(outLen + N);
  const maxPos = x.length - N;
  let prev = -1;
  for (let k = 0; k * Hs < outLen; k++) {
    let pos = Math.min(Math.max(0, Math.round(k * Hs * rate)), maxPos);
    if (prev >= 0 && prev + Hs + Hs <= x.length) pos = bestOffset(x, prev + Hs, pos, tol, Hs, maxPos);
    const o = k * Hs;
    for (let i = 0; i < N; i++) {
      y[o + i] += x[pos + i] * win[i];
      wsum[o + i] += win[i];
    }
    prev = pos;
  }
  for (let i = 0; i < outLen; i++) if (wsum[i] > 1e-4) y[i] /= wsum[i];
  return y.subarray(0, outLen);
};

/**
 * Mixes planned takes into one mono voice track of `length` samples.
 *   items: [{ key, pcm, segments, gain }]
 * `cache` (a Map) keeps stretched phrases between renders, keyed by take and cut.
 */
export const renderVoice = (items, length, sr = SR, cache = null) => {
  const out = new Float32Array(length);
  const fade = Math.round(0.01 * sr);
  for (const { key, pcm, segments, gain = 1 } of items) {
    for (const seg of segments) {
      const a = Math.max(0, Math.round(seg.src0 * sr));
      const b = Math.min(pcm.length, Math.round(seg.src1 * sr));
      if (b - a < 2) continue;
      let piece;
      if (Math.abs(seg.rate - 1) < 0.004) piece = pcm.subarray(a, b);
      else {
        const id = `${key}|${a}|${b}|${seg.rate.toFixed(4)}`;
        piece = cache?.get(id);
        if (!piece) {
          piece = timeStretch(pcm.subarray(a, b), seg.rate, sr);
          cache?.set(id, piece);
        }
      }
      const d0 = Math.round(seg.dst * sr);
      const n = piece.length;
      const iEnd = Math.min(n, length - d0);
      for (let i = Math.max(0, -d0); i < iEnd; i++) {
        let g = gain;
        if (i < fade) g *= i / fade;
        else if (n - i < fade) g *= (n - i) / fade;
        out[d0 + i] += piece[i] * g;
      }
    }
  }
  return out;
};

// ITU-R BS.1770 K-weighting, coefficients as in libebur128 so any sample rate works.
const kWeighting = (sr) => {
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / sr);
  const Vh = 10 ** (G / 20);
  const Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const shelf = {
    b: [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0],
    a: [(2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0],
  };
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / sr);
  a0 = 1 + K / Q + K * K;
  const highpass = { b: [1, -2, 1], a: [(2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0] };
  return [shelf, highpass];
};

const biquad = (x, { b, a }) => {
  const y = new Float32Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
};

// Integrated loudness (LUFS) of a mono signal, with the absolute and relative gates.
export const loudness = (x, sr = SR) => {
  const block = Math.round(0.4 * sr);
  if (x.length < block) return -Infinity;
  const [shelf, highpass] = kWeighting(sr);
  const y = biquad(biquad(x, shelf), highpass);
  const prefix = new Float64Array(y.length + 1);
  for (let i = 0; i < y.length; i++) prefix[i + 1] = prefix[i] + y[i] * y[i];
  const hop = Math.round(0.1 * sr);
  const z = [];
  for (let i = 0; i + block <= y.length; i += hop) z.push((prefix[i + block] - prefix[i]) / block);
  const lk = (v) => -0.691 + 10 * Math.log10(v);
  const mean = (arr) => arr.reduce((p, q) => p + q, 0) / arr.length;
  const loud = z.filter((v) => v > 0 && lk(v) > -70);
  if (!loud.length) return -Infinity;
  const gate = lk(mean(loud)) - 10;
  return lk(mean(loud.filter((v) => lk(v) > gate)));
};

export const peak = (channels) => {
  let p = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) p = Math.max(p, Math.abs(ch[i]));
  return p;
};

// Look-ahead peak limiter, in place. Holds every sample at or under `ceilingDb`.
export const limit = (channels, sr = SR, ceilingDb = -1) => {
  const ceil = dbToGain(ceilingDb);
  const n = channels[0].length;
  const look = Math.max(1, Math.round(0.005 * sr));
  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let p = 0;
    for (const ch of channels) p = Math.max(p, Math.abs(ch[i]));
    need[i] = p > ceil ? ceil / p : 1;
  }
  const target = new Float32Array(n);
  const dq = new Int32Array(n);
  let h = 0;
  let t = 0;
  for (let j = 0; j < n + look; j++) {
    if (j < n) {
      while (t > h && need[dq[t - 1]] >= need[j]) t--;
      dq[t++] = j;
    }
    const i = j - look;
    if (i < 0) continue;
    while (dq[h] < i) h++;
    target[i] = need[dq[h]];
  }
  const attack = 1 - Math.exp(-1 / (0.001 * sr));
  const release = 1 - Math.exp(-1 / (0.08 * sr));
  let g = 1;
  for (let i = 0; i < n; i++) {
    const tg = target[i];
    g += (tg - g) * (tg < g ? attack : release);
    for (const ch of channels) {
      const v = ch[i] * g;
      ch[i] = v > ceil ? ceil : v < -ceil ? -ceil : v;
    }
  }
  return channels;
};

export const encodeWav = (channels, sr = SR) => {
  const nch = channels.length;
  const n = channels[0].length;
  const bytes = n * nch * 2;
  const buf = new ArrayBuffer(44 + bytes);
  const v = new DataView(buf);
  const tag = (o, s) => {
    for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  tag(0, "RIFF");
  v.setUint32(4, 36 + bytes, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, nch, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * nch * 2, true);
  v.setUint16(32, nch * 2, true);
  v.setUint16(34, 16, true);
  tag(36, "data");
  v.setUint32(40, bytes, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nch; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return buf;
};

// PCM or float WAV to Float32 channels. Used by the Node tools; the browser uses decodeAudioData.
export const decodeWav = (input) => {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const id = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (id(0) !== "RIFF" || id(8) !== "WAVE") throw new Error("Not a WAV file");
  let fmt = null;
  let data = null;
  for (let o = 12; o + 8 <= v.byteLength; ) {
    const size = v.getUint32(o + 4, true);
    if (id(o) === "fmt ") {
      fmt = { format: v.getUint16(o + 8, true), channels: v.getUint16(o + 10, true), rate: v.getUint32(o + 12, true), bits: v.getUint16(o + 22, true) };
    } else if (id(o) === "data") {
      data = { offset: o + 8, size: Math.min(size, v.byteLength - o - 8) };
      break;
    }
    o += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error("WAV has no fmt or data chunk");
  const { channels: nch, bits, rate } = fmt;
  const float = fmt.format === 3;
  const step = bits / 8;
  const n = Math.floor(data.size / (step * nch));
  const out = Array.from({ length: nch }, () => new Float32Array(n));
  let o = data.offset;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nch; c++) {
      let s;
      if (float) s = bits === 64 ? v.getFloat64(o, true) : v.getFloat32(o, true);
      else if (bits === 16) s = v.getInt16(o, true) / 0x8000;
      else if (bits === 24) s = ((v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getInt8(o + 2) << 16)) / 0x800000);
      else if (bits === 32) s = v.getInt32(o, true) / 0x80000000;
      else s = (v.getUint8(o) - 128) / 128;
      out[c][i] = s;
      o += step;
    }
  }
  return { rate, channels: out };
};
