// Music styles for launch, feature and demo videos. Shared by the page, the server and the
// starter CLI. Styles stay generic: ElevenLabs rejects prompts that name artists or songs.

export const DEFAULT_NEGATIVE = ["vocals", "singing", "lyrics", "choir", "spoken word", "big edm drop", "aggressive distortion", "abrupt ending"];

// Directions per part of a track. A style can replace any of them.
export const ROLE_STYLES = {
  intro: ["sparse intro", "soft and gentle start", "few elements", "room for voiceover"],
  build: ["building gradually", "adds subtle rhythmic motion", "rising energy"],
  lift: ["fuller arrangement", "confident main theme", "warm full chords"],
  steady: ["steady groove", "consistent energy", "not busy", "supports narration"],
  resolve: ["resolving", "gentle swell", "final cadence", "ends on a sustained final chord"],
};

const style = (s) => ({ ...s, negative: [...DEFAULT_NEGATIVE, ...(s.negative ?? [])] });

export const PRESETS = [
  style({
    id: "minimal-tech-pulse",
    name: "Minimal Tech Pulse",
    blurb: "Sparse electronic pulse and clean plucks. Precise and understated, made for talking over.",
    bpm: 100,
    energy: "low",
    tags: ["electronic", "minimal", "demo", "voiceover"],
    positive: ["minimal electronic", "soft analog synth pulse", "clean plucked synth arpeggio", "warm sub bass", "light clicky percussion", "precise and understated", "modern software product video", "100 bpm", "great production quality"],
  }),
  style({
    id: "cinematic-build",
    name: "Cinematic Build",
    blurb: "Felt piano and low strings over a quiet pulse that builds to a confident lift.",
    bpm: 90,
    energy: "medium",
    tags: ["cinematic", "piano", "strings", "launch"],
    positive: ["restrained cinematic score", "felt piano motif", "low sustained strings", "subtle electronic pulse", "slow build", "hopeful and confident", "product launch film", "90 bpm", "great production quality"],
    negative: ["epic trailer percussion", "huge orchestral crescendo"],
  }),
  style({
    id: "optimistic-saas-house",
    name: "Optimistic SaaS House",
    blurb: "Light tech house with warm keys and crisp hats. Upbeat without getting busy.",
    bpm: 112,
    energy: "medium",
    tags: ["house", "upbeat", "feature", "electronic"],
    positive: ["light tech house", "warm electric piano chords", "crisp hi-hats", "rounded bassline", "upbeat and optimistic", "clean modern mix", "feature announcement video", "112 bpm", "great production quality"],
  }),
  style({
    id: "ambient-keynote",
    name: "Ambient Keynote",
    blurb: "Airy pads and slow evolving chords, no drums. Calm space for a keynote-style open.",
    bpm: 70,
    energy: "low",
    tags: ["ambient", "calm", "keynote", "no drums"],
    positive: ["airy ambient pads", "gentle shimmering textures", "slow evolving chords", "calm and spacious", "elegant", "keynote opening", "70 bpm", "great production quality"],
    negative: ["drums", "percussion", "beat"],
    roles: { build: ["slowly opening up", "added warmth", "rising harmonic motion"], steady: ["steady ambient bed", "consistent", "not busy", "supports narration"] },
  }),
  style({
    id: "warm-hybrid",
    name: "Warm Hybrid",
    blurb: "Acoustic guitar and soft piano with light synth textures. Human and hopeful.",
    bpm: 96,
    energy: "medium",
    tags: ["acoustic", "warm", "story", "hybrid"],
    positive: ["fingerpicked acoustic guitar", "soft piano", "subtle synth textures", "light shaker percussion", "warm and human", "hopeful", "customer story video", "96 bpm", "great production quality"],
  }),
  style({
    id: "lofi-demo",
    name: "Lo-fi Demo",
    blurb: "Mellow lo-fi beat with dusty keys. Relaxed and focused, good under walkthroughs.",
    bpm: 80,
    energy: "low",
    tags: ["lo-fi", "chill", "tutorial", "demo"],
    positive: ["mellow lo-fi hip hop beat", "dusty electric piano", "soft vinyl texture", "relaxed round bass", "cozy and focused", "tutorial walkthrough", "80 bpm", "great production quality"],
  }),
  style({
    id: "driving-synthwave",
    name: "Driving Synthwave",
    blurb: "Pulsing synth bass and bright pads with forward motion. For teasers and hype cuts.",
    bpm: 118,
    energy: "high",
    tags: ["synthwave", "energetic", "teaser", "electronic"],
    positive: ["driving synth bass arpeggio", "retro modern synthwave", "punchy electronic drums", "bright lead pads", "energetic forward motion", "product teaser", "118 bpm", "great production quality"],
  }),
  style({
    id: "piano-strings",
    name: "Precision Piano and Strings",
    blurb: "Elegant piano ostinato with pizzicato strings. Refined, steady and trustworthy.",
    bpm: 92,
    energy: "medium",
    tags: ["piano", "strings", "enterprise", "elegant"],
    positive: ["elegant piano ostinato", "pizzicato and legato strings", "light percussion", "confident and trustworthy", "refined", "enterprise product video", "92 bpm", "great production quality"],
  }),
  style({
    id: "glitch-minimal",
    name: "Glitch Minimal",
    blurb: "Micro clicks, granular texture and deep sub. Detailed and technical, suits code on screen.",
    bpm: 105,
    energy: "medium",
    tags: ["glitch", "minimal", "developer", "electronic"],
    positive: ["minimal glitch electronica", "crisp micro clicks", "soft granular textures", "deep sub bass", "precise rhythmic detail", "developer tools video", "105 bpm", "great production quality"],
  }),
  style({
    id: "playful-plucks",
    name: "Playful Plucks",
    blurb: "Bright marimba and pluck melodies over a bouncy rhythm. Friendly and light.",
    bpm: 110,
    energy: "medium",
    tags: ["playful", "bright", "app", "marimba"],
    positive: ["bright marimba melody", "playful synth plucks", "bouncy rhythm", "soft claps", "friendly and light", "clean arrangement", "app feature video", "110 bpm", "great production quality"],
  }),
  style({
    id: "tension-reveal",
    name: "Tension to Reveal",
    blurb: "Low drones and a ticking pulse that build suspense, then open into bright major chords.",
    bpm: 95,
    energy: "medium",
    tags: ["tension", "reveal", "teaser", "cinematic"],
    positive: ["dark ambient tension", "ticking pulse", "low drones", "rising suspense", "restrained", "software teaser", "95 bpm", "great production quality"],
    roles: {
      lift: ["tension peaks", "held breath", "rising risers"],
      resolve: ["opens into bright major chords", "relief and clarity", "reveal moment", "ends on a sustained major chord"],
    },
  }),
  style({
    id: "social-cut-energy",
    name: "Social Cut Energy",
    blurb: "Punchy modern beat with bold synth stabs. Short-form energy for vertical cuts.",
    bpm: 122,
    energy: "high",
    tags: ["social", "energetic", "short", "electronic"],
    positive: ["punchy modern electronic beat", "bold synth stabs", "tight kick and snare", "energetic and confident", "short-form social video", "clean loud mix", "122 bpm", "great production quality"],
  }),
];

export const presetById = (id) => PRESETS.find((p) => p.id === id) ?? null;

export const roleStyles = (preset, role) => preset?.roles?.[role] ?? ROLE_STYLES[role];

// A one-line prompt for prompt mode (used for free-text requests that start from a style).
export const presetPrompt = (preset, extra = "") =>
  `Instrumental background music for a technology product video. ${preset.positive.join(", ")}.${extra ? ` ${extra}` : ""}`;
