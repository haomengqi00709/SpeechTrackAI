# SpeechTrack AI - Project Documentation

## Overview

SpeechTrack AI is a smart teleprompter application that combines real-time speech tracking with AI-powered live translation. Built as a frontend-only React SPA, it leverages browser APIs and Google's Gemini AI to provide a seamless presentation experience.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           App.tsx                                    │
│                    (Mode: EDIT | READ)                              │
├────────────────────────────┬────────────────────────────────────────┤
│                            │                                         │
│    ScriptEditor.tsx        │         Teleprompter.tsx               │
│    (EDIT Mode)             │         (READ Mode)                    │
│                            │                                         │
│  ┌──────────────────┐      │    ┌─────────────────────────────┐    │
│  │ Script Input     │      │    │ Speech Tracking Panel       │    │
│  │ PDF Upload       │      │    │ (useSpeechRecognition)      │    │
│  │ AI Analysis      │      │    ├─────────────────────────────┤    │
│  │ Script Polish    │      │    │ Translation Panel           │    │
│  └──────────────────┘      │    │ (useGeminiLive OR           │    │
│                            │    │  useTextTranslation)        │    │
│                            │    └─────────────────────────────┘    │
└────────────────────────────┴────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                          Services Layer                              │
├─────────────────────────────┬───────────────────────────────────────┤
│  geminiService.ts           │  pdfService.ts                        │
│  - analyzeScript()          │  - PDF text extraction                │
│  - polishScript()           │                                       │
└─────────────────────────────┴───────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                           Hooks Layer                                │
├───────────────────┬───────────────────┬─────────────────────────────┤
│ useSpeechRecog.   │ useGeminiLive     │ useTextTranslation          │
│ (Web Speech API)  │ (Live API)        │ (Text API + TTS)            │
│                   │                   │                              │
│ - transcript      │ - audio streaming │ - translation               │
│ - isListening     │ - bidirectional   │ - browser/gemini TTS        │
│ - auto-restart    │ - real-time       │ - faster text display       │
└───────────────────┴───────────────────┴─────────────────────────────┘
```

## Technology Stack

| Layer | Technology |
|-------|------------|
| Framework | React 19 + TypeScript |
| Build Tool | Vite |
| Styling | Tailwind CSS (CDN) |
| AI | Google Gemini (@google/genai) |
| PDF | pdfjs-dist |
| Audio | Web Audio API, MediaDevices |
| Speech | Web Speech Recognition API |

## Core Features

### 1. Script Editing (EDIT Mode)

**Components:** `ScriptEditor.tsx`, `geminiService.ts`

- **Text Input**: Direct script entry with word/character count
- **PDF Upload**: Extract text from PDF presentations
- **AI Analysis**: Gemini 2.5 Flash analyzes scripts for:
  - Tone (Serious, Inspiring, Casual, etc.)
  - Estimated duration
  - Pacing suggestions
  - Key points extraction
  - Readability score (0-100)
- **Script Polish**: AI rewrites script for better flow and professionalism

### 2. Speech Tracking (READ Mode)

**Components:** `Teleprompter.tsx`, `useSpeechRecognition.ts`

Real-time word highlighting that follows the speaker's voice.

#### Tracking Algorithm

Uses a **distance-based confirmation system** to prevent false jumps while allowing intentional skips:

```
Distance from current position → Required consecutive word matches
─────────────────────────────────────────────────────────────────
0-1 words ahead               → 1 word match (immediate progression)
2-10 words ahead              → 2 consecutive words must match
11+ words ahead               → 3 consecutive words must match
```

**Why this approach:**
- Single word matches are common (e.g., "the", "and") and could cause false jumps
- Requiring more confirmation for longer jumps reduces errors
- Still allows speakers to skip sections intentionally

**Manual Controls:**
- Click any word to jump to that position
- Arrow keys for manual navigation
- Space bar toggles tracking on/off

### 3. Live Translation

Two translation modes available, selectable before starting:

#### Mode A: "Live" (Gemini Live API)

**Hook:** `useGeminiLive.ts`

```
┌──────────┐    PCM Audio     ┌─────────────────┐    Audio + Text    ┌──────────┐
│   Mic    │ ───────────────► │  Gemini Live    │ ─────────────────► │ Speaker  │
│          │   16kHz Int16    │  Native Audio   │   24kHz + text     │          │
└──────────┘                  └─────────────────┘                    └──────────┘
```

- **Model:** `gemini-2.5-flash-native-audio-preview-12-2025`
- **Pros:** Natural voice, handles context well
- **Cons:** Higher latency (waits for speech pauses), may delay during long sentences

#### Mode B: "Fast" (Text Pipeline + TTS)

**Hook:** `useTextTranslation.ts`

```
┌──────────┐    Web Speech    ┌─────────────────┐    Text     ┌─────────────────┐
│   Mic    │ ───────────────► │  Speech-to-Text │ ──────────► │  Gemini Text    │
│          │    Recognition   │  (Browser API)  │             │  Translation    │
└──────────┘                  └─────────────────┘             └────────┬────────┘
                                                                       │
                              ┌─────────────────┐    Translated        │
                              │  TTS Engine     │ ◄─────────────────────┘
                              │ (Browser/Gemini)│    Text
                              └────────┬────────┘
                                       │
                                       ▼
                              ┌──────────────────┐
                              │  Audio Output    │
                              └──────────────────┘
```

- **Translation triggers:**
  - Sentence boundary detected (. ! ? , ; :)
  - 5+ words accumulated
  - 2 seconds elapsed since last translation
- **Voice options:**
  - **Fast (Browser TTS):** Instant playback, robotic voice
  - **Natural (Gemini TTS):** Higher quality voice, additional API latency
- **Pros:** Faster text display, more control over timing
- **Cons:** Two-step process, voice may not match Live mode quality

### 4. PDF Presentation Mode

When a PDF is uploaded:
- Left panel: PDF slides with navigation
- Right panel: Translation/interpretation feed
- Keyboard navigation: Arrow keys, Space, Enter
- Overlay captions on slides (when translation active)

## UI Layout (READ Mode)

```
┌─────────────────────────────────────────────────────────────────────┐
│  [← Back]  [Live|Fast]  [Voice: Fast|Natural]  [Start]  [▣]  [⟲]  [🎤] │
├─────────────────────────────────┬───────────────────────────────────┤
│                                 │ ← Draggable divider               │
│     Script / PDF View           │     Translation Panel             │
│                                 │                                   │
│   Words highlighted as          │   Source: (what you said)         │
│   speaker progresses            │                                   │
│                                 │   Target: (translation)           │
│   ████ spoken                   │                                   │
│   ░░░░ upcoming                 │   [Speaking indicator]            │
│                                 │                                   │
└─────────────────────────────────┴───────────────────────────────────┘
```

The right panel is resizable via drag handle.

## State Management

Simple React hooks pattern - no external state library.

| State | Location | Purpose |
|-------|----------|---------|
| `mode` | App.tsx | EDIT vs READ mode |
| `script` | App.tsx | Script text content |
| `activeIndex` | Teleprompter.tsx | Current word position |
| `translationMode` | Teleprompter.tsx | 'live' or 'text' |
| `voiceMode` | Teleprompter.tsx | 'browser' or 'gemini' |
| `showSubtitles` | Teleprompter.tsx | Translation active |

## Audio Processing Details

### Input (Microphone → Gemini)
```typescript
// Float32 from Web Audio → Int16 PCM → Base64
const pcmToBase64 = (data: Float32Array): string => {
  const int16 = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const s = Math.max(-1, Math.min(1, data[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  // ... convert to base64
};
```

### Output (Gemini → Speaker)
```typescript
// Base64 → Int16 PCM → Float32 for Web Audio
const playAudioChunk = (base64Data: string) => {
  // Decode base64 → Uint8Array → Int16Array
  // Convert Int16 → Float32 (divide by 32768)
  // Create AudioBuffer, schedule playback
};
```

## Known Limitations & Considerations

### Speech Recognition
- **Browser dependency:** Only works in Chrome/Edge (Web Speech API)
- **Transcript resets:** Browser may reset transcript after silence; code handles this
- **Single instance:** Can't run two speech recognitions simultaneously; Fast mode shares transcript with tracking when both active

### Live Translation (Gemini Live API)
- **VAD latency:** Gemini waits for speech pauses before responding
- **Long sentences:** May accumulate delay during extended speech
- **Quick mode (hidden):** Attempted to reduce latency with periodic nudges; not fully effective

### Fast Translation
- **Two-step latency:** Speech recognition + translation + TTS
- **Browser TTS quality:** Robotic but instant
- **Gemini TTS quality:** Natural but adds ~1-2s per phrase

### General
- **Frontend-only:** API key exposed in browser (use environment variables)
- **No persistence:** Scripts not saved between sessions
- **No tests:** Test infrastructure not yet configured

## Environment Setup

```bash
# .env.local
API_KEY=your_gemini_api_key
```

```bash
npm install
npm run dev    # http://localhost:3000
```

## File Structure

```
SpeechTrackAI/
├── App.tsx                 # Root component, mode switching
├── index.tsx               # Entry point
├── types.ts                # TypeScript interfaces
├── components/
│   ├── ScriptEditor.tsx    # EDIT mode UI
│   ├── Teleprompter.tsx    # READ mode UI (main)
│   └── PDFViewer.tsx       # PDF rendering
├── hooks/
│   ├── useSpeechRecognition.ts  # Web Speech API wrapper
│   ├── useGeminiLive.ts         # Gemini Live API streaming
│   └── useTextTranslation.ts    # Text translation + TTS
├── services/
│   ├── geminiService.ts    # Script analysis & polish
│   └── pdfService.ts       # PDF text extraction
├── vite.config.ts
├── tailwind.config.js
└── package.json
```

## Future Considerations

1. **Reduce Live mode latency**
   - Explore Gemini's VAD settings
   - Consider hybrid approach (text for display, audio for voice)

2. **Translation tracking**
   - Sync visual highlighting with audio playback
   - Handle paraphrasing (speaker doesn't match script exactly)

3. **Multi-language support**
   - Source language detection
   - More target languages (currently English → French primary)

4. **Persistence**
   - Save scripts locally or to cloud
   - Session history

5. **Mobile support**
   - Touch-friendly controls
   - Responsive layout improvements
