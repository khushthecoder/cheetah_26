# DoseCard

**Photograph a doctor's prescription. Get a large-print, Hindi + English daily medicine card for the fridge — read by Gemma running on your own laptop.**

> Built for the Hacktoberfest 2026 Weekend Challenge: *Build for a Friend*.

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
3. **Plain code decides the schedule** — a deterministic, unit-tested decoder turns `1-0-1`, `BD`, `HS`, `½-0-½`, `1-0-0-1`, "after lunch", "subah khali pet" etc. into morning / afternoon / evening / night. The model's own guess is used only as a flagged fallback.
4. **A human checks every row** against the photo, shown side by side. The card can't be generated until every medicine is ticked.
5. **Print the card or copy it for WhatsApp.**

## Why open-source AI (and not a cloud API)

These are true for this implementation, not aspirational:

- **The prescription never leaves the laptop.** The browser talks to a Vite dev server bound to `127.0.0.1`, which proxies to Ollama on `127.0.0.1:11434`. There is no other network call — no analytics, no remote fonts.
- **It works offline** once the model is downloaded.
- **It costs nothing per prescription.** No API key, no quota.
- **The model is swappable** — set `VITE_MODEL` to any Ollama model with vision support.
- **It runs on an 8 GB MacBook Air-class machine** (`gemma4:e2b-it-qat`, ~4.3 GB).

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
medicine timings. So the model is only asked to transcribe; interpretation is done by code that has tests.
See [`src/lib/frequency.ts`](src/lib/frequency.ts) and [`src/lib/extract.ts`](src/lib/extract.ts).

## Results

<!-- TODO: fill from `npm run eval` output (eval-results/*.json) — measured, not estimated. -->

| | |
|---|---|
| Medicines found | TODO |
| Schedule correct — model's own guess | TODO |
| Schedule correct — DoseCard (rules + fallback) | TODO |
| Average time per prescription (text) | TODO |
| Photo → review screen | TODO |

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
```

The client is tested against Ollama being offline, the model missing, timeouts, empty / non-JSON /
wrongly-shaped output, duplicate rows and hallucinated rows.

## Privacy

- Nothing is uploaded anywhere. Inference is local; the only server is your own machine.
- The last card is saved in this browser's `localStorage` so it survives a refresh. "Start a new prescription" deletes it.
- Don't commit real prescriptions — `private/` is git-ignored for local test photos.

## Limitations (honest)

- **Not medical advice.** DoseCard transcribes; a person must check every row, and the app enforces that.
- Handwriting accuracy of a 2B model is limited. Badly lit or very messy prescriptions will need manual fixes.
- Weekly / alternate-day schedules are deliberately not decoded — they're flagged for manual entry.
- "OD" with no time is assumed to be morning and flagged.
- Runs on a laptop; there is no phone app or hosted version (by design — see Privacy).

## Future work

<!-- TODO: add what your person actually asked for after using it -->
- Refill reminders from the "for how long" field
- A phone build that runs a small Gemma on-device
- Medicine-name spell-check against a local, open drug list

## Credits

- [Gemma](https://ai.google.dev/gemma) open-weight models by Google DeepMind
- [Ollama](https://ollama.com) for local inference
