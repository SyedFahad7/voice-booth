// Publishes local video projects to the hosted booth as bundles: the render, the music bed without
// the voice, the original voice lines with their timing, and the project's other voice takes, so
// the hosted booth plays them the way the local one does. Each run makes a new version.
//   node tools/publish.mjs list                 projects that can be published
//   node tools/publish.mjs <projectId...>       publish them
//   node tools/publish.mjs music                copy the local music library up
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DIRS, relaunchWithSystemCa, slug, stamp } from "../lib/config.mjs";
import { find, randomName, writeFile, writeJson } from "../lib/hosted/r2.mjs";
import { LICENSE } from "../lib/music-core.mjs";
import { findProject, listProjects } from "../lib/projects.mjs";
import { loadHostedEnv, mapLimit } from "./hosted-env.mjs";

const TYPE = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
};
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

const upload = (file, key) => writeFile(key, fs.readFileSync(file), TYPE[path.extname(file).toLowerCase()] ?? "application/octet-stream");

const list = () => {
  for (const p of listProjects().filter((x) => x.kind !== "upload")) {
    const lines = p.sections.filter((s) => s.orig?.path).length;
    console.log(`${p.id.padEnd(28)} ${p.title}  (${p.sections.length} lines, ${lines} with original audio${p.bed ? ", bed" : ", no bed"}${p.takes?.length ? `, ${p.takes.length} voice takes` : ""})`);
  }
};

const publish = async (id) => {
  const p = findProject(id);
  if (!p) throw new Error(`No project "${id}". Run "node tools/publish.mjs list".`);
  if (p.kind === "upload") throw new Error(`${id} is an uploaded video; open it in the hosted booth with "Open a video…" instead.`);
  const t0 = Date.now();
  const bid = `bd-${slug(p.id)}-${stamp()}-${crypto.randomBytes(3).toString("hex")}`;
  const base = `bundles/${bid}`;
  let total = 0;
  const up = async (file, name) => {
    const r = await upload(file, `${base}/${randomName(name)}`);
    total += r.size;
    return r.key;
  };
  const ext = (file) => path.extname(file).toLowerCase();
  const warnings = [...(p.warnings ?? [])];
  if (!p.bed) warnings.push("Published without a music bed, so takes play over silence. Build the bed (npm run bed) and publish again.");
  else if (p.bed.stale) warnings.push("The music bed is older than the render. Rebuild it (npm run bed) and publish again.");

  console.log(`${p.title}: uploading the render…`);
  const video = { key: await up(p.video.path, `video${ext(p.video.path)}`), name: path.basename(p.video.path), width: p.video.width ?? null, height: p.video.height ?? null, duration: p.video.duration ?? null };
  const bed = p.bed ? { key: await up(p.bed.path, `bed${ext(p.bed.path)}`), name: path.basename(p.bed.path) } : null;
  const sections = await mapLimit(p.sections, 4, async (s, i) => ({
    id: s.id,
    text: s.text,
    delivery: s.delivery ?? null,
    settings: s.settings ?? null,
    seed: s.seed ?? 1842 + i,
    at: s.at ?? null,
    orig: s.orig?.chars ? { key: s.orig.path ? await up(s.orig.path, `orig-${i}-${slug(s.id)}${ext(s.orig.path)}`) : null, chars: s.orig.chars, starts: s.orig.starts, ends: s.orig.ends } : null,
  }));
  const takes = [];
  for (const [ti, t] of (p.takes ?? []).entries()) {
    const ready = t.sections.filter((s) => s.chars && s.path);
    takes.push({
      track: t.track,
      voiceId: t.voiceId,
      modelId: t.modelId,
      speed: t.speed,
      sections: await mapLimit(ready, 4, async (s) => ({
        id: s.id,
        index: t.sections.indexOf(s),
        key: await up(s.path, `take-${ti}-${slug(t.track)}-${slug(s.id)}${ext(s.path)}`),
        chars: s.chars,
        starts: s.starts,
        ends: s.ends,
      })),
    });
  }
  const manifest = {
    id: bid,
    kind: "bundle",
    title: p.title,
    group: p.group ?? "Published",
    publishedAt: new Date().toISOString(),
    source: { projectId: p.id, handoff: p.handoff ? { script: p.handoff.script, cwd: path.basename(p.handoff.cwd) } : null },
    video,
    bed,
    voiceGain: p.voiceGain ?? 1,
    original: p.original ?? null,
    sections,
    takes,
    warnings,
  };
  await writeJson(`${base}/bundle.json`, manifest);
  console.log(`  published as ${bid}: ${sections.length} lines, ${bed ? "with" : "without"} the bed, ${takes.length} voice takes, ${mb(total)} in ${Math.round((Date.now() - t0) / 1000)}s`);
  for (const w of warnings) console.log(`  note: ${w}`);
};

// The local library, as is. Track ids are content hashes, so a track already up there is skipped.
const music = async () => {
  const metas = fs
    .readdirSync(DIRS.music)
    .filter((n) => n.endsWith(".json"))
    .map((n) => JSON.parse(fs.readFileSync(path.join(DIRS.music, n), "utf8")))
    .filter((m) => m.file && fs.existsSync(path.join(DIRS.music, m.file)));
  let copied = 0;
  let bytes = 0;
  await mapLimit(metas, 4, async (m) => {
    if (await find(`music/${m.id}.json`)) return;
    const r = await upload(path.join(DIRS.music, m.file), `music/${m.file}`);
    await writeJson(`music/${m.id}.json`, { ...m, audioKey: r.key, ...(m.source === "elevenlabs" ? { license: LICENSE } : {}) });
    copied++;
    bytes += r.size;
  });
  console.log(`music: copied ${copied} of ${metas.length} tracks (${mb(bytes)}); the rest were already up`);
};

if (!(await relaunchWithSystemCa())) {
  const args = process.argv.slice(2);
  const run = async () => {
    if (!args.length || args[0] === "list") return list();
    loadHostedEnv();
    if (args[0] === "music") return music();
    for (const id of args) await publish(id);
  };
  run().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
