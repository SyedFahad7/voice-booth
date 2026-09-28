import { spawn } from "node:child_process";

export const createFfmpeg = (bin) => {
  if (!bin) return null;

  // `-n` refuses to overwrite: every output path the booth writes is new.
  const run = (args) =>
    new Promise((resolve, reject) => {
      const child = spawn(bin, ["-hide_banner", "-nostdin", "-v", "error", "-n", ...args], { windowsHide: true });
      let err = "";
      child.stderr.on("data", (d) => (err += d));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}: ${err.trim().slice(-800)}`))));
    });

  let aac = null;
  const aacEncoder = () => {
    aac ??= new Promise((resolve) => {
      const child = spawn(bin, ["-hide_banner", "-encoders"], { windowsHide: true });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.on("error", () => resolve("aac"));
      child.on("close", () => resolve(/\slibfdk_aac\s/.test(out) ? "libfdk_aac" : "aac"));
    });
    return aac;
  };

  return {
    bin,
    run,
    toWav: (input, output, { channels = 1, rate = 48000 } = {}) =>
      run(["-i", input, "-vn", "-ac", String(channels), "-ar", String(rate), "-c:a", "pcm_s16le", output]),
    // The decoded audio as WAV bytes, without touching the disk.
    pcm: (input, { channels = 1, rate = 48000 } = {}) =>
      new Promise((resolve, reject) => {
        const args = ["-hide_banner", "-nostdin", "-v", "error", "-i", input, "-vn", "-ac", String(channels), "-ar", String(rate), "-c:a", "pcm_s16le", "-f", "wav", "pipe:1"];
        const child = spawn(bin, args, { windowsHide: true });
        const chunks = [];
        let err = "";
        child.stdout.on("data", (c) => chunks.push(c));
        child.stderr.on("data", (d) => (err += d));
        child.on("error", reject);
        child.on("close", (code) => (code === 0 ? resolve(new Uint8Array(Buffer.concat(chunks))) : reject(new Error(`ffmpeg exited with ${code}: ${err.trim().slice(-800)}`))));
      }),
    mux: async (video, audio, output) =>
      run([
        "-i", video,
        "-i", audio,
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-c:v", "copy",
        "-c:a", await aacEncoder(),
        "-b:a", "256k",
        "-ar", "48000",
        "-shortest",
        "-movflags", "+faststart",
        output,
      ]),
  };
};
