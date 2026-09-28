// Brings takes picked on the hosted booth back into their video project, the same way the local
// booth's "Save take to project" does. Run it where the video project lives.
//   node tools/picks.mjs                                        picks, newest first
//   node tools/picks.mjs import <pickId> [--track <name>] [--dry-run]
import fs from "node:fs";
import path from "node:path";
import { DIRS, findFfmpeg, relaunchWithSystemCa } from "../lib/config.mjs";
import { createFfmpeg } from "../lib/ffmpeg.mjs";
import { listAll, openFile, readJson } from "../lib/hosted/r2.mjs";
import { findProject } from "../lib/projects.mjs";
import { loadHostedEnv, mapLimit } from "./hosted-env.mjs";

const show = async () => {
  const items = (await listAll("picks/")).filter((o) => /^picks\/pk-[\w-]+\.json$/.test(o.key));
  const picks = (await Promise.all(items.map((o) => readJson(o.key)))).filter(Boolean).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  if (!picks.length) return console.log("No picks yet. Pick a take on the hosted booth with “Send this take to the project”.");
  for (const k of picks) {
    console.log(`${k.id}  ${k.createdAt.slice(0, 16).replace("T", " ")}  ${k.title} → track "${k.track}"  (${k.modelId}, ${k.speed}×, ${k.sections.length} lines)`);
    if (k.note) console.log(`    “${k.note}”`);
  }
  console.log(`\nBring one in: node tools/picks.mjs import <id>   (add --dry-run to check it first)`);
};

// Downloads each line into the local take cache as well, so the local booth has the exact audio.
const bringIn = async (id, { track, dry }) => {
  const pick = await readJson(`picks/${id}.json`);
  if (!pick) throw new Error(`No pick "${id}". Run "node tools/picks.mjs" to see them.`);
  const project = findProject(pick.source?.projectId);
  if (!project) throw new Error(`The video project "${pick.source?.projectId}" isn't on this machine. Run this where it lives.`);
  if (!project.saveTake) throw new Error(`${project.title} can't take a voice track from the booth.`);
  const ffmpeg = createFfmpeg(findFfmpeg());
  const sections = await mapLimit(pick.sections, 4, async (s) => {
    const mp3 = path.join(DIRS.tts, `${s.key}.mp3`);
    if (!fs.existsSync(mp3)) {
      const res = await openFile(s.mp3Key);
      if (!res.ok) throw new Error(`Couldn't download ${s.id} (${res.status})`);
      fs.writeFileSync(mp3, Buffer.from(await res.arrayBuffer()), { flag: "wx" });
    }
    const wav = path.join(DIRS.tts, `${s.key}.wav`);
    if (ffmpeg && !fs.existsSync(wav)) await ffmpeg.toWav(mp3, wav);
    const meta = path.join(DIRS.tts, `${s.key}.json`);
    if (!fs.existsSync(meta)) {
      const hosted = await readJson(`tts/${s.key}.json`);
      if (hosted) {
        const { audioKey, mp3Key, ...local } = hosted;
        fs.writeFileSync(meta, JSON.stringify(local), { flag: "wx" });
      }
    }
    return { id: s.id, mp3, chars: s.chars, starts: s.starts, ends: s.ends };
  });
  const name = track ?? pick.track;
  console.log(`${pick.title}: ${sections.length} lines downloaded (${pick.modelId}, ${pick.speed}×) as track "${name}"`);
  if (dry) return console.log("Dry run: nothing written to the video project.");
  const result = await project.saveTake({ track: name, voiceId: pick.voiceId, modelId: pick.modelId, speed: pick.speed, sections });
  console.log(`Wrote ${result.written.join(", ")}`);
  for (const step of result.next ?? []) console.log(`  next: ${step}`);
};

if (!(await relaunchWithSystemCa())) {
  const [cmd, id, ...rest] = process.argv.slice(2);
  const flag = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const run = async () => {
    loadHostedEnv();
    if (!cmd || cmd === "list") return show();
    if (cmd === "import" && id) return bringIn(id, { track: flag("--track"), dry: rest.includes("--dry-run") });
    console.error("usage: node tools/picks.mjs [list | import <pickId> [--track <name>] [--dry-run]]");
    process.exit(2);
  };
  run().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
