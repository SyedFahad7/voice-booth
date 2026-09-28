// The hosted booth's storage keys for the local tools, from the environment or from voice-booth's
// .env / .env.local. Nothing here is ever printed.
import fs from "node:fs";
import path from "node:path";
import { BOOTH } from "../lib/config.mjs";
import { storageReady } from "../lib/hosted/r2.mjs";

const NAMES = /^\s*(R2_ACCOUNT_ID|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|R2_BUCKET)\s*=\s*(.*?)\s*$/;

export const loadHostedEnv = () => {
  for (const name of [".env", ".env.local"]) {
    const file = path.join(BOOTH, name);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(NAMES);
      if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  if (!storageReady()) throw new Error("Storage keys missing: put R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET in voice-booth/.env.");
};

export const mapLimit = async (items, n, fn) => {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
};
