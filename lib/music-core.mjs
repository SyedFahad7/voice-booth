// Music library rules shared by the local server and the hosted function: what a request asks
// ElevenLabs for, how tracks are named and described, and the starter set. No file system here.
import { PRESETS, presetById, presetPrompt } from "../public/music-presets.js";
import { checkPlan, planForLength, planLength } from "../public/music-plan.js";

export const LICENSE =
  "Made with ElevenLabs Music on a paid plan. Paid-plan rights cover online videos and ads, not TV, film or radio. Use it in your own videos; don't hand the library out as a music pack.";
export const AUDIO_EXT = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".flac"]);
export const AUDIO_TYPE = { ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".flac": "audio/flac" };

const clampLength = (ms) => Math.round(Math.min(600000, Math.max(10000, Number(ms) || 60000)));
const fmtLength = (ms) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// What the page sees for a track; `url` is wherever its audio can be fetched.
export const trackReply = (m, url) => ({
  id: m.id,
  name: m.name,
  url,
  bytes: m.bytes,
  addedAt: m.addedAt,
  source: m.source ?? "upload",
  preset: m.preset ?? null,
  lengthMs: m.lengthMs ?? null,
  bpm: m.bpm ?? null,
  energy: m.energy ?? null,
  tags: m.tags ?? [],
  variant: m.variant ?? null,
  starterKey: m.starterKey ?? null,
  fitFor: m.fitFor ?? null,
  prompt: m.prompt ?? null,
  license: m.license ?? null,
});

// What to ask ElevenLabs for. Throws with status 400 on a bad request, before anything is queued.
export const resolveSpec = (spec) => {
  const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
  const preset = spec.preset ? presetById(spec.preset) : null;
  if (spec.preset && !preset) throw bad(`Unknown style "${spec.preset}"`);
  if (spec.kind === "style") {
    if (!preset) throw bad("Pick a style first");
    const lengthMs = clampLength(spec.lengthMs);
    return { plan: planForLength(preset, lengthMs).plan, lengthMs, name: `${preset.name}${spec.variant ? ` ${spec.variant}` : ""} · ${fmtLength(lengthMs)}` };
  }
  if (spec.kind === "fit") {
    const errors = checkPlan(spec.plan);
    if (errors.length) throw bad(errors.join("; "));
    return { plan: spec.plan, lengthMs: planLength(spec.plan), name: `${preset?.name ?? "Custom"} · fitted to ${spec.fitFor?.title ?? "a video"}` };
  }
  if (spec.kind === "prompt") {
    const text = String(spec.prompt ?? "").trim();
    if (!text) throw bad("Describe the music first");
    const lengthMs = clampLength(spec.lengthMs);
    const short = text.length > 48 ? `${text.slice(0, 47)}…` : text;
    return { prompt: preset ? presetPrompt(preset, text) : `Instrumental background music for a technology product video. ${text}`, lengthMs, name: `${short} · ${fmtLength(lengthMs)}` };
  }
  throw bad("Unknown request");
};

export const publicJob = (j) => ({
  id: j.id,
  state: j.state,
  kind: j.spec.kind,
  name: j.resolved.name,
  preset: j.spec.preset ?? null,
  lengthMs: j.resolved.lengthMs,
  createdAt: j.createdAt,
  startedAt: j.startedAt ?? null,
  doneAt: j.doneAt ?? null,
  trackId: j.trackId ?? null,
  error: j.error ?? null,
  suggestion: j.suggestion ?? null,
  starterKey: j.spec.starterKey ?? null,
  projectId: j.spec.projectId ?? null,
  seconds: j.startedAt ? Math.round(((j.doneAt ?? Date.now()) - j.startedAt) / 100) / 10 : null,
  retries: j.retries ?? 0,
});

// Composing the same thing twice gives two different tracks, so repeats get numbered.
export const uniqueName = (name, takenNames) => {
  const taken = new Set(takenNames);
  let n = 2;
  let candidate = name;
  while (taken.has(candidate)) candidate = `${name} (${n++})`;
  return candidate;
};

// Everything stored about a track a job made, beside its audio.
export const madeTrackMeta = (job, name) => {
  const preset = presetById(job.spec.preset);
  return {
    name,
    source: "elevenlabs",
    preset: preset?.id ?? null,
    lengthMs: job.resolved.lengthMs,
    bpm: preset?.bpm ?? null,
    energy: preset?.energy ?? null,
    tags: preset?.tags ?? [],
    variant: job.spec.variant ?? null,
    starterKey: job.spec.starterKey ?? null,
    fitFor: job.spec.fitFor ?? null,
    prompt: job.resolved.prompt ?? null,
    plan: job.resolved.plan ?? null,
    seed: job.spec.seed ?? null,
    model: "music_v2",
    license: LICENSE,
  };
};

// Starter library: every style at 60 s and 90 s.
export const STARTER = PRESETS.flatMap((p) => [
  { preset: p.id, variant: "A", lengthMs: 60000, seed: 1001 },
  { preset: p.id, variant: "B", lengthMs: 90000, seed: 2002 },
]);
export const starterKey = (s) => `${s.preset}:${s.variant}`;

export const starterStatus = (tracks) => {
  const have = new Set(tracks.map((t) => t.starterKey).filter(Boolean));
  return { total: STARTER.length, made: STARTER.filter((s) => have.has(starterKey(s))).length };
};

// Starter tracks that are neither in the library nor being made.
export const missingStarter = (tracks, busyKeys) => {
  const have = new Set(tracks.map((t) => t.starterKey).filter(Boolean));
  return STARTER.filter((s) => !have.has(starterKey(s)) && !busyKeys.has(starterKey(s))).map((s) => ({ kind: "style", ...s, starterKey: starterKey(s) }));
};
