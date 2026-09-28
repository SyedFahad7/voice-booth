// Script vs. what speech-to-text heard, to spot words a take skipped or garbled.
// Shared by the browser and the Node self-test.

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES = [
  [1e12, "trillion"],
  [1e9, "billion"],
  [1e6, "million"],
  [1e3, "thousand"],
];

const underThousand = (n) => {
  const out = [];
  if (n >= 100) {
    out.push(ONES[Math.floor(n / 100)], "hundred");
    n %= 100;
  }
  if (n >= 20) {
    out.push(TENS[Math.floor(n / 10)]);
    if (n % 10) out.push(ONES[n % 10]);
  } else if (n > 0) out.push(ONES[n]);
  return out;
};

export const numberWords = (raw) => {
  const [whole, frac] = raw.replace(/,/g, "").split(".");
  let n = Number(whole);
  const out = [];
  if (n === 0) out.push("zero");
  for (const [value, name] of SCALES) {
    if (n >= value) {
      out.push(...underThousand(Math.floor(n / value)), name);
      n %= value;
    }
  }
  out.push(...underThousand(n));
  if (frac) out.push("point", ...[...frac].map((d) => ONES[Number(d)]));
  return out.join(" ");
};

// Lowercase word tokens, with numbers, % and $ spelled out the way they are spoken.
export const tokens = (text) =>
  text
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/\$\s?(\d[\d,]*(?:\.\d+)?)/g, "$1 dollars")
    .replace(/(\d)\s?%/g, "$1 percent")
    .replace(/\d[\d,]*(?:\.\d+)?/g, (n) => ` ${numberWords(n)} `)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

const distance = (a, b) => {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[b.length];
};

const close = (a, b) => {
  if (a === b) return true;
  const n = Math.min(a.length, b.length);
  return (n >= 5 && distance(a, b) <= 1) || (n >= 8 && distance(a, b) <= 2);
};

/**
 * Lines the script's words up with the transcript (edit distance over word tokens; "re run" and
 * "rerun" count as the same).
 *   scriptWords: the words of the take, as displayed
 *   heardText:   what speech-to-text returned
 * Returns one entry per script word: { status: "ok" | "missing" | "misread", heard }.
 */
export const compareWords = (scriptWords, heardText) => {
  const toks = [];
  scriptWords.forEach((w, i) => tokens(w).forEach((t) => toks.push({ t, w: i })));
  const heard = tokens(heardText);
  const n = toks.length;
  const m = heard.length;
  const cost = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(Infinity));
  const move = Array.from({ length: n + 1 }, () => new Int8Array(m + 1));
  cost[0][0] = 0;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const c = cost[i][j];
      if (c === Infinity) continue;
      const relax = (ii, jj, add, mv) => {
        if (c + add < cost[ii][jj]) {
          cost[ii][jj] = c + add;
          move[ii][jj] = mv;
        }
      };
      if (i < n && j < m) relax(i + 1, j + 1, close(toks[i].t, heard[j]) ? 0 : 1, 1);
      if (i < n) relax(i + 1, j, 1, 2);
      if (j < m) relax(i, j + 1, 0.8, 3);
      if (i + 1 < n && j < m && toks[i].t + toks[i + 1].t === heard[j]) relax(i + 2, j + 1, 0, 4);
      if (i < n && j + 1 < m && heard[j] + heard[j + 1] === toks[i].t) relax(i + 1, j + 2, 0, 5);
    }
  }
  const status = toks.map(() => "ok");
  const heardAs = toks.map(() => null);
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const mv = move[i][j];
    if (mv === 1) {
      i--;
      j--;
      if (!close(toks[i].t, heard[j])) {
        status[i] = "misread";
        heardAs[i] = heard[j];
      }
    } else if (mv === 2) {
      i--;
      status[i] = "missing";
    } else if (mv === 3) j--;
    else if (mv === 4) {
      i -= 2;
      j--;
    } else if (mv === 5) {
      i--;
      j -= 2;
    } else break;
  }
  return scriptWords.map((_, w) => {
    const mine = toks.map((t, k) => (t.w === w ? k : -1)).filter((k) => k >= 0);
    if (!mine.length) return { status: "ok", heard: null };
    const bad = mine.filter((k) => status[k] !== "ok");
    if (!bad.length) return { status: "ok", heard: null };
    if (bad.length === mine.length && bad.every((k) => status[k] === "missing")) return { status: "missing", heard: null };
    return { status: "misread", heard: bad.map((k) => heardAs[k]).filter(Boolean).join(" ") || null };
  });
};

const COMMON = new Set(
  "a an and are as at be but by can do for from go he her his how i if in is it its it's just let no not now of on or our run see she so stop that the their then there these they this to two up we what when who why will with yes you your".split(" "),
);

// Distinctive words worth biasing speech-to-text toward: names, acronyms, anything with digits.
export const keyterms = (text) => {
  const out = new Set();
  for (const w of text.match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*[\p{L}\p{N}]|[\p{L}\p{N}]/gu) ?? []) {
    if (/\d/.test(w) || /^\p{Lu}{2,}$/u.test(w) || (/^\p{Lu}/u.test(w) && !COMMON.has(w.toLowerCase()))) out.add(w);
  }
  return [...out].slice(0, 20);
};
