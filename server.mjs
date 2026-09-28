// Voice booth: try ElevenLabs voices on a finished video without re-rendering it.
//   node server.mjs        then open http://localhost:4455
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { BOOTH, DIRS, findFfmpeg, findKey, relaunchWithSystemCa, slug, stamp } from "./lib/config.mjs";
import { createEleven, speechBody } from "./lib/eleven.mjs";
import { createFfmpeg } from "./lib/ffmpeg.mjs";
import * as music from "./lib/music.mjs";
import { createUpload, findProject, listProjects } from "./lib/projects.mjs";

const PORT = Number(process.env.PORT ?? 4455);
const HOST = "127.0.0.1";
const PUBLIC = path.join(BOOTH, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".png": "image/png",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".flac": "audio/flac",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const keyInfo = findKey();
const eleven = keyInfo.key ? createEleven(keyInfo.key) : null;
const ffmpeg = createFfmpeg(findFfmpeg());
if (eleven) music.setClient(eleven);

const memo = new Map();
const cached = async (name, ttl, fn) => {
  const hit = memo.get(name);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await fn();
  memo.set(name, { at: Date.now(), value });
  return value;
};

const needEleven = () => {
  if (!eleven) throw new HttpError(400, "No ElevenLabs key found. Put ELEVENLABS_API_KEY=... in voice-booth/.env and restart.");
  return eleven;
};
const needFfmpeg = () => {
  if (!ffmpeg) throw new HttpError(500, "No ffmpeg found. Install it or set FFMPEG_PATH.");
  return ffmpeg;
};

const readBody = async (req, limit = 5 << 20) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "Request too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};
const readJson = async (req) => {
  const raw = await readBody(req);
  try {
    return raw.length ? JSON.parse(raw.toString("utf8")) : {};
  } catch {
    throw new HttpError(400, "Body is not JSON");
  }
};
const readJsonFile = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const sendJson = (res, status, data) => {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
};

const sendFile = (req, res, file) => {
  const stat = fs.statSync(file);
  const headers = {
    "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
  };
  const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
    let end = range[1] && range[2] ? Number(range[2]) : stat.size - 1;
    end = Math.min(end, stat.size - 1);
    if (start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Content-Length": end - start + 1 });
    if (req.method === "HEAD") return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, "Content-Length": stat.size });
  if (req.method === "HEAD") return res.end();
  return fs.createReadStream(file).pipe(res);
};

const projectOr404 = (id) => {
  const p = findProject(id);
  if (!p) throw new HttpError(404, `No project "${id}"`);
  return p;
};

const jobs = new Map();

// What the page sees: URLs instead of disk paths.
const clientProject = (p) => {
  const job = jobs.get(p.id);
  return {
    id: p.id,
    kind: p.kind,
    title: p.title,
    group: p.group,
    video: {
      url: `/media/${p.id}/video`,
      name: path.basename(p.video.path),
      width: p.video.width ?? null,
      height: p.video.height ?? null,
      duration: p.video.duration ?? null,
    },
    bed: p.bed ? { url: `/media/${p.id}/bed`, name: path.basename(p.bed.path), stale: Boolean(p.bed.stale) } : null,
    canBuildBed: typeof p.buildBed === "function",
    canSaveTake: typeof p.saveTake === "function",
    voiceGain: p.voiceGain ?? 1,
    original: p.original ?? null,
    sections: (p.sections ?? []).map((s, i) => ({
      id: s.id,
      text: s.text,
      delivery: s.delivery ?? null,
      settings: s.settings ?? null,
      seed: s.seed ?? 1842 + i,
      at: s.at ?? null,
      orig: s.orig?.chars ? { url: s.orig.path ? `/media/${p.id}/orig/${i}` : null, chars: s.orig.chars, starts: s.orig.starts, ends: s.orig.ends } : null,
    })),
    takes: (p.takes ?? []).map((t, ti) => ({
      track: t.track,
      voiceId: t.voiceId,
      modelId: t.modelId,
      speed: t.speed,
      sections: t.sections
        .filter((s) => s.chars)
        .map((s) => ({ id: s.id, index: t.sections.indexOf(s), url: `/media/${p.id}/take/${ti}/${t.sections.indexOf(s)}`, chars: s.chars, starts: s.starts, ends: s.ends })),
    })),
    handoff: p.handoff ? { script: p.handoff.script, command: p.handoff.command, cwd: path.basename(p.handoff.cwd) } : null,
    bedJob: job ? { state: job.state, log: job.log.slice(-6), error: job.error ?? null } : null,
    warnings: p.warnings ?? [],
  };
};

const inflight = new Map();
const checking = new Map();

const generate = async (key, voiceId, body) => {
  const t0 = Date.now();
  const { out, attempt } = await needEleven().speak(voiceId, body);
  const a = out.alignment ?? out.normalized_alignment;
  if (!a) throw new HttpError(502, "ElevenLabs returned no timing for this take");
  const mp3 = path.join(DIRS.tts, `${key}.mp3`);
  const wav = path.join(DIRS.tts, `${key}.wav`);
  if (!fs.existsSync(mp3)) fs.writeFileSync(mp3, Buffer.from(out.audio_base64, "base64"));
  if (!fs.existsSync(wav)) await needFfmpeg().toWav(mp3, wav);
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
    ms: Date.now() - t0,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(DIRS.tts, `${key}.json`), JSON.stringify(meta), { flag: "wx" });
  return meta;
};

const takeReply = (m, cached) => ({
  key: m.key,
  audio: `/cache/tts/${m.key}.wav`,
  chars: m.chars,
  starts: m.starts,
  ends: m.ends,
  attempt: m.attempt,
  ms: m.ms,
  cached,
});

const extractAudio = async (p) => {
  const stat = fs.statSync(p.video.path);
  const out = path.join(DIRS.extract, `${slug(p.id)}-${Math.round(stat.mtimeMs)}.wav`);
  if (!fs.existsSync(out)) {
    try {
      await needFfmpeg().toWav(p.video.path, out, { channels: 2 });
    } catch {
      throw new HttpError(404, "This video has no audio track");
    }
  }
  return out;
};

const routes = [
  [
    "GET",
    /^\/api\/status$/,
    async () => {
      let subscription = null;
      if (eleven) subscription = await cached("subscription", 60_000, () => eleven.subscription()).catch((err) => ({ error: err.message }));
      return { key: Boolean(keyInfo.key), keySource: keyInfo.source, ffmpeg: ffmpeg?.bin ?? null, subscription };
    },
  ],
  [
    "GET",
    /^\/api\/projects$/,
    async () => listProjects().map((p) => ({ id: p.id, title: p.title, group: p.group, kind: p.kind, voiceId: p.original?.voiceId ?? null })),
  ],
  ["GET", /^\/api\/projects\/([\w.-]+)$/, async (req, m) => clientProject(projectOr404(m[1]))],
  [
    "POST",
    /^\/api\/projects\/([\w.-]+)\/bed$/,
    async (req, m) => {
      const p = projectOr404(m[1]);
      if (!p.buildBed) throw new HttpError(400, "This project can't build its own music bed");
      if (jobs.get(p.id)?.state === "running") return { state: "running" };
      const job = { state: "running", log: [], startedAt: Date.now() };
      jobs.set(p.id, job);
      p.buildBed((line) => {
        job.log.push(line);
        if (job.log.length > 200) job.log.shift();
      })
        .then(() => {
          job.state = "done";
          listProjects();
        })
        .catch((err) => {
          job.state = "error";
          job.error = err.message;
        });
      return { state: "running" };
    },
  ],
  [
    "POST",
    /^\/api\/upload$/,
    async (req, m, url) => {
      const name = url.searchParams.get("name") ?? "video.mp4";
      const project = await createUpload(name, req);
      return { id: project.id };
    },
  ],
  [
    "GET",
    /^\/api\/voices$/,
    async (req, m, url) => {
      if (url.searchParams.has("fresh")) memo.delete("voices");
      return cached("voices", 5 * 60_000, () => needEleven().voices());
    },
  ],
  ["GET", /^\/api\/models$/, async () => cached("models", 60 * 60_000, () => needEleven().models())],
  [
    "GET",
    /^\/api\/library$/,
    async (req, m, url) =>
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
    async (req) => {
      const { ownerId, voiceId, name } = await readJson(req);
      if (!ownerId || !voiceId) throw new HttpError(400, "ownerId and voiceId are required");
      const added = await needEleven().addShared(ownerId, voiceId, name ?? voiceId);
      memo.delete("voices");
      return { voiceId: added.voice_id ?? voiceId };
    },
  ],
  [
    "POST",
    /^\/api\/tts$/,
    async (req) => {
      const b = await readJson(req);
      if (!b.voiceId || !b.modelId || !String(b.text ?? "").trim()) throw new HttpError(400, "voiceId, modelId and text are required");
      const body = speechBody(b);
      const key = crypto.createHash("sha256").update(JSON.stringify([b.voiceId, body])).digest("hex").slice(0, 32);
      const metaFile = path.join(DIRS.tts, `${key}.json`);
      if (fs.existsSync(metaFile)) return takeReply(readJsonFile(metaFile), true);
      if (b.cacheOnly) throw new HttpError(404, "Not cached");
      if (!inflight.has(key)) inflight.set(key, generate(key, b.voiceId, body).finally(() => inflight.delete(key)));
      return takeReply(await inflight.get(key), false);
    },
  ],
  [
    "POST",
    /^\/api\/check$/,
    async (req) => {
      const b = await readJson(req);
      let file;
      let id;
      if (b.key) {
        if (!/^[a-f0-9]{32}$/.test(b.key)) throw new HttpError(400, "Bad take key");
        file = path.join(DIRS.tts, `${b.key}.mp3`);
        id = b.key;
      } else {
        file = projectOr404(b.project).takes?.[Number(b.take)]?.sections?.[Number(b.section)]?.path;
        if (!file || !fs.existsSync(file)) throw new HttpError(404, "No such take");
        id = crypto.createHash("sha256").update(`${file}|${fs.statSync(file).mtimeMs}`).digest("hex").slice(0, 32);
      }
      if (!fs.existsSync(file)) throw new HttpError(404, "Take audio not found");
      const out = path.join(DIRS.stt, `${id}.json`);
      if (fs.existsSync(out)) return readJsonFile(out);
      if (!checking.has(id)) {
        const job = (async () => {
          const r = await needEleven().transcribe(fs.readFileSync(file), path.basename(file), { keyterms: (b.keyterms ?? []).slice(0, 20) });
          if (!fs.existsSync(out)) fs.writeFileSync(out, JSON.stringify(r), { flag: "wx" });
          return r;
        })();
        checking.set(id, job.finally(() => checking.delete(id)));
      }
      return checking.get(id);
    },
  ],
  [
    "POST",
    /^\/api\/music$/,
    async (req, m, url) => music.saveUpload(path.basename(url.searchParams.get("name") ?? "music.mp3"), await readBody(req, 300 << 20)),
  ],
  ["GET", /^\/api\/music$/, async () => ({ tracks: music.listTracks(), starter: music.starterStatus() })],
  ["POST", /^\/api\/music\/generate$/, async (req) => music.enqueue(await readJson(req))],
  ["POST", /^\/api\/music\/starter$/, async () => ({ queued: music.queueStarter().length, starter: music.starterStatus() })],
  ["GET", /^\/api\/music\/jobs$/, async () => music.listJobs()],
  [
    "DELETE",
    /^\/api\/music\/([a-f0-9]{16})$/,
    async (req, m) => {
      music.removeTrack(m[1]);
      return { ok: true };
    },
  ],
  [
    "POST",
    /^\/api\/export$/,
    async (req, m, url) => {
      const p = projectOr404(url.searchParams.get("project"));
      const label = slug(url.searchParams.get("label") ?? "voice");
      const tag = stamp();
      const wav = path.join(DIRS.work, `mix-${tag}-${label}.wav`);
      await pipeline(req, fs.createWriteStream(wav, { flags: "wx" }));
      const file = `${slug(p.id)}__${label}__${tag}.mp4`;
      const out = path.join(DIRS.exports, file);
      await needFfmpeg().mux(p.video.path, wav, out);
      fs.promises.unlink(wav).catch(() => {});
      return { file, url: `/exports/${encodeURIComponent(file)}`, path: out, mb: Number((fs.statSync(out).size / 1048576).toFixed(1)) };
    },
  ],
  [
    "POST",
    /^\/api\/handoff$/,
    async (req) => {
      const b = await readJson(req);
      const p = projectOr404(b.project);
      if (!p.saveTake) throw new HttpError(400, "This project doesn't take handoffs");
      const sections = (b.sections ?? []).map((s) => {
        if (!/^[a-f0-9]{32}$/.test(s.key ?? "")) throw new HttpError(400, `Section ${s.id} has no generated take`);
        const meta = readJsonFile(path.join(DIRS.tts, `${s.key}.json`));
        const c = s.clean;
        const clean =
          Array.isArray(c?.chars) &&
          c.chars.length === c.starts?.length &&
          c.chars.length === c.ends?.length &&
          c.chars.every((x) => typeof x === "string") &&
          [...c.starts, ...c.ends].every(Number.isFinite);
        const t = clean ? c : meta;
        return { id: s.id, mp3: path.join(DIRS.tts, `${s.key}.mp3`), chars: t.chars, starts: t.starts, ends: t.ends };
      });
      try {
        return p.saveTake({ track: b.track, voiceId: b.voiceId, modelId: b.modelId, speed: b.speed, sections });
      } catch (err) {
        throw new HttpError(400, err.message);
      }
    },
  ],
  [
    "POST",
    /^\/api\/reveal$/,
    async (req) => {
      const { file } = await readJson(req);
      const target = path.join(DIRS.exports, path.basename(String(file ?? "")));
      if (!fs.existsSync(target)) throw new HttpError(404, "No such export");
      if (process.platform === "win32") spawn("explorer.exe", [`/select,${target}`], { detached: true, stdio: "ignore" }).unref();
      else spawn(process.platform === "darwin" ? "open" : "xdg-open", [path.dirname(target)], { detached: true, stdio: "ignore" }).unref();
      return { ok: true };
    },
  ],
];

const mediaRoute = async (req, res, pathname) => {
  let m = pathname.match(/^\/media\/([\w.-]+)\/(video|bed|video-audio)$/);
  if (m) {
    const p = projectOr404(m[1]);
    const file = m[2] === "video" ? p.video.path : m[2] === "bed" ? p.bed?.path : await extractAudio(p);
    if (!file || !fs.existsSync(file)) throw new HttpError(404, "Not found");
    return sendFile(req, res, file);
  }
  m = pathname.match(/^\/media\/([\w.-]+)\/orig\/(\d+)$/);
  if (m) {
    const file = projectOr404(m[1]).sections?.[Number(m[2])]?.orig?.path;
    if (!file || !fs.existsSync(file)) throw new HttpError(404, "Not found");
    return sendFile(req, res, file);
  }
  m = pathname.match(/^\/media\/([\w.-]+)\/take\/(\d+)\/(\d+)$/);
  if (m) {
    const file = projectOr404(m[1]).takes?.[Number(m[2])]?.sections?.[Number(m[3])]?.path;
    if (!file || !fs.existsSync(file)) throw new HttpError(404, "Not found");
    return sendFile(req, res, file);
  }
  m = pathname.match(/^\/cache\/tts\/([a-f0-9]{32}\.(?:wav|mp3))$/);
  if (m) return sendFile(req, res, path.join(DIRS.tts, m[1]));
  m = pathname.match(/^\/music\/([a-f0-9]{16}\.[a-z0-9]+)$/);
  if (m) {
    const file = path.join(DIRS.music, m[1]);
    if (!fs.existsSync(file)) throw new HttpError(404, "Not found");
    return sendFile(req, res, file);
  }
  m = pathname.match(/^\/exports\/([^/]+)$/);
  if (m) {
    const file = path.join(DIRS.exports, path.basename(decodeURIComponent(m[1])));
    if (!fs.existsSync(file)) throw new HttpError(404, "Not found");
    return sendFile(req, res, file);
  }
  return false;
};

const staticRoute = (req, res, pathname) => {
  if (pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return true;
  }
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  sendFile(req, res, file);
  return true;
};

const handle = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  try {
    for (const [method, pattern, fn] of routes) {
      const m = url.pathname.match(pattern);
      if (m && req.method === method) return sendJson(res, 200, await fn(req, m, url));
    }
    if (req.method === "GET" || req.method === "HEAD") {
      if ((await mediaRoute(req, res, url.pathname)) !== false) return;
      if (staticRoute(req, res, url.pathname)) return;
    }
    throw new HttpError(404, "Not found");
  } catch (err) {
    if (res.headersSent) return res.destroy(err);
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) console.error(err);
    sendJson(res, status, { error: err.message });
  }
};

const start = () => {
  listProjects();
  const server = http.createServer(handle);
  server.on("error", (err) => {
    if (err.code !== "EADDRINUSE") throw err;
    console.log(`Voice booth is already running at http://localhost:${PORT}`);
    process.exit(0);
  });
  server.listen(PORT, HOST, () => {
    console.log(`Voice booth on http://localhost:${PORT}`);
    console.log(`  ElevenLabs key: ${keyInfo.key ? `from ${keyInfo.source}` : "missing (add ELEVENLABS_API_KEY to voice-booth/.env)"}`);
    console.log(`  ffmpeg: ${ffmpeg?.bin ?? "missing"}`);
  });
};

if (!(await relaunchWithSystemCa())) start();
