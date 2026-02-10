# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
npm install          # Install dependencies
npm run dev          # Development server (http://localhost:3000)
npm run build        # Build for production
npm run preview      # Preview production build
```

No lint, test, or formatting commands are configured.

## Required Configuration

Set `GEMINI_API_KEY` in `.env.local`. Vite config maps this to both `process.env.API_KEY` and `process.env.GEMINI_API_KEY` via `define` in `vite.config.ts`.

## Architecture Overview

**SpeechTrack AI** is a frontend-only React + TypeScript SPA — a smart teleprompter with speech recognition tracking and Gemini AI integration. All API calls go directly to Google's Gemini APIs from the browser.

### Two-Mode Application

- **EDIT mode** (`ScriptEditor.tsx`): Script editing, PDF upload, AI analysis (tone, duration, pacing, readability), script polishing
- **READ mode** (`Teleprompter.tsx`): Teleprompter presentation with real-time speech tracking and optional live translation

`App.tsx` holds top-level state (`mode`, `script`, `pdfFile`) and renders one mode at a time.

### Key Directories

```
components/          # ScriptEditor, Teleprompter, PDFViewer
services/            # geminiService (analysis/polish), pdfService (PDF text extraction)
hooks/               # useSpeechRecognition, useGeminiLive, useTextTranslation
```

### Technology Stack

- **React 19** + **TypeScript** + **Vite** (requires `target: 'esnext'` for pdfjs-dist top-level await)
- **@google/genai** — Gemini 2.5 Flash for analysis, Native Audio Preview for live translation
- **Tailwind CSS** via CDN (`<script src="https://cdn.tailwindcss.com">` in index.html)
- **pdfjs-dist** for PDF rendering
- **Browser APIs**: Web Speech Recognition (Chrome/Edge only), Web Audio, MediaDevices
- Path alias: `@/` maps to project root (configured in both `tsconfig.json` and `vite.config.ts`)

### Import Map

`index.html` contains an import map pointing to CDN URLs for dependencies. This coexists with the npm `node_modules` setup used by Vite's dev server and build.

## Core Features

### Speech Tracking (Teleprompter.tsx + useSpeechRecognition hook)

Uses Web Speech API to track speaker position in script via a distance-based confirmation algorithm:
- 0-1 words ahead: Single word match accepted
- 2-10 words ahead: Requires 2 consecutive words
- 11+ words ahead: Requires 3 consecutive words

This prevents false jumps on common words while allowing intentional skips. Users can also click any word to manually jump.

### Live Translation — Two Modes

#### Mode A: "Live" (useGeminiLive.ts)

Bidirectional audio streaming with Gemini Live API:
- **Input**: Microphone audio → PCM Int16 Base64 at 16kHz
- **Output**: Translated audio playback (24kHz) + text transcription
- **Model**: `gemini-2.5-flash-native-audio-preview-12-2025`
- **Trade-off**: Natural voice quality but higher latency (Gemini's VAD waits for speech pauses)

Key states: `liveSource` (English transcript), `liveSubtitle` (French translation text), `audioPlaybackCount`, `volume`.

#### Mode B: "Fast" (useTextTranslation.ts)

Pipeline: Browser Speech Recognition → Gemini text translation → TTS (browser or Gemini)
- **Translation triggers**: Sentence boundary (`.!?,;:`), 5+ accumulated words, or 2s timeout
- **Voice options**: Browser TTS (instant, robotic) or Gemini TTS (natural, ~1-2s latency)
- **Trade-off**: Faster text display, more timing control, but two-step process

### Disabled/Hidden Features

- **Translation tracking**: Commented-out code for green highlighting synced with audio playback. Challenges: matching paraphrased speech to script, syncing visual with audio timing.
- **Quick Response Mode**: Hidden UI button. Periodic "nudge" messages to reduce Gemini Live latency — not yet effective due to VAD behavior.

## Important Notes

- **State management**: Simple React hooks, no external state library
- **Audio processing**: Custom PCM encoding (Float32 → Int16 Base64) for Gemini Live API input; reverse for output playback via Web Audio API with scheduled buffering
- **No persistence**: Scripts are not saved between sessions
- **Speech recognition**: Only works in Chrome/Edge; browser may reset transcript after silence (handled in code); can't run two recognitions simultaneously
