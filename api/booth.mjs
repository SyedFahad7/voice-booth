// The hosted voice booth. Every /api and /media request lands here (see vercel.json) and gets the
// same answers the local server.mjs gives, with Cloudflare R2 in place of the disk and ffmpeg-static
// in place of Remotion's ffmpeg. Everything but signing in needs the BOOTH_PASSWORD session.
//
// Projects are bundles published from a machine with the video project (tools/publish.mjs: the
// render, the voice-free bed, the original lines and their timing) or plain uploaded videos.
// A take picked here goes back to the video project through tools/picks.mjs.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import ffmpegPath from "ffmpeg-static";
import { createEleven, speechBody } from "../lib/eleven.mjs";
import { createFfmpeg } from "../lib/ffmpeg.mjs";
import { hasPassword, signIn, signOut, signedIn } from "../lib/hosted/auth.mjs";
import * as music from "../lib/hosted/music.mjs";
import { find, listAll, openFile, randomName, readJson, remove, signedPutUrl, signedUrl, storageReady, writeFile, writeJson } from "../lib/hosted/r2.mjs";
import { AUDIO_EXT, starterStatus } from "../lib/music-core.mjs";
import { slug, stamp } from "../lib/names.mjs";

const VIDEO_TYPE = { ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska" };
// Big files go from the browser straight to storage through signed links; the function only ever
// sees small JSON bodies (Vercel refuses request bodies over 4.5 MB).
const MAX_VIDEO = 2 << 30;
const TMP = path.join(os.tmpdir(), "voice-booth");

const eleven = process.env.ELEVENLABS_API_KEY ? createEleven(process.env.ELEVENLABS_API_KEY) : null;
// ffmpeg-static downloads its binary in an install script, which npm only runs when allowed.
const ffmpeg = ffmpegPath && fs.existsSync(ffmpegPath) ? createFfmpeg(ffmpegPath) : null;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } });

const readBody = async (request) => {
  const text = await request.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, "Body is not JSON");
  }
};

const needEleven = () => {
  if (!eleven) throw new HttpError(400, "No ElevenLabs key. Add ELEVENLABS_API_KEY to the Vercel project's environment variables and redeploy.");
  return eleven;
};
const needFfmpeg = () => {
  if (!ffmpeg) throw new HttpError(500, "This deployment has no ffmpeg. Check that package.json allows ffmpeg-static's install script, then redeploy.");
  return ffmpeg;
};

const tmpFile = (name) => {
  fs.mkdirSync(TMP, { recursive: true });
  return path.join(TMP, randomName(name));
};
const dropTmp = (...files) => files.forEach((f) => fs.promises.unlink(f).catch(() => {}));

const memo = new Map();
const cached = async (name, ttl, fn) => {
  const hit = memo.get(name);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await fn();
  memo.set(name, { at: Date.now(), value });
  return value;
};

/* Projects: published bundles (bd-…) and uploaded videos (up-…, with the script saved beside them) */

const projectOr404 = async (id) => {
  const p = /^bd-[\w.-]+$/.test(id ?? "") ? await readJson(`bundles/${id}/bundle.json`) : /^up-[\w.-]+$/.test(id ?? "") ? await readJson(`projects/${id}.json`) : null;
  if (!p) throw new HttpError(404, `No project "${id}"`);
  return p;
};

const latestScript = async (id) => {
  const versions = (await listAll(`projects/${id}/script-`)).sort((a, b) => (a.key < b.key ? 1 : -1));
  return versions.length ? readJson(versions[0].key) : null;
};

const day = (iso) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

const listProjects = async () => {
  const [bundleKeys, uploadKeys] = await Promise.all([listAll("bundles/"), listAll("projects/")]);
  const [bundles, uploads] = await Promise.all([
    Promise.all(bundleKeys.filter((o) => /^bundles\/bd-[\w.-]+\/bundle\.json$/.test(o.key)).map((o) => readJson(o.key))),
    Promise.all(uploadKeys.filter((o) => /^projects\/up-[\w.-]+\.json$/.test(o.key)).map((o) => readJson(o.key))),
  ]);
  return [
    ...bundles
      .filter(Boolean)
      .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1))
      .map((m) => ({ id: m.id, title: `${m.title} · published ${day(m.publishedAt)}`, group: m.group, kind: "bundle", voiceId: m.original?.voiceId ?? null })),
    ...uploads
      .filter(Boolean)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((p) => ({ id: p.id, title: p.title, group: "Uploaded videos", kind: "upload", voiceId: null })),
  ];
};

// What the page sees: signed links instead of storage keys.
const clientProject = async (p) => {
  const video = { url: await signedUrl(p.video.key), name: p.video.name, width: p.video.width ?? null, height: p.video.height ?? null, duration: p.video.duration ?? null };
  const base = { id: p.id, video, canBuildBed: false, canSaveTake: false, handoff: null, bedJob: null };
  if (p.kind !== "bundle") {
    return { ...base, kind: "upload", title: p.title, group: "Uploaded videos", bed: null, voiceGain: 1, original: null, sections: [], takes: [], warnings: [], script: (await latestScript(p.id))?.sections ?? null };
  }
  const sign = (key) => (key ? signedUrl(key) : null);
  return {
    ...base,
    kind: "bundle",
    title: p.title,
    group: p.group,
    bed: p.bed ? { url: await sign(p.bed.key), name: p.bed.name, stale: false } : null,
    canPick: true,
    pickTrack: p.source?.handoff?.script ?? null,
    voiceGain: p.voiceGain ?? 1,
    original: p.original ?? null,
    sections: await Promise.all(p.sections.map(async (s) => ({ ...s, orig: s.orig ? { url: await sign(s.orig.key), chars: s.orig.chars, starts: s.orig.starts, ends: s.orig.ends } : null }))),
    takes: await Promise.all((p.takes ?? []).map(async (t) => ({ ...t, sections: await Promise.all(t.sections.map(async ({ key, ...s }) => ({ ...s, url: await sign(key) }))) }))),
    warnings: p.warnings ?? [],
    publishedAt: p.publishedAt,
  };
};

// The video in this instance's /tmp, for ffmpeg. Fetched once per instance.
const localVideo = async (p) => {
  const file = path.join(TMP, p.id, `video${path.extname(p.video.name).toLowerCase() || ".mp4"}`);
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const res = await openFile(p.video.key);
  if (!res.ok) throw new HttpError(502, "Couldn't read the video from storage");
  const part = `${file}.part`;
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(part));
  fs.renameSync(part, file);
  return file;
};

const readObject = async (key) => {
  const res = await openFile(key);
  if (!res.ok) throw new HttpError(502, "Couldn't read audio from storage");
  return Buffer.from(await res.arrayBuffer());
};

/* Speech */

const ttsReply = async (m, cached) => ({ key: m.key, audio: await signedUrl(m.audioKey), chars: m.chars, starts: m.starts, ends: m.ends, attempt: m.attempt, ms: m.ms, cached });

// The WAV is what the page plays; the MP3 is ElevenLabs' own file, which a picked take carries
// back to the video project.
const generate = async (key, voiceId, body) => {
  const t0 = Date.now();
  const { out, attempt } = await needEleven().speak(voiceId, body);
  const a = out.alignment ?? out.normalized_alignment;
  if (!a) throw new HttpError(502, "ElevenLabs returned no timing for this take");
  const mp3 = tmpFile(`${key}.mp3`);
  const wav = tmpFile(`${key}.wav`);
  try {
    const bytes = Buffer.from(out.audio_base64, "base64");
    fs.writeFileSync(mp3, bytes);
    await needFfmpeg().toWav(mp3, wav);
    await Promise.all([writeFile(`tts/${key}.wav`, fs.readFileSync(wav), "audio/wav"), writeFile(`tts/${key}.mp3`, bytes, "audio/mpeg")]);
    const meta = {
      key,
      voiceId,
      modelId: body.model_id,
      text: body.text,
      voiceSettings: body.voice_settings,
      seed: body.seed,
      attempt,
      chars: a.characters,
      starts: a.character_start_times_seconds,
      ends: a.character_end_times_seconds,
      audioKey: `tts/${key}.wav`,
      mp3Key: `tts/${key}.mp3`,
      ms: Date.now() - t0,
      createdAt: new Date().toISOString(),
    };
    await writeJson(`tts/${key}.json`, meta);
    return meta;
  } finally {
    dropTmp(mp3, wav);
  }
};

/* Routes */

const LOCAL_ONLY = "That only works in the booth running on your own computer.";

const routes = [
  [
    "POST",
    /^\/api\/login$/,
    async (request) => {
      if (!hasPassword()) throw new HttpError(503, "Set BOOTH_PASSWORD in the Vercel project's environment variables first.");
      const { password } = await readBody(request);
      const cookie = signIn(password);
      if (!cookie) {
        await new Promise((r) => setTimeout(r, 800));
        throw new HttpError(401, "That password isn't right.");
      }
      return json({ ok: true }, 200, { "Set-Cookie": cookie });
    },
  ],
  ["POST", /^\/api\/logout$/, async () => json({ ok: true }, 200, { "Set-Cookie": signOut() })],
  [
    "GET",
    /^\/api\/status$/,
    async () => {
      const subscription = eleven ? await cached("subscription", 60_000, () => eleven.subscription()).catch((err) => ({ error: err.message })) : null;
      return { key: Boolean(eleven), keySource: "Vercel environment", ffmpeg: ffmpeg ? "bundled" : null, storage: storageReady(), subscription, hosted: true };
    },
  ],
  ["GET", /^\/api\/projects$/, listProjects],
  ["GET", /^\/api\/projects\/([\w.-]+)$/, async (request, m) => clientProject(await projectOr404(m[1]))],
  [
    "PUT",
    /^\/api\/projects\/([\w.-]+)\/script$/,
    async (request, m) => {
      const p = await projectOr404(m[1]);
      if (p.kind === "bundle") throw new HttpError(400, "A published project's script comes from the video project");
      const { sections } = await readBody(request);
      if (!Array.isArray(sections)) throw new HttpError(400, "sections must be a list");
      await writeJson(`projects/${p.id}/script-${Date.now()}.json`, { sections, savedAt: new Date().toISOString() });
      return { ok: true };
    },
  ],
  ["POST", /^\/api\/projects\/([\w.-]+)\/bed$/, async () => Promise.reject(new HttpError(400, LOCAL_ONLY))],
  [
    "POST",
    /^\/api\/upload\/sign$/,
    async (request) => {
      const b = await readBody(request);
      const name = path.basename(String(b.name ?? "video.mp4"));
      const ext = path.extname(name).toLowerCase();
      if (!VIDEO_TYPE[ext]) throw new HttpError(400, `Unsupported video type "${ext || name}"`);
      if (Number(b.size) > MAX_VIDEO) throw new HttpError(413, "The hosted booth takes videos up to 2 GB.");
      const id = `up-${stamp()}-${slug(path.basename(name, ext))}-${crypto.randomBytes(3).toString("hex")}`;
      const key = `uploads/${id}/${randomName(`video${ext}`)}`;
      return { id, key, url: await signedPutUrl(key) };
    },
  ],
  [
    "POST",
    /^\/api\/upload\/finish$/,
    async (request) => {
      const b = await readBody(request);
      if (!/^up-[\w.-]+$/.test(b.id ?? "") || !String(b.key ?? "").startsWith(`uploads/${b.id}/`)) throw new HttpError(400, "Bad upload");
      const video = await find(b.key);
      if (!video) throw new HttpError(400, "The upload didn't arrive. Try again.");
      const name = path.basename(String(b.name ?? "video.mp4"));
      await writeJson(`projects/${b.id}.json`, { id: b.id, title: path.basename(name, path.extname(name)), video: { key: b.key, name, size: video.size }, createdAt: new Date().toISOString() });
      return { id: b.id };
    },
  ],
  [
    "GET",
    /^\/api\/voices$/,
    async (request, m, url) => {
      if (url.searchParams.has("fresh")) memo.delete("voices");
      return cached("voices", 5 * 60_000, () => needEleven().voices());
    },
  ],
  ["GET", /^\/api\/models$/, async () => cached("models", 60 * 60_000, () => needEleven().models())],
  [
    "GET",
    /^\/api\/library$/,
    async (request, m, url) =>
      needEleven().library({
        q: url.searchParams.get("q") ?? "",
        gender: url.searchParams.get("gender") ?? "",
        language: url.searchParams.get("language") || "en",
        page: Number(url.searchParams.get("page") ?? 0),
      }),
  ],
  [
    "POST",
    /^\/api\/library\/add$/,
    async (request) => {
      const { ownerId, voiceId, name } = await readBody(request);
      if (!ownerId || !voiceId) throw new HttpError(400, "ownerId and voiceId are required");
      const added = await needEleven().addShared(ownerId, voiceId, name ?? voiceId);
      memo.delete("voices");
      return { voiceId: added.voice_id ?? voiceId };
    },
  ],
  [
    "POST",
    /^\/api\/tts$/,
    async (request) => {
      const b = await readBody(request);
      if (!b.voiceId || !b.modelId || !String(b.text ?? "").trim()) throw new HttpError(400, "voiceId, modelId and text are required");
      const body = speechBody(b);
      const key = crypto.createHash("sha256").update(JSON.stringify([b.voiceId, body])).digest("hex").slice(0, 32);
      const hit = await readJson(`tts/${key}.json`);
      if (hit) return await ttsReply(hit, true);
      if (b.cacheOnly) throw new HttpError(404, "Not cached");
      return await ttsReply(await generate(key, b.voiceId, body), false);
    },
  ],
  [
    "POST",
    /^\/api\/check$/,
    async (request) => {
      const b = await readBody(request);
      let id;
      let audioKey;
      if (b.key) {
        if (!/^[a-f0-9]{32}$/.test(b.key)) throw new HttpError(400, "Bad take key");
        id = b.key;
        audioKey = async () => (await readJson(`tts/${b.key}.json`))?.audioKey;
      } else {
        // One of a published project's own voice takes.
        const p = await projectOr404(b.project);
        const key = p.takes?.[Number(b.take)]?.sections?.find((s) => s.index === Number(b.section))?.key;
        if (!key) throw new HttpError(404, "No such take");
        id = crypto.createHash("sha256").update(key).digest("hex").slice(0, 32);
        audioKey = async () => key;
      }
      const hit = await readJson(`stt/${id}.json`);
      if (hit) return hit;
      const key = await audioKey();
      if (!key) throw new HttpError(404, "Take audio not found");
      const r = await needEleven().transcribe(await readObject(key), path.basename(key), { keyterms: (b.keyterms ?? []).slice(0, 20) });
      await writeJson(`stt/${id}.json`, r);
      return r;
    },
  ],
  [
    "POST",
    /^\/api\/picks$/,
    async (request) => {
      const b = await readBody(request);
      const p = await projectOr404(b.project);
      if (p.kind !== "bundle") throw new HttpError(400, "Only a published project can take a pick back");
      const track = slug(b.track ?? "");
      if (!track || track === "take") throw new HttpError(400, "Give the track a name");
      if (!Array.isArray(b.sections) || b.sections.length !== p.sections.length) throw new HttpError(400, "A pick needs every line of the take");
      const sections = await Promise.all(
        b.sections.map(async (s, i) => {
          if (s.id !== p.sections[i].id || !/^[a-f0-9]{32}$/.test(s.key ?? "")) throw new HttpError(400, `Line ${i + 1} has no generated take`);
          const take = await readJson(`tts/${s.key}.json`);
          if (!take?.mp3Key) throw new HttpError(400, `Line ${i + 1} has no take audio; press ↻ on it and try again`);
          const c = s.clean;
          const clean = Array.isArray(c?.chars) && c.chars.length === c.starts?.length && c.chars.length === c.ends?.length && [...c.starts, ...c.ends].every(Number.isFinite);
          const t = clean ? c : take;
          return { id: s.id, key: s.key, mp3Key: take.mp3Key, chars: t.chars, starts: t.starts, ends: t.ends };
        }),
      );
      const pick = {
        id: `pk-${stamp()}-${crypto.randomBytes(3).toString("hex")}`,
        project: p.id,
        title: p.title,
        source: p.source,
        track,
        voiceId: String(b.voiceId ?? ""),
        modelId: String(b.modelId ?? ""),
        speed: Number(b.speed) || 1,
        note: String(b.note ?? "").slice(0, 500),
        createdAt: new Date().toISOString(),
        sections,
      };
      await writeJson(`picks/${pick.id}.json`, pick);
      return { id: pick.id, track };
    },
  ],
  [
    // The page hashes the file first, so a track already in the library isn't uploaded again.
    "POST",
    /^\/api\/music\/sign$/,
    async (request) => {
      const b = await readBody(request);
      const ext = path.extname(path.basename(String(b.name ?? ""))).toLowerCase();
      if (!AUDIO_EXT.has(ext)) throw new HttpError(400, `Unsupported audio type "${ext || b.name}"`);
      if (!/^[a-f0-9]{40}$/.test(b.sha1 ?? "")) throw new HttpError(400, "Missing the file's SHA-1");
      const id = b.sha1.slice(0, 16);
      const existing = await readJson(`music/${id}.json`);
      if (existing) return { track: await music.reply(existing) };
      return { id, ext, url: await signedPutUrl(`music/${id}${ext}`) };
    },
  ],
  ["POST", /^\/api\/music\/finish$/, async (request) => music.register(await readBody(request))],
  [
    "GET",
    /^\/api\/music$/,
    async () => {
      const tracks = await music.listTracks();
      return { tracks, starter: starterStatus(tracks) };
    },
  ],
  ["POST", /^\/api\/music\/generate$/, async (request) => music.enqueue(needEleven(), await readBody(request))],
  [
    "POST",
    /^\/api\/music\/starter$/,
    async () => {
      const queued = await music.queueStarter(needEleven());
      return { queued: queued.length, starter: starterStatus(await music.listTracks()) };
    },
  ],
  ["GET", /^\/api\/music\/jobs$/, async () => music.listJobs()],
  [
    "DELETE",
    /^\/api\/music\/([a-f0-9]{16})$/,
    async (request, m) => {
      await music.removeTrack(m[1]);
      return { ok: true };
    },
  ],
  [
    "POST",
    /^\/api\/export\/sign$/,
    async () => {
      const key = `mixes/${randomName("mix.wav")}`;
      return { key, url: await signedPutUrl(key) };
    },
  ],
  [
    // The page uploads its mix first (export/sign), then asks for the MP4.
    "POST",
    /^\/api\/export$/,
    async (request) => {
      const b = await readBody(request);
      const p = await projectOr404(b.project);
      if (!/^mixes\/[\w.-]+\.wav$/.test(b.mixKey ?? "")) throw new HttpError(400, "Upload the mix first");
      const label = slug(b.label ?? "voice");
      const file = `${slug(p.id)}__${label}__${stamp()}.mp4`;
      const [video, wav, out] = [await localVideo(p), tmpFile("mix.wav"), tmpFile(file)];
      try {
        const mix = await openFile(b.mixKey);
        if (!mix.ok) throw new HttpError(400, "The mix upload didn't arrive. Try again.");
        await pipeline(Readable.fromWeb(mix.body), fs.createWriteStream(wav));
        await needFfmpeg().mux(video, wav, out);
        const saved = await writeFile(`exports/${randomName(file)}`, fs.readFileSync(out), "video/mp4");
        return { file, url: await signedUrl(saved.key), download: await signedUrl(saved.key, { download: file }), mb: Number((saved.size / 1048576).toFixed(1)) };
      } finally {
        dropTmp(wav, out);
        remove(b.mixKey).catch(() => {});
      }
    },
  ],
  ["POST", /^\/api\/handoff$/, async () => Promise.reject(new HttpError(400, LOCAL_ONLY))],
  ["POST", /^\/api\/reveal$/, async () => Promise.reject(new HttpError(400, LOCAL_ONLY))],
  [
    "GET",
    /^\/media\/([\w.-]+)\/video-audio$/,
    async (request, m) => {
      const p = await projectOr404(m[1]);
      const key = `extract/${p.id}.wav`;
      if (!(await find(key))) {
        const out = tmpFile("audio.wav");
        const f = needFfmpeg();
        try {
          await f.toWav(await localVideo(p), out, { channels: 2 });
        } catch {
          throw new HttpError(404, "This video has no audio track");
        }
        await writeFile(key, fs.readFileSync(out), "audio/wav");
        dropTmp(out);
      }
      return new Response(null, { status: 302, headers: { Location: await signedUrl(key), "Cache-Control": "no-store" } });
    },
  ],
];

const OPEN = new Set(["POST /api/login", "POST /api/logout"]);

const handle = async (request) => {
  const url = new URL(request.url);
  const route = url.searchParams.get("route") || url.pathname;
  try {
    if (!OPEN.has(`${request.method} ${route}`) && !signedIn(request)) {
      return json({ error: hasPassword() ? "Sign in to use the booth." : "Set BOOTH_PASSWORD in the Vercel project's environment variables first.", signin: true }, 401);
    }
    for (const [method, pattern, fn] of routes) {
      const m = route.match(pattern);
      if (!m || request.method !== method) continue;
      const out = await fn(request, m, url);
      return out instanceof Response ? out : json(out);
    }
    throw new HttpError(404, "Not found");
  } catch (err) {
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) console.error(`${request.method} ${route}:`, err);
    return json({ error: err.message }, status);
  }
};

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
