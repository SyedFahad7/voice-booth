// Offline checks for the booth. No ElevenLabs calls.
//   node tools/selftest.mjs                   audio math and music plans (dsp + music)
//   node tools/selftest.mjs verify <project>  rebuild the video's audio from bed + original takes
//   node tools/selftest.mjs fit <project> <track> [anchor|tight|off]
//                                             lay another project take onto the picture, write an MP4
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DIRS, findFfmpeg, stamp } from "../lib/config.mjs";
import { createFfmpeg } from "../lib/ffmpeg.mjs";
import * as music from "../lib/music.mjs";
import { listProjects } from "../lib/projects.mjs";
import { SR, dbToGain, decodeWav, encodeWav, envelope, limit, loudness, mapTime, peak, phrases, planSection, renderVoice, speechSpan, timeStretch, wordRanges, wordTimes } from "../public/dsp.js";
import { cleanTiming, plainText, render } from "../public/markup.js";
import { PRESETS, presetPrompt } from "../public/music-presets.js";
import { MAX_CHUNK, MAX_CHUNKS, MIN_CHUNK, checkPlan, planForLength, planForVideo, planLength } from "../public/music-plan.js";
import { compareWords, keyterms, numberWords } from "../public/words.js";

const bin = findFfmpeg();
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
};

const decode = (file, channels = 1) =>
  new Promise((resolve, reject) => {
    const args = ["-hide_banner", "-nostdin", "-v", "error", "-i", file, "-vn", "-ac", String(channels), "-ar", String(SR), "-c:a", "pcm_s16le", "-f", "wav", "pipe:1"];
    const child = spawn(bin, args, { windowsHide: true });
    const chunks = [];
    let err = "";
    child.stdout.on("data", (c) => chunks.push(c));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(decodeWav(new Uint8Array(Buffer.concat(chunks)))) : reject(new Error(err.trim()))));
  });

const concat = (arrays) => {
  const out = new Float32Array(arrays.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrays) {
    out.set(a, o);
    o += a.length;
  }
  return out;
};

const rms = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / Math.max(1, x.length));
const db = (v) => 20 * Math.log10(Math.max(v, 1e-12));

const sine = (freq, seconds, amp) => {
  const x = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return x;
};

const crossings = (x) => {
  let n = 0;
  for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 && x[i] >= 0) n++;
  return n;
};

// Synthetic alignment: `pace` seconds per character, `pause` after each phrase break.
const fakeAlign = (text, pace, pause) => {
  const chars = Array.from(text);
  const starts = [];
  const ends = [];
  let t = 0.1;
  chars.forEach((c, i) => {
    starts.push(t);
    t += /[.,—]/.test(c) && /\s/.test(chars[i + 1] ?? " ") ? pause : pace;
    ends.push(t);
  });
  return { chars, starts, ends, length: t + 0.3 };
};

const dsp = () => {
  const p1 = phrases(Array.from("You changed one function. CI runs thirty thousand tests to check it."));
  check("phrases split at sentence ends", p1.length === 2, `${p1.length} phrases`);
  const p2 = phrases(Array.from("CI runs everything, every time — not because it should, but because it can't tell."));
  check("phrases split at commas and dashes", p2.length === 4, `${p2.length} phrases`);
  const p3 = phrases(Array.from("Graphify 0.9.67 mapped charge() fine."));
  check("dots inside numbers and calls don't split", p3.length === 1, `${p3.length} phrases`);

  const text = "Graphify maps your codebase, follows the graph from your change, and skips the rest.";
  const orig = fakeAlign(text, 0.06, 0.3);
  const slow = fakeAlign(text, 0.066, 0.3);

  const natural = planSection(slow, orig, { at: 1, limit: 20, mode: "natural" });
  check("natural mode plays the take whole, first word on the original's", natural.segments.length === 1 && natural.segments[0].rate === 1 && Math.abs(natural.stats.drift) < 1e-9);
  const pushed = planSection(slow, orig, { at: 1, limit: 20, mode: "natural", notBefore: 1.6 });
  check("natural mode waits for the previous section instead of talking over it", pushed.stats.startAt >= 1.6 - 1e-9 && pushed.stats.drift > 0, `starts ${pushed.stats.startAt.toFixed(2)}s`);

  const phrase = planSection(slow, orig, { at: 1, limit: 20, mode: "phrase" });
  const runs = phrases(slow.chars);
  const segEnd = (s) => s.dst + (s.src1 - s.src0) / s.rate;
  const noOverlap = phrase.segments.every((s, j) => j === 0 || phrase.segments[j - 1] && segEnd(phrase.segments[j - 1]) <= s.dst + 1e-9);
  const pauses = runs.slice(1).map((r, j) => {
    const prevEnd = phrase.segments[j].dst + (slow.ends[runs[j].last] - phrase.segments[j].src0) / phrase.segments[j].rate;
    const nextStart = phrase.segments[j + 1].dst + (slow.starts[r.first] - phrase.segments[j + 1].src0) / phrase.segments[j + 1].rate;
    return (nextStart - prevEnd) / (slow.starts[r.first] - slow.ends[runs[j].last]);
  });
  check("phrase mode cuts at pauses and never overlaps phrases", phrase.segments.length === 3 && noOverlap, `${phrase.segments.length} phrases`);
  check("phrase mode keeps at least 75% of every natural pause", pauses.every((k) => k >= 0.75 - 1e-6), pauses.map((k) => `${Math.round(k * 100)}%`).join(" "));
  check("phrase mode stays near the original phrase starts", Math.abs(phrase.stats.drift) < 0.25, `late ${phrase.stats.drift.toFixed(2)}s`);
  const tight = planSection(slow, orig, { at: 1, limit: 20, mode: "tight" });
  check("tight mode nudges phrase lengths gently", tight.stats.rateHi <= 1.1 + 1e-9 && tight.stats.rateLo >= 0.92 - 1e-9 && tight.stats.rateHi > 1.05, `${tight.stats.rateLo.toFixed(2)}–${tight.stats.rateHi.toFixed(2)}x`);
  const roomy = planSection(slow, orig, { at: 1, mode: "phrase" });
  const snug = planSection(slow, orig, { at: 1, limit: roomy.stats.endAt - 0.2, mode: "phrase" });
  check("phrase mode speeds a section up evenly when it would overrun", snug.stats.overflow < 1e-3 && snug.stats.rateLo === snug.stats.rateHi && snug.stats.rateHi > 1 && snug.stats.rateHi <= 1.12, `${snug.stats.rateHi.toFixed(3)}x`);
  const edited = planSection(slow, { ...orig, chars: Array.from(text.replace("maps", "reads")) }, { at: 1, limit: 20, mode: "phrase" });
  check("edited text plays naturally instead of phrase by phrase", edited.stats.mode === "natural" && edited.segments.length === 1);

  // A waveform with a real silence at the comma, while the timing claims the first phrase ends
  // 80 ms before its sound does, and the first letter starts at 0.0 like ElevenLabs reports it.
  const voiced = (spans, len) => {
    const pcm = new Float32Array(Math.round(len * SR));
    for (const [a, b] of spans) for (let i = Math.round(a * SR); i < Math.round(b * SR); i++) pcm[i] = 0.3 * Math.sin((2 * Math.PI * 180 * i) / SR);
    return pcm;
  };
  const line = "Hello there, general Kenobi.";
  const timed = (p1End, p2Start, p2End) => {
    const chars = Array.from(line);
    const comma = line.indexOf(",");
    const starts = [];
    const ends = [];
    chars.forEach((c, i) => {
      const [a, b, n, k] = i < comma ? [0, p1End, comma, i] : i <= comma + 1 ? [p1End, p2Start, 2, i - comma] : [p2Start, p2End, chars.length - comma - 2, i - comma - 2];
      starts.push(a + ((b - a) * k) / n);
      ends.push(a + ((b - a) * (k + 1)) / n);
    });
    return { chars, starts, ends };
  };
  const lineOrig = timed(0.9, 1.3, 2.1);
  const withGap = { ...timed(0.92, 1.45, 2.2), length: 2.5 };
  withGap.env = envelope(voiced([[0.1, 1.0], [1.4, 2.2]], 2.5));
  const cutPlan = planSection(withGap, lineOrig, { at: 1, mode: "phrase" });
  const [c0, c1] = cutPlan.segments;
  check("the cut lands in the real silence, not where the timing says the phrase ended", cutPlan.segments.length === 2 && c0.src1 > 1.0 && c1.src0 < 1.4 && c0.src1 <= c1.src0, `cut ${c0?.src1.toFixed(2)}–${c1?.src0.toFixed(2)}s`);
  check("the first word starts where its sound starts, not at 0.0", Math.abs(cutPlan.stats.startAt - (1 + 0.09)) < 0.02, `${(cutPlan.stats.startAt - 1).toFixed(2)}s into the take`);
  const noGap = { ...timed(0.92, 1.45, 2.2), length: 2.5 };
  noGap.env = envelope(voiced([[0.1, 2.2]], 2.5));
  check("phrases with no real silence between them are never cut apart", planSection(noGap, lineOrig, { at: 1, mode: "phrase" }).segments.length === 1);

  const heard = wordTimes(withGap, cutPlan);
  check("word times follow the voice onto the video", heard.length === 4 && heard.every((w, i) => i === 0 || w.start >= heard[i - 1].start) && Math.abs(heard[2].start - mapTime(cutPlan.segments, withGap.starts[heard[2].first])) < 1e-9, heard.map((w) => `${w.text} ${w.start.toFixed(2)}`).join(", "));

  check("numbers read the way they are spoken", numberWords("30,000") === "thirty thousand" && numberWords("85") === "eighty five" && numberWords("0.9") === "zero point nine", numberWords("16"));
  const said = compareWords("CI spend drops eighty-five percent — roughly fifteen thousand dollars a month.".split(" "), "CI spend drops 85% roughly $15,000 a month.");
  check("a transcript with digits still matches a spelled-out script", said.every((w) => w.status === "ok"), said.filter((w) => w.status !== "ok").length + " flagged");
  const skipped = compareWords("It will never skip a test that could catch your bug.".split(" "), "It will skip a test that could catch your bug.");
  check("a skipped word is caught", skipped[2].status === "missing" && skipped.filter((w) => w.status !== "ok").length === 1);
  const garbled = compareWords("Two steps to wire it into Buildkite.".split(" "), "Two steps to wire it into build kite.");
  check("a name split in two still counts as said", garbled.every((w) => w.status === "ok"));
  const swapped = compareWords("Sixteen minutes to green becomes two.".split(" "), "Sixty minutes to green becomes two.");
  check("a misheard word is flagged with what was heard", swapped[0].status === "misread" && swapped[0].heard === "sixty");
  check("key terms pick out names and acronyms", keyterms("Two steps to wire it into Buildkite. CI runs 30k tests. Graphify maps it.").join(",") === "Buildkite,CI,30k,Graphify", keyterms("Two steps to wire it into Buildkite. CI runs 30k tests. Graphify maps it.").join(","));

  const tone = sine(220, 1, 0.5);
  for (const rate of [0.9, 1.2]) {
    const t0 = performance.now();
    const y = timeStretch(tone, rate, SR);
    const ms = performance.now() - t0;
    const mid = y.subarray(2400, y.length - 2400);
    const pitch = (crossings(mid) / mid.length) * SR;
    check(`time stretch ${rate}x keeps length, level and pitch`, Math.abs(y.length - SR / rate) <= 1 && Math.abs(db(rms(mid)) - db(rms(tone))) < 0.5 && Math.abs(pitch - 220) < 3, `${y.length} samples, ${pitch.toFixed(1)} Hz, ${ms.toFixed(0)} ms`);
  }

  const lufs = loudness(sine(997, 5, dbToGain(-20)), SR);
  check("loudness of a -20 dBFS 997 Hz tone is -23 LUFS", Math.abs(lufs + 23) < 0.2, `${lufs.toFixed(2)} LUFS`);

  const hot = [sine(300, 1, 2), sine(450, 1, 1.5)];
  limit(hot, SR, -1);
  check("limiter holds -1 dBFS", peak(hot) <= dbToGain(-1) + 1e-6, `${db(peak(hot)).toFixed(2)} dBFS`);

  const back = decodeWav(new Uint8Array(encodeWav([sine(440, 0.1, 0.5), sine(660, 0.1, 0.25)], SR)));
  check("WAV round trip", back.rate === SR && back.channels.length === 2 && Math.abs(back.channels[1][100] - sine(660, 0.1, 0.25)[100]) < 1e-4);
};

const markupChecks = () => {
  const V2 = "eleven_multilingual_v2";
  const V3 = "eleven_v3";
  const plain = "CI runs everything, every time — not because it should, but because it can't tell.";
  check("a line without markup goes to every model exactly as written", [V2, V3].every((m) => render(plain, m).sent === plain && render(plain, m).clean === plain && !render(plain, m).marks.length));
  const lines = listProjects().flatMap((p) => (p.sections ?? []).map((s) => s.text).filter(Boolean));
  const changed = lines.filter((t) => [V2, V3].some((m) => render(t, m).sent !== t));
  check("every project line is sent unchanged, so takes already made still load from cache", !changed.length, changed.length ? changed[0] : `${lines.length} lines`);

  const line = 'Graphify maps your codebase. <break time="1.0s" /> Then it skips the rest.';
  const v2 = render(line, V2);
  check("v2 voices get the <break> as typed; the script keeps just the words", v2.sent === line && v2.clean === "Graphify maps your codebase. Then it skips the rest." && v2.marks[0]?.label === "1s" && v2.marks[0].at === v2.clean.indexOf("Then"), `${v2.marks[0]?.label} before "${v2.clean.slice(v2.marks[0]?.at, v2.marks[0]?.at + 4)}"`);
  const capped = render('Wait. <break time="4.5s" /> Now.', V2);
  check("a pause over 3 s is capped, with a warning", capped.sent === 'Wait. <break time="3.0s" /> Now.' && capped.issues.some((x) => x.level === "warn"), capped.sent);
  check("pauses can be written in milliseconds", render('One <break time="750ms" /> two.', V2).sent === 'One <break time="0.75s" /> two.');

  const v3 = (s) => render(`Graphify maps your codebase. <break time="${s}s" /> Then it skips the rest.`, V3).sent.replace("Graphify maps your codebase.", "…").replace("Then it skips the rest.", "…");
  const forms = [0.4, 0.8, 1, 1.5, 2.5].map((s) => `${s}s → "${v3(s)}"`).join(", ");
  check(
    "v3 voices get the nearest pause they can do instead of <break>",
    v3(0.4) === "… …" && v3(0.8) === "… — …" && v3(1) === "… ... …" && v3(1.5) === "… [pause] …" && v3(2.5) === "… [long pause] …",
    forms,
  );
  check("mid-sentence, a short pause becomes a dash on v3", render('It maps <break time="0.5s" /> your code.', V3).sent === "It maps — your code.");

  const tagged = "Hello [whispers] there [laughs], then [pause] go.";
  const t2 = render(tagged, V2);
  const t3 = render(tagged, V3);
  check(
    "v3 tags are left out for v2 voices, and [pause] becomes a break",
    t2.sent === 'Hello there, then <break time="1.0s" /> go.' && t2.issues.filter((x) => x.level === "warn").length === 2 && t2.marks.filter((m) => m.dropped).length === 2,
    t2.sent,
  );
  check("v3 voices get the tags as typed", t3.sent === tagged && t3.clean === "Hello there, then go." && !t3.issues.length, t3.clean);

  const lex = [{ word: "Graphify", respell: "Graf-ih-fy", ipa: "/ˈɡræfɪfaɪ/" }];
  const say2 = render("graphify's graph beats Graphifying.", V2, lex);
  const say3 = render("Graphify's graph.", V3, lex);
  check(
    "pronunciations replace whole words in any case: a respelling for v2, IPA for v3",
    say2.sent === "Graf-ih-fy's graph beats Graphifying." && say3.sent === '"/ˈɡræfɪfaɪ/"\'s graph.' && say2.clean === "graphify's graph beats Graphifying." && say3.clean === "Graphify's graph." && say2.used.length === 1,
    `${say2.sent} | ${say3.sent}`,
  );
  const ipaOnly = render("Graphify maps it.", V2, [{ word: "Graphify", ipa: "ˈɡræfɪfaɪ" }]);
  check("a phonetic-only entry is sent as written to v2 voices, with a warning", ipaOnly.sent === "Graphify maps it." && ipaOnly.issues.some((x) => x.level === "warn"));

  const fake = (sent) => {
    const chars = Array.from(sent);
    return { chars, starts: chars.map((_, i) => i * 0.05), ends: chars.map((_, i) => i * 0.05 + 0.05) };
  };
  const both = render('Graphify maps your codebase. <break time="1.0s" /> Then it skips the rest.', V2, lex);
  const a = fake(both.sent);
  const timed = cleanTiming(both, a);
  const words = wordRanges(timed?.chars ?? []).map((w) => w.text);
  const at = (i) => Array.from(both.sent).indexOf(i);
  check(
    "the timing moves onto the line's own words",
    words.join(" ") === "Graphify maps your codebase. Then it skips the rest." &&
      timed.starts[0] === a.starts[0] &&
      timed.ends["Graphify".length - 1] === a.ends["Graf-ih-fy".length - 1] &&
      timed.starts[timed.chars.indexOf("T")] === a.starts[at("T")] &&
      timed.marks[0].start === a.starts[at("<")],
    words.join(" | "),
  );
  check("timing that doesn't match what was sent is refused", cleanTiming(both, fake(both.sent.replace("Then", "When"))) === null);
  check("context text drops pauses and tags", plainText(tagged) === "Hello there, then go." && plainText(line) === "Graphify maps your codebase. Then it skips the rest.");
};

// ElevenLabs refuses prompts that name artists, songs or franchises.
const NAMED = /\b(zimmer|daft punk|odesza|tycho|coldplay|imagine dragons|disney|pixar|marvel|star wars|netflix|apple|google|in the style of|sounds like)\b/i;

const musicChecks = async () => {
  check("12 music styles with distinct ids", PRESETS.length === 12 && new Set(PRESETS.map((p) => p.id)).size === 12);
  const loose = PRESETS.filter((p) => {
    const styles = [...p.positive, ...p.negative];
    return (
      p.positive.length < 7 ||
      p.positive.length > 50 ||
      p.negative.length > 50 ||
      !p.positive.includes(`${p.bpm} bpm`) ||
      !["low", "medium", "high"].includes(p.energy) ||
      !p.negative.includes("vocals") ||
      styles.some((s) => s !== s.toLowerCase() || NAMED.test(s))
    );
  });
  check("every style has 7+ lowercase styles with its tempo, keeps vocals out, names no artist or brand", !loose.length, loose.map((p) => p.id).join(", "));
  check("prompts built from a style ask for instrumental music", PRESETS.every((p) => /^Instrumental /.test(presetPrompt(p, "hopeful")) && !NAMED.test(presetPrompt(p, "hopeful"))));

  const lengths = [3000, 8000, 11999, 12000, 24999, 30000, 59999, 60000, 80167, 90000, 119999, 120000, 245000, 600000];
  const off = lengths.flatMap((L) => PRESETS.map((p) => ({ L, id: p.id, plan: planForLength(p, L).plan }))).filter(({ L, plan }) => planLength(plan) !== L || checkPlan(plan).length);
  check("a track of any length from 3 s to 10 min plans exactly to the millisecond, for every style", !off.length, off.length ? off.slice(0, 3).map((x) => `${x.id} ${x.L}`).join(", ") : `${lengths.length} lengths x ${PRESETS.length} styles`);
  const arc = planForLength(PRESETS[0], 90000).roles.join(" > ");
  check("a 90 s track opens quietly, builds, lifts and resolves", arc === "intro > build > steady > lift > resolve", arc);

  const fitted = listProjects().filter((p) => p.id.startsWith("test-impact") && p.video.duration && p.sections.length >= 2);
  if (!fitted.length) console.log("skip no Test Impact projects to fit music to");
  for (const p of fitted) {
    const lines = p.sections.map((s) => {
      const sp = speechSpan(s.orig);
      return { start: s.at + sp.start, end: s.at + sp.end };
    });
    const { plan, bounds, roles } = planForVideo(PRESETS[1], p.video.duration, lines);
    const L = Math.round(p.video.duration * 1000);
    const inPauses = bounds.slice(1, -1).every((b) => lines.some((l, i) => i > 0 && b / 1000 > lines[i - 1].end && b / 1000 < l.start));
    check(
      `${p.id}: music changes in the pauses between lines and ends on the video's last millisecond`,
      planLength(plan) === L && !checkPlan(plan).length && inPauses && roles[0] === "intro" && roles.at(-1) === "resolve",
      `${roles.join(" > ")}, ${plan.chunks.map((c) => (c.duration_ms / 1000).toFixed(2)).join(" + ")} = ${planLength(plan)} ms`,
    );
  }
  const shortScene = planForVideo(PRESETS[0], 30, [
    { start: 0.35, end: 4.09 },
    { start: 5.18, end: 6.0 },
    { start: 7.2, end: 12.39 },
    { start: 13.5, end: 19.11 },
    { start: 20.23, end: 26.93 },
  ]);
  check("a scene under 3 s joins its shorter neighbour", shortScene.bounds.join(",") === "0,6600,12945,19670,30000" && planLength(shortScene.plan) === 30000, shortScene.bounds.join(","));
  const longScene = planForVideo(PRESETS[0], 300, [
    { start: 1, end: 10 },
    { start: 11, end: 290 },
  ]);
  check("a scene over 2 minutes splits evenly", longScene.plan.chunks.every((c) => c.duration_ms <= MAX_CHUNK && c.duration_ms >= MIN_CHUNK) && planLength(longScene.plan) === 300000, longScene.plan.chunks.map((c) => c.duration_ms / 1000).join(" + "));
  const manyLines = planForVideo(PRESETS[0], 200, Array.from({ length: 40 }, (_, i) => ({ start: i * 5 + 0.5, end: i * 5 + 4.5 })));
  check("40 lines still make at most 30 parts", manyLines.plan.chunks.length <= MAX_CHUNKS && planLength(manyLines.plan) === 200000 && !checkPlan(manyLines.plan).length, `${manyLines.plan.chunks.length} parts`);

  // The library and its queue in a scratch folder, with a stand-in for ElevenLabs.
  const home = DIRS.music;
  DIRS.music = fs.mkdtempSync(path.join(os.tmpdir(), "booth-music-"));
  try {
    const wav = Buffer.from(encodeWav([sine(220, 0.5, 0.2)], SR));
    const a = music.saveUpload("bed.wav", wav);
    const b = music.saveUpload("bed again.wav", wav);
    const listed = music.listTracks();
    check("an upload is stored once however often it's added", a.id === b.id && listed.length === 1 && listed[0].name === "bed.wav" && listed[0].source === "upload" && listed[0].url === `/music/${a.id}.wav`);
    let refused = null;
    try {
      music.saveUpload("notes.txt", Buffer.from("hello"));
    } catch (err) {
      refused = err.status;
    }
    check("a file that isn't audio is refused", refused === 400);

    const calls = [];
    let failWith = null;
    music.setClient({
      composeMusic: async (req) => {
        calls.push(req);
        if (failWith) throw Object.assign(new Error(failWith), { status: 400, suggestion: "a calm felt piano piece" });
        return { audio: Buffer.from(`stand-in track ${calls.length}`), format: "mp3_48000_192", retries: 0 };
      },
    });
    music.enqueue({ kind: "style", preset: "lofi-demo", lengthMs: 30000, seed: 7 });
    music.enqueue({ kind: "style", preset: "lofi-demo", lengthMs: 30000, seed: 8 });
    await music.whenIdle();
    const made = music.listTracks().filter((t) => t.source === "elevenlabs");
    check("made tracks keep their style, length, tempo and licence note", made.length === 2 && made.every((t) => t.preset === "lofi-demo" && t.lengthMs === 30000 && t.bpm === 80 && t.license));
    const names = made.map((t) => t.name).sort().join(" | ");
    check("asking for the same track twice gives two distinct names", names === "Lo-fi Demo · 0:30 | Lo-fi Demo · 0:30 (2)", names);
    check("each request is a valid plan of the asked length, with its seed", calls.every((c) => !checkPlan(c.plan).length && planLength(c.plan) === 30000) && calls.map((c) => c.seed).join() === "7,8");

    failWith = "ElevenLabs 400 (bad_prompt): the prompt names a protected work";
    music.enqueue({ kind: "prompt", prompt: "a famous film theme", lengthMs: 20000 });
    await music.whenIdle();
    const failed = music.listJobs()[0];
    check("a refused request keeps ElevenLabs' reason and suggestion", failed.state === "error" && /bad_prompt/.test(failed.error) && failed.suggestion === "a calm felt piano piece");
    let badPlan = null;
    try {
      music.enqueue({ kind: "fit", preset: "lofi-demo", plan: { chunks: [{ text: "[Intro]", duration_ms: 1000, positive_styles: ["lo-fi"] }] } });
    } catch (err) {
      badPlan = err;
    }
    check("a plan ElevenLabs would reject is refused before it's queued", badPlan?.status === 400 && /3–120 s/.test(badPlan.message), badPlan?.message);

    const gone = made[0].id;
    music.removeTrack(gone);
    check("a removed track leaves the list at once", !music.listTracks().some((t) => t.id === gone));
    const statusOf = (fn) => {
      try {
        fn();
      } catch (err) {
        return err.status;
      }
      return 200;
    };
    check("removing a track twice, or a path, is a 404", statusOf(() => music.removeTrack(gone)) === 404 && statusOf(() => music.removeTrack("../../server")) === 404);
  } finally {
    music.setClient(null);
    DIRS.music = home;
  }
};

// Offset (seconds) that best lines `take` up with `mix` near `at`, from 4 kHz correlation
// refined at full rate.
const offsetOf = (mix, take, at, search = 0.08) => {
  const f = 12;
  const dec = (x, from, n) => {
    const out = new Float32Array(Math.max(0, Math.floor(n / f)));
    for (let i = 0; i < out.length; i++) {
      let s = 0;
      for (let k = 0; k < f; k++) s += x[from + i * f + k] ?? 0;
      out[i] = s / f;
    }
    return out;
  };
  const len = Math.min(take.length, 6 * SR);
  const a0 = Math.round(at * SR);
  const lags = Math.round((search * SR) / f);
  const mixD = dec(mix, a0 - lags * f, len + 2 * lags * f);
  const takeD = dec(take, 0, len);
  let best = 0;
  let score = -Infinity;
  for (let l = 0; l <= 2 * lags; l++) {
    let s = 0;
    for (let i = 0; i < takeD.length; i++) s += takeD[i] * mixD[l + i];
    if (s > score) {
      score = s;
      best = l;
    }
  }
  let fine = a0 + (best - lags) * f;
  let fineScore = -Infinity;
  const center = fine;
  for (let d = -f; d <= f; d++) {
    let s = 0;
    const o = center + d;
    for (let i = 0; i < len; i += 2) s += take[i] * (mix[o + i] ?? 0);
    if (s > fineScore) {
      fineScore = s;
      fine = o;
    }
  }
  return fine / SR - at;
};

// Energy of (master - parts) relative to the master.
const residual = (master, parts) => {
  let e = 0;
  let m = 0;
  for (let i = 0; i < master.length; i++) {
    const d = master[i] - parts[i];
    e += d * d;
    m += master[i] * master[i];
  }
  return 10 * Math.log10(e / m);
};

const shifted = (x, lag, n) => {
  const out = new Float32Array(n);
  for (let i = Math.max(0, lag); i < n && i - lag < x.length; i++) out[i] = x[i - lag];
  return out;
};

const verify = async (id) => {
  const p = listProjects().find((x) => x.id === id);
  if (!p) throw new Error(`No project ${id}`);
  const master = (await decode(p.video.path)).channels[0];
  const n = master.length;
  const takes = await Promise.all(p.sections.map(async (s) => (await decode(s.orig.path)).channels[0]));
  const offsets = p.sections.map((s, i) => offsetOf(master, takes[i], s.at));
  const voiceLag = [...offsets].sort((a, b) => a - b)[Math.floor(offsets.length / 2)];
  console.log(`  the voice sits ${(voiceLag * 1000).toFixed(1)} ms late in the file (every section by the same amount):`);
  p.sections.forEach((s, i) => console.log(`    ${s.id.padEnd(11)} at ${s.at.toFixed(3)}s   ${((offsets[i] - voiceLag) * 1000).toFixed(2)} ms from that`));
  const voice = new Float32Array(n);
  p.sections.forEach((s, i) => {
    const o = Math.round(s.at * SR);
    for (let k = 0; k < takes[i].length && o + k < n; k++) voice[o + k] += takes[i][k] * p.voiceGain;
  });
  const voiceIn = shifted(voice, Math.round(voiceLag * SR), n);
  if (!p.bed) {
    console.log(`  residual, voice only: ${residual(master, voiceIn).toFixed(1)} dB (no music bed built yet)`);
    return;
  }
  const bed = (await decode(p.bed.path)).channels[0];
  const bedLag = offsetOf(master, bed.subarray(Math.round(1.5 * SR)), 1.5);
  console.log(`  the music bed sits ${(bedLag * 1000).toFixed(1)} ms late in the file`);
  const bedIn = shifted(bed, Math.round(bedLag * SR), n);
  const both = Float32Array.from(bedIn, (v, i) => v + voiceIn[i]);
  console.log(`  residual, bed + voice: ${residual(master, both).toFixed(1)} dB`);
  console.log(`  residual, bed only:    ${residual(master, bedIn).toFixed(1)} dB`);
  console.log(`  residual, voice only:  ${residual(master, voiceIn).toFixed(1)} dB`);
};

const fit = async (id, track, mode = "natural") => {
  const p = listProjects().find((x) => x.id === id);
  if (!p) throw new Error(`No project ${id}`);
  const take = p.takes.find((t) => t.track === track);
  if (!take) throw new Error(`${id} has no take "${track}". Takes: ${p.takes.map((t) => t.track).join(", ")}`);
  const master = await decode(p.video.path, 2);
  const n = master.channels[0].length;
  const origPcm = [];
  const newPcm = [];
  const items = [];
  const t0 = performance.now();
  let prevEnd = -Infinity;
  for (let i = 0; i < p.sections.length; i++) {
    const s = p.sections[i];
    const ts = take.sections.find((x) => x.id === s.id);
    const pcm = (await decode(ts.path)).channels[0];
    origPcm.push((await decode(s.orig.path)).channels[0]);
    newPcm.push(pcm);
    const next = p.sections[i + 1];
    const lim = next ? next.at + speechSpan(next.orig).start - 0.1 : n / SR - 0.1;
    const align = { chars: ts.chars, starts: ts.starts, ends: ts.ends, length: pcm.length / SR, env: envelope(pcm) };
    const plan = planSection(align, s.orig, { at: s.at, limit: lim, mode, notBefore: prevEnd + 0.4 });
    prevEnd = plan.stats.endAt;
    const st = plan.stats;
    console.log(
      `  ${s.id.padEnd(11)} ${st.phrases} phrase(s)  speech ${st.spanOrig.toFixed(2)}s -> ${st.spanNew.toFixed(2)}s  rate ${st.rateLo.toFixed(2)}-${st.rateHi.toFixed(2)}x  late ${st.drift.toFixed(2)}s  overflow ${st.overflow.toFixed(2)}s`,
    );
    items.push({ key: `${track}:${s.id}`, pcm, segments: plan.segments });
  }
  const voice = renderVoice(items, n, SR, new Map());
  const target = loudness(concat(origPcm), SR) + db(p.voiceGain);
  const gain = dbToGain(target - loudness(concat(newPcm), SR));
  console.log(`  fitted in ${(performance.now() - t0).toFixed(0)} ms, take gain ${db(gain).toFixed(1)} dB`);
  const bed = p.bed ? await decode(p.bed.path, 2) : null;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = voice[i] * gain;
    L[i] = v + (bed?.channels[0][i] ?? 0);
    R[i] = v + (bed?.channels[1][i] ?? 0);
  }
  limit([L, R], SR, -1);
  const ffmpeg = createFfmpeg(bin);
  const tag = stamp();
  const wav = path.join(DIRS.work, `fit-${id}-${track}-${mode}-${tag}.wav`);
  fs.writeFileSync(wav, Buffer.from(encodeWav([L, R], SR)));
  const mp4 = path.join(DIRS.work, `fit-${id}-${track}-${mode}-${tag}.mp4`);
  await ffmpeg.mux(p.video.path, wav, mp4);
  console.log(`  wrote ${mp4}${p.bed ? "" : " (no music bed yet, voice only)"}`);
};

const levels = async (...files) => {
  for (const file of files) {
    const x = (await decode(file)).channels[0];
    console.log(`  ${path.basename(file)}: ${loudness(x, SR).toFixed(1)} LUFS, peak ${db(peak([x])).toFixed(1)} dBFS, ${(x.length / SR).toFixed(2)}s`);
  }
};

const all = async () => {
  dsp();
  markupChecks();
  await musicChecks();
};

const [cmd = "all", ...args] = process.argv.slice(2);
const run = { all, dsp, markup: markupChecks, music: musicChecks, verify, fit, levels }[cmd];
if (!run) {
  console.error("usage: node tools/selftest.mjs [all | dsp | markup | music | verify <project> | fit <project> <track> [mode] | levels <file...>]");
  process.exit(2);
}
if (["verify", "fit", "levels"].includes(cmd) && !bin) {
  console.error("No ffmpeg found");
  process.exit(1);
}
Promise.resolve(run(...args))
  .then(() => process.exit(failures ? 1 : 0))
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
