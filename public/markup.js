// Script markup: pauses, ElevenLabs audio tags and pronunciations. A line keeps one readable form;
// each model gets the syntax it understands (every model but v3 takes <break>, v3 takes punctuation
// and [tags]), and the timing ElevenLabs sends back is moved onto the line's own words.
// Shared by the page and the Node self-test.

export const MAX_PAUSE = 3;
export const PAUSE_CHOICES = [0.5, 1, 1.5, 2, 3];

// Named pauses are v3 tags; other models get a <break> of this length instead.
const PAUSE_TAGS = { "short pause": 0.5, pause: 1, "long pause": 2 };

// What v3 gets instead of a <break>, with the silence each form left on Sarah (one seed, measured
// 2026-09-28): after a sentence or clause ends, and in the middle of one.
const V3_AFTER_STOP = [
  ["", 0.3],
  ["—", 0.86],
  ["...", 1.13],
  ["[pause]", 1.63],
  ["[long pause]", 2.63],
];
const V3_MID = [
  ["—", 0.38],
  ["...", 1.19],
  ["[pause]", 1.63],
  ["[long pause]", 2.63],
];

const MARKUP = /<break\s+time\s*=\s*["']?(\d+(?:\.\d+)?)\s*(ms|s)?["']?\s*\/?>|\[([a-z][a-z '’-]{0,39})\]/gi;
const IPA_INLINE = /\/[^/\s]*[ˈˌəɪʊæɑɒɔɛɜʌθðŋʃʒʤʧɡːɹɾʔ][^/\s]*\//u;
const STOP = /[.,;:!?…]/;

export const isV3 = (modelId) => String(modelId ?? "").startsWith("eleven_v3");

const fmtSeconds = (s) => {
  const r = Math.round(s * 100) / 100;
  return Number.isInteger(r) ? `${r}.0` : String(r);
};

export const pauseTag = (seconds) => `<break time="${fmtSeconds(seconds)}s" />`;

// The line as text, pauses and tags, in order.
export const parse = (text) => {
  const s = String(text ?? "");
  const parts = [];
  let last = 0;
  for (const m of s.matchAll(MARKUP)) {
    if (m.index > last) parts.push({ type: "text", text: s.slice(last, m.index) });
    if (m[1] !== undefined) {
      parts.push({ type: "pause", raw: m[0], seconds: Number(m[1]) / (m[2]?.toLowerCase() === "ms" ? 1000 : 1), form: "break" });
    } else {
      const name = m[3].trim().toLowerCase().replace(/’/g, "'");
      parts.push(name in PAUSE_TAGS ? { type: "pause", raw: m[0], seconds: PAUSE_TAGS[name], form: "tag", name } : { type: "tag", raw: m[0], name });
    }
    last = m.index + m[0].length;
  }
  if (last < s.length) parts.push({ type: "text", text: s.slice(last) });
  return parts;
};

export const cleanEntry = (e) => ({
  word: String(e?.word ?? "").trim(),
  respell: String(e?.respell ?? "").trim(),
  ipa: String(e?.ipa ?? "")
    .trim()
    .replace(/^["'/\s]+|["'/\s]+$/g, ""),
});

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const matcher = (entries) => {
  if (!entries.length) return null;
  const words = [...entries].sort((a, b) => b.word.length - a.word.length).map((e) => escapeRe(e.word));
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.join("|")})(?![\\p{L}\\p{N}])`, "giu");
};

const nearest = (forms, s) => forms.reduce((a, b) => (Math.abs(b[1] - s) < Math.abs(a[1] - s) ? b : a));

/**
 * The text a model should get for a line, and how it maps back.
 *   sent      what goes to ElevenLabs
 *   clean     the line's own words, without pauses or tags
 *   cleanMap  for each code point of `clean`, the code point of `sent` it is heard at
 *   marks     pauses and tags: { at (index in clean), kind, label, from, to (in sent), dropped, note }
 *   used      pronunciation entries this line used
 *   issues    { level: "warn" | "info", text }
 */
export const render = (text, modelId, lexicon = []) => {
  const v3 = isV3(modelId);
  const entries = lexicon.map(cleanEntry).filter((e) => e.word);
  const re = matcher(entries);
  const sent = [];
  const clean = [];
  const marks = [];
  const used = new Map();
  const issues = [];
  const note = (level, msg) => issues.some((x) => x.text === msg) || issues.push({ level, text: msg });

  // A tag that was sent needs a space before the next word, but not before punctuation.
  let spaceDue = false;
  const lastIs = (arr, test) => arr.length > 0 && test(arr[arr.length - 1]);
  const addText = (src) => {
    for (const ch of src) {
      if (/\s/.test(ch)) {
        if (sent.length && !lastIs(sent, (c) => /\s/.test(c))) sent.push(" ");
        if (clean.length && !lastIs(clean, (c) => c.ch === " ")) clean.push({ ch: " ", at: sent.length - 1 });
        spaceDue = false;
        continue;
      }
      if (/[,.;:!?]/.test(ch)) {
        // A tag left out can strand the space before it: "Hello [laughs], then".
        if (lastIs(sent, (c) => c === " ")) sent.pop();
        if (lastIs(clean, (c) => c.ch === " ")) clean.pop();
      } else if (spaceDue) sent.push(" ");
      spaceDue = false;
      clean.push({ ch, at: sent.length });
      sent.push(ch);
    }
  };
  const addSay = (src, out) => {
    if (spaceDue) sent.push(" ");
    spaceDue = false;
    const from = sent.length;
    sent.push(...Array.from(out));
    const n = sent.length - from;
    const chars = Array.from(src);
    chars.forEach((ch, k) => clean.push({ ch, at: from + (chars.length > 1 ? Math.round((k * (n - 1)) / (chars.length - 1)) : 0) }));
  };
  const addMark = (mark, out) => {
    if (out && sent.length && !lastIs(sent, (c) => /\s/.test(c))) sent.push(" ");
    const from = sent.length;
    sent.push(...Array.from(out));
    marks.push({ ...mark, at: clean.length, from, to: sent.length, out });
    spaceDue = Boolean(out);
  };
  const lastSent = () => {
    for (let i = sent.length - 1; i >= 0; i--) if (!/\s/.test(sent[i])) return sent[i];
    return "";
  };

  const parts = parse(text);
  const breaks = parts.filter((p) => p.type === "pause").length;
  if (!v3 && breaks >= 4) note("warn", `${breaks} pauses in one line. ElevenLabs warns that many pauses can make the voice speed up or glitch.`);
  for (const p of parts) {
    if (p.type === "text") {
      if (!v3 && IPA_INLINE.test(p.text)) note("warn", "Phonetic spelling between slashes only works on v3 voices.");
      let last = 0;
      for (const m of re ? p.text.matchAll(re) : []) {
        const e = entries.find((x) => x.word.toLowerCase() === m[0].toLowerCase());
        const out = v3 && e.ipa ? `"/${e.ipa}/"` : e.respell || null;
        if (!out) {
          note("warn", `"${e.word}" only has a phonetic spelling, which works on v3 voices, so this voice gets it as written.`);
          continue;
        }
        addText(p.text.slice(last, m.index));
        addSay(m[0], out);
        used.set(e.word.toLowerCase(), e);
        last = m.index + m[0].length;
      }
      addText(p.text.slice(last));
      continue;
    }
    if (p.type === "pause") {
      const s = Math.min(MAX_PAUSE, Math.max(0, p.seconds));
      if (p.seconds > MAX_PAUSE) note("warn", `ElevenLabs pauses go up to ${MAX_PAUSE} s, so a ${fmtSeconds(p.seconds)} s pause plays as ${MAX_PAUSE} s.`);
      const label = p.form === "tag" ? p.name : `${fmtSeconds(s).replace(/\.0$/, "")}s`;
      if (!v3) {
        if (p.form === "tag") note("info", `${p.raw} is v3 syntax, so this voice gets a ${fmtSeconds(s)} s break instead.`);
        addMark({ kind: "pause", label, seconds: s }, pauseTag(s));
      } else if (p.form === "tag") {
        addMark({ kind: "pause", label, seconds: s }, p.raw);
      } else {
        const [out, about] = nearest(STOP.test(lastSent()) ? V3_AFTER_STOP : V3_MID, s);
        const how = out ? `"${out}"` : "just the punctuation before it";
        const around = `around ${about.toFixed(1)} s, and it varies by take`;
        note("info", `v3 voices can't time a pause exactly, so a ${fmtSeconds(s)} s pause becomes ${how} (${around}).`);
        addMark({ kind: "pause", label, seconds: s, note: `Becomes ${how} on v3 (${around})` }, out);
      }
      continue;
    }
    if (v3) addMark({ kind: "tag", label: p.name }, p.raw);
    else {
      note("warn", `${p.raw} only works on v3 voices. This voice would say it out loud, so it's left out.`);
      addMark({ kind: "tag", label: p.name, dropped: true, note: "Left out: only v3 voices can use it" }, "");
    }
  }
  while (sent.length && /\s/.test(sent[sent.length - 1])) sent.pop();
  while (clean.length && clean[clean.length - 1].ch === " ") clean.pop();
  for (const m of marks) m.at = Math.min(m.at, clean.length);
  return {
    sent: sent.join(""),
    clean: clean.map((c) => c.ch).join(""),
    cleanMap: clean.map((c) => c.at),
    marks,
    used: [...used.values()],
    issues,
  };
};

// Just the words, for context text sent alongside a line.
export const plainText = (text) => render(text, "").clean;

// ElevenLabs' timing for the sent text moved onto the line's own characters, and when each mark is
// heard. Null when the timing doesn't match what was sent.
export const cleanTiming = (r, align) => {
  if (!r || !align?.chars || align.chars.length !== Array.from(r.sent).length || align.chars.join("") !== r.sent) return null;
  return {
    chars: Array.from(r.clean),
    starts: r.cleanMap.map((j) => align.starts[j]),
    ends: r.cleanMap.map((j) => align.ends[j]),
    marks: r.marks.map((m) => ({ ...m, start: m.to > m.from ? align.starts[m.from] : null, end: m.to > m.from ? align.ends[m.to - 1] : null })),
  };
};
