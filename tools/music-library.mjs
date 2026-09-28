// The booth's music library from the command line.
//   node tools/music-library.mjs list
//   node tools/music-library.mjs starter [--dry-run]   every style at 60 s and 90 s (24 tracks)
//   node tools/music-library.mjs verify [--scribe]     lengths and energy arcs; --scribe also
//                                                      checks nobody sings (speech-to-text)
import fs from "node:fs";
import path from "node:path";
import { DIRS, findFfmpeg, findKey, relaunchWithSystemCa } from "../lib/config.mjs";
import { createEleven } from "../lib/eleven.mjs";
import { createFfmpeg } from "../lib/ffmpeg.mjs";
import * as music from "../lib/music.mjs";
import { listProjects } from "../lib/projects.mjs";
import { SR, decodeWav, loudness } from "../public/dsp.js";
import { presetById } from "../public/music-presets.js";
import { planForLength } from "../public/music-plan.js";

const client = () => {
  const { key } = findKey();
  if (!key) throw new Error("No ElevenLabs key found. Put ELEVENLABS_API_KEY=... in voice-booth/.env");
  return createEleven(key);
};

const mapLimit = async (items, n, fn) => {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
};

const fmt = (ms) => `${(ms / 1000).toFixed(2)}s`;

const list = () => {
  for (const t of music.listTracks()) {
    console.log(`${t.id}  ${t.source.padEnd(10)} ${String(t.lengthMs ? `${Math.round(t.lengthMs / 1000)}s` : "").padEnd(5)} ${t.name}`);
  }
  const s = music.starterStatus();
  console.log(`starter library: ${s.made} of ${s.total}`);
};

const starter = async (dry) => {
  if (dry) {
    for (const s of music.STARTER) {
      const p = presetById(s.preset);
      const { plan, roles } = planForLength(p, s.lengthMs);
      console.log(`${p.name} ${s.variant}, ${s.lengthMs / 1000}s: ${roles.join(" > ")} (${plan.chunks.map((c) => (c.duration_ms / 1000).toFixed(1)).join(" + ")})`);
      console.log(`  ${plan.chunks[0].positive_styles.join(", ")}`);
    }
    return;
  }
  music.setClient(client());
  const queued = music.queueStarter();
  console.log(`${queued.length} to make, ${music.starterStatus().made} already in the library`);
  const t0 = Date.now();
  let last = -1;
  const timer = setInterval(() => {
    const done = music.listJobs().filter((j) => j.state === "done" || j.state === "error").length;
    if (done !== last) console.log(`  ${done}/${queued.length} after ${Math.round((Date.now() - t0) / 1000)}s`);
    last = done;
  }, 3000);
  await music.whenIdle();
  clearInterval(timer);
  for (const j of music.listJobs().reverse()) {
    console.log(`${j.state.padEnd(5)} ${String(j.seconds ?? "").padStart(5)}s${j.retries ? ` (${j.retries} retries)` : ""}  ${j.name}${j.error ? `  ${j.error}` : ""}`);
  }
  console.log(`done in ${Math.round((Date.now() - t0) / 1000)}s`);
  list();
};

// Each made track against what was asked for: it decodes, lasts the requested length (a track
// fitted to a video within 50 ms), its intro and ending sit below its loudest middle part, and
// with --scribe, speech-to-text hears no words in it.
const verify = async (withScribe) => {
  const ffmpeg = createFfmpeg(findFfmpeg());
  if (!ffmpeg) throw new Error("No ffmpeg found");
  const eleven = withScribe ? client() : null;
  const videos = new Map(listProjects().map((p) => [p.id, p.video.duration]));
  const tracks = music.listTracks().filter((t) => t.source === "elevenlabs");
  const rows = await mapLimit(tracks, 4, async (t) => {
    const meta = JSON.parse(fs.readFileSync(path.join(DIRS.music, `${t.id}.json`), "utf8"));
    const file = path.join(DIRS.music, meta.file);
    const x = decodeWav(await ffmpeg.pcm(file)).channels[0];
    const ms = (x.length / SR) * 1000;
    const notes = [];
    let ok = true;

    const tolerance = meta.fitFor ? 50 : 500;
    const lengthOk = Math.abs(ms - meta.lengthMs) <= tolerance;
    ok &&= lengthOk;
    notes.push(`${fmt(ms)} for ${fmt(meta.lengthMs)} asked${lengthOk ? "" : `, off by more than ${tolerance} ms`}`);
    const video = videos.get(meta.fitFor?.projectId);
    if (video) notes.push(`video ${fmt(video * 1000)} (${Math.round(ms - video * 1000)} ms)`);

    if (meta.plan?.chunks?.length >= 3) {
      let at = 0;
      const parts = meta.plan.chunks.map((c) => {
        const a = Math.round((at / 1000) * SR);
        at += c.duration_ms;
        return { label: c.text.match(/\[(.+?)\]/)?.[1] ?? "?", lufs: loudness(x.subarray(a, Math.min(x.length, Math.round((at / 1000) * SR))), SR) };
      });
      const peak = Math.max(...parts.slice(1, -1).map((p) => p.lufs));
      const tail = loudness(x.subarray(Math.max(0, x.length - Math.round(1.5 * SR))), SR);
      const arcOk = parts[0].lufs < peak && tail < peak;
      ok &&= arcOk;
      notes.push(`${parts.map((p) => `${p.label} ${p.lufs.toFixed(1)}`).join(" · ")} · last 1.5s ${tail.toFixed(1)} LUFS${arcOk ? "" : "  (arc doesn't rise and settle)"}`);
    }

    if (eleven) {
      const cache = path.join(DIRS.stt, `music-${t.id}.json`);
      let heard;
      if (fs.existsSync(cache)) heard = JSON.parse(fs.readFileSync(cache, "utf8"));
      else {
        heard = await eleven.transcribe(fs.readFileSync(file), meta.file);
        if (!fs.existsSync(cache)) fs.writeFileSync(cache, JSON.stringify(heard), { flag: "wx" });
      }
      const words = heard.words.map((w) => w.text);
      ok &&= words.length === 0;
      notes.push(words.length ? `heard ${words.length} word(s): "${words.slice(0, 8).join(" ")}"` : "no words heard");
    }
    return { t, ok, notes };
  });
  for (const { t, ok, notes } of rows) {
    console.log(`${ok ? "ok  " : "FAIL"} ${t.name}`);
    for (const n of notes) console.log(`       ${n}`);
  }
  const bad = rows.filter((r) => !r.ok).length;
  console.log(`${rows.length - bad} of ${rows.length} made tracks pass${withScribe ? "" : " (add --scribe to check for singing)"}`);
  if (bad) process.exitCode = 1;
};

if (!(await relaunchWithSystemCa())) {
  const [cmd = "list", ...flags] = process.argv.slice(2);
  const run = { list: async () => list(), starter: () => starter(flags.includes("--dry-run")), verify: () => verify(flags.includes("--scribe")) }[cmd];
  if (!run) {
    console.error("usage: node tools/music-library.mjs list | starter [--dry-run] | verify [--scribe]");
    process.exit(2);
  }
  run().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
