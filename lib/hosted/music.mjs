// The hosted music library and its generation jobs, in R2. A track is music/<id>.<ext> with
// music/<id>.json beside it. A job is a folder of step files (queued, running, then done or error),
// each written once, so any function instance can report progress.
import crypto from "node:crypto";
import path from "node:path";
import { waitUntil } from "@vercel/functions";
import { AUDIO_EXT, AUDIO_TYPE, madeTrackMeta, missingStarter, publicJob, resolveSpec, trackReply, uniqueName } from "../music-core.mjs";
import { find, listAll, mediaPath, readJson, remove, writeFile, writeJson } from "./r2.mjs";

const META = /^music\/([a-f0-9]{16})\.json$/;
const STEP = /^jobs\/([\w-]+)\/(queued|running|done|error)\.json$/;
// A job that hasn't finished by now died with its function (the limit is 300 s).
const STALE_MS = 6 * 60_000;

const notFound = () => Object.assign(new Error("No such track"), { status: 404 });

export const listTracks = async () => {
  const items = (await listAll("music/")).filter((o) => META.test(o.key));
  const metas = await Promise.all(items.map((o) => readJson(o.key)));
  return metas
    .filter((m) => m?.audioKey)
    .map((m) => trackReply(m, mediaPath(m.audioKey)))
    .sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1));
};

// Content-addressed, so the same audio is stored once.
export const store = async (buf, ext, meta) => {
  const id = crypto.createHash("sha1").update(buf).digest("hex").slice(0, 16);
  if (await find(`music/${id}.json`)) return readJson(`music/${id}.json`);
  const audio = await writeFile(`music/${id}${ext}`, buf, AUDIO_TYPE[ext] ?? "application/octet-stream");
  const full = { id, file: `${id}${ext}`, audioKey: audio.key, bytes: buf.length, addedAt: new Date().toISOString(), ...meta };
  await writeJson(`music/${id}.json`, full);
  return full;
};

export const saveUpload = async (name, buf) => {
  const ext = path.extname(name).toLowerCase();
  if (!AUDIO_EXT.has(ext)) throw Object.assign(new Error(`Unsupported audio type "${ext || name}"`), { status: 400 });
  const m = await store(buf, ext, { name, source: "upload" });
  return trackReply(m, mediaPath(m.audioKey));
};

export const removeTrack = async (id) => {
  if (!/^[a-f0-9]{16}$/.test(id) || !(await find(`music/${id}.json`))) throw notFound();
  const m = await readJson(`music/${id}.json`);
  await remove([`music/${id}.json`, m.audioKey]);
};

/* Jobs */

const stepKey = (id, step) => `jobs/${id}/${step}.json`;

const run = async (client, job) => {
  const startedAt = Date.now();
  await writeJson(stepKey(job.id, "running"), { startedAt });
  try {
    const { audio, retries } = await client.composeMusic({ plan: job.resolved.plan, prompt: job.resolved.prompt, lengthMs: job.resolved.lengthMs, seed: job.spec.seed });
    const names = (await listTracks()).map((t) => t.name);
    const meta = await store(audio, ".mp3", madeTrackMeta(job, uniqueName(job.resolved.name, names)));
    await writeJson(stepKey(job.id, "done"), { trackId: meta.id, name: meta.name, retries, doneAt: Date.now() });
  } catch (err) {
    await writeJson(stepKey(job.id, "error"), { error: err.message, suggestion: err.suggestion ?? null, doneAt: Date.now() });
  }
};

// Two at a time, like the local queue, so ElevenLabs doesn't rate-limit a batch.
const runAll = async (client, jobs) => {
  const queue = [...jobs];
  await Promise.all(
    [0, 1].map(async () => {
      while (queue.length) await run(client, queue.shift());
    }),
  );
};

const enqueueMany = async (client, specs) => {
  const jobs = specs.map((spec) => ({ id: `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`, state: "queued", spec, resolved: resolveSpec(spec), createdAt: Date.now() }));
  await Promise.all(jobs.map((j) => writeJson(stepKey(j.id, "queued"), { spec: j.spec, resolved: j.resolved, createdAt: j.createdAt })));
  if (jobs.length) waitUntil(runAll(client, jobs));
  return jobs.map(publicJob);
};

export const enqueue = async (client, spec) => (await enqueueMany(client, [spec]))[0];

export const listJobs = async () => {
  const steps = new Map();
  for (const o of await listAll("jobs/")) {
    const m = o.key.match(STEP);
    if (!m) continue;
    if (!steps.has(m[1])) steps.set(m[1], {});
    steps.get(m[1])[m[2]] = o;
  }
  const dayAgo = Date.now() - 86_400_000;
  const old = [];
  const jobs = await Promise.all(
    [...steps].map(async ([id, s]) => {
      if (!s.queued) return null;
      if (s.queued.uploadedAt.getTime() < dayAgo) {
        old.push(...Object.values(s).map((o) => o.key));
        return null;
      }
      const [q, r, end] = await Promise.all([readJson(s.queued.key), s.running ? readJson(s.running.key) : null, s.done || s.error ? readJson((s.done ?? s.error).key) : null]);
      if (!q) return null;
      let state = s.done ? "done" : s.error ? "error" : s.running ? "running" : "queued";
      let error = end?.error ?? null;
      if ((state === "queued" || state === "running") && Date.now() - q.createdAt > STALE_MS) {
        state = "error";
        error = "Timed out before ElevenLabs finished. Try again.";
      }
      return publicJob({
        id,
        state,
        spec: q.spec,
        resolved: { ...q.resolved, name: end?.name ?? q.resolved.name },
        createdAt: q.createdAt,
        startedAt: r?.startedAt,
        doneAt: end?.doneAt,
        trackId: end?.trackId,
        error,
        suggestion: end?.suggestion,
        retries: end?.retries,
      });
    }),
  );
  if (old.length) waitUntil(remove(old).catch(() => {}));
  return jobs
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 60);
};

// Queues whatever part of the starter library doesn't exist yet.
export const queueStarter = async (client) => {
  const [tracks, jobs] = await Promise.all([listTracks(), listJobs()]);
  const busy = new Set(jobs.filter((j) => j.state === "queued" || j.state === "running").map((j) => j.starterKey).filter(Boolean));
  return enqueueMany(client, missingStarter(tracks, busy));
};
