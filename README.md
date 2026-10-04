# DoseCard

**Photograph a doctor's prescription. Get a large-print, Hindi + English daily medicine card for the fridge — read by Gemma running on your own laptop.**

> Built for the Hacktoberfest 2026 Weekend Challenge: *Build for a Friend*.

**Live:** https://dosecard.onrender.com — the page is hosted; the AI runs on your own computer (see [Deployment](#deployment-render)).

<!-- TODO: screenshot of the printed card on the fridge -->

## Why I built this

<!-- TODO (real story, in your words): who this is for, what the prescriptions look like,
     what went wrong before (missed dose / phone calls / rewriting it on paper). -->

## The problem

Indian prescriptions are written in shorthand: `1-0-1`, `BD`, `TDS`, `HS`, `OD`, `SOS`, `AC/PC`, often by hand.
Someone in the family has to translate that into *"which pill, when, before or after food, until when"* — and then
re-explain it over the phone, or write it out again on paper, every time the prescription changes.

## What DoseCard does

1. **Add the prescription** — a photo (up to 3 pages) or typed / pasted text.
2. **Gemma reads it on-device** — an open-weight model running in Ollama copies each medicine, strength, and the dosing text *exactly as written* into strict JSON.
3. **Plain code decides the schedule** — a deterministic, unit-tested decoder turns `1-0-1`, `BD`, `HS`, `½-0-½`, `1-0-0-1`, "after lunch", "subah khali pet" etc. into morning / afternoon / evening / night. If the code can't decode it, the row is left blank for the person to fill in — the model is never asked to guess.
4. **A human checks every row** against the photo, shown side by side. Anything the model wrote that isn't in the input (a changed name, an invented strength or dose) is flagged. The card can't be generated until every medicine is ticked and has a time.
5. **Print the card or copy it for WhatsApp.**

## Why open-source AI (and not a cloud API)

These are true for this implementation, not aspirational:

- **The prescription never leaves the laptop.** The browser talks to a Vite dev server bound to `127.0.0.1`, which proxies to Ollama on `127.0.0.1:11434`. There is no other network call — no analytics, no remote fonts.
- **It works offline** once the model is downloaded.
- **It costs nothing per prescription.** No API key, no quota.
- **The model is swappable** — set `VITE_MODEL` to any Ollama model with vision support.
- **It runs on an 8 GB M3 MacBook** (`gemma4:e2b-it-qat`, ~4.3 GB download).

## Architecture

```
 Browser (React, 127.0.0.1:5173)
   │  photo → downscaled to 1280px JPEG in a <canvas>
   │  POST /ollama/api/chat   { format: <JSON schema>, temperature: 0 }
   ▼
 Vite dev proxy ──► Ollama (127.0.0.1:11434) ──► gemma4:e2b-it-qat  (open weights, on-device)
                                                    │
   ┌────────────────────────────────────────────────┘  strict JSON: name, strength,
   ▼                                                   frequency_text (verbatim), food_text, …
 zod validation (bad rows dropped individually, dupes merged)
   ▼
 frequency.ts — deterministic decoder: "1-0-1" → {morning:1, night:1}
   ▼
 Review screen (human ticks every row) ──► Dose card (print / WhatsApp)  ──► localStorage (this browser only)
```

**The key design decision:** a 2B-parameter model is good at *reading* messy text and bad at being trusted with
medicine timings. We measured it: asked to also say *when* to take each medicine, Gemma's own answer was right
for **9 of 23** medicines — it read `HS` (bedtime) as morning and `0-0-1` as evening. The same model copying the
dosing text *verbatim* got all 23 right. So the model only transcribes; interpretation is done by code that has tests.
See [`src/lib/frequency.ts`](src/lib/frequency.ts) and [`src/lib/extract.ts`](src/lib/extract.ts).

## Results

Measured with `npm run eval` on an 8 GB M3, `gemma4:e2b-it-qat`, temperature 0. The test set is 8 typed prescriptions
(34 medicines) in different styles — GP shorthand, Latin abbreviations, spoken instructions, Hinglish WhatsApp,
four-slot notation, syrups and drops. 3 of them were written *after* the fixes below, as a held-out check.
Raw results are in [`eval/`](eval).

| | First design (model also guessed times) | Current design |
|---|---|---|
| Medicines found | 23 / 23 | **34 / 34** |
| Invented medicines | 0 | **0** |
| Schedule correct | 9 / 23 by the model · 21 / 23 by the decoder | **32 / 34** |
| Schedule **wrong** | 2 | **0** |
| Left for the person to set (by design) | — | 2 (`OD` with no time written) |
| Avg. time per prescription (text) | 15.2 s | **7.2 s** |

What the eval caught and what changed:

- `Glimisave M1 1-0-1` decoded as three times a day, and `Telma 40 1-0-0` would have read as *40 tablets*. Dose patterns now need consistent separators, can't be glued to letters, and more than 4 units in a slot is rejected.
- `Dolo only if fever goes above 100` and `Cetirizine at bedtime if itching` were put on the daily schedule. Any written condition now makes a medicine "only when needed", and those never appear in the daily grid.
- `OD` (once daily) was silently turned into "morning". It isn't written, so the app now asks.
- In a live run Gemma gave `Pan D` a strength of `1` that isn't on the prescription. Strengths must now appear next to the medicine's name, or the row is flagged.

**Not yet measured:** accuracy on real handwritten prescription photos. That is the hardest case for a 2B model and
is being tested with the real person this was built for.

## Tech stack

React 19 · TypeScript · Vite · Zod · Vitest · Ollama · Gemma 4 E2B (QAT, open weights)

## Run it locally

Requirements: Node 20+, [Ollama](https://ollama.com), ~5 GB free disk, 8 GB RAM.

```bash
# 1. Install and start Ollama
brew install ollama && brew services start ollama   # or the Ollama desktop app

# 2. Download the open-weight model (~4.3 GB, one time)
ollama pull gemma4:e2b-it-qat

# 3. Run DoseCard
git clone https://github.com/khushthecoder/cheetah_26.git dosecard && cd dosecard
npm install
npm run dev            # → http://127.0.0.1:5173
```

Click **Use a sample prescription → Read prescription** to try it without a real one.

### Environment variables

Copy `.env.example` to `.env` to override:

| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Where the dev server proxies `/ollama` |
| `VITE_MODEL` | `gemma4:e2b-it-qat` | Any Ollama model with image support |

## Testing

```bash
npm test          # unit tests: dose decoder, output validation, Ollama client errors, WhatsApp text
npm run typecheck
npm run build
npm run eval      # runs samples/eval-cases.json through the local model and scores it
npm run read -- path/to/prescription.jpg   # one photo or .txt through the same pipeline, raw output shown
```

The client is tested against Ollama being offline, the model missing, timeouts, empty / non-JSON /
wrongly-shaped output, duplicate rows and hallucinated rows.

## Deployment (Render)

The hosted version is a **static site on Render**. Only the web page is hosted — the AI is not.
The visitor's browser talks to Ollama on *their own* computer (`http://localhost:11434`), so prescriptions still never
leave the device. Running Gemma on a server instead would mean uploading health data and paying for a large CPU instance.

```
 GitHub push ─► GitHub Actions CI (typecheck · tests · build · no private/ files)
                   │ passes
                   ▼
              Render static site  (render.yaml, deploys only after CI passes)
                   │ serves HTML/JS/CSS
                   ▼
 Visitor's browser ──fetch──► Ollama on the visitor's machine (localhost:11434) ──► Gemma
```

- [`render.yaml`](render.yaml) — Render Blueprint: build command, publish dir, Node version, security headers
  (the Content-Security-Policy only allows the page to talk to itself and to `localhost:11434`).
- [`.github/workflows/ci.yml`](.github/workflows/ci.yml) — runs on every push and pull request.

**Visitors need a one-time setup**, which the page shows them with their exact site address:

```bash
ollama pull gemma4:e2b-it-qat
launchctl setenv OLLAMA_ORIGINS "https://<your-site>.onrender.com"   # macOS, then quit & reopen Ollama
# or: OLLAMA_ORIGINS="https://<your-site>.onrender.com" ollama serve
```

Ollama rejects requests from any website not listed in `OLLAMA_ORIGINS` (it returns 403), so this step is required.
Chrome may also ask for permission for the site to access apps on this device — click Allow.

## Privacy

- Nothing is uploaded anywhere. Inference is local; the only server is your own machine.
- The last card is saved in this browser's `localStorage` so it survives a refresh. "Start a new prescription" deletes it.
- Don't commit real prescriptions — `private/` is git-ignored for local test photos.

## Limitations (honest)

- **Not medical advice.** DoseCard transcribes; a person must check every row, and the app enforces that.
- Handwriting accuracy of a 2B model is limited. Badly lit or very messy prescriptions will need manual fixes.
- Weekly / alternate-day schedules are deliberately not decoded — they're flagged for manual entry.
- "OD" with no time written is left for the person to set — the app doesn't pick a time.
- Grounding checks (name / strength / dose must appear in the input) only work for typed text. For photos, the side-by-side review is the safeguard.
- The hosted page still needs Ollama on the visitor's computer (by design — see Privacy). There is no phone app yet.

## Future work

<!-- TODO: add what your person actually asked for after using it -->
- Refill reminders from the "for how long" field
- A phone build that runs a small Gemma on-device
- Medicine-name spell-check against a local, open drug list

## Credits

- [Gemma](https://ai.google.dev/gemma) open-weight models by Google DeepMind
- [Ollama](https://ollama.com) for local inference
