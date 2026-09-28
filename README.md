# Voice booth

Try ElevenLabs voices, pauses and background music on a finished video without re-rendering it.

Built for Graphify's Remotion videos. The booth reads the video project's own files: where each
line of the script sits on the picture, the original voice's timing, and a music bed rendered
without the voice. It fits each new take onto the picture, plays it against the untouched video,
and saves the take you pick back into the project so the video can be rendered once with it.

## What it does

- **Voices**: your ElevenLabs voices and the Voice Library, on any model (v3, Multilingual v2,
  Flash). Lines generate three at a time and are cached, so a take you've made before loads free.
- **Fitting**: *Natural* plays every line as generated with its first word on the original's;
  *Phrase sync* cuts only in real silences and keeps phrases on their original beats; *Tight*
  stretches phrases gently (0.92–1.1×). Takes are leveled to the original voice for fair A/B.
- **Script card**: karaoke highlighting that follows the voice. Edit a line and it regenerates.
  Add pauses (the booth writes the right syntax for each model), v3 tags like `[whispers]`, and a
  per-project pronunciation list.
- **Word check**: ElevenLabs Scribe transcribes every line and flags missing or misheard words.
- **Music**: drop an MP3 onto a timeline lane (move, trim, fades, ducking under the voice), or use
  the music library: 12 launch-video styles made with ElevenLabs Music, and *Compose to fit*, which
  writes a track whose sections change where the video's lines change.
- **Export**: copies the video stream untouched and writes the new voice, bed and music as its audio.
- **Save take to project**: writes the take you're hearing into the video project as a new voice
  track, so the read you picked is the read that ships.

## Run it

Needs Node.js 22.15 or newer.

```bash
npm install
cp .env.example .env    # then add your ELEVENLABS_API_KEY
npm start               # http://localhost:4455
```

On Windows you can double-click `start.cmd` instead. The API key stays on the server; the browser
never sees it.

## Videos it can open

- **Test Impact**, read live from `../test-impact-video` (or `TEST_IMPACT_DIR`).
- **Any project that writes a voice map**: put `out/<name>.voicemap.json` (and ideally
  `out/<name>.bed.wav`, the mix without the voice) next to the render in a folder beside the booth.
- **Any other video** with "Open a video…": paste the script and pin each line to its start.

A voice map, with paths relative to the file:

```json
{
  "title": "Launch video",
  "video": { "path": "launch.mp4", "width": 1920, "height": 1080, "duration": 80.2 },
  "bed": { "path": "launch.bed.wav" },
  "voiceGain": 1,
  "original": { "voiceId": "…", "modelId": "eleven_v3", "speed": 1.06 },
  "sections": [
    {
      "id": "hook",
      "text": "You changed one function.",
      "at": 0.35,
      "orig": { "path": "vo/hook.mp3", "text": "You changed one function.", "starts": [], "ends": [] }
    }
  ]
}
```

`at` is where the section's audio starts on the video. `orig` is the ElevenLabs character timing
of the take the picture was cut to; without it, sections simply play from `at`.

## Commands

| Command | What it does |
| --- | --- |
| `npm test` | Offline checks: fitting, timing, markup, music plans, the library queue |
| `npm run bed -- <track>` | Render the Test Impact music bed without the voice |
| `npm run music:starter` | Make the 24-track starter library (every style at 60 s and 90 s) |
| `npm run music:verify` | Check every made track's length, energy arc, and that nobody sings |

Takes, transcripts, music and exports stay in `cache/`, `music/` and `exports/`, which git ignores.

## Music licence

Tracks made with ElevenLabs Music on a paid plan can be used in online videos and ads, not TV,
film or radio. Keep the library for your own videos rather than sharing it as a music pack.
