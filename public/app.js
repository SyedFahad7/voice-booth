import { SR, dbToGain, encodeWav, envelope, limit, loudness, mapTime, planSection, renderVoice, speechSpan, wordRanges, wordTimes } from "./dsp.js";
import { PAUSE_CHOICES, cleanEntry, cleanTiming, isV3, pauseTag, plainText, render } from "./markup.js";
import { compareWords, keyterms, tokens } from "./words.js";
import { PRESETS, presetById } from "./music-presets.js";
import { planForLength, planForVideo } from "./music-plan.js";

const $ = (sel, root = document) => root.querySelector(sel);

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
};

const api = async (url, { method = "GET", json, body, headers } = {}) => {
  const res = await fetch(url, {
    method,
    headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: json !== undefined ? JSON.stringify(json) : body,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text.slice(0, 300) };
  }
  if (res.status === 401 && data?.signin) showSignin(data.error);
  if (!res.ok) throw new Error(data?.error ?? `${res.status} ${res.statusText}`);
  return data;
};

// The hosted booth sits behind one password; any call made signed out opens this.
const showSignin = (message) => {
  const box = document.querySelector("#signin");
  if (!box.hidden) return;
  box.hidden = false;
  document.querySelector("#signin-error").textContent = /^Sign in/.test(message ?? "") ? "" : message ?? "";
  setTimeout(() => document.querySelector("#signin-password").focus(), 0);
};

const signIn = async (e) => {
  e.preventDefault();
  const err = document.querySelector("#signin-error");
  err.textContent = "";
  const res = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: document.querySelector("#signin-password").value }) });
  if (res.ok) return location.reload();
  err.textContent = (await res.json().catch(() => null))?.error ?? "Couldn't sign in.";
};

const signOut = async () => {
  await fetch("/api/logout", { method: "POST" });
  location.reload();
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fmtTime = (t, digits = 1) => {
  if (!Number.isFinite(t)) return "–";
  const m = Math.floor(Math.max(0, t) / 60);
  const s = Math.max(0, t) - m * 60;
  return `${m}:${s.toFixed(digits).padStart(digits + 3, "0")}`;
};
const fmtDb = (v) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
const debounce = (fn, ms) => {
  let id;
  return (...args) => {
    clearTimeout(id);
    id = setTimeout(() => fn(...args), ms);
  };
};
const slugify = (s) =>
  String(s)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30) || "take";
const hash = (s) => {
  let x = 5381;
  for (let i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) >>> 0;
  return x.toString(36);
};
const concat = (arrays) => {
  const out = new Float32Array(arrays.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrays) {
    out.set(a, o);
    o += a.length;
  }
  return out;
};
const runLimited = async (tasks, n) => {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) await tasks[next++]();
  };
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
};

const store = {
  get: (key, fallback) => {
    try {
      return JSON.parse(localStorage.getItem(`booth.${key}`)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set: (key, value) => localStorage.setItem(`booth.${key}`, JSON.stringify(value)),
};

const toast = (msg, kind = "info") => {
  const el = h("div", { class: `toast ${kind}` }, msg);
  $("#toasts").append(el);
  const life = kind === "error" ? 8000 : 3500;
  setTimeout(() => el.classList.add("out"), life);
  setTimeout(() => el.remove(), life + 500);
};

const MODE_HINT = {
  natural: "Plays every line exactly as ElevenLabs generated it. If a line runs long, the next one waits for it.",
  phrase: "Also starts each phrase near its original beat. Cuts only in real silences and keeps at least 75% of every pause.",
  tight: "Phrase sync, plus gently stretches phrases (up to 10%) toward the original lengths.",
};
const MODEL_ORDER = ["eleven_v3", "eleven_multilingual_v2", "eleven_flash_v2_5", "eleven_turbo_v2_5", "eleven_flash_v2", "eleven_turbo_v2"];
const DEFAULT_SETTINGS = { stability: 0.5, similarity_boost: 0.75, style: 0 };
const CATEGORY = { premade: "default", cloned: "clone", professional: "pro clone", generated: "designed", famous: "iconic", high_quality: "hq" };
const SECTION_GAP = 0.4;
const MUSIC_TARGET_LUFS = -27;
const LANE_X = 52;

// Plays the booth's audio against the <video> clock. The video stays the master: every play,
// seek or stall restarts the Web Audio sources at the video's position.
class Engine {
  constructor(video) {
    this.video = video;
    this.ctx = new AudioContext({ sampleRate: SR, latencyHint: "interactive" });
    this.out = new DynamicsCompressorNode(this.ctx, { threshold: -2, knee: 0, ratio: 20, attack: 0.002, release: 0.1 });
    this.out.connect(this.ctx.destination);
    this.gains = {};
    for (const name of ["voice", "bed", "music"]) {
      this.gains[name] = new GainNode(this.ctx);
      this.gains[name].connect(this.out);
    }
    this.buffers = { voice: null, bed: null, music: null };
    this.booth = false;
    this.sources = [];
    this.t0 = 0;
    this.v0 = 0;
    for (const ev of ["playing", "seeked"]) video.addEventListener(ev, () => this.restart());
    for (const ev of ["pause", "waiting", "seeking", "ended", "emptied"]) video.addEventListener(ev, () => this.stop());
    setInterval(() => this.checkDrift(), 250);
  }

  get playing() {
    return !this.video.paused && !this.video.ended && this.video.readyState >= 3;
  }

  set(name, buffer) {
    this.buffers[name] = buffer;
    this.restart();
  }

  setBooth(on) {
    this.booth = on;
    this.video.muted = on;
    this.restart();
  }

  setGains(db) {
    const now = this.ctx.currentTime;
    for (const [name, value] of Object.entries(db)) this.gains[name].gain.setTargetAtTime(dbToGain(value), now, 0.015);
  }

  // Where the listener is in the video right now, audio latency included.
  position() {
    if (!this.sources.length) return this.video.currentTime;
    return this.v0 + (this.ctx.currentTime - this.t0) - (this.ctx.outputLatency || this.ctx.baseLatency || 0);
  }

  stop() {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {}
      s.disconnect();
    }
    this.sources = [];
  }

  restart() {
    this.stop();
    if (!this.booth || !this.playing) return;
    if (this.ctx.state !== "running") this.ctx.resume();
    const lead = 0.03;
    const when = this.ctx.currentTime + lead;
    const at = this.video.currentTime + lead;
    this.t0 = when;
    this.v0 = at;
    for (const [name, buffer] of Object.entries(this.buffers)) {
      if (!buffer || at >= buffer.duration) continue;
      const src = new AudioBufferSourceNode(this.ctx, { buffer });
      src.connect(this.gains[name]);
      src.start(when, at);
      this.sources.push(src);
    }
  }

  checkDrift() {
    if (!this.sources.length || !this.playing) return;
    const pos = this.v0 + (this.ctx.currentTime - this.t0);
    if (Math.abs(pos - this.video.currentTime) > 0.07) this.restart();
  }
}

const video = $("#video");
const sample = $("#sample");
const engine = new Engine(video);

const savedSel = store.get("sel", {});
if (savedSel.mode === "anchor" || savedSel.mode === "off") savedSel.mode = "natural";

const S = {
  status: null,
  projects: [],
  project: null,
  duration: 0,
  voices: [],
  models: [],
  tab: "mine",
  query: "",
  library: { q: null, items: [], page: 0, more: false, loading: false },
  sel: { voiceId: null, modelId: "eleven_multilingual_v2", speed: 1, mode: "natural", presets: true, stability: 0.5, similarity: 0.75, style: 0, ...savedSel },
  takes: [],
  active: "original",
  mix: { voiceDb: 0, bedDb: 0, bedSource: "none" },
  bed: null,
  music: null,
  musicLib: [],
  musicTrack: null,
  targetLufs: -18,
  stretch: new Map(),
  exporting: false,
  exportResult: null,
  handoffResult: null,
  sampleUrl: null,
  editing: -1,
  lexicon: [],
  checkWords: store.get("checkWords", true),
  view: [],
  hl: -1,
  hlPast: -1,
  hlLine: -1,
  scriptHover: false,
  starter: { made: 0, total: 24 },
  jobs: [],
  seenJobs: new Set(),
  autoUse: new Set(),
  mtab: "library",
  mfilter: { q: "", style: "", length: "" },
  favs: new Set(store.get("musicFavs", [])),
  genStyle: store.get("genStyle", "minimal-tech-pulse"),
  genLength: store.get("genLength", "video"),
};

const saveSel = () => store.set("sel", S.sel);
const activeTake = () => S.takes.find((t) => t.id === S.active) ?? null;
const endTime = () => S.duration || S.project?.video.duration || 0;
// The last frame. The video element's duration also counts the audio track's encoder padding.
const pictureEnd = () => S.project?.video.duration || endTime();
const flowProject = () => S.project?.kind === "upload";
const fixedAt = (s) => (flowProject() ? (s.pinned ? s.at : null) : s.at);
const firstOnset = (s) => (s.orig ? speechSpan(s.orig)?.start ?? 0 : 0);
const hasPresets = () => Boolean(S.project?.sections.some((s) => s.settings));
const baseText = (i) => S.project?.baseSections?.[i]?.text ?? S.project?.sections[i]?.text;

const shortVoice = (id) => {
  const v = S.voices.find((x) => x.voiceId === id);
  return v ? v.name.split(/\s+[-–—]\s+/)[0] : String(id).slice(0, 8);
};
const shortModel = (id) => {
  const m = S.models.find((x) => x.modelId === id);
  return (m?.name ?? id).replace(/^Eleven\s+/i, "").replace(/^eleven_/, "");
};
const takeLabel = (t) => (t.kind === "project" ? shortVoice(t.voiceId) : `${shortVoice(t.voiceId)} · ${shortModel(t.modelId)} · ${t.speed.toFixed(2)}×`);
const orderedModels = () =>
  [...S.models].sort((a, b) => {
    const ia = MODEL_ORDER.indexOf(a.modelId);
    const ib = MODEL_ORDER.indexOf(b.modelId);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

const decodeUrl = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} loading ${url}`);
  return engine.ctx.decodeAudioData(await res.arrayBuffer());
};
const mono = (buffer) => {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += d[i] / buffer.numberOfChannels;
  }
  return out;
};

/* Takes */

let takeSeq = 0;
const newTake = ({ kind, voiceId, modelId, speed, settings = null, track = null, ti = null, sections = null }) => ({
  id: `t${++takeSeq}`,
  kind,
  voiceId,
  modelId,
  speed,
  settings,
  track,
  ti,
  sections: S.project.sections.map((s, i) => ({
    status: "queued",
    seed: sections?.[i]?.seed ?? s.seed ?? 1842 + i,
    text: sections?.[i]?.text ?? s.text,
    lex: sections?.[i]?.lex ?? [],
    key: null,
    pcm: null,
    align: null,
    error: null,
    cached: false,
    stale: false,
    check: null,
    si: null,
  })),
  gainDb: 0,
  lufs: null,
  plans: [],
  buffer: null,
  data: null,
  dirty: true,
  autoplay: false,
});

// A generated line is out of date when its text, or the pronunciations it would use, changed since.
const isStale = (take, i) => {
  const sec = take.sections[i];
  const text = S.project.sections[i].text;
  return sec.text !== text || render(text, take.modelId, sec.lex).sent !== render(text, take.modelId, S.lexicon).sent;
};
const markStale = () => {
  for (const t of S.takes) if (t.kind === "generated") t.sections.forEach((sec, i) => (sec.stale = isStale(t, i)));
};

const sameTake = (a, b) =>
  a.voiceId === b.voiceId &&
  a.modelId === b.modelId &&
  a.speed === b.speed &&
  JSON.stringify(a.settings) === JSON.stringify(b.settings) &&
  a.sections.every((s, i) => s.seed === b.sections[i].seed && s.text === b.sections[i].text);

// Where every line of a take lands on the video. A line never starts before the previous one has
// finished, so a long line pushes the rest back instead of talking over them.
const planTake = (take) => {
  const p = S.project;
  let prevEnd = -Infinity;
  take.plans = p.sections.map((s, i) => {
    const at = fixedAt(s) ?? Math.max(0.4, prevEnd + SECTION_GAP);
    const next = p.sections[i + 1];
    const nextAt = next ? fixedAt(next) : null;
    const limit = next ? (nextAt !== null && nextAt !== undefined ? nextAt + firstOnset(next) - 0.1 : Infinity) : endTime() - 0.1;
    const sec = take.sections[i];
    let plan = null;
    if (sec?.status === "ready") {
      plan = planSection(sec.align, s.orig, { at, limit, mode: S.sel.mode, notBefore: prevEnd + SECTION_GAP });
      prevEnd = plan.stats?.endAt ?? prevEnd;
    } else {
      const span = s.orig ? speechSpan(s.orig) : null;
      prevEnd = Math.max(prevEnd, span ? at + span.end : at + Math.max(1, s.text.length / 15));
    }
    return { at, limit, plan, last: !next };
  });
};

const buildVoice = (take) => {
  const n = Math.max(1, Math.ceil(endTime() * SR));
  const items = [];
  take.plans.forEach((pl, i) => {
    const sec = take.sections[i];
    if (pl.plan && sec.pcm) items.push({ key: sec.key, pcm: sec.pcm, segments: pl.plan.segments });
  });
  take.data = renderVoice(items, n, SR, S.stretch);
  take.buffer = engine.ctx.createBuffer(1, n, SR);
  take.buffer.copyToChannel(take.data, 0);
  take.dirty = false;
};

// Every take plays at the loudness the original voice had in the video, so A/B is fair.
const normalize = (take) => {
  const pieces = take.sections.filter((s) => s.pcm).map((s) => s.pcm);
  if (!pieces.length) return;
  const l = loudness(concat(pieces), SR);
  take.lufs = l;
  take.gainDb = Number.isFinite(l) ? clamp(S.targetLufs - l, -20, 20) : 0;
};

const musicDb = () => (S.music?.buffer ? S.music.autoDb + S.music.gainDb : -60);
const applyGains = () => engine.setGains({ voice: (activeTake()?.gainDb ?? 0) + S.mix.voiceDb, bed: S.mix.bedDb, music: musicDb() });

const rebuildActive = debounce(() => {
  const take = activeTake();
  if (!take) return;
  if (take.dirty || !take.buffer) buildVoice(take);
  engine.set("voice", take.buffer);
  applyGains();
  renderMusic();
}, 60);

const refreshTake = (take) => {
  if (!S.takes.includes(take)) return;
  normalize(take);
  planTake(take);
  take.dirty = true;
  if (S.active === take.id) {
    rebuildActive();
    if (take.autoplay && take.sections[0]?.status === "ready") {
      take.autoplay = false;
      if (video.paused) playFrom(take.plans[0]?.plan?.stats?.startAt ?? take.plans[0]?.at ?? 0);
    }
  }
  renderTakes();
  renderScript();
  renderTimeline();
  renderExport();
};

const replanAll = () => {
  for (const t of S.takes) {
    planTake(t);
    t.dirty = true;
  }
  if (activeTake()) rebuildActive();
  renderScript();
  renderTimeline();
};

const setActive = (id) => {
  S.active = S.takes.some((t) => t.id === id) ? id : "original";
  const take = activeTake();
  if (take) {
    if (take.dirty || !take.buffer) {
      planTake(take);
      buildVoice(take);
    }
    engine.set("voice", take.buffer);
    engine.setBooth(true);
    applyGains();
  } else {
    engine.setBooth(false);
  }
  S.handoffResult = null;
  S.editing = -1;
  renderMusic();
  renderTakes();
  renderScript();
  renderTimeline();
  renderExport();
};

const playFrom = (t) => {
  engine.ctx.resume();
  video.currentTime = clamp(t - 0.3, 0, endTime());
  video.play().catch(() => {});
};

const togglePlay = () => {
  if (!S.project) return;
  engine.ctx.resume();
  if (video.paused) video.play().catch(() => {});
  else video.pause();
};

/* Music */

const peaksOf = (buffer) => {
  const buckets = Math.min(12000, Math.max(200, Math.ceil(buffer.duration * 100)));
  const size = buffer.length / buckets;
  const out = new Float32Array(buckets);
  const chans = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  for (let b = 0; b < buckets; b++) {
    let top = 0;
    const end = Math.min(buffer.length, Math.floor((b + 1) * size));
    for (let i = Math.floor(b * size); i < end; i++) for (const ch of chans) top = Math.max(top, Math.abs(ch[i]));
    out[b] = top;
  }
  return out;
};

const saveMusic = () => {
  if (!S.project) return;
  if (!S.music) return store.set(`music.${S.project.id}`, null);
  const { id, name, url, offset, in: start, out, gainDb, fadeIn, fadeOut, duck } = S.music;
  store.set(`music.${S.project.id}`, { id, name, url, offset, in: start, out, gainDb, fadeIn, fadeOut, duck });
};

const loadMusic = async (conf) => {
  const p = S.project;
  S.music = { ...conf, loading: true };
  renderMusicLane();
  renderMix();
  try {
    const buffer = await decodeUrl(conf.url);
    if (S.project !== p || S.music?.url !== conf.url) return;
    const dur = buffer.duration;
    const lufs = loudness(mono(buffer), SR);
    const start = clamp(conf.in ?? 0, 0, Math.max(0, dur - 1));
    const room = endTime() ? Math.max(1, endTime() - (conf.offset ?? 0)) : Infinity;
    const out = conf.out === undefined || conf.out === null ? start + room : conf.out;
    Object.assign(S.music, {
      buffer,
      dur,
      peaks: peaksOf(buffer),
      autoDb: Number.isFinite(lufs) ? clamp(MUSIC_TARGET_LUFS - lufs, -30, 12) : -12,
      loading: false,
      in: start,
      out: clamp(out, start + 1, Math.min(dur, start + room)),
    });
    saveMusic();
    renderMusic();
  } catch (err) {
    toast(`Couldn't load that music: ${err.message}`, "error");
    S.music = null;
    saveMusic();
  }
  renderMusicLane();
  renderMix();
  applyGains();
};

// Tracks composed for this video already start and end with it, so they get short fades.
const useMusic = (meta) => {
  const fitted = meta.fitFor?.projectId === S.project?.id;
  return loadMusic({ id: meta.id, name: meta.name, url: meta.url, offset: 0, in: 0, out: null, gainDb: 0, fadeIn: fitted ? 0.3 : 1, fadeOut: fitted ? 0.8 : 2, duck: 8 });
};

const removeMusic = () => {
  S.music = null;
  S.musicTrack = null;
  engine.set("music", null);
  saveMusic();
  renderMusicLane();
  renderMix();
};

// How far the music dips under the voice of the take being heard, per 10 ms.
const duckCurve = (frames) => {
  const take = activeTake();
  if (!S.music.duck || !take) return null;
  const down = dbToGain(-S.music.duck);
  const g = new Float32Array(frames).fill(1);
  const attack = 0.25;
  const release = 0.45;
  for (const pl of take.plans) {
    const st = pl.plan?.stats;
    if (!st) continue;
    const f0 = Math.max(0, Math.floor((st.startAt - attack) * 100));
    const f1 = Math.min(frames - 1, Math.ceil((st.endAt + release) * 100));
    for (let f = f0; f <= f1; f++) {
      const t = f / 100;
      const v = t < st.startAt ? 1 - (1 - down) * ((t - (st.startAt - attack)) / attack) : t <= st.endAt ? down : down + (1 - down) * ((t - st.endAt) / release);
      g[f] = Math.min(g[f], clamp(v, down, 1));
    }
  }
  return g;
};

// Bakes trim, position, fades and ducking into a track the length of the video. Volume is a gain
// node, so the slider answers instantly.
const renderMusic = () => {
  const m = S.music;
  if (!m?.buffer || !endTime()) {
    S.musicTrack = null;
    engine.set("music", null);
    return;
  }
  const n = Math.ceil(endTime() * SR);
  const track = engine.ctx.createBuffer(2, n, SR);
  const L = track.getChannelData(0);
  const R = track.getChannelData(1);
  const sl = m.buffer.getChannelData(0);
  const sr = m.buffer.getChannelData(m.buffer.numberOfChannels > 1 ? 1 : 0);
  const i0 = Math.round(m.offset * SR);
  const s0 = Math.round(m.in * SR);
  const len = Math.max(0, Math.min(Math.round((m.out - m.in) * SR), sl.length - s0));
  const fi = Math.round(m.fadeIn * SR);
  const fo = Math.round(m.fadeOut * SR);
  const duck = duckCurve(Math.ceil(n / 480) + 2);
  for (let k = 0; k < len; k++) {
    const t = i0 + k;
    if (t >= n) break;
    let g = 1;
    if (k < fi) g *= Math.sin(((k / fi) * Math.PI) / 2);
    if (len - k < fo) g *= Math.sin((((len - k) / fo) * Math.PI) / 2);
    if (duck) {
      const f = t / 480;
      const a = Math.floor(f);
      g *= duck[a] + (duck[a + 1] - duck[a]) * (f - a);
    }
    L[t] = sl[s0 + k] * g;
    R[t] = sr[s0 + k] * g;
  }
  S.musicTrack = track;
  engine.set("music", track);
};
const renderMusicSoon = debounce(renderMusic, 90);

const drawWave = (canvas) => {
  const m = S.music;
  if (!m?.peaks) return;
  const w = canvas.clientWidth;
  const hgt = canvas.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(hgt * dpr));
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "rgba(6, 35, 20, 0.32)";
  const P = m.peaks;
  const mid = hgt / 2 - 3;
  const room = (hgt - 16) / 2;
  for (let x = 0; x < w; x++) {
    const t0 = m.in + (x / w) * (m.out - m.in);
    const t1 = m.in + ((x + 1) / w) * (m.out - m.in);
    const b0 = Math.floor((t0 / m.dur) * P.length);
    const b1 = Math.max(b0 + 1, Math.floor((t1 / m.dur) * P.length));
    let top = 0;
    for (let b = b0; b < b1 && b < P.length; b++) top = Math.max(top, P[b]);
    const hh = Math.max(0.5, top * room);
    ctx.fillRect(x, mid - hh, 1, hh * 2);
  }
};

const renderMusicLane = () => {
  const area = $("#clip-area");
  const m = S.music;
  const D = endTime();
  if (!S.project || !D) return area.replaceChildren();
  if (!m) return area.replaceChildren(h("div", { class: "lane-empty" }, "Drop an MP3 anywhere, or use Add music"));
  if (m.loading || !m.buffer) return area.replaceChildren(h("div", { class: "lane-empty" }, h("span", { class: "spin" }), ` Loading ${m.name}…`));
  const len = m.out - m.in;
  const clip = h(
    "div",
    { class: `clip${drag?.kind && drag.kind !== "seek" ? " dragging" : ""}`, "data-drag": "move", title: "Drag to move. Pull an edge to trim. Drag a dot to set the fade.", style: `left:${(m.offset / D) * 100}%;width:${(len / D) * 100}%` },
    h("canvas"),
    h("div", { class: "fade fade-in", style: `width:${(m.fadeIn / len) * 100}%` }),
    h("div", { class: "fade fade-out", style: `width:${(m.fadeOut / len) * 100}%` }),
    h("span", { class: "clip-name" }, m.name),
    h("div", { class: "grip grip-l", "data-drag": "trim-in" }),
    h("div", { class: "grip grip-r", "data-drag": "trim-out" }),
    h("div", { class: "knob knob-in", "data-drag": "fade-in", style: `left:${(m.fadeIn / len) * 100}%` }),
    h("div", { class: "knob knob-out", "data-drag": "fade-out", style: `right:${(m.fadeOut / len) * 100}%` }),
  );
  area.replaceChildren(clip);
  drawWave(clip.querySelector("canvas"));
};

let drag = null;

const timeAtX = (clientX) => {
  const r = $("#timeline").getBoundingClientRect();
  return clamp((clientX - r.left - LANE_X) / (r.width - LANE_X), 0, 1) * endTime();
};
const pxPerSec = () => ($("#timeline").clientWidth - LANE_X) / Math.max(0.1, endTime());

const snapTargets = () => [0, endTime(), video.currentTime, ...(activeTake()?.plans ?? []).map((pl) => pl.plan?.stats?.startAt).filter((t) => t !== undefined)];
const snapTime = (t) => {
  const tol = 7 / pxPerSec();
  let best = t;
  let dist = tol;
  for (const x of snapTargets()) {
    if (Math.abs(x - t) < dist) {
      dist = Math.abs(x - t);
      best = x;
    }
  }
  return best;
};

const showTip = (clientX, text) => {
  const tip = $("#drag-tip");
  const r = $("#timeline").getBoundingClientRect();
  tip.hidden = false;
  tip.textContent = text;
  tip.style.left = `${clamp(clientX - r.left, 60, r.width - 60)}px`;
};

const dragMusic = (e) => {
  const m = S.music;
  const o = drag.m0;
  const len0 = o.out - o.in;
  const dt = (e.clientX - drag.x0) / pxPerSec();
  drag.moved = true;
  if (drag.kind === "move") {
    let start = o.offset + dt;
    const snapped = snapTime(start);
    if (snapped !== start) start = snapped;
    else {
      const endSnap = snapTime(start + len0);
      if (endSnap !== start + len0) start = endSnap - len0;
    }
    m.offset = clamp(start, 0, Math.max(0, endTime() - 1));
    m.out = Math.min(o.out, m.in + Math.max(1, endTime() - m.offset));
    showTip(e.clientX, `starts ${fmtTime(m.offset)} · ends ${fmtTime(m.offset + (m.out - m.in))}`);
  } else if (drag.kind === "trim-in") {
    let d = clamp(dt, Math.max(-o.in, -o.offset), len0 - 1);
    const snapped = snapTime(o.offset + d);
    if (snapped !== o.offset + d) d = clamp(snapped - o.offset, Math.max(-o.in, -o.offset), len0 - 1);
    m.in = o.in + d;
    m.offset = o.offset + d;
    showTip(e.clientX, `song from ${fmtTime(m.in)} · starts at ${fmtTime(m.offset)}`);
  } else if (drag.kind === "trim-out") {
    const most = Math.min(m.dur, o.in + (endTime() - o.offset));
    let out = clamp(o.out + dt, o.in + 1, most);
    const edge = snapTime(o.offset + (out - o.in));
    if (edge !== o.offset + (out - o.in)) out = clamp(o.in + (edge - o.offset), o.in + 1, most);
    m.out = out;
    showTip(e.clientX, `song to ${fmtTime(m.out)} · ${(m.out - m.in).toFixed(1)}s used`);
  } else if (drag.kind === "fade-in") {
    m.fadeIn = clamp(o.fadeIn + dt, 0, Math.max(0, m.out - m.in - m.fadeOut));
    showTip(e.clientX, `fade in ${m.fadeIn.toFixed(1)}s`);
  } else if (drag.kind === "fade-out") {
    m.fadeOut = clamp(o.fadeOut - dt, 0, Math.max(0, m.out - m.in - m.fadeIn));
    showTip(e.clientX, `fade out ${m.fadeOut.toFixed(1)}s`);
  }
  const len = m.out - m.in;
  m.fadeIn = Math.min(m.fadeIn, len);
  m.fadeOut = Math.min(m.fadeOut, len - m.fadeIn);
  renderMusicLane();
};

/* Music library */

const musicDialog = () => $("#music-dialog");
const fmtLen = (ms) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const lengthBucket = (ms) => (!ms ? "" : ms < 45000 ? "short" : ms <= 90000 ? "mid" : "long");
const videoLengthMs = () => Math.round(pictureEnd() * 1000);
const genLengthMs = () => (S.genLength === "video" ? videoLengthMs() || 60000 : Number(S.genLength));
const ROLE_NAME = { intro: "intro", build: "build", lift: "lift", steady: "steady", resolve: "resolve", single: "one part" };
const isActiveJob = (j) => j.state === "queued" || j.state === "running";

// Where the lines of the take being heard sit (or the original's, before any take is complete).
const fitLines = () => {
  const p = S.project;
  if (!p) return [];
  const take = activeTake();
  if (take) {
    const lines = take.plans.map((pl) => pl.plan?.stats).filter(Boolean);
    if (lines.length === p.sections.length) return lines.map((st) => ({ start: st.startAt, end: st.endAt }));
  }
  return p.sections
    .map((s) => {
      const at = fixedAt(s);
      const sp = s.orig ? speechSpan(s.orig) : null;
      return at !== null && at !== undefined && sp ? { start: at + sp.start, end: at + sp.end } : null;
    })
    .filter(Boolean);
};

const fitPlan = (preset) => {
  const lines = fitLines();
  return { lines, ...(lines.length >= 2 ? planForVideo(preset, pictureEnd(), lines) : planForLength(preset, videoLengthMs())) };
};

const filteredTracks = () => {
  const { q, style, length } = S.mfilter;
  const needle = q.trim().toLowerCase();
  return S.musicLib.filter((t) => {
    if (style === "fav" && !S.favs.has(t.id)) return false;
    if (style === "fitted" && !t.fitFor) return false;
    if (style === "upload" && t.source !== "upload") return false;
    if (style && !["fav", "fitted", "upload"].includes(style) && t.preset !== style) return false;
    if (length && lengthBucket(t.lengthMs) !== length) return false;
    if (needle && ![t.name, t.preset, ...(t.tags ?? []), t.prompt ?? ""].join(" ").toLowerCase().includes(needle)) return false;
    return true;
  });
};

const putOnLane = (t) => {
  useMusic(t);
  toast(`${t.name} is on the music lane.`);
  musicDialog().close();
};

const trackRow = (t) => {
  const p = presetById(t.preset);
  const playing = S.sampleUrl === t.url && !sample.paused;
  const source = t.fitFor ? `fitted to ${t.fitFor.title ?? "a video"}` : t.source === "elevenlabs" ? "ElevenLabs" : "your file";
  const meta = [p?.name, t.bpm ? `${t.bpm} bpm` : null, t.energy ? `${t.energy} energy` : null, t.lengthMs ? fmtLen(t.lengthMs) : null].filter(Boolean).join(" · ");
  return h(
    "div",
    { class: `track${t.id === S.music?.id ? " current" : ""}` },
    h("button", { class: `play${playing ? " playing" : ""}`, type: "button", title: "Hear it", onclick: () => playSample(t.url) }, playing ? "❚❚" : "▶"),
    h("div", {}, h("div", { class: "title", title: t.prompt ?? t.name }, t.name), h("div", { class: "meta" }, meta || t.prompt || "")),
    h("span", { class: "badge", title: t.license ?? "" }, source),
    h(
      "div",
      { class: "acts" },
      h("button", { class: `star${S.favs.has(t.id) ? " on" : ""}`, type: "button", title: "Favourite", onclick: () => toggleFav(t.id) }, S.favs.has(t.id) ? "★" : "☆"),
      h("button", { class: "icon", type: "button", disabled: !S.project, onclick: () => putOnLane(t) }, t.id === S.music?.id ? "In use" : "Use"),
      h("button", { class: "icon", type: "button", title: "Delete it from the library", onclick: () => removeLibraryTrack(t) }, "Remove"),
    ),
  );
};

const renderLibrary = () => {
  if (!musicDialog()?.open) return;
  $("#music-count").textContent = `${S.musicLib.length} track${S.musicLib.length === 1 ? "" : "s"} · starter ${S.starter.made} of ${S.starter.total}`;
  const options = [["", "All styles"], ["fav", "Favourites"], ["fitted", "Composed for a video"], ["upload", "Your files"], ...PRESETS.map((p) => [p.id, p.name])];
  $("#music-style").replaceChildren(...options.map(([value, label]) => h("option", { value, selected: value === S.mfilter.style }, label)));
  const building = S.jobs.some((j) => j.starterKey && isActiveJob(j));
  $("#starter-banner").replaceChildren(
    ...(S.starter.made < S.starter.total
      ? [
          h(
            "div",
            { class: "banner" },
            building ? h("span", { class: "spin" }) : null,
            h(
              "span",
              { class: "hint" },
              building
                ? `Making the starter library: ${S.starter.made} of ${S.starter.total} done.`
                : `${S.starter.made ? `${S.starter.made} of ${S.starter.total} starter tracks made.` : "No starter library yet."} It's the 12 launch-video styles at 60 s and 90 s, made with ElevenLabs Music in about three minutes.`,
            ),
            building ? null : h("button", { class: "icon", type: "button", onclick: buildStarter }, S.starter.made ? "Finish it" : "Build the starter library"),
          ),
        ]
      : []),
  );
  const list = filteredTracks();
  $("#music-list").replaceChildren(
    ...(list.length ? list.map(trackRow) : [h("p", { class: "hint" }, S.musicLib.length ? "Nothing matches." : "No music yet. Build the starter library, make a track, or drop an MP3 on the page.")]),
  );
};

const renderJobs = () => {
  const box = $("#gen-jobs");
  const jobs = S.jobs.slice(0, 12);
  box.replaceChildren(
    ...(jobs.length ? [h("span", { class: "eyebrow" }, "Recent")] : []),
    ...jobs.map((j) => {
      const t = S.musicLib.find((x) => x.id === j.trackId);
      const playing = t && S.sampleUrl === t.url && !sample.paused;
      return h(
        "div",
        { class: `job${j.state === "error" ? " error" : ""}` },
        isActiveJob(j) ? h("span", { class: "spin" }) : h("span", { class: "state" }, j.state === "done" ? "✓" : "✕"),
        h("span", { class: "name", title: j.error ?? j.name }, j.state === "error" ? `${j.name}: ${j.error}` : j.name),
        h("span", { class: "state" }, j.state === "queued" ? "queued" : j.state === "error" ? "failed" : `${j.seconds ?? 0}s`),
        j.state === "error" && j.suggestion
          ? h("button", { class: "icon", type: "button", title: j.suggestion, onclick: () => ($("#gen-prompt").value = j.suggestion) }, "Use their suggestion")
          : null,
        t ? h("button", { class: "icon", type: "button", onclick: () => playSample(t.url) }, playing ? "❚❚" : "▶") : null,
        t && S.project ? h("button", { class: "icon", type: "button", onclick: () => putOnLane(t) }, "Use") : null,
      );
    }),
  );
};

const renderGenerate = () => {
  if (!musicDialog()?.open) return;
  const D = videoLengthMs();
  const lengths = [
    ["video", D ? `This video (${fmtLen(D)})` : "This video"],
    ["30000", "30 s"],
    ["60000", "60 s"],
    ["90000", "90 s"],
  ];
  if (S.genLength === "video" && !D) S.genLength = "60000";
  $("#gen-length").replaceChildren(
    ...lengths.map(([v, label]) =>
      h(
        "button",
        {
          type: "button",
          class: S.genLength === v ? "on" : "",
          disabled: v === "video" && !D,
          onclick: () => {
            S.genLength = v;
            store.set("genLength", v);
            renderGenerate();
          },
        },
        label,
      ),
    ),
  );
  $("#style-grid").replaceChildren(
    ...PRESETS.map((p) => {
      const example = S.musicLib.find((t) => t.starterKey === `${p.id}:A`) ?? S.musicLib.find((t) => t.preset === p.id);
      const playing = example && S.sampleUrl === example.url && !sample.paused;
      return h(
        "div",
        {
          class: `style-card${S.genStyle === p.id ? " on" : ""}`,
          onclick: () => {
            S.genStyle = p.id;
            store.set("genStyle", p.id);
            renderGenerate();
          },
        },
        h("div", { class: "name" }, p.name),
        h("div", { class: "blurb" }, p.blurb),
        h("div", { class: "meta" }, `${p.bpm} bpm · ${p.energy} energy`),
        h(
          "div",
          { class: "row" },
          example
            ? h(
                "button",
                {
                  class: "icon",
                  type: "button",
                  title: "Hear an example",
                  onclick: (e) => {
                    e.stopPropagation();
                    playSample(example.url);
                  },
                },
                playing ? "❚❚ Stop" : "▶ Hear it",
              )
            : null,
          h("span", { class: "spacer" }),
          h(
            "button",
            {
              class: "icon",
              type: "button",
              title: `A stand-alone ${fmtLen(genLengthMs())} track`,
              onclick: (e) => {
                e.stopPropagation();
                makeStyleTrack(p.id);
              },
            },
            "Make a track",
          ),
        ),
      );
    }),
  );
  const preset = presetById(S.genStyle) ?? PRESETS[0];
  const btn = $("#gen-fit");
  if (!S.project || !D) {
    $("#fit-summary").textContent = "Open a video first.";
    btn.disabled = true;
  } else {
    const r = fitPlan(preset);
    const parts = r.roles.map((role, i) => `${ROLE_NAME[role]} ${fmtTime(r.bounds[i] / 1000)}`).join(" · ");
    $("#fit-summary").textContent = `${preset.name}, ${fmtLen(D)} in ${r.roles.length} part${r.roles.length === 1 ? "" : "s"}: ${parts}.${r.lines.length >= 2 ? " Each change falls in the pause between two lines, and the last part resolves on the final frame." : ""}`;
    btn.disabled = false;
    btn.textContent = `Compose ${preset.name} to fit this video`;
  }
  renderJobs();
};

const renderMusicDialog = () => {
  renderLibrary();
  renderGenerate();
};

let pollTimer = null;
const pollJobs = async () => {
  clearTimeout(pollTimer);
  try {
    S.jobs = await api("/api/music/jobs");
  } catch {
    return;
  }
  const fresh = S.jobs.filter((j) => j.state === "done" && !S.seenJobs.has(j.id));
  for (const j of S.jobs.filter((x) => x.state === "error" && !S.seenJobs.has(x.id))) {
    S.seenJobs.add(j.id);
    toast(`Music failed: ${j.error}`, "error");
  }
  const open = musicDialog().open;
  if (fresh.length || (open && S.starter.made < S.starter.total)) await loadMusicLib();
  for (const j of fresh) {
    S.seenJobs.add(j.id);
    if (!S.autoUse.delete(j.id)) continue;
    const t = S.musicLib.find((x) => x.id === j.trackId);
    if (t && t.fitFor?.projectId === S.project?.id) {
      await useMusic(t);
      toast(`${t.name} is on the music lane.`);
    }
  }
  renderJobs();
  if (S.jobs.some(isActiveJob) || (open && S.starter.made < S.starter.total)) pollTimer = setTimeout(pollJobs, 2000);
};

const queueMusic = async (spec, { autoUse = false } = {}) => {
  try {
    const job = await api("/api/music/generate", { method: "POST", json: spec });
    if (autoUse) S.autoUse.add(job.id);
    S.jobs = [job, ...S.jobs.filter((j) => j.id !== job.id)];
    renderJobs();
    pollJobs();
    return job;
  } catch (err) {
    toast(err.message, "error");
    return null;
  }
};

// The music API takes seeds up to 2^31 - 1.
const randomSeed = () => Math.floor(Math.random() * 2_147_483_647);

const makeStyleTrack = (presetId) => queueMusic({ kind: "style", preset: presetId, lengthMs: genLengthMs(), seed: randomSeed() });

const composeFit = () => {
  const preset = presetById(S.genStyle) ?? PRESETS[0];
  const { plan, lines } = fitPlan(preset);
  queueMusic(
    { kind: "fit", preset: preset.id, plan, seed: randomSeed(), projectId: S.project.id, fitFor: { projectId: S.project.id, title: S.project.title, duration: pictureEnd(), lines } },
    { autoUse: true },
  ).then((job) => job && toast(`Composing ${preset.name} for this video. It goes on the music lane when it's ready.`));
};

const makePromptTrack = () => {
  const text = $("#gen-prompt").value.trim();
  if (!text) return toast("Describe the music first.", "error");
  queueMusic({ kind: "prompt", prompt: text, lengthMs: genLengthMs() });
};

const buildStarter = async () => {
  try {
    const r = await api("/api/music/starter", { method: "POST" });
    S.starter = r.starter;
    toast(r.queued ? `Making ${r.queued} starter tracks.` : "The starter library is already complete.");
    pollJobs();
  } catch (err) {
    toast(err.message, "error");
  }
};

const toggleFav = (id) => {
  if (S.favs.has(id)) S.favs.delete(id);
  else S.favs.add(id);
  store.set("musicFavs", [...S.favs]);
  renderLibrary();
};

const removeLibraryTrack = async (t) => {
  if (!confirm(`Delete "${t.name}" from the music library?`)) return;
  try {
    await api(`/api/music/${t.id}`, { method: "DELETE" });
    if (S.music?.id === t.id) removeMusic();
    if (S.sampleUrl === t.url) {
      sample.pause();
      S.sampleUrl = null;
    }
    if (S.favs.delete(t.id)) store.set("musicFavs", [...S.favs]);
    await loadMusicLib();
  } catch (err) {
    toast(err.message, "error");
  }
};

const openMusic = (tab = S.mtab) => {
  S.mtab = tab;
  const d = musicDialog();
  if (!d.open) d.showModal();
  document.querySelectorAll("[data-mtab]").forEach((b) => b.classList.toggle("on", b.dataset.mtab === tab));
  $("#music-library").hidden = tab !== "library";
  $("#music-generate").hidden = tab !== "generate";
  renderMusicDialog();
  loadMusicLib();
  pollJobs();
};

/* Pronunciations */

const lexDialog = () => $("#lex-dialog");

const renderLexButton = () => {
  $("#lex-open").textContent = S.lexicon.length ? `Say it like (${S.lexicon.length})` : "Say it like";
};

const saveLexicon = () => {
  const next = S.lexDraft.map(cleanEntry).filter((e) => e.word);
  if (JSON.stringify(next) === JSON.stringify(S.lexicon)) return;
  S.lexicon = next;
  store.set(`lexicon.${S.project.id}`, next);
  markStale();
  renderLexButton();
  renderScript();
  renderTakes();
  renderControls();
};

// Lines of the script that would use an entry, for v2 voices by its respelling or v3 by its IPA.
const linesUsing = (e) => S.project.sections.filter((s) => render(s.text, e.respell ? "" : "eleven_v3", [e]).used.length).length;

const renderLexicon = () => {
  const rows = S.lexDraft;
  const n = rows.filter((e) => e.word.trim()).length;
  $("#lex-count").textContent = `${n} word${n === 1 ? "" : "s"} · ${S.project.title ?? S.project.id}`;
  $("#lex-rows").replaceChildren(
    ...rows.map((e, k) => {
      const field = (key, placeholder) =>
        h("input", {
          type: "text",
          value: e[key] ?? "",
          placeholder,
          spellcheck: "false",
          "aria-label": placeholder,
          oninput: (ev) => (rows[k][key] = ev.target.value),
          onchange: () => {
            saveLexicon();
            renderLexicon();
          },
        });
      const c = cleanEntry(e);
      const uses = c.word && (c.respell || c.ipa) ? linesUsing(c) : 0;
      return h(
        "div",
        { class: "lex-row" },
        field("word", "Word or name"),
        field("respell", "e.g. Graf-ih-fy"),
        field("ipa", "e.g. ˈɡræfɪfaɪ"),
        h(
          "div",
          { class: "acts" },
          h("span", { class: "hint" }, !c.word ? "" : uses ? `in ${uses} line${uses === 1 ? "" : "s"}` : "not in the script"),
          h("button", { class: "icon", type: "button", title: "Hear it with the voice chosen on the right", onclick: () => hearWord(rows[k]) }, "▶ Hear"),
          h(
            "button",
            {
              class: "icon",
              type: "button",
              onclick: () => {
                rows.splice(k, 1);
                saveLexicon();
                renderLexicon();
              },
            },
            "Remove",
          ),
        ),
      );
    }),
  );
};

const hearWord = async (entry) => {
  const e = cleanEntry(entry);
  if (!e.word) return toast("Type the word first.");
  if (!S.sel.voiceId) return toast("Pick a voice first.", "error");
  const r = render(`${e.word}.`, S.sel.modelId, [e]);
  try {
    const res = await api("/api/tts", { method: "POST", json: { voiceId: S.sel.voiceId, modelId: S.sel.modelId, speed: S.sel.speed, seed: 1842, text: r.sent, settings: DEFAULT_SETTINGS } });
    playSample(res.audio);
    toast(`${shortVoice(S.sel.voiceId)} (${shortModel(S.sel.modelId)}) was sent: ${r.sent}`);
  } catch (err) {
    toast(err.message, "error");
  }
};

const openLexicon = () => {
  if (!S.project) return;
  S.lexDraft = S.lexicon.map((e) => ({ ...e }));
  if (!S.lexDraft.length) S.lexDraft.push({ word: "", respell: "", ipa: "" });
  renderLexicon();
  lexDialog().showModal();
};

const addLexRow = () => {
  S.lexDraft.push({ word: "", respell: "", ipa: "" });
  renderLexicon();
  $("#lex-rows").lastElementChild?.querySelector("input")?.focus();
};

/* Script */

const syncOf = (sec, heardWords) => {
  const said = wordRanges(sec.align.chars);
  const diffs = [];
  for (let k = 1; k < said.length; k++) {
    const want = tokens(said[k].text).join(" ");
    if (!want) continue;
    const t = sec.align.starts[said[k].first];
    let best = null;
    for (const w of heardWords) {
      if (tokens(w.text).join(" ") !== want) continue;
      const d = Math.abs(w.start - t);
      if (d < 0.6 && (best === null || d < best)) best = d;
    }
    if (best !== null) diffs.push(best);
  }
  return diffs;
};

const checkQueue = [];
let checking = 0;
const queueCheck = (take, i) => {
  const sec = take.sections[i];
  if (!S.checkWords || !S.status?.key || sec.check || sec.status !== "ready") return;
  if (take.kind === "project" && (take.ti === null || sec.si === null)) return;
  sec.check = { state: "pending" };
  checkQueue.push({ take, i, p: S.project });
  pumpChecks();
};
const pumpChecks = () => {
  while (checking < 2 && checkQueue.length) {
    const { take, i, p } = checkQueue.shift();
    if (S.project !== p) continue;
    checking++;
    const sec = take.sections[i];
    const text = sec.align.chars.join("");
    const body = take.kind === "project" ? { project: p.id, take: take.ti, section: sec.si } : { key: sec.key };
    api("/api/check", { method: "POST", json: { ...body, keyterms: keyterms(text) } })
      .then((r) => {
        const words = wordRanges(sec.align.chars).map((w) => w.text);
        sec.check = { state: "done", heard: r.text, results: compareWords(words, r.text), sync: syncOf(sec, r.words ?? []) };
      })
      .catch((err) => {
        sec.check = { state: "error", error: err.message };
      })
      .finally(() => {
        checking--;
        if (S.project === p && S.active === take.id) renderScript();
        pumpChecks();
      });
  }
};

const verdict = (sec) => {
  const c = sec?.check;
  if (!c) return null;
  if (c.state === "pending") return h("span", { class: "verdict" }, h("span", { class: "spin" }), " checking words");
  if (c.state === "error") return h("span", { class: "verdict warn", title: c.error }, "word check failed");
  const missing = c.results.filter((r) => r.status === "missing").length;
  const unclear = c.results.filter((r) => r.status === "misread").length;
  const title = `Speech-to-text heard: "${c.heard}"`;
  if (!missing && !unclear) return h("span", { class: "verdict good", title }, "✓ every word heard");
  return h("span", { class: `verdict ${missing ? "bad" : "warn"}`, title }, [missing ? `${missing} missing` : null, unclear ? `${unclear} unclear` : null].filter(Boolean).join(" · "));
};

// A line's words with its pauses and tags between them. Words and marks with times light up as the
// voice reaches them; `results` is the word check, one entry per word.
const wordsAndMarks = (words, marks, line, results) => {
  const out = [];
  const add = (el, start, end) => {
    if (start !== null && start !== undefined) S.view.push({ start, end, el, line });
    out.push(...(out.length ? [" ", el] : [el]));
  };
  let m = 0;
  const addMark = (mk) => {
    const timed = mk.start !== null && mk.start !== undefined;
    const title = mk.note ?? (mk.kind === "pause" ? `Pause: ${mk.label}` : `Delivery tag for v3 voices: [${mk.label}]`);
    add(h("span", { class: `mark ${mk.kind}${mk.dropped ? " dropped" : ""}${timed ? "" : " idle"}`, title, onclick: timed ? () => playFrom(mk.start) : null }, mk.kind === "pause" ? `⏸ ${mk.label}` : mk.label), mk.start, mk.end);
  };
  words.forEach((w, k) => {
    while (m < marks.length && marks[m].at <= w.first) addMark(marks[m++]);
    const r = results?.[k];
    const timed = w.start !== null && w.start !== undefined;
    const el = h(
      "span",
      {
        class: timed ? `w${r && r.status !== "ok" ? ` ${r.status}` : ""}` : null,
        "data-t": timed ? w.start.toFixed(3) : null,
        title: r?.status === "missing" ? "Speech-to-text didn't hear this word" : r?.status === "misread" ? `Heard as "${r.heard ?? "?"}"` : null,
        onclick: timed ? () => playFrom(w.start + 0.25) : null,
      },
      w.text,
    );
    add(el, w.start, w.end);
  });
  while (m < marks.length) addMark(marks[m++]);
  return out;
};

// Warnings from turning the line into this take's model syntax, such as a v3 tag a v2 voice can't use.
const markupNote = (sec) => {
  const warns = sec?.said?.issues?.filter((x) => x.level === "warn") ?? [];
  if (!warns.length) return null;
  const dropped = (sec.said.marks ?? []).filter((mk) => mk.dropped).map((mk) => `[${mk.label}]`);
  const label = dropped.length === 1 ? `${dropped[0]} left out` : dropped.length > 1 ? `${dropped.length} tags left out` : "check this line";
  return h("span", { class: "verdict warn", title: warns.map((x) => x.text).join("\n") }, `⚠ ${label}`);
};

const fitText = (s, sec, pl) => {
  const span = s.orig ? speechSpan(s.orig) : null;
  const origLen = span ? span.end - span.start : null;
  const st = sec?.status === "ready" ? pl?.plan?.stats : null;
  if (!st) return origLen ? h("span", { class: "fit" }, `${origLen.toFixed(1)}s`) : null;
  const out = [st.spanOrig ? `${st.spanOrig.toFixed(1)}s → ${st.spanNew.toFixed(1)}s ` : `${st.spanNew.toFixed(1)}s `];
  if (st.overflow > 0.05) out.push(h("span", { class: "bad" }, pl.last ? `${st.overflow.toFixed(1)}s past the end` : `runs ${st.overflow.toFixed(1)}s into the next line`));
  else if (st.drift > 0.08) out.push(h("span", { class: st.drift > 0.4 ? "warn" : "" }, `${st.mode === "natural" ? "starts" : "up to"} ${st.drift.toFixed(1)}s late`));
  else out.push(h("span", { class: "good" }, "on time"));
  if (st.mode !== "natural") out.push(` · ${st.phrases} phrase${st.phrases === 1 ? "" : "s"}`);
  if (st.rateHi > 1.004 || st.rateLo < 0.996) out.push(` · ${st.rateLo.toFixed(2)}–${st.rateHi.toFixed(2)}×`);
  return h("span", { class: "fit", title: "Original speech → this take, and whether it lands on time" }, ...out);
};

const stateEl = (sec) => {
  if (!sec) return null;
  if (sec.status === "generating" || sec.status === "loading") return h("span", { class: "spin", title: "Working" });
  if (sec.status === "error") return h("span", { class: "state err", title: sec.error ?? "" }, "error");
  if (sec.status === "missing") return h("span", { class: "state", title: "Not in the cache. Press ↻ to generate it." }, "missing");
  if (sec.status === "queued") return h("span", { class: "state" }, "queued");
  if (sec.stale) return h("span", { class: "state", title: "The line or a pronunciation changed after this take. Press ↻ to update it." }, "out of date");
  return sec.cached ? h("span", { class: "state", title: "From cache, no credits used" }, "cached") : null;
};

// Editing a line: pause buttons, what this voice's model will be sent, and anything it can't do.
const lineEditor = (i, s, take) => {
  const p = S.project;
  const own = take?.kind === "generated";
  const modelId = own ? take.modelId : S.sel.modelId;
  const voiceId = own ? take.voiceId : S.sel.voiceId;
  const ta = h("textarea");
  ta.value = s.text;
  const preview = h("div", { class: "editor-preview" });
  const update = () => {
    const r = render(ta.value.replace(/\s+/g, " ").trim(), modelId, S.lexicon);
    preview.replaceChildren(
      h("div", { class: "sent" }, h("span", { class: "eyebrow" }, `${voiceId ? shortVoice(voiceId) : "This voice"} · ${shortModel(modelId)} gets`), h("code", {}, r.sent || "…")),
      ...r.issues.map((x) => h("div", { class: `issue ${x.level}` }, x.text)),
    );
  };
  const insert = (snippet) => {
    const { selectionStart: a, selectionEnd: b, value } = ta;
    const before = value.slice(0, a);
    const after = value.slice(b);
    const piece = `${before && !/\s$/.test(before) ? " " : ""}${snippet}${after && !/^\s/.test(after) ? " " : ""}`;
    ta.value = before + piece + after;
    ta.setSelectionRange(before.length + piece.length, before.length + piece.length);
    ta.focus();
    update();
  };
  ta.addEventListener("input", update);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      saveEdit(i, ta.value);
    }
  });
  update();
  setTimeout(() => ta.focus(), 0);
  return h(
    "div",
    { class: "editor" },
    ta,
    h(
      "div",
      { class: "tools" },
      h("span", { class: "eyebrow" }, "Add a pause"),
      ...PAUSE_CHOICES.map((sec) => h("button", { class: "icon", type: "button", title: `Insert a ${sec} s pause at the cursor`, onclick: () => insert(pauseTag(sec)) }, `${sec} s`)),
      h("span", { class: "hint" }, isV3(modelId) ? "CAPITALS add emphasis. v3 voices also take tags like [excited], [whispers] or [sighs]." : "CAPITALS add emphasis. Tags like [whispers] only work on v3 voices."),
    ),
    preview,
    h(
      "div",
      { class: "bar" },
      h("button", { class: "icon", type: "button", onclick: () => saveEdit(i, ta.value) }, own ? "Save and regenerate this line" : "Save"),
      h("button", { class: "icon", type: "button", onclick: () => ((S.editing = -1), renderScript()) }, "Cancel"),
      baseText(i) !== s.text ? h("button", { class: "icon", type: "button", onclick: () => saveEdit(i, baseText(i)) }, "Back to the project's text") : null,
      h("span", { class: "hint" }, `Ctrl+Enter saves.${p.kind !== "upload" ? " Edits stay in the booth until you save a take to the project." : ""}`),
    ),
  );
};

const scriptBulk = () => {
  const p = S.project;
  const ta = h("textarea", { placeholder: "Paste the voiceover script. Leave a blank line between sections; each section is generated and placed on its own." });
  ta.value = p.sections.map((s) => s.text).join("\n\n");
  return h(
    "div",
    { class: "script-all" },
    ta,
    h(
      "div",
      { class: "bar" },
      h("button", { type: "button", class: "icon", onclick: () => applyScript(ta.value) }, p.sections.length ? "Replace the whole script" : "Use this script"),
      h("span", { class: "hint" }, "Lines play one after another. ⌖ pins a line to start at the playhead."),
    ),
  );
};

// One block per line: timing, word check and actions on top, the words underneath. The words of
// the take being heard carry their video times, so the tick loop can light them up.
const renderScript = () => {
  const body = $("#script-body");
  const p = S.project;
  S.view = [];
  S.hl = -1;
  S.hlPast = -1;
  S.hlLine = -1;
  if (!p) return body.replaceChildren();
  const take = activeTake();
  const blocks = [];
  if (p.kind === "upload" && (!p.sections.length || S.editing === -2)) blocks.push(scriptBulk());
  const syncs = [];
  p.sections.forEach((s, i) => {
    const sec = take?.sections[i] ?? null;
    const pl = take?.plans[i] ?? null;
    const at = pl?.at ?? fixedAt(s);
    let words = null;
    let marks = [];
    if (take && sec?.status === "ready" && pl?.plan?.stats) {
      words = wordTimes(sec.align, pl.plan);
      const onVideo = (t) => (t === null || t === undefined ? null : mapTime(pl.plan.segments, t));
      marks = (sec.marks ?? []).map((mk) => ({ ...mk, start: onVideo(mk.start), end: onVideo(mk.end) }));
    } else if (!take && s.orig && at !== null && at !== undefined) {
      words = wordRanges(s.orig.chars).map((w, k) => ({
        ...w,
        start: at + s.orig.starts[w.first] + (k === 0 && s.orig.starts[w.first] === 0 ? 0.08 : 0),
        end: at + s.orig.ends[w.last],
      }));
    }
    const results = sec?.check?.state === "done" ? sec.check.results : null;
    if (sec?.check?.state === "done") syncs.push(...sec.check.sync);
    let para;
    if (words) para = h("p", { class: "words" }, wordsAndMarks(words, marks, i, results));
    else {
      const r = render(sec?.status === "ready" ? sec.text : s.text, take?.modelId ?? S.sel.modelId, S.lexicon);
      para = h("p", { class: "words plain" }, wordsAndMarks(wordRanges(Array.from(r.clean)), r.marks, i, null));
    }

    const editor = S.editing === i ? lineEditor(i, s, take) : null;

    blocks.push(
      h(
        "div",
        { class: "line", "data-i": String(i) },
        h(
          "div",
          { class: "line-head" },
          h("span", { class: "idx" }, String(i + 1).padStart(2, "0")),
          h("span", { class: "id" }, s.id),
          s.delivery ? h("span", {}, s.delivery) : null,
          baseText(i) !== s.text ? h("span", { class: "verdict warn", title: `Project text: "${baseText(i)}"` }, "edited") : null,
          h("span", { title: "Where this line starts in the video" }, at !== null && at !== undefined ? fmtTime(at, 2) : "–"),
          fitText(s, sec, pl),
          verdict(sec),
          take?.kind === "generated" ? markupNote(sec) : null,
          h(
            "span",
            { class: "acts" },
            stateEl(sec),
            h("button", { class: "icon", type: "button", title: "Play from here", onclick: () => playFrom(pl?.plan?.stats?.startAt ?? at ?? 0) }, "▶"),
            take?.kind === "generated"
              ? h("button", { class: "icon", type: "button", title: sec?.stale ? "Update this line to its current text and pronunciations" : "New take of this line", disabled: sec?.status === "generating", onclick: () => reroll(take, i) }, "↻")
              : null,
            h("button", { class: "icon", type: "button", title: "Edit this line", onclick: () => ((S.editing = i), renderScript()) }, "✎"),
            p.kind === "upload"
              ? h("button", { class: "icon", type: "button", title: s.pinned ? "Pinned. Click to let it follow the previous line." : "Start this line at the playhead", onclick: () => pin(i) }, s.pinned ? "⌖ pinned" : "⌖")
              : null,
          ),
        ),
        editor ?? para,
      ),
    );
  });
  if (p.kind === "upload" && p.sections.length && S.editing !== -2) {
    blocks.push(h("div", { class: "script-all" }, h("div", { class: "bar" }, h("button", { class: "icon", type: "button", onclick: () => ((S.editing = -2), renderScript()) }, "Replace the whole script"))));
  }
  const keep = body.scrollTop;
  body.replaceChildren(...blocks);
  body.scrollTop = keep;
  const hint = $("#script-hint");
  if (syncs.length >= 5) {
    const sorted = [...syncs].sort((a, b) => a - b);
    hint.textContent = `Follows the voice: word timing matches speech-to-text within ${Math.round(sorted[Math.floor(sorted.length / 2)] * 1000)} ms (median of ${sorted.length} words). Click a word to jump there.`;
  } else hint.textContent = take || p.sections.some((s) => s.orig) ? "Follows the voice. Click a word to jump there." : "Generate a take to see it follow the voice.";
};

const highlight = () => {
  const words = S.view;
  if (!words.length) return;
  const t = engine.position();
  let lo = 0;
  let hi = words.length - 1;
  let k = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start <= t) {
      k = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  // Between lines nothing is lit, but everything already said stays dark.
  const between = k >= 0 && t > words[k].end + 0.8 && (k + 1 >= words.length || words[k + 1].line !== words[k].line);
  const now = between ? -1 : k;
  const pastUpTo = k;
  if (now === S.hl && pastUpTo === S.hlPast) return;
  const prevPast = S.hlPast;
  if (pastUpTo > prevPast) for (let i = Math.max(0, prevPast + 1); i <= pastUpTo; i++) words[i].el.classList.add("past");
  else for (let i = pastUpTo + 1; i <= prevPast && i < words.length; i++) words[i].el.classList.remove("past");
  if (S.hl >= 0 && words[S.hl]) words[S.hl].el.classList.remove("now");
  if (now >= 0) words[now].el.classList.add("now");
  S.hl = now;
  S.hlPast = pastUpTo;
  const line = now >= 0 ? words[now].line : pastUpTo >= 0 ? words[pastUpTo].line : -1;
  if (line !== S.hlLine) {
    document.querySelectorAll("#script-body .line").forEach((el) => el.classList.toggle("now", Number(el.dataset.i) === line));
    S.hlLine = line;
  }
  if (now >= 0 && !S.scriptHover && !video.paused) {
    const body = $("#script-body");
    const top = words[now].el.offsetTop;
    if (top < body.scrollTop + 16 || top > body.scrollTop + body.clientHeight - 48) body.scrollTo({ top: Math.max(0, top - body.clientHeight / 3), behavior: "smooth" });
  }
};

const saveEdit = (i, raw) => {
  const p = S.project;
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  S.editing = -1;
  if (!text) {
    toast("A line can't be empty.", "error");
    return renderScript();
  }
  if (text === p.sections[i].text) return renderScript();
  p.sections[i].text = text;
  if (p.kind === "upload") saveScript();
  else {
    const edits = store.get(`edits.${p.id}`, {});
    if (text === baseText(i)) delete edits[p.sections[i].id];
    else edits[p.sections[i].id] = text;
    store.set(`edits.${p.id}`, edits);
  }
  for (const t of S.takes) if (t.kind === "generated" && t.sections[i].text !== text) t.sections[i].stale = true;
  const take = activeTake();
  if (take?.kind === "generated") {
    Object.assign(take.sections[i], { text, stale: false, check: null });
    saveTakes();
    runTake(take, { only: i });
  } else toast("Saved. Generate a take to hear the new line.");
  saveTakes();
  renderControls();
  renderScript();
};

/* Loading */

const refreshStatus = async () => {
  try {
    S.status = await api("/api/status");
  } catch (err) {
    S.status = { key: false, ffmpeg: null, error: err.message };
  }
  renderStatus();
  renderControls();
};

const loadProjects = async () => {
  S.projects = await api("/api/projects");
  renderProjects();
};

const loadVoices = async (fresh = false) => {
  try {
    S.voices = await api(`/api/voices${fresh ? "?fresh=1" : ""}`);
  } catch (err) {
    toast(`Couldn't load voices: ${err.message}`, "error");
  }
  renderVoices();
  renderControls();
  renderTakes();
  renderProjects();
};

const loadModels = async () => {
  try {
    S.models = await api("/api/models");
    if (!S.models.some((m) => m.modelId === S.sel.modelId)) S.sel.modelId = orderedModels()[0]?.modelId ?? "eleven_multilingual_v2";
  } catch (err) {
    toast(`Couldn't load models: ${err.message}`, "error");
  }
  renderControls();
  renderTakes();
};

const loadMusicLib = async () => {
  try {
    const r = await api("/api/music");
    S.musicLib = r.tracks;
    S.starter = r.starter;
  } catch {
    S.musicLib = [];
  }
  renderMix();
  renderLibrary();
  renderGenerate();
};

const loadProject = async (id) => {
  if (!id) return;
  video.pause();
  engine.setBooth(false);
  for (const name of ["voice", "bed", "music"]) engine.set(name, null);
  const p = await api(`/api/projects/${encodeURIComponent(id)}`);
  if (p.kind === "upload") p.sections = ((S.status?.hosted && p.script) || store.get(`script.${p.id}`, [])).map((s, i) => ({ settings: null, orig: null, delivery: null, seed: 1842 + i, ...s }));
  p.baseSections = p.sections.map((s) => ({ text: s.text }));
  if (p.kind !== "upload") {
    const edits = store.get(`edits.${p.id}`, {});
    for (const s of p.sections) if (edits[s.id]) s.text = edits[s.id];
  }
  Object.assign(S, { project: p, takes: [], active: "original", bed: null, music: null, musicTrack: null, exportResult: null, handoffResult: null, pickResult: null, targetLufs: -18, duration: p.video.duration ?? 0, editing: -1 });
  S.lexicon = store
    .get(`lexicon.${p.id}`, [])
    .map(cleanEntry)
    .filter((e) => e.word);
  renderLexButton();
  S.stretch.clear();
  S.mix.bedSource = p.bed ? "stem" : "none";
  store.set("project", p.id);
  if (!S.sel.voiceId && p.original?.speed) S.sel.speed = p.original.speed;
  $("#player").classList.add("has-video");
  $("#stage").classList.toggle("portrait", Boolean(p.video.width && p.video.height && p.video.height > p.video.width));
  video.src = p.video.url;
  renderAll();
  measureTarget();
  loadBed();
  addProjectTakes();
  restoreTakes();
  const music = store.get(`music.${p.id}`, null);
  if (music?.url) loadMusic(music);
};

const measureTarget = async () => {
  const p = S.project;
  const urls = p.sections.map((s) => s.orig?.url).filter(Boolean);
  if (!urls.length) return;
  try {
    const buffers = await Promise.all(urls.map(decodeUrl));
    if (S.project !== p) return;
    const l = loudness(concat(buffers.map(mono)), SR);
    if (Number.isFinite(l)) S.targetLufs = l + 20 * Math.log10(p.voiceGain || 1);
    for (const t of S.takes) normalize(t);
    applyGains();
    renderTakes();
  } catch (err) {
    console.warn("Couldn't measure the original voice", err);
  }
};

const loadBed = async () => {
  const p = S.project;
  S.bed = null;
  engine.set("bed", null);
  const url = S.mix.bedSource === "stem" ? p.bed?.url : S.mix.bedSource === "video" ? `/media/${p.id}/video-audio` : null;
  renderMix();
  if (!url) return;
  try {
    const buffer = await decodeUrl(url);
    if (S.project !== p) return;
    S.bed = buffer;
    engine.set("bed", buffer);
  } catch (err) {
    toast(`Couldn't load the bed: ${err.message}`, "error");
    S.mix.bedSource = "none";
  }
  renderMix();
};

// The timing everything downstream uses is on the line's own words: pauses, tags and respellings
// that went to ElevenLabs are taken out, and kept as marks for the script card.
const readySection = (take, sec, buffer, extra) => {
  const pcm = mono(buffer);
  const raw = { chars: extra.chars, starts: extra.starts, ends: extra.ends };
  const timed = sec.said ? cleanTiming(sec.said, raw) : null;
  Object.assign(sec, {
    status: "ready",
    pcm,
    align: { chars: (timed ?? raw).chars, starts: (timed ?? raw).starts, ends: (timed ?? raw).ends, length: buffer.duration, env: envelope(pcm) },
    marks: timed?.marks ?? [],
    ...extra.fields,
  });
};

// Takes that already exist in the video project (other voices of the same script) cost nothing.
const addProjectTakes = () => {
  const p = S.project;
  p.takes.forEach((pt, ti) => {
    const take = newTake({ kind: "project", voiceId: pt.voiceId, modelId: pt.modelId, speed: pt.speed, track: pt.track, ti });
    S.takes.push(take);
    for (const ps of pt.sections) {
      const i = p.sections.findIndex((s) => s.id === ps.id);
      if (i < 0) continue;
      const sec = take.sections[i];
      Object.assign(sec, { status: "loading", si: ps.index, text: ps.chars.join("") });
      decodeUrl(ps.url)
        .then((buffer) => readySection(take, sec, buffer, { chars: ps.chars, starts: ps.starts, ends: ps.ends, fields: { key: `${pt.track}:${ps.id}` } }))
        .catch((err) => Object.assign(sec, { status: "error", error: err.message }))
        .finally(() => {
          if (S.project !== p) return;
          refreshTake(take);
          queueCheck(take, i);
        });
    }
    for (const sec of take.sections) if (sec.status === "queued") Object.assign(sec, { status: "error", error: "This take has no such line" });
  });
  renderTakes();
};

const saveTakes = () => {
  if (!S.project) return;
  store.set(
    `takes.${S.project.id}`,
    S.takes
      .filter((t) => t.kind === "generated")
      .map((t) => ({ voiceId: t.voiceId, modelId: t.modelId, speed: t.speed, settings: t.settings, sections: t.sections.map((s) => ({ seed: s.seed, text: s.text, ...(s.lex?.length ? { lex: s.lex } : {}) })) })),
  );
};

// Takes made in earlier sessions come back from the server cache only, so a reload never spends credits.
const restoreTakes = () => {
  const p = S.project;
  const oldKey = hash(p.baseSections.map((s) => s.text).join("\u241e"));
  for (const meta of store.get(`takes.${p.id}`, [])) {
    let sections = meta.sections;
    if (!sections && meta.seeds && meta.script === oldKey) sections = meta.seeds.map((seed, i) => ({ seed, text: p.baseSections[i].text }));
    if (!Array.isArray(sections) || sections.length !== p.sections.length) continue;
    const take = newTake({ kind: "generated", ...meta, sections });
    take.sections.forEach((sec, i) => (sec.stale = isStale(take, i)));
    S.takes.push(take);
    runTake(take, { cacheOnly: true });
  }
  saveTakes();
  renderTakes();
};

const runTake = async (take, { only = null, cacheOnly = false } = {}) => {
  const p = S.project;
  const tasks = p.sections.map((s, i) => async () => {
    if (only !== null && i !== only) return;
    if (S.project !== p || !S.takes.includes(take)) return;
    const sec = take.sections[i];
    // A take restored from cache keeps the pronunciations it was made with.
    const said = render(sec.text, take.modelId, cacheOnly ? sec.lex : S.lexicon);
    Object.assign(sec, { status: "generating", error: null, check: null, said, lex: said.used });
    renderScript();
    renderTakes();
    try {
      const res = await api("/api/tts", {
        method: "POST",
        json: {
          voiceId: take.voiceId,
          modelId: take.modelId,
          speed: take.speed,
          seed: sec.seed,
          text: said.sent,
          settings: take.settings ?? s.settings ?? DEFAULT_SETTINGS,
          previousText: p.sections[i - 1] ? plainText(p.sections[i - 1].text) : null,
          nextText: p.sections[i + 1] ? plainText(p.sections[i + 1].text) : null,
          cacheOnly,
        },
      });
      const buffer = await decodeUrl(res.audio);
      readySection(take, sec, buffer, { chars: res.chars, starts: res.starts, ends: res.ends, fields: { key: res.key, cached: res.cached } });
    } catch (err) {
      Object.assign(sec, { status: cacheOnly ? "missing" : "error", error: err.message });
      if (!cacheOnly) toast(`${s.id}: ${err.message}`, "error");
    }
    if (S.project !== p) return;
    refreshTake(take);
    queueCheck(take, i);
  });
  await runLimited(tasks, 3);
  if (!cacheOnly && S.status?.key) refreshStatus();
};

/* Actions */

const generate = () => {
  const p = S.project;
  if (!p?.sections.length) return toast("Add the script first.", "error");
  if (!S.sel.voiceId) return toast("Pick a voice first.", "error");
  engine.ctx.resume();
  const custom = { stability: S.sel.stability, similarity_boost: S.sel.similarity, style: S.sel.style };
  const take = newTake({ kind: "generated", voiceId: S.sel.voiceId, modelId: S.sel.modelId, speed: S.sel.speed, settings: S.sel.presets && hasPresets() ? null : custom });
  const dupe = S.takes.find((t) => t.kind === "generated" && sameTake(t, take));
  if (dupe) {
    setActive(dupe.id);
    return toast("You already have that take. Switched to it.");
  }
  take.autoplay = true;
  S.takes.push(take);
  saveTakes();
  setActive(take.id);
  runTake(take);
};

const reroll = (take, i) => {
  const sec = take.sections[i];
  if (sec.stale) Object.assign(sec, { text: S.project.sections[i].text, stale: false });
  else sec.seed = Math.floor(Math.random() * 4_000_000_000);
  saveTakes();
  runTake(take, { only: i });
};

const removeTake = (take) => {
  S.takes = S.takes.filter((t) => t !== take);
  if (S.active === take.id) setActive("original");
  saveTakes();
  renderTakes();
};

const selectVoice = (id) => {
  S.sel.voiceId = id;
  const v = S.voices.find((x) => x.voiceId === id);
  if (v?.hqModels?.length && !v.hqModels.includes(S.sel.modelId)) {
    const better = MODEL_ORDER.find((m) => v.hqModels.includes(m) && S.models.some((x) => x.modelId === m));
    if (better) {
      S.sel.modelId = better;
      toast(`${shortVoice(id)} is tuned for ${shortModel(better)}, so the model switched to it.`);
    }
  }
  saveSel();
  renderVoices();
  renderControls();
};

const playSample = (url) => {
  if (!url) return toast("This voice has no sample.");
  if (S.sampleUrl === url && !sample.paused) {
    sample.pause();
    S.sampleUrl = null;
  } else {
    sample.src = url;
    S.sampleUrl = url;
    sample.play().catch(() => {});
  }
  renderVoices();
  renderMusicDialog();
};

const searchLibrary = async (q, page = 0) => {
  S.library.loading = true;
  renderVoices();
  try {
    const r = await api(`/api/library?q=${encodeURIComponent(q)}&page=${page}`);
    Object.assign(S.library, { items: page ? [...S.library.items, ...r.voices] : r.voices, q, page, more: r.hasMore });
  } catch (err) {
    toast(err.message, "error");
  }
  S.library.loading = false;
  renderVoices();
};

const addFromLibrary = async (v) => {
  try {
    const { voiceId } = await api("/api/library/add", { method: "POST", json: { ownerId: v.ownerId, voiceId: v.voiceId, name: v.name } });
    v.added = true;
    await loadVoices(true);
    selectVoice(voiceId);
    toast(`${v.name} is now in your voices.`);
  } catch (err) {
    toast(err.message, "error");
  }
  renderVoices();
};

const exportMix = async () => {
  const take = activeTake();
  const p = S.project;
  if (!take || S.exporting) return;
  if (take.sections.some((s) => s.status !== "ready")) return toast("Export unlocks when every line is ready.", "error");
  S.exporting = true;
  renderExport();
  await new Promise(requestAnimationFrame);
  try {
    if (take.dirty || !take.data) buildVoice(take);
    if (S.music?.buffer && !S.musicTrack) renderMusic();
    const n = take.data.length;
    const vg = dbToGain(take.gainDb + S.mix.voiceDb);
    const bg = dbToGain(S.mix.bedDb);
    const mg = dbToGain(musicDb());
    const bl = S.bed?.getChannelData(0) ?? null;
    const br = S.bed ? S.bed.getChannelData(S.bed.numberOfChannels > 1 ? 1 : 0) : null;
    const ml = S.musicTrack?.getChannelData(0) ?? null;
    const mr = S.musicTrack?.getChannelData(1) ?? null;
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const v = take.data[i] * vg;
      L[i] = v + (bl && i < bl.length ? bl[i] * bg : 0) + (ml && i < ml.length ? ml[i] * mg : 0);
      R[i] = v + (br && i < br.length ? br[i] * bg : 0) + (mr && i < mr.length ? mr[i] * mg : 0);
    }
    limit([L, R], SR, -1);
    const wav = encodeWav([L, R], SR);
    const label = `${shortVoice(take.voiceId)}-${shortModel(take.modelId)}-${take.speed.toFixed(2)}-${S.sel.mode}${S.music?.buffer ? "-music" : ""}`;
    if (S.status?.hosted) {
      const signed = await api("/api/export/sign", { method: "POST" });
      await putFile(signed.url, new Blob([wav], { type: "audio/wav" }), "Uploading the mix");
      S.exportResult = await api("/api/export", { method: "POST", json: { project: p.id, label, mixKey: signed.key } });
    } else {
      S.exportResult = await api(`/api/export?project=${encodeURIComponent(p.id)}&label=${encodeURIComponent(label)}`, {
        method: "POST",
        body: wav,
        headers: { "Content-Type": "audio/wav" },
      });
    }
    toast(`Saved ${S.exportResult.file}`);
  } catch (err) {
    toast(`Export failed: ${err.message}`, "error");
  }
  S.exporting = false;
  renderExport();
};

// The project gets timing on the line's own words, not on the pauses or respellings sent.
const takeLines = (take) =>
  take.sections.map((s, i) => ({
    id: S.project.sections[i].id,
    key: s.key,
    clean: s.marks?.length || s.lex?.length ? { chars: s.align.chars, starts: s.align.starts, ends: s.align.ends } : undefined,
  }));

const sendPick = async (track, note) => {
  const take = activeTake();
  try {
    S.pickResult = await api("/api/picks", { method: "POST", json: { project: S.project.id, track, note, voiceId: take.voiceId, modelId: take.modelId, speed: take.speed, sections: takeLines(take) } });
    toast(`Sent "${S.pickResult.track}" to the project.`);
  } catch (err) {
    S.pickResult = { error: err.message };
  }
  renderExport();
};

const saveTakeToProject = async (track) => {
  const take = activeTake();
  const p = S.project;
  try {
    S.handoffResult = await api("/api/handoff", {
      method: "POST",
      json: {
        project: p.id,
        track,
        voiceId: take.voiceId,
        modelId: take.modelId,
        speed: take.speed,
        sections: takeLines(take),
      },
    });
    toast(`Saved as the "${track}" track in ${p.handoff.cwd}.`);
    loadProjects();
  } catch (err) {
    S.handoffResult = { error: err.message };
  }
  renderExport();
};

const buildBed = async () => {
  const p = S.project;
  try {
    await api(`/api/projects/${encodeURIComponent(p.id)}/bed`, { method: "POST" });
  } catch (err) {
    return toast(err.message, "error");
  }
  const poll = async () => {
    const fresh = await api(`/api/projects/${encodeURIComponent(p.id)}`).catch(() => null);
    if (!fresh || S.project?.id !== p.id) return;
    S.project.bedJob = fresh.bedJob;
    if (fresh.bedJob?.state === "running") {
      renderMix();
      setTimeout(poll, 1200);
      return;
    }
    S.project.bed = fresh.bed;
    if (fresh.bedJob?.state === "error") toast(`The music bed failed: ${fresh.bedJob.error}`, "error");
    else {
      S.mix.bedSource = "stem";
      await loadBed();
      toast("Music bed ready.");
    }
    renderMix();
  };
  poll();
};

// On the hosted booth big files go from the browser straight to storage through a signed link,
// because Vercel refuses request bodies over 4.5 MB.
const putFile = (url, file, label) =>
  new Promise((resolve, reject) => {
    const note = h("div", { class: "toast" }, `${label}…`);
    $("#toasts").append(note);
    const done = () => {
      note.classList.add("out");
      setTimeout(() => note.remove(), 500);
    };
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    if (file.type) xhr.setRequestHeader("Content-Type", file.type);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) note.textContent = `${label}… ${Math.round((e.loaded / e.total) * 100)}%`;
    };
    xhr.onload = () => {
      done();
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`storage refused the upload (${xhr.status})`));
    };
    xhr.onerror = () => {
      done();
      reject(new Error("the upload was cut off"));
    };
    xhr.send(file);
  });

const sha1Hex = async (file) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-1", await file.arrayBuffer())), (b) => b.toString(16).padStart(2, "0")).join("");

const uploadVideo = async (file) => {
  if (!file) return;
  try {
    let id;
    if (S.status?.hosted) {
      const signed = await api("/api/upload/sign", { method: "POST", json: { name: file.name, size: file.size } });
      await putFile(signed.url, file, `Uploading ${file.name}`);
      ({ id } = await api("/api/upload/finish", { method: "POST", json: { id: signed.id, key: signed.key, name: file.name } }));
    } else {
      toast(`Opening ${file.name}…`);
      ({ id } = await api(`/api/upload?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file }));
    }
    await loadProjects();
    $("#project").value = id;
    await loadProject(id);
  } catch (err) {
    toast(`Couldn't open it: ${err.message}`, "error");
  }
};

const uploadMusic = async (file) => {
  if (!file) return;
  if (!S.project) return toast("Open a video first, then add music.", "error");
  try {
    let meta;
    if (S.status?.hosted) {
      const signed = await api("/api/music/sign", { method: "POST", json: { name: file.name, sha1: await sha1Hex(file) } });
      meta = signed.track;
      if (!meta) {
        await putFile(signed.url, file, `Adding ${file.name}`);
        meta = await api("/api/music/finish", { method: "POST", json: { id: signed.id, ext: signed.ext, name: file.name } });
      }
    } else {
      toast(`Adding ${file.name}…`);
      meta = await api(`/api/music?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
    }
    await loadMusicLib();
    await useMusic(meta);
    toast(`${meta.name} is on the music lane. Drag it to move it, pull its edges to trim.`);
  } catch (err) {
    toast(`Couldn't add it: ${err.message}`, "error");
  }
};

// The hosted booth also keeps an uploaded video's script with the video, so it follows you.
let scriptTimer = null;
const saveScript = () => {
  const p = S.project;
  const sections = p.sections.map(({ id, text, at, pinned, seed }) => ({ id, text, at, pinned, seed }));
  store.set(`script.${p.id}`, sections);
  if (!S.status?.hosted) return;
  clearTimeout(scriptTimer);
  scriptTimer = setTimeout(() => api(`/api/projects/${encodeURIComponent(p.id)}/script`, { method: "PUT", json: { sections } }).catch((err) => toast(`Couldn't save the script: ${err.message}`, "error")), 800);
};

const applyScript = (text) => {
  const p = S.project;
  const parts = text
    .split(/\n\s*\n/)
    .map((t) => t.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  S.editing = -1;
  if (parts.length === p.sections.length && parts.every((t, i) => t === p.sections[i].text)) return renderScript();
  if (S.takes.some((t) => t.kind === "generated") && !confirm("Replacing the script clears this video's takes. Continue?")) return renderScript();
  p.sections = parts.map((t, i) => ({
    id: `line-${i + 1}`,
    text: t,
    at: p.sections[i]?.pinned ? p.sections[i].at : null,
    pinned: Boolean(p.sections[i]?.pinned),
    seed: 1842 + i,
    settings: null,
    orig: null,
    delivery: null,
  }));
  p.baseSections = p.sections.map((s) => ({ text: s.text }));
  saveScript();
  S.takes = [];
  setActive("original");
  saveTakes();
  renderAll();
};

const pin = (i) => {
  const s = S.project.sections[i];
  if (s.pinned) Object.assign(s, { pinned: false, at: null });
  else Object.assign(s, { pinned: true, at: Number(video.currentTime.toFixed(3)) });
  saveScript();
  replanAll();
};

/* Rendering */

const renderStatus = () => {
  const s = S.status;
  const el = $("#status");
  el.replaceChildren();
  if (!s) return;
  const bits = [];
  if (!s.key) bits.push(h("span", { class: "bad" }, "No ElevenLabs key"));
  else if (s.subscription && !s.subscription.error) bits.push(`${Math.max(0, s.subscription.limit - s.subscription.used).toLocaleString()} credits left`);
  else bits.push(`Key from ${s.keySource}`);
  if (!s.ffmpeg) bits.push(h("span", { class: "bad" }, "No ffmpeg, so export is off"));
  if (s.hosted) bits.push(h("button", { class: "linkish", type: "button", onclick: signOut }, "Sign out"));
  bits.forEach((b, i) => el.append(...(i ? [" · ", b] : [b])));
  el.title = s.key ? `ElevenLabs key from ${s.keySource}\nffmpeg: ${s.ffmpeg ?? "missing"}` : keyHint();
};

const keyHint = () =>
  S.status?.hosted ? "Add ELEVENLABS_API_KEY to the Vercel project's environment variables and redeploy." : "Put ELEVENLABS_API_KEY in voice-booth/.env and restart.";

const renderProjects = () => {
  const sel = $("#project");
  const groups = new Map();
  for (const p of S.projects) {
    if (!groups.has(p.group)) groups.set(p.group, []);
    groups.get(p.group).push(p);
  }
  sel.replaceChildren(
    ...(S.projects.length ? [] : [h("option", { value: "" }, "No videos yet")]),
    ...[...groups].map(([g, list]) =>
      h(
        "optgroup",
        { label: g },
        list.map((p) => h("option", { value: p.id, selected: p.id === S.project?.id }, p.voiceId && S.voices.length ? `${p.title} · ${shortVoice(p.voiceId)}` : p.title)),
      ),
    ),
  );
};

const voiceRow = (v, { selected, onSelect, action }) =>
  h(
    "div",
    { class: `voice${selected ? " on" : ""}`, onclick: onSelect, title: v.description ?? "" },
    h(
      "button",
      {
        class: `play${S.sampleUrl && S.sampleUrl === v.previewUrl ? " playing" : ""}`,
        type: "button",
        title: "Hear the sample",
        onclick: (e) => {
          e.stopPropagation();
          playSample(v.previewUrl);
        },
      },
      S.sampleUrl && S.sampleUrl === v.previewUrl ? "❚❚" : "▶",
    ),
    h("div", {}, h("div", { class: "name" }, v.name), h("div", { class: "meta" }, [v.gender, v.age, v.accent, v.useCase].filter(Boolean).join(" · ").replaceAll("_", " "))),
    action ?? h("span", { class: "cat" }, CATEGORY[v.category] ?? v.category ?? ""),
  );

const renderVoices = () => {
  const box = $("#voices");
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === S.tab));
  $("#voice-search").placeholder = S.tab === "mine" ? "Filter your voices" : "Search the Voice Library, then press Enter";
  if (!S.status?.key) return box.replaceChildren(h("p", { class: "none" }, `${keyHint()} Then your voices load here.`));
  if (S.tab === "mine") {
    const q = S.query.trim().toLowerCase();
    const list = S.voices.filter((v) => !q || [v.name, v.gender, v.age, v.accent, v.description, v.useCase, v.category].join(" ").toLowerCase().includes(q));
    box.replaceChildren(
      ...(list.length ? list.map((v) => voiceRow(v, { selected: v.voiceId === S.sel.voiceId, onSelect: () => selectVoice(v.voiceId) })) : [h("p", { class: "none" }, S.voices.length ? "No match." : "Loading voices…")]),
    );
    return;
  }
  const lib = S.library;
  if (lib.q === null && !lib.loading) {
    box.replaceChildren(h("p", { class: "none" }, "Search thousands of community voices. Samples are free; adding a voice uses a voice slot."));
    return;
  }
  const rows = lib.items.map((v) => {
    const mine = S.voices.some((x) => x.voiceId === v.voiceId);
    return voiceRow(v, {
      selected: v.voiceId === S.sel.voiceId,
      onSelect: () => (mine ? selectVoice(v.voiceId) : null),
      action: mine
        ? h("span", { class: "cat" }, "added")
        : h(
            "button",
            {
              class: "icon",
              type: "button",
              onclick: (e) => {
                e.stopPropagation();
                addFromLibrary(v);
              },
            },
            "Add",
          ),
    });
  });
  if (lib.loading) rows.push(h("p", { class: "none" }, h("span", { class: "spin" }), " Searching…"));
  else if (!lib.items.length) rows.push(h("p", { class: "none" }, "Nothing found."));
  else if (lib.more) rows.push(h("button", { class: "more", type: "button", onclick: () => searchLibrary(lib.q, lib.page + 1) }, "More"));
  box.replaceChildren(...rows);
};

const renderControls = () => {
  const v = S.voices.find((x) => x.voiceId === S.sel.voiceId);
  $("#chosen-voice").textContent = v ? v.name : S.sel.voiceId ? shortVoice(S.sel.voiceId) : "Pick a voice";
  $("#model").replaceChildren(...orderedModels().map((m) => h("option", { value: m.modelId, selected: m.modelId === S.sel.modelId }, m.name)));
  const hint = $("#model-hint");
  if (v?.hqModels?.length && !v.hqModels.includes(S.sel.modelId)) {
    hint.className = "hint warn";
    hint.textContent = `${shortVoice(v.voiceId)} isn't tuned for this model. Tuned for ${v.hqModels.map(shortModel).join(", ")}.`;
  } else {
    hint.className = "hint";
    hint.textContent = S.sel.modelId?.includes("flash") ? "Fastest and cheapest. Good for auditions; render the winner on v3 or Multilingual v2." : "";
  }
  $("#speed").value = S.sel.speed;
  $("#speed-out").textContent = `${Number(S.sel.speed).toFixed(2)}×`;
  renderSpeedHint();
  $("#mode").value = S.sel.mode;
  $("#mode-hint").textContent = MODE_HINT[S.sel.mode] ?? "";
  const presets = hasPresets();
  $("#presets").checked = S.sel.presets;
  $("#presets").closest(".check").hidden = !presets;
  const useCustom = !(S.sel.presets && presets);
  for (const k of ["stability", "similarity", "style"]) {
    const el = $(`#${k}`);
    el.value = S.sel[k];
    el.disabled = !useCustom;
    el.closest(".field").classList.toggle("off", !useCustom);
    $(`output[data-for="${k}"]`).textContent = Number(S.sel[k]).toFixed(2);
  }
  $(".advanced summary").textContent = `Delivery · ${useCustom ? "custom" : "project presets"}`;

  const p = S.project;
  const said = p ? p.sections.map((s) => render(s.text, S.sel.modelId, S.lexicon)) : [];
  const chars = said.reduce((n, r) => n + r.sent.length, 0);
  const m = S.models.find((x) => x.modelId === S.sel.modelId);
  const warns = said.flatMap((r, i) => r.issues.filter((x) => x.level === "warn").map((x) => ({ line: i + 1, text: x.text })));
  const mh = $("#markup-hint");
  mh.hidden = !warns.length;
  mh.replaceChildren(
    ...(warns.length ? [h("strong", {}, `Before you generate with ${S.sel.voiceId ? shortVoice(S.sel.voiceId) : "this voice"} (${shortModel(S.sel.modelId)}):`)] : []),
    ...warns.slice(0, 3).map((w) => h("div", {}, `Line ${w.line}: ${w.text}`)),
    ...(warns.length > 3 ? [h("div", {}, `And ${warns.length - 3} more.`)] : []),
  );
  $("#generate").disabled = !p?.sections.length || !S.sel.voiceId || !S.status?.key;
  $("#gen-note").textContent = !S.status?.key
    ? keyHint()
    : p?.sections.length
      ? `${p.sections.length} lines · ${chars.toLocaleString()} characters · about ${Math.round(chars * (m?.costFactor ?? 1)).toLocaleString()} credits. A take you've made before loads from cache for free.`
      : p
        ? "Add the script first."
        : "";
};

const renderSpeedHint = () => {
  const el = $("#speed-hint");
  const s = Number(S.sel.speed);
  el.className = s < 0.9 || s > 1.1 ? "hint warn" : "hint";
  el.textContent = s < 0.9 || s > 1.1 ? "ElevenLabs warns that extreme speeds can hurt quality: rushed words, lost pauses. Staying within 0.9–1.1× is safest." : "";
};

const renderTakes = () => {
  const items = [
    h(
      "button",
      { class: `chip plain${S.active === "original" ? " on" : ""}`, type: "button", onclick: () => setActive("original"), title: "The video's own soundtrack (key 0)" },
      h("span", { class: "n" }, "0"),
      "Original video",
    ),
  ];
  S.takes.forEach((t, k) => {
    const ready = t.sections.filter((s) => s.status === "ready").length;
    const busy = t.sections.some((s) => s.status === "generating" || s.status === "loading");
    const inVideo = t.kind === "project" && t.track === S.project?.original?.track;
    const title = [
      `${shortVoice(t.voiceId)} · ${shortModel(t.modelId)} · speed ${t.speed}`,
      t.kind === "project" ? `Track "${t.track}" in the video project` : null,
      Number.isFinite(t.lufs) ? `Leveled ${fmtDb(t.gainDb)} to match the original voice` : null,
      k < 9 ? `Key ${k + 1}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    items.push(
      h(
        "span",
        {
          class: `chip${S.active === t.id ? " on" : ""}`,
          role: "button",
          tabindex: "0",
          title,
          onclick: () => setActive(t.id),
          onkeydown: (e) => (e.key === "Enter" ? setActive(t.id) : null),
        },
        k < 9 ? h("span", { class: "n" }, String(k + 1)) : null,
        takeLabel(t),
        t.kind === "project" ? h("span", { class: "tag" }, inVideo ? "in video" : "in project") : null,
        ready < t.sections.length ? h("span", { class: "progress" }, busy ? h("span", { class: "spin" }) : null, ` ${ready}/${t.sections.length}`) : null,
        t.kind === "generated"
          ? h(
              "button",
              {
                class: "x",
                type: "button",
                title: "Remove this take",
                onclick: (e) => {
                  e.stopPropagation();
                  removeTake(t);
                },
              },
              "×",
            )
          : h("span", { class: "n" }, ""),
      ),
    );
  });
  $("#takes").replaceChildren(...items);
  renderPace();
};

// A voice that reads much faster or slower than the original is better fixed with ElevenLabs'
// own speed setting than with time-stretching.
const renderPace = () => {
  const el = $("#pace");
  el.replaceChildren();
  const take = activeTake();
  if (!take || take.sections.some((s) => s.status !== "ready")) return;
  let spoken = 0;
  let orig = 0;
  for (const pl of take.plans) {
    const st = pl.plan?.stats;
    if (st?.spanOrig) {
      spoken += st.spanNew;
      orig += st.spanOrig;
    }
  }
  if (!orig) return;
  const ratio = spoken / orig;
  const who = shortVoice(take.voiceId);
  if (Math.abs(ratio - 1) < 0.04) return el.append(`${who} reads at about the original pace.`);
  el.append(`${who} reads ${Math.round(Math.abs(ratio - 1) * 100)}% ${ratio > 1 ? "slower" : "faster"} than the original.`);
  const speed = clamp(Math.round(take.speed * ratio * 100) / 100, 0.7, 1.2);
  if (take.kind === "generated" && speed !== take.speed) {
    el.append(
      h(
        "button",
        {
          class: "icon",
          type: "button",
          onclick: () => {
            Object.assign(S.sel, { voiceId: take.voiceId, modelId: take.modelId, speed });
            saveSel();
            renderControls();
            generate();
          },
        },
        `Try speed ${speed.toFixed(2)}×`,
      ),
    );
  }
};

const renderWarnings = () => {
  const p = S.project;
  $("#warnings").replaceChildren(...(p?.warnings ?? []).map((w) => h("div", { class: "warning" }, w)));
};

const renderTimeline = () => {
  const lanes = $("#lanes");
  const p = S.project;
  const D = endTime();
  if (!p || !D) return lanes.replaceChildren();
  const pct = (t) => `${clamp((t / D) * 100, 0, 100)}%`;
  const take = activeTake();
  const spans = [];
  p.sections.forEach((s, i) => {
    const at = fixedAt(s);
    if (s.orig && at !== null && at !== undefined) {
      const sp = speechSpan(s.orig);
      if (sp) spans.push(h("div", { class: "span orig", style: `left:${pct(at + sp.start)};width:${pct(sp.end - sp.start)}`, title: `${s.id}, original` }));
    }
    const pl = take?.plans[i];
    const st = take?.sections[i]?.status === "ready" ? pl?.plan?.stats : null;
    if (st) {
      const cls = st.overflow > 0.05 ? " bad" : st.drift > 0.4 || st.rateHi > 1.06 ? " warn" : "";
      spans.push(h("div", { class: `span new${cls}`, style: `left:${pct(st.startAt)};width:${pct(Math.max(0.05, st.endAt - st.startAt))}`, title: `${s.id}, ${takeLabel(take)}` }));
    } else if (take && pl) {
      spans.push(h("div", { class: "span new pending", style: `left:${pct(pl.at)};width:${pct(Math.max(0.5, s.text.length / 15))}` }));
    }
  });
  lanes.replaceChildren(...spans);
  renderMusicLane();
};

const renderMix = () => {
  const p = S.project;
  $("#voice-db").value = S.mix.voiceDb;
  $("#voice-db-out").textContent = fmtDb(S.mix.voiceDb);
  $("#bed-db").value = S.mix.bedDb;
  $("#bed-db-out").textContent = fmtDb(S.mix.bedDb);
  const options = [];
  if (p?.bed) options.push(["stem", "Music bed from the project"]);
  if (p) options.push(["video", "The video's own audio"]);
  options.push(["none", "Nothing"]);
  $("#bed-source").replaceChildren(...options.map(([value, label]) => h("option", { value, selected: value === S.mix.bedSource }, label)));
  const st = $("#bed-status");
  st.className = "hint";
  st.replaceChildren();
  if (p?.bedJob?.state === "running") {
    const last = [...(p.bedJob.log ?? [])].reverse().find((l) => /Rendered \d+\/\d+/.test(l));
    const m = last?.match(/Rendered (\d+)\/(\d+)/);
    st.append(h("span", { class: "spin" }), ` Rendering the music bed${m ? ` ${Math.round((m[1] / m[2]) * 100)}%` : "…"}`);
  } else if (p) {
    if (S.mix.bedSource === "stem" && p.bed?.stale) {
      st.className = "hint warn";
      st.append("The video was re-rendered after this music bed was made. ");
    }
    if (S.mix.bedSource === "video") st.append(p.original ? "Careful: the video's audio still has the old voice in it. " : "The video's own sound plays under the new voice. ");
    if (p.canBuildBed && (!p.bed || p.bed.stale)) st.append(h("button", { class: "icon", type: "button", onclick: buildBed }, p.bed ? "Rebuild music bed" : "Build the music bed (about a minute)"));
  }

  const m = S.music;
  const ready = Boolean(m?.buffer);
  $(".music-box").classList.toggle("off", !ready);
  const info = $("#music-info");
  info.replaceChildren();
  if (!m) info.append(`Browse ${S.musicLib.length ? `${S.musicLib.length} tracks` : "the library"}, compose music that fits this video, or drop an MP3 anywhere. It plays with the takes, not with the original video.`);
  else if (!ready) info.append(h("span", { class: "spin" }), ` Loading ${m.name}…`);
  else {
    info.append(
      h("strong", {}, m.name),
      ` · uses ${fmtTime(m.in)}–${fmtTime(m.out)} of ${fmtTime(m.dur)} · starts at ${fmtTime(m.offset)} `,
      h("button", { class: "icon", type: "button", onclick: () => playFrom(m.offset + 0.3) }, "▶"),
      " ",
      h("button", { class: "icon", type: "button", onclick: removeMusic }, "Remove"),
    );
  }
  $("#music-db").value = m?.gainDb ?? 0;
  $("#music-db-out").textContent = fmtDb(m?.gainDb ?? 0);
  $("#music-fi").value = m?.fadeIn ?? 1;
  $("#music-fi-out").textContent = `${(m?.fadeIn ?? 1).toFixed(1)}s`;
  $("#music-fo").value = m?.fadeOut ?? 2;
  $("#music-fo-out").textContent = `${(m?.fadeOut ?? 2).toFixed(1)}s`;
  $("#music-duck").value = String(m?.duck ?? 8);
};

// On the hosted booth a picked take goes back to the video project through `npm run picks`.
const renderPick = (box, p, take) => {
  if (!p?.canPick || take?.kind !== "generated") {
    box.hidden = true;
    return box.replaceChildren();
  }
  box.hidden = false;
  const complete = take.sections.every((s) => s.status === "ready" && !s.stale);
  const track = h("input", { type: "text", spellcheck: "false" });
  track.value = take.track ?? `${p.pickTrack ?? "take"}-${slugify(shortVoice(take.voiceId))}`;
  track.addEventListener("input", () => (take.track = track.value.trim()));
  const note = h("input", { type: "text", placeholder: "Why this one? (optional)" });
  const r = S.pickResult;
  box.replaceChildren(
    ...[
      h("span", { class: "eyebrow" }, "Picked this voice?"),
      h("p", {}, "Send the exact take you're hearing back to the video project. On the computer with the project, ", h("code", {}, "npm run picks"), " saves it as a voice track, and the video renders once with it."),
      h("label", { class: "field" }, h("span", {}, "Track"), track),
      h("label", { class: "field" }, h("span", {}, "Note"), note),
      h("button", { class: "ghost", type: "button", disabled: !complete, onclick: () => sendPick(track.value.trim(), note.value.trim()) }, "Send this take to the project"),
      r?.error ? h("p", { class: "hint bad" }, r.error) : null,
      r?.id ? h("p", { class: "hint" }, "Sent as ", h("code", {}, r.track), ". To bring it in: ", h("code", {}, `npm run picks -- import ${r.id}`)) : null,
    ].filter(Boolean),
  );
};

const renderHandoff = () => {
  const box = $("#handoff");
  const p = S.project;
  const take = activeTake();
  if (S.status?.hosted) return renderPick(box, p, take);
  if (!p?.handoff || take?.kind !== "generated") {
    box.hidden = true;
    return box.replaceChildren();
  }
  box.hidden = false;
  const complete = take.sections.every((s) => s.status === "ready" && !s.stale);
  const input = h("input", { type: "text", spellcheck: "false" });
  input.value = take.track ?? `${p.handoff.script}-${slugify(shortVoice(take.voiceId))}`;
  const cmd = () =>
    p.handoff.command
      .replace("{voiceId}", take.voiceId)
      .replace("{modelId}", take.modelId)
      .replace("{speed}", String(take.speed))
      .replace("{track}", input.value.trim() || "track");
  const pre = h("pre", {}, cmd());
  input.addEventListener("input", () => {
    take.track = input.value.trim();
    pre.textContent = cmd();
  });
  const r = S.handoffResult;
  // replaceChildren would print a null as the text "null".
  box.replaceChildren(
    ...[
      h("span", { class: "eyebrow" }, "Picked this voice?"),
      h("p", {}, "Save the exact take you're hearing into ", h("code", {}, p.handoff.cwd), " as a new voice track. The video agent then times the picture to it and renders once."),
      h("label", { class: "field" }, h("span", {}, "Track"), input),
      h("button", { class: "ghost", type: "button", disabled: !complete || !p.canSaveTake, onclick: () => saveTakeToProject(input.value.trim()) }, "Save take to project"),
      r?.error ? h("p", { class: "hint bad" }, r.error) : null,
      r?.written
        ? h("div", {}, h("p", {}, "Wrote ", r.written.map((f, i) => [i ? ", " : "", h("code", {}, f)]), ". Next, for the agent:"), h("ol", {}, r.next.map((n) => h("li", {}, n))))
        : null,
      h(
        "details",
        {},
        h("summary", {}, "Or regenerate it there"),
        pre,
        h("button", { class: "icon", type: "button", onclick: () => navigator.clipboard.writeText(cmd()).then(() => toast("Copied.")) }, "Copy"),
      ),
    ].filter(Boolean),
  );
};

const renderExport = () => {
  const take = activeTake();
  const done = Boolean(take) && take.sections.every((s) => s.status === "ready");
  const btn = $("#export");
  btn.disabled = !done || S.exporting || !S.status?.ffmpeg;
  btn.textContent = S.exporting ? "Exporting…" : "Export MP4";
  const box = $("#export-result");
  box.replaceChildren();
  if (!take) box.append("Pick a take above to export it with this video.");
  else if (!done) box.append("Export unlocks when every line is ready.");
  else box.append(`Copies the video untouched and writes the voice${S.music?.buffer ? ", music" : ""} and bed as its audio.`);
  if (S.exportResult) {
    const r = S.exportResult;
    const hosted = S.status?.hosted;
    box.append(
      h("div", {}, hosted ? "Ready: " : "Saved ", h("code", {}, hosted ? r.file : `exports/${r.file}`), ` (${r.mb} MB)`),
      h(
        "div",
        { class: "links" },
        h("button", { type: "button", onclick: () => window.open(r.url, "_blank") }, "Play it"),
        hosted
          ? h("button", { type: "button", onclick: () => (location.href = r.download) }, "Download")
          : h("button", { type: "button", onclick: () => api("/api/reveal", { method: "POST", json: { file: r.file } }).catch((e) => toast(e.message, "error")) }, "Show in folder"),
      ),
    );
  }
  renderHandoff();
};

const renderAll = () => {
  renderStatus();
  renderProjects();
  renderVoices();
  renderControls();
  renderTakes();
  renderWarnings();
  renderScript();
  renderTimeline();
  renderMix();
  renderExport();
  $("#check-words").checked = S.checkWords;
};

const tick = () => {
  const D = endTime();
  const frac = D ? clamp(video.currentTime / D, 0, 1) : 0;
  $("#playhead").style.left = `calc(${LANE_X}px + (100% - ${LANE_X}px) * ${frac})`;
  $("#time").textContent = `${fmtTime(video.currentTime)} / ${fmtTime(D)}`;
  $("#play").textContent = video.paused ? "▶" : "❚❚";
  highlight();
  requestAnimationFrame(tick);
};

/* Wiring */

const isAudio = (f) => f.type.startsWith("audio/") || /\.(mp3|wav|m4a|aac|ogg|opus|flac)$/i.test(f.name);
const isVideo = (f) => f.type.startsWith("video/") || /\.(mp4|mov|webm|mkv|m4v)$/i.test(f.name);

const wire = () => {
  $("#project").addEventListener("change", (e) => loadProject(e.target.value).catch((err) => toast(err.message, "error")));
  $("#open-video").addEventListener("click", () => $("#file").click());
  $("#file").addEventListener("change", (e) => {
    uploadVideo(e.target.files[0]);
    e.target.value = "";
  });
  $("#play").addEventListener("click", togglePlay);
  video.addEventListener("click", togglePlay);
  video.addEventListener("loadedmetadata", () => {
    S.duration = video.duration;
    $("#stage").classList.toggle("portrait", video.videoHeight > video.videoWidth);
    replanAll();
    renderMusic();
    renderTimeline();
  });
  video.addEventListener("error", () => {
    if (video.getAttribute("src")) toast("This browser can't play that video. An H.264 MP4 works everywhere.", "error");
  });

  const timeline = $("#timeline");
  timeline.addEventListener("pointerdown", (e) => {
    if (!S.project || !endTime()) return;
    const handle = e.target.closest("[data-drag]");
    try {
      timeline.setPointerCapture(e.pointerId);
    } catch {}
    if (handle && S.music?.buffer) {
      const m = S.music;
      drag = { kind: handle.dataset.drag, x0: e.clientX, m0: { offset: m.offset, in: m.in, out: m.out, fadeIn: m.fadeIn, fadeOut: m.fadeOut }, moved: false };
      e.preventDefault();
      renderMusicLane();
      return;
    }
    drag = { kind: "seek" };
    video.currentTime = timeAtX(e.clientX);
  });
  timeline.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if (drag.kind === "seek") video.currentTime = timeAtX(e.clientX);
    else dragMusic(e);
  });
  const endDrag = () => {
    const moved = drag && drag.kind !== "seek" && drag.moved;
    drag = null;
    $("#drag-tip").hidden = true;
    renderMusicLane();
    if (moved) {
      renderMusic();
      saveMusic();
      renderMix();
    }
  };
  timeline.addEventListener("pointerup", endDrag);
  timeline.addEventListener("pointercancel", endDrag);
  timeline.addEventListener("dblclick", (e) => {
    if (e.target.closest(".clip") && S.music) playFrom(S.music.offset + 0.3);
  });
  window.addEventListener("resize", debounce(renderMusicLane, 100));

  const scriptBody = $("#script-body");
  scriptBody.addEventListener("mouseenter", () => (S.scriptHover = true));
  scriptBody.addEventListener("mouseleave", () => (S.scriptHover = false));
  $("#check-words").addEventListener("change", (e) => {
    S.checkWords = e.target.checked;
    store.set("checkWords", S.checkWords);
    if (S.checkWords) for (const t of S.takes) t.sections.forEach((_, i) => queueCheck(t, i));
  });

  document.querySelectorAll(".tabs button").forEach((b) =>
    b.addEventListener("click", () => {
      S.tab = b.dataset.tab;
      $("#voice-search").value = S.tab === "mine" ? S.query : S.library.q ?? "";
      renderVoices();
    }),
  );
  $("#voice-search").addEventListener("input", (e) => {
    if (S.tab === "mine") {
      S.query = e.target.value;
      renderVoices();
    }
  });
  $("#voice-search").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && S.tab === "library") searchLibrary(e.target.value.trim());
  });
  sample.addEventListener("ended", () => {
    S.sampleUrl = null;
    renderVoices();
    renderMusicDialog();
  });

  $("#model").addEventListener("change", (e) => {
    S.sel.modelId = e.target.value;
    saveSel();
    renderControls();
  });
  $("#speed").addEventListener("input", (e) => {
    S.sel.speed = Number(e.target.value);
    $("#speed-out").textContent = `${S.sel.speed.toFixed(2)}×`;
    renderSpeedHint();
    saveSel();
  });
  $("#mode").addEventListener("change", (e) => {
    S.sel.mode = e.target.value;
    $("#mode-hint").textContent = MODE_HINT[S.sel.mode] ?? "";
    saveSel();
    replanAll();
  });
  $("#presets").addEventListener("change", (e) => {
    S.sel.presets = e.target.checked;
    saveSel();
    renderControls();
  });
  for (const k of ["stability", "similarity", "style"]) {
    $(`#${k}`).addEventListener("input", (e) => {
      S.sel[k] = Number(e.target.value);
      $(`output[data-for="${k}"]`).textContent = S.sel[k].toFixed(2);
      saveSel();
    });
  }
  $("#generate").addEventListener("click", generate);

  $("#voice-db").addEventListener("input", (e) => {
    S.mix.voiceDb = Number(e.target.value);
    $("#voice-db-out").textContent = fmtDb(S.mix.voiceDb);
    applyGains();
  });
  $("#bed-db").addEventListener("input", (e) => {
    S.mix.bedDb = Number(e.target.value);
    $("#bed-db-out").textContent = fmtDb(S.mix.bedDb);
    applyGains();
  });
  $("#bed-source").addEventListener("change", (e) => {
    S.mix.bedSource = e.target.value;
    loadBed();
  });

  $("#music-add").addEventListener("click", () => $("#music-file").click());
  $("#music-file").addEventListener("change", (e) => {
    uploadMusic(e.target.files[0]);
    e.target.value = "";
  });
  $("#music-db").addEventListener("input", (e) => {
    if (!S.music) return;
    S.music.gainDb = Number(e.target.value);
    $("#music-db-out").textContent = fmtDb(S.music.gainDb);
    applyGains();
    saveMusic();
  });
  for (const [id, key] of [
    ["#music-fi", "fadeIn"],
    ["#music-fo", "fadeOut"],
  ]) {
    $(id).addEventListener("input", (e) => {
      const m = S.music;
      if (!m?.buffer) return;
      const other = key === "fadeIn" ? m.fadeOut : m.fadeIn;
      m[key] = clamp(Number(e.target.value), 0, Math.max(0, m.out - m.in - other));
      $(`${id}-out`).textContent = `${m[key].toFixed(1)}s`;
      renderMusicLane();
      renderMusicSoon();
      saveMusic();
    });
  }
  $("#music-duck").addEventListener("change", (e) => {
    if (!S.music) return;
    S.music.duck = Number(e.target.value);
    renderMusic();
    saveMusic();
  });
  $("#music-browse").addEventListener("click", () => openMusic("library"));
  document.querySelectorAll("[data-mtab]").forEach((b) => b.addEventListener("click", () => openMusic(b.dataset.mtab)));
  $("#music-close").addEventListener("click", () => musicDialog().close());
  musicDialog().addEventListener("click", (e) => {
    if (e.target !== musicDialog()) return;
    const r = musicDialog().getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) musicDialog().close();
  });
  musicDialog().addEventListener("close", () => {
    if (S.sampleUrl) {
      sample.pause();
      S.sampleUrl = null;
      renderVoices();
    }
  });
  $("#signin-form").addEventListener("submit", signIn);
  $("#lex-open").addEventListener("click", openLexicon);
  $("#lex-add").addEventListener("click", addLexRow);
  $("#lex-close").addEventListener("click", () => lexDialog().close());
  lexDialog().addEventListener("click", (e) => {
    if (e.target !== lexDialog()) return;
    const r = lexDialog().getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) lexDialog().close();
  });
  lexDialog().addEventListener("close", saveLexicon);
  $("#music-search").addEventListener("input", (e) => {
    S.mfilter.q = e.target.value;
    renderLibrary();
  });
  $("#music-style").addEventListener("change", (e) => {
    S.mfilter.style = e.target.value;
    renderLibrary();
  });
  $("#music-length").addEventListener("change", (e) => {
    S.mfilter.length = e.target.value;
    renderLibrary();
  });
  $("#gen-fit").addEventListener("click", composeFit);
  $("#gen-prompt-go").addEventListener("click", makePromptTrack);
  $("#export").addEventListener("click", exportMix);

  const player = $("#player");
  let depth = 0;
  document.addEventListener("dragenter", (e) => {
    if (![...(e.dataTransfer?.types ?? [])].includes("Files")) return;
    depth++;
    player.classList.add("dragging");
  });
  document.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (!depth) player.classList.remove("dragging");
  });
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    depth = 0;
    player.classList.remove("dragging");
    const files = [...(e.dataTransfer?.files ?? [])];
    const vid = files.find(isVideo);
    const aud = files.find(isAudio);
    if (vid) uploadVideo(vid);
    else if (aud) uploadMusic(aud);
  });

  document.addEventListener("keydown", (e) => {
    if (e.target.closest?.("input, textarea, select") || e.metaKey || e.ctrlKey || e.altKey || musicDialog().open || lexDialog().open) return;
    if (e.code === "Space") {
      e.preventDefault();
      togglePlay();
    } else if (/^Digit\d$/.test(e.code)) {
      const k = Number(e.code.slice(5));
      if (k === 0) setActive("original");
      else if (S.takes[k - 1]) setActive(S.takes[k - 1].id);
    } else if (e.code === "ArrowLeft") video.currentTime = Math.max(0, video.currentTime - 2);
    else if (e.code === "ArrowRight") video.currentTime = Math.min(endTime(), video.currentTime + 2);
  });
};

const init = async () => {
  wire();
  requestAnimationFrame(tick);
  await refreshStatus();
  const loads = [
    loadProjects(),
    loadMusicLib(),
    api("/api/music/jobs")
      .then((jobs) => {
        S.jobs = jobs;
        for (const j of jobs) if (!isActiveJob(j)) S.seenJobs.add(j.id);
        if (jobs.some(isActiveJob)) pollJobs();
      })
      .catch(() => {}),
  ];
  if (S.status?.key) loads.push(loadVoices(), loadModels());
  await Promise.allSettled(loads);
  const last = store.get("project", null);
  const id = S.projects.some((p) => p.id === last) ? last : S.projects[0]?.id;
  if (id) await loadProject(id).catch((err) => toast(err.message, "error"));
  renderAll();
};

init();
