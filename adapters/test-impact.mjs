// Voice maps for test-impact-video, read live from the Remotion project's data files so every
// section lands exactly where the render put it.
//
//   node adapters/test-impact.mjs list
//   node adapters/test-impact.mjs bed <track>      music bed + effects without the voice
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DIRS, WORKSPACE, findFfmpeg, stamp } from "../lib/config.mjs";
import { createFfmpeg } from "../lib/ffmpeg.mjs";
import { encodeWav } from "../public/dsp.js";

export const PROJECT = path.resolve(process.env.TEST_IMPACT_DIR ?? path.join(WORKSPACE, "test-impact-video"));
const DATA = path.join(PROJECT, "src", "data");
const PUBLIC = path.join(PROJECT, "public");
const OUT = path.join(PROJECT, "out");

// Must match src/lib/time.ts (FPS), src/data/timing.ts (scene lengths) and
// src/components/AudioMix.tsx (VOICE gain).
const FPS = 60;
const VOICE_GAIN = 0.75;
const frames = (s) => Math.round(s * FPS);

const RENDERS = { main: "graphify-test-impact-80s-16x9.mp4", cut30: "graphify-test-impact-30s-9x16.mp4" };

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const mtime = (file) => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};

const ORDER = (t) => (t === "main" ? "0" : t === "cut30" ? "1" : `2${t}`);

const tracks = () =>
  fs
    .readdirSync(DATA)
    .map((n) => n.match(/^vo-(.+)\.json$/)?.[1])
    .filter((t) => t && t !== "sections")
    .sort((a, b) => ORDER(a).localeCompare(ORDER(b)));

// Same rule as src/Root.tsx: cut30 -> Cut30, cut30-matt -> Cut30-Matt.
const compositionId = (track) =>
  track === "main" ? "Main65" : track.replace(/^cut30/, "Cut30").replace(/-([a-z])/g, (_, c) => `-${c.toUpperCase()}`);

const scriptOf = (track, vo) => (track === "main" ? "main" : vo.script ?? "cut30");

const renderFor = (track) => {
  if (!fs.existsSync(OUT)) return null;
  if (RENDERS[track]) {
    const file = path.join(OUT, RENDERS[track]);
    return fs.existsSync(file) ? file : null;
  }
  const suffix = track.replace(/^cut30-/, "").toLowerCase();
  const hit = fs.readdirSync(OUT).find((n) => n.endsWith(".mp4") && n.toLowerCase().includes(`-${suffix}`));
  return hit ? path.join(OUT, hit) : null;
};

// The delivery presets live in tools/voiceover.mjs as an object literal; read them from there.
const deliveryPresets = () => {
  try {
    const src = fs.readFileSync(path.join(PROJECT, "tools", "voiceover.mjs"), "utf8");
    const block = src.match(/const DELIVERY = (\{[\s\S]*?\n\});/)[1];
    return JSON.parse(
      block
        .replace(/\/\/.*$/gm, "")
        .replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":')
        .replace(/,(\s*[}\]])/g, "$1"),
    );
  } catch {
    return {};
  }
};

// The alignment arrays hold one entry per character of `text`.
const charsOf = (s) => {
  const points = Array.from(s.text);
  if (points.length === s.starts.length) return points;
  const units = s.text.split("");
  return units.length === s.starts.length ? units : null;
};

// planScenes() in src/data/timing.ts: speech starts `voAt` into its scene, scenes run
// back to back, and a fixed `total` hands the remainder to the last scene.
const placements = (track, sections) => {
  const { pads, total } = readJson(path.join(DATA, "scene-pads.json"))[track];
  const duration = (id) => sections.find((s) => s.id === id).duration;
  const lens = pads.map((p) => frames(p.voAt + duration(p.id) + p.tail));
  if (total !== undefined) lens[lens.length - 1] = frames(total) - lens.slice(0, -1).reduce((a, b) => a + b, 0);
  const at = {};
  let start = 0;
  pads.forEach((p, i) => {
    at[p.id] = start / FPS + p.voAt;
    start += lens[i];
  });
  return { at, duration: start / FPS };
};

const bedFor = (id, render) => {
  const dir = path.join(DIRS.stems, id);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((n) => /^bed-.+\.wav$/.test(n)).sort();
  if (!files.length) return null;
  const file = path.join(dir, files[files.length - 1]);
  return { path: file, stale: mtime(file) < mtime(render) };
};

export const projects = () => {
  if (!fs.existsSync(path.join(DATA, "vo-sections.json"))) return [];
  const texts = readJson(path.join(DATA, "vo-sections.json"));
  const presets = deliveryPresets();
  const all = tracks().map((track) => ({ track, vo: readJson(path.join(DATA, `vo-${track}.json`)) }));
  const takeOf = ({ track, vo }) => ({
    track,
    voiceId: vo.voiceId,
    modelId: vo.modelId,
    speed: vo.speed,
    sections: vo.sections.map((s) => ({ id: s.id, path: path.join(PUBLIC, s.file), chars: charsOf(s), starts: s.starts, ends: s.ends })),
  });

  const out = [];
  for (const { track, vo } of all) {
    const render = renderFor(track);
    if (!render) continue;
    let placed;
    try {
      placed = placements(track, vo.sections);
    } catch {
      continue;
    }
    const script = scriptOf(track, vo);
    const id = `test-impact-${track}`;
    const cut = track !== "main";
    const warnings = [];
    if (mtime(path.join(DATA, `vo-${track}.json`)) > mtime(render)) {
      warnings.push(`vo-${track}.json changed after ${path.basename(render)} was rendered, so section positions may not match the picture.`);
    }
    out.push({
      id,
      kind: "remotion",
      group: "Test Impact",
      title: `${cut ? "30s 9:16" : "80s 16:9"} · ${track}`,
      video: { path: render, width: cut ? 1080 : 1920, height: cut ? 1920 : 1080, fps: FPS, duration: placed.duration },
      bed: bedFor(id, render),
      voiceGain: VOICE_GAIN,
      original: { track, voiceId: vo.voiceId, modelId: vo.modelId, speed: vo.speed },
      sections: vo.sections.map((s, i) => {
        const line = texts[script]?.find((x) => x.id === s.id);
        return {
          id: s.id,
          text: line?.text ?? s.text,
          delivery: line?.delivery ?? null,
          settings: presets[line?.delivery] ?? null,
          seed: 1842 + i,
          at: placed.at[s.id],
          orig: { path: path.join(PUBLIC, s.file), chars: charsOf(s), starts: s.starts, ends: s.ends },
        };
      }),
      takes: all.filter((o) => scriptOf(o.track, o.vo) === script).map(takeOf),
      handoff: { script, cwd: PROJECT, command: `node tools/voiceover.mjs voice ${script} {voiceId} {modelId} {speed} {track}` },
      buildBed: (log) => buildBed(track, id, log),
      saveTake: (take) => saveTake(script, take),
      warnings,
    });
  }
  return out;
};

const copyTree = (from, to, skip) => {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip(e.name)) continue;
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) copyTree(a, b, () => false);
    else fs.copyFileSync(a, b);
  }
};

// Renders the composition's audio with every voice file swapped for silence: the bed and
// effects exactly as mixed in the video (still ducked under the original lines), minus the voice.
// The project's own files are only read.
export const buildBed = async (track, id = `test-impact-${track}`, log = console.log) => {
  const ffmpeg = createFfmpeg(findFfmpeg());
  if (!ffmpeg) throw new Error("No ffmpeg found");
  const cli = path.join(PROJECT, "node_modules", "@remotion", "cli", "remotion-cli.js");
  if (!fs.existsSync(cli)) throw new Error("test-impact-video has no node_modules; run npm install there first");

  const tag = stamp();
  const pub = path.join(DIRS.work, `tia-public-${tag}`);
  copyTree(PUBLIC, pub, (name) => name === "vo");
  const silentWav = path.join(pub, "silence.wav");
  fs.writeFileSync(silentWav, Buffer.from(encodeWav([new Float32Array(11025)], 44100)));
  const silentMp3 = path.join(pub, "silence.mp3");
  await ffmpeg.run(["-i", silentWav, "-c:a", "libmp3lame", "-b:a", "64k", silentMp3]);
  for (const t of tracks()) {
    for (const s of readJson(path.join(DATA, `vo-${t}.json`)).sections) {
      const dest = path.join(pub, s.file);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (!fs.existsSync(dest)) fs.copyFileSync(s.file.endsWith(".mp3") ? silentMp3 : silentWav, dest);
    }
  }

  const dir = path.join(DIRS.stems, id);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `bed-${tag}.wav`);
  log(`Rendering ${compositionId(track)} audio without the voice`);
  const systemCa = process.allowedNodeEnvironmentFlags.has("--use-system-ca") ? ["--use-system-ca"] : [];
  const args = [...systemCa, cli, "render", "src/index.ts", compositionId(track), out, "--codec=wav", `--public-dir=${pub}`, "--log=info"];
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: PROJECT, windowsHide: true });
    const onData = (d) => String(d).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).forEach((l) => log(l));
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`remotion render exited with ${code}`))));
  });
  log(`Wrote ${out}`);
  return out;
};

// Writes a booth take into the project in voiceover.mjs's format, so the read that was
// auditioned is the read that gets rendered. Refuses to touch an existing track.
const saveTake = (script, { track, voiceId, modelId, speed, sections }) => {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(track ?? "")) throw new Error("Track names use lowercase letters, digits and single dashes.");
  const json = path.join(DATA, `vo-${track}.json`);
  const dir = path.join(PUBLIC, "vo", track);
  if (fs.existsSync(json) || fs.existsSync(dir)) throw new Error(`test-impact-video already has a "${track}" track. Pick another name.`);
  fs.mkdirSync(dir, { recursive: true });
  const result = { script, voiceId, modelId, speed, sections: [] };
  const written = [];
  sections.forEach((s, i) => {
    const file = `vo/${track}/${String(i + 1).padStart(2, "0")}-${s.id}.mp3`;
    fs.copyFileSync(s.mp3, path.join(PUBLIC, file), fs.constants.COPYFILE_EXCL);
    written.push(`public/${file}`);
    result.sections.push({ id: s.id, file, duration: s.ends[s.ends.length - 1], text: s.chars.join(""), starts: s.starts, ends: s.ends });
  });
  fs.writeFileSync(json, JSON.stringify(result), { flag: "wx" });
  written.push(`src/data/vo-${track}.json`);
  const script_ = readJson(path.join(DATA, "vo-sections.json"))[script] ?? [];
  const edited = result.sections.filter((s) => script_.find((x) => x.id === s.id)?.text !== s.text).map((s) => s.id);
  const next =
    script === "cut30"
      ? [
          `Register "${track}" in VO_TRACKS (src/data/vo.ts) and give it pads in src/data/scene-pads.json (copy the cut30 block). Root.tsx then adds a ${compositionId(track)} composition.`,
          `If it sounds quiet next to the other takes: python tools/vo_level.py ${track}`,
          `Render ${compositionId(track)}.`,
        ]
      : [
          `The main composition only reads the "main" track today, so voicing the 80s cut with "${track}" needs a small change in src/data/timing.ts.`,
          `If it sounds quiet: python tools/vo_level.py ${track}`,
        ];
  if (edited.length) next.unshift(`Lines edited in the booth: ${edited.join(", ")}. Update src/data/vo-sections.json to match.`);
  return { track, written, next };
};

const cli = async () => {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "list") {
    for (const p of projects()) {
      console.log(`${p.id}  ${path.basename(p.video.path)}  ${p.video.duration.toFixed(2)}s  bed: ${p.bed ? path.basename(p.bed.path) + (p.bed.stale ? " (older than video)" : "") : "none"}`);
      for (const s of p.sections) console.log(`  ${s.id.padEnd(11)} at ${s.at.toFixed(3)}s  ${s.delivery ?? ""}`);
      for (const w of p.warnings) console.log(`  warning: ${w}`);
    }
    return;
  }
  if (cmd === "bed" && arg) {
    await buildBed(arg);
    return;
  }
  console.error("usage: node adapters/test-impact.mjs list | bed <track>");
  process.exit(2);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
