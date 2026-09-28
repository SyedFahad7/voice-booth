// ElevenLabs music_v2 composition plans: a track shaped like a launch video (quiet open, build,
// lift, resolve) either at a set length or timed to a video's own scenes. Shared by the page, the
// server and the starter CLI.
import { roleStyles } from "./music-presets.js";

export const MIN_CHUNK = 3000;
export const MAX_CHUNK = 120000;
export const MAX_CHUNKS = 30;
const MAX_STYLES = 50;

const LABEL = { intro: "Intro", build: "Build", lift: "Main theme", steady: "Groove", resolve: "Outro", single: "Main theme" };

// Energy arc over n parts: quiet open, a build, lifts and steady stretches, then a resolve.
export const arcRoles = (n) => {
  if (n <= 1) return ["single"];
  if (n === 2) return ["intro", "resolve"];
  const m = n - 2;
  const middle = Array.from({ length: m }, (_, i) => {
    if (m === 1) return "lift";
    if (i === 0) return "build";
    if (i === m - 1) return "lift";
    return m === 3 ? "steady" : i % 2 === 1 ? "lift" : "steady";
  });
  return ["intro", ...middle, "resolve"];
};

const tempoOf = (preset) => preset.positive.find((s) => /\bbpm\b/.test(s)) ?? null;

const chunk = (preset, role, durationMs, first) => {
  const core = [preset.positive[0], tempoOf(preset)].filter(Boolean);
  const role_ = role === "single" ? ["complete short piece", "ends on a sustained final chord"] : roleStyles(preset, role);
  const positive = first ? [...preset.positive, ...role_] : [...core, ...role_];
  return {
    text: `[${LABEL[role]}]\n{instrumental}`,
    duration_ms: durationMs,
    positive_styles: [...new Set(positive)].slice(0, MAX_STYLES),
    negative_styles: [...new Set(preset.negative)].slice(0, MAX_STYLES),
  };
};

// Integer millisecond boundaries → chunk durations that sum exactly to the total. Parts shorter
// than MIN_CHUNK merge into their shorter neighbour, longer than MAX_CHUNK split evenly, and the
// smallest neighbours merge until there are at most MAX_CHUNKS.
export const normalizeBoundaries = (bounds) => {
  let b = [...new Set(bounds.map((x) => Math.round(x)))].sort((x, y) => x - y);
  const total = b[b.length - 1] - b[0];
  if (total < MIN_CHUNK) throw new Error(`A track needs at least ${MIN_CHUNK / 1000}s`);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 1; i < b.length; i++) {
      if (b[i] - b[i - 1] >= MIN_CHUNK || b.length <= 2) continue;
      // Drop the boundary shared with the shorter neighbour; the first and last never go.
      const left = i >= 2 ? b[i - 1] - b[i - 2] : Infinity;
      const right = i + 1 < b.length ? b[i + 1] - b[i] : Infinity;
      b.splice(left <= right ? i - 1 : i, 1);
      changed = true;
      break;
    }
  }
  const split = [b[0]];
  for (let i = 1; i < b.length; i++) {
    const len = b[i] - b[i - 1];
    const parts = Math.ceil(len / MAX_CHUNK);
    for (let k = 1; k < parts; k++) split.push(b[i - 1] + Math.round((len * k) / parts));
    split.push(b[i]);
  }
  b = split;
  while (b.length - 1 > MAX_CHUNKS) {
    let best = 1;
    for (let i = 1; i < b.length - 1; i++) if (b[i + 1] - b[i - 1] < b[best + 1] - b[best - 1]) best = i;
    b.splice(best, 1);
  }
  return b;
};

const planFromBounds = (preset, bounds) => {
  const b = normalizeBoundaries(bounds);
  const roles = arcRoles(b.length - 1);
  return {
    plan: { chunks: roles.map((role, i) => chunk(preset, role, b[i + 1] - b[i], i === 0)) },
    roles,
    bounds: b,
  };
};

// A self-contained track of `lengthMs`, split into an arc sized to its length.
export const planForLength = (preset, lengthMs) => {
  const L = Math.round(lengthMs);
  const shares = L < 12000 ? [1] : L < 25000 ? [0.25, 0.5, 0.25] : L < 60000 ? [0.2, 0.25, 0.35, 0.2] : L < 120000 ? [0.15, 0.2, 0.25, 0.25, 0.15] : [0.12, 0.16, 0.2, 0.2, 0.18, 0.14];
  const bounds = [0];
  let acc = 0;
  for (const s of shares.slice(0, -1)) bounds.push(Math.round((acc += s) * L));
  bounds.push(L);
  return planFromBounds(preset, bounds);
};

/**
 * A track timed to a video: one part per line of the script, changing in the pause between lines,
 * so the music moves when the picture cuts and resolves on the last frame.
 *   duration: video length in seconds
 *   lines:    [{ start, end }] where each line's speech sits on the video, in order
 */
export const planForVideo = (preset, duration, lines) => {
  const L = Math.round(duration * 1000);
  const spans = lines.filter((l) => Number.isFinite(l.start) && Number.isFinite(l.end) && l.end > l.start).sort((a, b) => a.start - b.start);
  if (spans.length < 2) return planForLength(preset, L);
  const bounds = [0];
  for (let i = 1; i < spans.length; i++) bounds.push(Math.round(((spans[i - 1].end + spans[i].start) / 2) * 1000));
  bounds.push(L);
  return planFromBounds(
    preset,
    bounds.filter((x) => x >= 0 && x <= L),
  );
};

export const planLength = (plan) => plan.chunks.reduce((n, c) => n + c.duration_ms, 0);

// Problems that would make ElevenLabs reject a plan; empty when it's fine.
export const checkPlan = (plan) => {
  const errors = [];
  const chunks = plan?.chunks;
  if (!Array.isArray(chunks) || !chunks.length) return ["The plan has no parts"];
  if (chunks.length > MAX_CHUNKS) errors.push(`${chunks.length} parts; the limit is ${MAX_CHUNKS}`);
  chunks.forEach((c, i) => {
    if (!Number.isInteger(c.duration_ms) || c.duration_ms < MIN_CHUNK || c.duration_ms > MAX_CHUNK) errors.push(`Part ${i + 1} lasts ${c.duration_ms} ms; parts must be 3–120 s`);
    if (!Array.isArray(c.positive_styles) || !c.positive_styles.length || c.positive_styles.length > MAX_STYLES) errors.push(`Part ${i + 1} needs 1–${MAX_STYLES} styles`);
    if (c.negative_styles && c.negative_styles.length > MAX_STYLES) errors.push(`Part ${i + 1} has too many styles to avoid`);
    if (typeof c.text !== "string" || !c.text.trim()) errors.push(`Part ${i + 1} has no text`);
  });
  const total = planLength(plan);
  if (total < MIN_CHUNK || total > 600000) errors.push(`The plan runs ${total} ms; tracks must be 3 s to 10 min`);
  return errors;
};
