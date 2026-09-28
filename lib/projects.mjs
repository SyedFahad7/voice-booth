import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { DIRS, WORKSPACE, slug, stamp } from "./config.mjs";
import * as testImpact from "../adapters/test-impact.mjs";

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const VIDEO_EXT = new Set([".mp4", ".m4v", ".mov", ".webm", ".mkv"]);

const charsFrom = (orig) => orig.chars ?? (orig.text ? Array.from(orig.text) : null);

// A video project can register any render by writing out/<name>.voicemap.json next to it.
// Paths inside the file are relative to the file.
const voicemaps = () => {
  const out = [];
  for (const d of fs.readdirSync(WORKSPACE, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith(".") || d.name === "voice-booth") continue;
    const dir = path.join(WORKSPACE, d.name, "out");
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".voicemap.json"))) {
      const file = path.join(dir, name);
      try {
        const m = readJson(file);
        const rel = (p) => (p ? path.resolve(dir, p) : null);
        out.push({
          id: `vm-${slug(d.name)}-${slug(name.replace(/\.voicemap\.json$/, ""))}`,
          kind: "voicemap",
          group: d.name,
          title: m.title ?? name.replace(/\.voicemap\.json$/, ""),
          video: { ...m.video, path: rel(m.video.path) },
          bed: m.bed?.path ? { path: rel(m.bed.path), stale: false } : null,
          voiceGain: m.voiceGain ?? 1,
          original: m.original ?? null,
          sections: m.sections.map((s, i) => ({
            ...s,
            seed: s.seed ?? 1842 + i,
            orig: s.orig ? { path: rel(s.orig.path), chars: charsFrom(s.orig), starts: s.orig.starts, ends: s.orig.ends } : null,
          })),
          takes: [],
          warnings: [],
        });
      } catch (err) {
        console.warn(`Skipping ${file}: ${err.message}`);
      }
    }
  }
  return out;
};

const uploads = () =>
  fs
    .readdirSync(DIRS.uploads, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(DIRS.uploads, d.name, "project.json")))
    .map((d) => {
      const p = readJson(path.join(DIRS.uploads, d.name, "project.json"));
      return {
        ...p,
        kind: "upload",
        group: "Your videos",
        video: { ...p.video, path: path.join(DIRS.uploads, d.name, p.video.file) },
        bed: null,
        voiceGain: 1,
        original: null,
        sections: [],
        takes: [],
        warnings: [],
      };
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

let registry = new Map();

export const listProjects = () => {
  const all = [...testImpact.projects(), ...voicemaps(), ...uploads()].filter((p) => p.video?.path && fs.existsSync(p.video.path));
  registry = new Map(all.map((p) => [p.id, p]));
  return all;
};

export const findProject = (id) => registry.get(id) ?? (listProjects(), registry.get(id));

export const createUpload = async (name, stream) => {
  const ext = path.extname(name).toLowerCase();
  if (!VIDEO_EXT.has(ext)) throw new Error(`Unsupported video type "${ext || name}"`);
  const base = path.basename(name, ext);
  const id = `up-${stamp()}-${slug(base)}`;
  const dir = path.join(DIRS.uploads, id);
  fs.mkdirSync(dir, { recursive: true });
  await pipeline(stream, fs.createWriteStream(path.join(dir, `video${ext}`), { flags: "wx" }));
  const project = { id, title: base, video: { file: `video${ext}` }, createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify(project, null, 2), { flag: "wx" });
  listProjects();
  return project;
};
