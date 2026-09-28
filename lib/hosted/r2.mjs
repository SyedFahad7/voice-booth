// Cloudflare R2 (its S3 API) as the hosted booth's disk. The bucket stays private: videos play
// from signed links, and audio comes through the booth's own /media/file route, so the bucket needs
// no CORS rules. Objects are written once under a content hash or a random name.
import crypto from "node:crypto";
import { AwsClient } from "aws4fetch";

const VARS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"];

export const storageReady = () => VARS.every((v) => process.env[v]);

let client = null;
const aws = () => {
  if (!storageReady()) throw Object.assign(new Error(`Storage isn't set up. Add ${VARS.join(", ")} to the environment.`), { status: 503 });
  client ??= new AwsClient({ accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY, service: "s3", region: "auto" });
  return client;
};

const objectUrl = (key = "") => `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${process.env.R2_BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`;

const call = async (method, key, { body, headers, query } = {}) => {
  const url = new URL(objectUrl(key));
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  const res = await aws().fetch(url.toString(), { method, body, headers });
  if (!res.ok && res.status !== 404 && res.status !== 206) {
    const text = await res.text().catch(() => "");
    throw new Error(`Storage ${method} ${key || "(bucket)"} failed: ${res.status} ${text.match(/<Message>(.*?)<\/Message>/)?.[1] ?? text.slice(0, 200)}`);
  }
  return res;
};

// Objects never change once written, so a read can be kept for the life of the process.
const seen = new Map();

export const readJson = async (key) => {
  if (seen.has(key)) return seen.get(key);
  const res = await call("GET", key);
  if (res.status === 404) return null;
  const value = JSON.parse(await res.text());
  seen.set(key, value);
  return value;
};

export const writeJson = async (key, data) => {
  await call("PUT", key, { body: JSON.stringify(data), headers: { "Content-Type": "application/json" } });
  seen.set(key, data);
};

export const writeFile = async (key, body, contentType) => {
  await call("PUT", key, { body, headers: { "Content-Type": contentType } });
  return { key, size: body.length ?? body.byteLength };
};

export const find = async (key) => {
  const res = await call("HEAD", key);
  if (res.status === 404) return null;
  return { key, size: Number(res.headers.get("content-length") ?? 0), uploadedAt: new Date(res.headers.get("last-modified") ?? 0) };
};

const unescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const field = (xml, tag) => xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1];

export const listAll = async (prefix) => {
  const out = [];
  let token;
  do {
    const query = { "list-type": "2", prefix, ...(token ? { "continuation-token": token } : {}) };
    const xml = await (await call("GET", "", { query })).text();
    for (const [, item] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      out.push({ key: unescape(field(item, "Key")), size: Number(field(item, "Size")), uploadedAt: new Date(field(item, "LastModified")) });
    }
    token = field(xml, "IsTruncated") === "true" ? unescape(field(xml, "NextContinuationToken") ?? "") : null;
  } while (token);
  return out;
};

export const remove = async (keys) => {
  await Promise.all([keys].flat().map((k) => call("DELETE", k)));
  for (const k of [keys].flat()) seen.delete(k);
};

// The object as a fetch Response, passing a Range header through for seeking.
export const openFile = (key, range) => call("GET", key, { headers: range ? { Range: range } : {} });

// A time-limited link straight to the object (the longest R2 allows is 7 days).
export const signedUrl = async (key, { seconds = 604800, download } = {}) => {
  const url = new URL(objectUrl(key));
  url.searchParams.set("X-Amz-Expires", String(seconds));
  if (download) url.searchParams.set("response-content-disposition", `attachment; filename="${download.replace(/"/g, "")}"`);
  const signed = await aws().sign(url.toString(), { method: "GET", aws: { signQuery: true } });
  return signed.url;
};

// Where the page fetches audio from: the booth's own origin, so no CORS rules are needed.
export const mediaPath = (key) => `/media/file/${key.split("/").map(encodeURIComponent).join("/")}`;

export const randomName = (name) => `${crypto.randomBytes(6).toString("hex")}-${name}`;
