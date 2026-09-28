const API = "https://api.elevenlabs.io";

const describe = (text) => {
  try {
    const body = JSON.parse(text);
    const detail = body.detail ?? body;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) return detail.map((d) => d.msg ?? JSON.stringify(d)).join("; ");
    return detail.message ?? detail.status ?? JSON.stringify(detail);
  } catch {
    return text.slice(0, 300);
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ElevenLabs answers a prompt that names an artist or song with a suggested rewrite.
const suggestionIn = (text) => {
  try {
    const find = (v) => {
      if (!v || typeof v !== "object") return null;
      for (const [k, x] of Object.entries(v)) {
        if (/suggest/i.test(k) && x) return typeof x === "string" ? x : JSON.stringify(x).slice(0, 400);
        const deeper = find(x);
        if (deeper) return deeper;
      }
      return null;
    };
    return find(JSON.parse(text));
  } catch {
    return null;
  }
};

const V3_STABILITY = [0, 0.5, 1];

// The request body ElevenLabs sees. The cache key is built from this, so equal bodies share audio.
export const speechBody = ({ modelId, text, settings = {}, speed = 1, seed, previousText, nextText }) => {
  const v3 = modelId.startsWith("eleven_v3");
  const stability = settings.stability ?? 0.5;
  return {
    text,
    model_id: modelId,
    voice_settings: v3
      ? {
          stability: V3_STABILITY.reduce((a, b) => (Math.abs(b - stability) < Math.abs(a - stability) ? b : a)),
          similarity_boost: settings.similarity_boost ?? 0.75,
          style: settings.style ?? 0,
          speed,
        }
      : {
          stability,
          similarity_boost: settings.similarity_boost ?? 0.75,
          style: settings.style ?? 0,
          use_speaker_boost: true,
          speed,
        },
    seed,
    previous_text: v3 ? undefined : previousText || undefined,
    next_text: v3 ? undefined : nextText || undefined,
  };
};

export const createEleven = (key) => {
  const call = async (method, route, body, attempt = 0) => {
    const res = await fetch(`${API}${route}`, {
      method,
      headers: { "xi-api-key": key, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && attempt < 4) {
      await sleep(1200 * (attempt + 1));
      return call(method, route, body, attempt + 1);
    }
    if (!res.ok) {
      const err = new Error(`ElevenLabs ${res.status}: ${describe(await res.text())}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  };

  return {
    subscription: async () => {
      const s = await call("GET", "/v1/user/subscription");
      return { tier: s.tier, used: s.character_count, limit: s.character_limit, resetsAt: s.next_character_count_reset_unix };
    },

    voices: async () =>
      (await call("GET", "/v1/voices")).voices.map((v) => ({
        voiceId: v.voice_id,
        name: v.name,
        category: v.category,
        gender: v.labels?.gender ?? null,
        age: v.labels?.age ?? null,
        accent: v.labels?.accent ?? null,
        description: v.labels?.descriptive ?? v.labels?.description ?? null,
        useCase: v.labels?.use_case ?? null,
        previewUrl: v.preview_url ?? null,
        hqModels: v.high_quality_base_model_ids ?? [],
      })),

    models: async () =>
      (await call("GET", "/v1/models"))
        .filter((m) => m.can_do_text_to_speech)
        .map((m) => ({
          modelId: m.model_id,
          name: m.name,
          description: m.description,
          maxChars: m.maximum_text_length_per_request ?? null,
          costFactor: m.model_rates?.character_cost_multiplier ?? 1,
        })),

    library: async ({ q, gender, language = "en", page = 0 }) => {
      const qs = new URLSearchParams({ page_size: "24", page: String(page), sort: "trending", language });
      if (q) qs.set("search", q);
      if (gender) qs.set("gender", gender);
      const r = await call("GET", `/v1/shared-voices?${qs}`);
      return {
        hasMore: Boolean(r.has_more),
        voices: r.voices.map((v) => ({
          voiceId: v.voice_id,
          ownerId: v.public_owner_id,
          name: v.name,
          category: v.category,
          gender: v.gender ?? null,
          age: v.age ?? null,
          accent: v.accent ?? null,
          description: v.descriptive ?? null,
          useCase: v.use_case ?? null,
          previewUrl: v.preview_url ?? null,
          added: Boolean(v.is_added_by_user),
          uses: v.cloned_by_count ?? 0,
        })),
      };
    },

    addShared: (ownerId, voiceId, name) => call("POST", `/v1/voices/add/${ownerId}/${voiceId}`, { new_name: name }),

    // A track from a composition plan (exact part lengths, seedable) or a free-text prompt
    // (always instrumental). 192 kbps needs a Creator tier or above, so 128 kbps is the fallback.
    composeMusic: async ({ prompt, lengthMs, plan, seed, modelId = "music_v2" }) => {
      const body = plan
        ? { composition_plan: plan, model_id: modelId, ...(Number.isInteger(seed) ? { seed } : {}) }
        : { prompt, music_length_ms: lengthMs, model_id: modelId, force_instrumental: true };
      const formats = ["mp3_48000_192", "mp3_44100_128"];
      for (let f = 0; f < formats.length; f++) {
        for (let attempt = 0; ; attempt++) {
          const res = await fetch(`${API}/v1/music?output_format=${formats[f]}`, {
            method: "POST",
            headers: { "xi-api-key": key, "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          if (res.status === 429 && attempt < 5) {
            await sleep(2500 * (attempt + 1));
            continue;
          }
          if (res.ok) return { audio: Buffer.from(await res.arrayBuffer()), format: formats[f], retries: attempt };
          const text = await res.text();
          if (f === 0 && [400, 403, 422].includes(res.status) && /output.?format|bitrate|192|tier|subscription/i.test(text)) break;
          const err = new Error(`ElevenLabs ${res.status}: ${describe(text)}`);
          err.status = res.status;
          err.suggestion = suggestionIn(text);
          throw err;
        }
      }
      throw new Error("ElevenLabs didn't return any music");
    },

    // What a take actually says, with word timings (Scribe v2). Key terms bias it toward names in
    // the script; if the API refuses them, it retries without.
    transcribe: async (audio, filename, { keyterms = [] } = {}) => {
      const form = (withTerms) => {
        const f = new FormData();
        f.append("model_id", "scribe_v2");
        f.append("tag_audio_events", "false");
        f.append("timestamps_granularity", "word");
        if (withTerms) for (const k of keyterms) f.append("keyterms", k);
        f.append("file", new Blob([audio]), filename);
        return f;
      };
      for (const withTerms of keyterms.length ? [true, false] : [false]) {
        for (let attempt = 0; ; attempt++) {
          const res = await fetch(`${API}/v1/speech-to-text`, { method: "POST", headers: { "xi-api-key": key }, body: form(withTerms) });
          if (res.status === 429 && attempt < 4) {
            await sleep(1200 * (attempt + 1));
            continue;
          }
          if (res.ok) {
            const r = await res.json();
            return { text: r.text ?? "", words: (r.words ?? []).filter((w) => w.type === "word").map((w) => ({ text: w.text, start: w.start, end: w.end })) };
          }
          const detail = describe(await res.text());
          if (withTerms && (res.status === 400 || res.status === 422)) break;
          const err = new Error(`ElevenLabs ${res.status}: ${detail}`);
          err.status = res.status;
          throw err;
        }
      }
      throw new Error("ElevenLabs speech-to-text failed");
    },

    // Speech plus per-character timing. Drops options a model rejects, the way
    // test-impact-video/tools/voiceover.mjs does (v3 has no request stitching or free stability).
    speak: async (voiceId, body) => {
      const route = `/v1/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_128`;
      const plain = { ...body, previous_text: undefined, next_text: undefined };
      const vs = body.voice_settings;
      const attempts = [
        body,
        plain,
        { ...plain, voice_settings: { stability: 0.5, similarity_boost: vs.similarity_boost, style: vs.style, speed: vs.speed } },
        { ...plain, voice_settings: { stability: 0.5, similarity_boost: 0.8, speed: vs.speed } },
      ];
      let last;
      for (let k = 0; k < attempts.length; k++) {
        try {
          return { out: await call("POST", route, attempts[k]), attempt: k };
        } catch (err) {
          last = err;
          if (err.status !== 400 && err.status !== 422) throw err;
        }
      }
      throw last;
    },
  };
};
