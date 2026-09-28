// The booth's music library: dropped files plus tracks made with ElevenLabs Music, and the queue
// that makes them. Each track is music/<id>.<ext> with music/<id>.json beside it.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DIRS } from "./config.mjs";
import { AUDIO_EXT, LICENSE, STARTER, madeTrackMeta, missingStarter, publicJob, resolveSpec, starterStatus as statusOf, trackReply, uniqueName } from "./music-core.mjs";

export { AUDIO_EXT, LICENSE, STARTER };

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const metaFile = (id) => path.join(DIRS.music, `${id}.json`);
const reply = (m) => trackReply(m, `/music/${m.file}`);

// Deletes can take a while on Windows (antivirus, sync clients), so a removed track leaves the list
// at once and its files are deleted in the background. If that fails, the track comes back.
const removing = new Set();

export const listTracks = () =>
  fs
    .readdirSync(DIRS.music)
    .filter((n) => n.endsWith(".json"))
    .map((n) => {
      try {
        return readJson(path.join(DIRS.music, n));
      } catch {
        return null;
      }
    })
    .filter((m) => m?.file && !removing.has(m.id) && fs.existsSync(path.join(DIRS.music, m.file)))
    .map(reply)
    .sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1));

// Content-addressed, so the same audio is stored once and nothing is ever overwritten.
const store = (buf, ext, meta) => {
  const id = crypto.createHash("sha1").update(buf).digest("hex").slice(0, 16);
  if (removing.has(id)) throw Object.assign(new Error("That track is still being removed. Try again in a moment."), { status: 409 });
  const file = `${id}${ext}`;
  if (!fs.existsSync(path.join(DIRS.music, file))) fs.writeFileSync(path.join(DIRS.music, file), buf, { flag: "wx" });
  if (fs.existsSync(metaFile(id))) return readJson(metaFile(id));
  const full = { id, file, bytes: buf.length, addedAt: new Date().toISOString(), ...meta };
  fs.writeFileSync(metaFile(id), JSON.stringify(full, null, 2), { flag: "wx" });
  return full;
};

export const saveUpload = (name, buf) => {
  const ext = path.extname(name).toLowerCase();
  if (!AUDIO_EXT.has(ext)) throw Object.assign(new Error(`Unsupported audio type "${ext || name}"`), { status: 400 });
  return reply(store(buf, ext, { name, source: "upload" }));
};

export const removeTrack = (id) => {
  if (!/^[a-f0-9]{16}$/.test(id) || removing.has(id) || !fs.existsSync(metaFile(id))) throw Object.assign(new Error("No such track"), { status: 404 });
  const m = readJson(metaFile(id));
  removing.add(id);
  Promise.all([path.join(DIRS.music, m.file), metaFile(id)].map((p) => fs.promises.unlink(p).catch((err) => (err.code === "ENOENT" ? null : Promise.reject(err)))))
    .catch((err) => console.error(`Couldn't delete track ${id}: ${err.message}`))
    .finally(() => removing.delete(id));
};

/* Generation queue */

const jobs = [];
let running = 0;
const MAX_RUNNING = 2;
let eleven = null;
let idle = [];

export const setClient = (client) => {
  eleven = client;
};

const run = async (job) => {
  running++;
  job.state = "running";
  job.startedAt = Date.now();
  try {
    const { audio, retries } = await eleven.composeMusic({ plan: job.resolved.plan, prompt: job.resolved.prompt, lengthMs: job.resolved.lengthMs, seed: job.spec.seed });
    job.retries = retries;
    const meta = store(
      audio,
      ".mp3",
      madeTrackMeta(
        job,
        uniqueName(
          job.resolved.name,
          listTracks().map((t) => t.name),
        ),
      ),
    );
    job.trackId = meta.id;
    job.resolved.name = meta.name;
    job.state = "done";
  } catch (err) {
    job.state = "error";
    job.error = err.message;
    job.suggestion = err.suggestion ?? null;
  } finally {
    running--;
    job.doneAt = Date.now();
    pump();
  }
};

const pump = () => {
  while (running < MAX_RUNNING) {
    const job = jobs.find((j) => j.state === "queued");
    if (!job) break;
    run(job);
  }
  if (!running && !jobs.some((j) => j.state === "queued")) {
    const waiting = idle;
    idle = [];
    waiting.forEach((resolve) => resolve());
  }
};

export const enqueue = (spec) => {
  if (!eleven) throw Object.assign(new Error("No ElevenLabs key found. Put ELEVENLABS_API_KEY=... in voice-booth/.env and restart."), { status: 400 });
  const resolved = resolveSpec(spec);
  const job = { id: crypto.randomBytes(6).toString("hex"), state: "queued", spec, resolved, createdAt: Date.now() };
  jobs.push(job);
  pump();
  return publicJob(job);
};

export const listJobs = () => jobs.slice(-60).reverse().map(publicJob);

export const whenIdle = () => (running || jobs.some((j) => j.state === "queued") ? new Promise((resolve) => idle.push(resolve)) : Promise.resolve());

// Queues whatever part of the starter library doesn't exist yet.
export const queueStarter = () => {
  const busy = new Set(jobs.filter((j) => j.state === "queued" || j.state === "running").map((j) => j.spec.starterKey).filter(Boolean));
  return missingStarter(listTracks(), busy).map(enqueue);
};

export const starterStatus = () => statusOf(listTracks());
