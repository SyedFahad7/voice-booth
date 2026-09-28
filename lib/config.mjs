import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BOOTH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const WORKSPACE = path.resolve(BOOTH, "..");

export const DIRS = {
  tts: path.join(BOOTH, "cache", "tts"),
  stt: path.join(BOOTH, "cache", "stt"),
  extract: path.join(BOOTH, "cache", "extract"),
  music: path.join(BOOTH, "music"),
  lufs: path.join(BOOTH, "cache", "lufs"),
  stems: path.join(BOOTH, "stems"),
  exports: path.join(BOOTH, "exports"),
  uploads: path.join(BOOTH, "uploads"),
  work: path.join(BOOTH, "work"),
};
for (const dir of Object.values(DIRS)) fs.mkdirSync(dir, { recursive: true });

const subdirs = () =>
  fs
    .readdirSync(WORKSPACE, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules")
    .map((d) => path.join(WORKSPACE, d.name));

const keyIn = (file) => {
  try {
    const match = fs.readFileSync(file, "utf8").match(/^\s*ELEVENLABS_API_KEY\s*=\s*(.+?)\s*$/m);
    return match ? match[1].replace(/^["']|["']$/g, "") : null;
  } catch {
    return null;
  }
};

// The booth's own .env wins; otherwise reuse the key a video project already keeps.
export const findKey = () => {
  if (process.env.ELEVENLABS_API_KEY) return { key: process.env.ELEVENLABS_API_KEY, source: "environment" };
  const files = [path.join(BOOTH, ".env"), path.join(WORKSPACE, ".env"), ...subdirs().map((d) => path.join(d, ".env"))];
  for (const file of files) {
    const key = keyIn(file);
    if (key) return { key, source: path.relative(WORKSPACE, file).replaceAll("\\", "/") };
  }
  return { key: null, source: null };
};

const COMPOSITOR = {
  win32: "compositor-win32-x64-msvc",
  darwin: `compositor-darwin-${process.arch}`,
  linux: `compositor-linux-${process.arch}-gnu`,
};

// PATH first, then the ffmpeg that ships inside any Remotion project in the workspace, then the
// one `npm install` brings (ffmpeg-static).
export const findFfmpeg = () => {
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, exe))) return path.join(dir, exe);
  }
  for (const dir of subdirs()) {
    const candidate = path.join(dir, "node_modules", "@remotion", COMPOSITOR[process.platform] ?? "", exe);
    if (fs.existsSync(candidate)) return candidate;
  }
  try {
    const bundled = createRequire(import.meta.url)("ffmpeg-static");
    if (bundled && fs.existsSync(bundled)) return bundled;
  } catch {}
  return null;
};

// Node's fetch only trusts its bundled CAs unless told otherwise; antivirus TLS inspection on
// this kind of machine needs the OS store. Returns true when it relaunched, so the caller stops.
export const relaunchWithSystemCa = async () => {
  const needed =
    process.allowedNodeEnvironmentFlags.has("--use-system-ca") &&
    !process.execArgv.includes("--use-system-ca") &&
    !(process.env.NODE_OPTIONS ?? "").includes("--use-system-ca");
  if (!needed) return false;
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["--use-system-ca", ...process.execArgv, ...process.argv.slice(1)], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
  return true;
};

export { slug, stamp } from "./names.mjs";
