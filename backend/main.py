import asyncio
import base64
import json
import logging
import re
import struct
import numpy as np
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from config import CORS_ORIGINS, HOST, PORT, INPUT_SAMPLE_RATE, OUTPUT_SAMPLE_RATE, IS_MAC, MIN_SPEECH_DURATION_S, PERSONAPLEX_MODEL_NAME
from models.omni import omni_model
from models.pipeline import asr_model, translation_model, tts_model, vad_detector
from models.personaplex import personaplex_model

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def unload_all_models():
    """Unload all models to free GPU memory."""
    if omni_model.loaded:
        omni_model.unload()
    if asr_model.loaded:
        asr_model.unload()
    if translation_model.loaded:
        translation_model.unload()
    if tts_model.loaded:
        tts_model.unload()
    if vad_detector.loaded:
        vad_detector.unload()
    if personaplex_model.loaded:
        personaplex_model.unload()


def load_omni():
    """Unload everything else, then load Omni."""
    unload_all_models()
    omni_model.load()


def load_pipeline():
    """Unload everything else, then load Pipeline models."""
    unload_all_models()
    asr_model.load()
    translation_model.load()
    tts_model.load()
    vad_detector.load()


def load_personaplex():
    """Unload everything else, then load PersonaPlex."""
    unload_all_models()
    personaplex_model.load()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lazy loading — no models loaded at startup. Each mode loads on demand."""
    logger.info("Server starting (lazy model loading — no models loaded at startup)")
    yield
    logger.info("Shutting down — unloading models")
    unload_all_models()


app = FastAPI(title="SpeechTrack AI Local Backend", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def decode_pcm_base64(data: str) -> np.ndarray:
    """Decode base64 PCM Int16 data to float32 numpy array."""
    raw = base64.b64decode(data)
    int16_array = np.frombuffer(raw, dtype=np.int16)
    return int16_array.astype(np.float32) / 32768.0


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "models": {
            "omni": omni_model.loaded,
            "asr": asr_model.loaded,
            "translation": translation_model.loaded,
            "tts": tts_model.loaded,
            "vad": vad_detector.loaded,
            "personaplex": personaplex_model.loaded,
        },
    }


@app.websocket("/ws/omni")
async def ws_omni(websocket: WebSocket):
    """Qwen3-Omni bidirectional streaming endpoint."""
    await websocket.accept()
    logger.info("Omni WebSocket connected")

    loop = asyncio.get_event_loop()

    # Lazy load: unload other models, load Omni
    if not omni_model.loaded:
        try:
            logger.info("Loading Omni model on demand...")
            await websocket.send_json({"type": "status", "data": "loading_model"})
            await loop.run_in_executor(None, load_omni)
        except Exception as e:
            logger.error(f"Failed to load Omni model: {e}")
            await websocket.send_json({"type": "error", "message": f"Model load failed: {e}"})
            await websocket.close()
            return

    audio_buffer = np.array([], dtype=np.float32)
    target_language = "French"

    try:
        await websocket.send_json({"type": "status", "data": "ready"})

        while True:
            raw = await websocket.receive_text()
            msg = json.loads(raw)

            if msg["type"] == "config":
                target_language = msg.get("targetLanguage", "French")
                logger.info(f"Omni config: target={target_language}")

            elif msg["type"] == "audio":
                chunk = decode_pcm_base64(msg["data"])
                audio_buffer = np.concatenate([audio_buffer, chunk])

                # Check for speech end via VAD
                if omni_model.loaded and len(audio_buffer) > INPUT_SAMPLE_RATE * 0.5:
                    has_silence = await loop.run_in_executor(
                        None, omni_model.detect_speech_end, audio_buffer, INPUT_SAMPLE_RATE
                    )

                    if has_silence and len(audio_buffer) > INPUT_SAMPLE_RATE * 0.3:
                        await websocket.send_json({"type": "status", "data": "processing"})

                        # Run inference in thread pool
                        result = await loop.run_in_executor(
                            None,
                            omni_model.translate,
                            audio_buffer.copy(),
                            INPUT_SAMPLE_RATE,
                            target_language,
                        )

                        # Send source text (we don't have separate ASR in omni mode,
                        # but the model may provide input transcription)
                        if result.get("text"):
                            await websocket.send_json({
                                "type": "translated_text",
                                "data": result["text"],
                            })

                        if result.get("audio"):
                            await websocket.send_json({
                                "type": "audio",
                                "data": result["audio"],
                                "sampleRate": OUTPUT_SAMPLE_RATE,
                            })

                        # Clear buffer after processing
                        audio_buffer = np.array([], dtype=np.float32)
                        await websocket.send_json({"type": "status", "data": "ready"})

            elif msg["type"] == "stop":
                logger.info("Omni stop received")
                break

    except WebSocketDisconnect:
        logger.info("Omni WebSocket disconnected")
    except Exception as e:
        logger.error(f"Omni WebSocket error: {e}")
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass


@app.websocket("/ws/pipeline")
async def ws_pipeline(websocket: WebSocket):
    """Qwen3 ASR + Translation + TTS pipeline endpoint.

    Strategy: stable prefix detection for real-time incremental translation.
    - ASR runs every ~1s on the growing buffer → sends source_text_interim
    - Compare consecutive ASR outputs to find "stable" prefix (words in 2+ runs)
    - Queue translation jobs for stable words — processed sequentially by a worker
    - On VAD silence → queue remaining words, wait for queue to drain, clear buffer
    - Max buffer: 15s — auto-flush to prevent ASR from slowing down on huge buffers
    """
    await websocket.accept()
    logger.info("Pipeline WebSocket connected")

    loop = asyncio.get_event_loop()

    # Lazy load: unload other models, load Pipeline
    if not (asr_model.loaded and translation_model.loaded and tts_model.loaded and vad_detector.loaded):
        try:
            logger.info("Loading Pipeline models on demand...")
            await websocket.send_json({"type": "status", "data": "loading_model"})
            await loop.run_in_executor(None, load_pipeline)
        except Exception as e:
            logger.error(f"Failed to load Pipeline models: {e}")
            await websocket.send_json({"type": "error", "message": f"Model load failed: {e}"})
            await websocket.close()
            return

    audio_buffer = np.array([], dtype=np.float32)
    target_language = "French"
    source_language = "English"
    asr_mode = "local"  # "local" = Qwen3-ASR, "browser" = client sends text
    loop = asyncio.get_event_loop()

    # ASR tracking (local mode)
    ASR_INTERVAL_S = 1.0
    last_asr_samples = 0
    last_asr_text = ""

    # Stable prefix tracking for incremental translation (local ASR mode)
    prev_asr_words: list[str] = []
    translated_word_count = 0

    # Text mode tracking (browser ASR mode) — position-based, not prefix-based
    text_translated_up_to = 0  # character position up to which we've already translated
    last_text_translate_time = asyncio.get_event_loop().time()

    # Translation queue — worker processes draft and refine jobs sequentially
    # Queue items: None (shutdown) or dict {"type": "draft"/"refine", ...}
    translate_queue: asyncio.Queue[dict | None] = asyncio.Queue()

    # TTS queue — serializes TTS calls so they don't collide (model isn't thread-safe)
    tts_queue: asyncio.Queue[str | None] = asyncio.Queue()

    # Context: list of prior user/assistant turns for multi-turn chat translation
    translation_context_turns: list[dict] = []
    MAX_CONTEXT_TURNS = 6

    # Draft+Refine architecture:
    # - "draft" jobs produce fast translations shown immediately (no TTS, no context)
    # - "refine" jobs re-translate accumulated source with context → replace drafts, run TTS
    draft_source_chunks: list[str] = []
    draft_count_since_refine = 0
    refine_queued = False

    MAX_BUFFER_S = 15.0

    FILLER_WORDS = {'the', 'okay', 'um', 'uh', 'ah', 'oh', 'hmm', 'hm', 'a', 'an', ''}

    def is_filler(text: str) -> bool:
        cleaned = text.strip().rstrip('.')
        words = [w.strip().lower() for w in cleaned.split() if w.strip()]
        meaningful = [w for w in words if w not in FILLER_WORDS]
        return len(meaningful) == 0

    def find_stable_prefix_len(prev_words: list[str], curr_words: list[str]) -> int:
        """Find how many words from the start match between two consecutive ASR outputs."""
        common = 0
        for i in range(min(len(prev_words), len(curr_words))):
            if prev_words[i].lower() == curr_words[i].lower():
                common = i + 1
            else:
                break
        return common

    async def translation_worker():
        """Background task: process draft and refine translation jobs.
        Draft = fast translation shown immediately (no TTS, no context).
        Refine = re-translate accumulated source with context, replace drafts, run TTS."""
        nonlocal draft_count_since_refine, refine_queued
        try:
            while True:
                job = await translate_queue.get()
                if job is None:
                    translate_queue.task_done()
                    break
                try:
                    if job["type"] == "draft":
                        text = job["text"]
                        logger.info(f"[Pipeline] Draft translate: '{text.strip()}'")
                        full_translation = ""
                        for text_chunk in translation_model.translate_stream(text.strip(), target_language):
                            full_translation += text_chunk
                            await websocket.send_json({"type": "translated_text_draft", "data": text_chunk})
                        await websocket.send_json({"type": "translated_text_draft", "data": " "})
                        logger.info(f"[Pipeline] Draft result: '{full_translation.strip()}'")

                        draft_source_chunks.append(text.strip())
                        draft_count_since_refine += 1

                        # Auto-trigger refine after 3 drafts or sentence boundary
                        has_sentence_end = bool(re.search(r'[.!?]$', text.strip()))
                        if (draft_count_since_refine >= 3 or has_sentence_end) and not refine_queued:
                            translate_queue.put_nowait({"type": "refine"})
                            refine_queued = True

                    elif job["type"] == "refine":
                        refine_queued = False
                        if not draft_source_chunks:
                            continue  # Nothing to refine

                        source = " ".join(draft_source_chunks)
                        logger.info(f"[Pipeline] Refining: '{source}' (context: {len(translation_context_turns)} turns)")
                        full_translation = ""
                        for text_chunk in translation_model.translate_stream(
                            source.strip(), target_language,
                            context_turns=translation_context_turns if translation_context_turns else None
                        ):
                            full_translation += text_chunk

                        # Send complete refined text — frontend replaces all drafts
                        await websocket.send_json({"type": "translated_text_final", "data": full_translation.strip()})
                        logger.info(f"[Pipeline] Refined: '{full_translation.strip()}'")

                        # Update context with refined translation only
                        translation_context_turns.append({"role": "user", "content": source.strip()})
                        translation_context_turns.append({"role": "assistant", "content": full_translation.strip()})
                        while len(translation_context_turns) > MAX_CONTEXT_TURNS:
                            translation_context_turns.pop(0)

                        # Queue TTS — runs in separate worker, doesn't block translation
                        if full_translation.strip():
                            tts_queue.put_nowait(full_translation.strip())

                        # Clear draft tracking for next cycle
                        draft_source_chunks.clear()
                        draft_count_since_refine = 0

                except Exception as e:
                    logger.error(f"[Pipeline] Worker error: {e}")
                    await websocket.send_json({"type": "error", "message": f"Translation failed: {e}"})
                finally:
                    translate_queue.task_done()
        except asyncio.CancelledError:
            pass

    async def tts_worker():
        """Background task: process TTS jobs sequentially (model isn't thread-safe)."""
        try:
            while True:
                text = await tts_queue.get()
                if text is None:
                    tts_queue.task_done()
                    break
                try:
                    logger.info(f"[Pipeline] TTS synthesizing: '{text[:50]}...'")
                    audio_b64 = await loop.run_in_executor(
                        None, tts_model.synthesize, text, target_language
                    )
                    await websocket.send_json({
                        "type": "audio", "data": audio_b64, "sampleRate": tts_model.sample_rate,
                    })
                    logger.info("[Pipeline] TTS audio sent")
                except Exception as e:
                    logger.error(f"[Pipeline] TTS failed: {e}")
                finally:
                    tts_queue.task_done()
        except asyncio.CancelledError:
            pass

    def queue_draft(text: str):
        """Add a draft translation job to the queue."""
        if text.strip() and not is_filler(text):
            translate_queue.put_nowait({"type": "draft", "text": text})

    def check_stable_and_translate(current_words: list[str]):
        """Check stable prefix and queue translation if enough new words."""
        nonlocal prev_asr_words, translated_word_count

        if not current_words:
            prev_asr_words = current_words
            return

        stable_len = find_stable_prefix_len(prev_asr_words, current_words)
        prev_asr_words = current_words

        new_stable_count = stable_len - translated_word_count
        if new_stable_count <= 0:
            return

        new_stable_text = ' '.join(current_words[translated_word_count:stable_len])
        if is_filler(new_stable_text):
            return

        has_sentence_boundary = bool(re.search(r'[.!?,;:]', new_stable_text))
        if new_stable_count >= 5 or has_sentence_boundary:
            logger.info(f"[Pipeline] Stable translate ({new_stable_count} words): '{new_stable_text}'")
            translated_word_count = stable_len
            queue_draft(new_stable_text)

    async def flush_buffer():
        """Finalize current buffer: final ASR, queue remaining translation, clear state."""
        nonlocal audio_buffer, last_asr_samples, last_asr_text, prev_asr_words, translated_word_count, refine_queued

        if len(audio_buffer) < INPUT_SAMPLE_RATE * MIN_SPEECH_DURATION_S:
            # Too short, just clear
            audio_buffer = np.array([], dtype=np.float32)
            last_asr_samples = 0
            last_asr_text = ""
            prev_asr_words = []
            translated_word_count = 0
            return

        try:
            final_text = await loop.run_in_executor(
                None, asr_model.transcribe, audio_buffer.copy(), INPUT_SAMPLE_RATE, source_language
            )
            final_text = final_text.strip()

            if final_text and not is_filler(final_text):
                logger.info(f"[Pipeline] ASR final: '{final_text}'")
                await websocket.send_json({"type": "source_text", "data": final_text})

                # Queue remaining untranslated words
                final_words = final_text.split()
                if translated_word_count < len(final_words):
                    remaining = ' '.join(final_words[translated_word_count:])
                    if remaining.strip() and not is_filler(remaining):
                        logger.info(f"[Pipeline] Queue remaining: '{remaining}'")
                        queue_draft(remaining)

        except Exception as e:
            logger.error(f"[Pipeline] Final ASR failed: {e}")

        # Trigger refine for any accumulated drafts on speech pause
        if not refine_queued:
            translate_queue.put_nowait({"type": "refine"})
            refine_queued = True

        # Clear state for next utterance
        audio_buffer = np.array([], dtype=np.float32)
        last_asr_samples = 0
        last_asr_text = ""
        prev_asr_words = []
        translated_word_count = 0

    # Start workers
    worker_task = asyncio.create_task(translation_worker())
    tts_task = asyncio.create_task(tts_worker())

    try:
        await websocket.send_json({"type": "status", "data": "ready"})

        while True:
            try:
                raw = await asyncio.wait_for(websocket.receive_text(), timeout=3.0)
            except asyncio.TimeoutError:
                # No message for 3s — trigger refine if there are unrefined drafts
                if draft_source_chunks and not refine_queued:
                    logger.info("[Pipeline] Timeout → triggering refine for pending drafts")
                    translate_queue.put_nowait({"type": "refine"})
                    refine_queued = True
                continue
            msg = json.loads(raw)

            if msg["type"] == "config":
                target_language = msg.get("targetLanguage", "French")
                source_language = "French" if target_language == "English" else "English"
                asr_mode = msg.get("asrMode", "local")
                logger.info(f"Pipeline config: source={source_language} → target={target_language}, asr={asr_mode}")

            elif msg["type"] == "audio":
                chunk = decode_pcm_base64(msg["data"])
                audio_buffer = np.concatenate([audio_buffer, chunk])

                # --- Run ASR periodically for live source text + incremental translation ---
                new_samples = len(audio_buffer) - last_asr_samples
                if asr_model.loaded and new_samples >= INPUT_SAMPLE_RATE * ASR_INTERVAL_S:
                    try:
                        current_text = await loop.run_in_executor(
                            None, asr_model.transcribe, audio_buffer.copy(), INPUT_SAMPLE_RATE, source_language
                        )
                        current_text = current_text.strip()

                        if current_text and current_text != last_asr_text:
                            if not is_filler(current_text):
                                logger.info(f"[Pipeline] ASR interim: '{current_text}'")
                                await websocket.send_json({
                                    "type": "source_text_interim",
                                    "data": current_text,
                                })
                                last_asr_text = current_text

                                check_stable_and_translate(current_text.split())
                    except Exception as e:
                        logger.warning(f"[Pipeline] ASR failed: {e}")

                    last_asr_samples = len(audio_buffer)

                # --- VAD: detect silence → flush buffer ---
                if vad_detector.loaded and len(audio_buffer) > INPUT_SAMPLE_RATE * 0.5:
                    has_silence = await loop.run_in_executor(
                        None, vad_detector.detect_speech_end, audio_buffer, INPUT_SAMPLE_RATE
                    )

                    if has_silence and len(audio_buffer) > INPUT_SAMPLE_RATE * MIN_SPEECH_DURATION_S:
                        await flush_buffer()
                        await websocket.send_json({"type": "status", "data": "ready"})

                # --- Auto-flush if buffer too long (prevents ASR slowdown) ---
                elif len(audio_buffer) > INPUT_SAMPLE_RATE * MAX_BUFFER_S:
                    logger.info(f"[Pipeline] Auto-flush: buffer exceeded {MAX_BUFFER_S}s")
                    await flush_buffer()

            elif msg["type"] == "text":
                # Browser ASR mode — text comes from client, skip local ASR
                # Uses character position tracking (not prefix matching) to handle
                # browser Speech API revising capitalization/punctuation in interim results
                text = msg.get("data", "").strip()
                is_final = msg.get("isFinal", False)

                if not text or is_filler(text):
                    continue

                # Handle transcript reset (browser restarts recognition)
                if len(text) < text_translated_up_to:
                    text_translated_up_to = 0

                new_content = text[text_translated_up_to:].strip()
                if not new_content or is_filler(new_content):
                    continue

                if is_final:
                    logger.info(f"[Pipeline/Text] Final translate: '{new_content}'")
                    text_translated_up_to = len(text)
                    last_text_translate_time = asyncio.get_event_loop().time()
                    queue_draft(new_content)
                    # Final result — trigger refine for accumulated drafts
                    if not refine_queued:
                        translate_queue.put_nowait({"type": "refine"})
                        refine_queued = True
                else:
                    now = asyncio.get_event_loop().time()
                    time_since = now - last_text_translate_time
                    has_sentence = bool(re.search(r'[.!?,;:]', new_content))
                    word_count = len(new_content.split())
                    time_trigger = time_since >= 2.0 and word_count >= 2

                    if has_sentence or word_count >= 5 or time_trigger:
                        trigger = "sentence" if has_sentence else (f"{word_count} words" if word_count >= 5 else "timeout")
                        logger.info(f"[Pipeline/Text] Translate trigger ({trigger}): '{new_content}'")
                        text_translated_up_to = len(text)
                        last_text_translate_time = now
                        queue_draft(new_content)

            elif msg["type"] == "stop":
                logger.info("Pipeline stop received")
                break

    except WebSocketDisconnect:
        logger.info("Pipeline WebSocket disconnected")
    except Exception as e:
        logger.error(f"Pipeline WebSocket error: {e}")
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass
    finally:
        # Shutdown workers
        translate_queue.put_nowait(None)
        tts_queue.put_nowait(None)
        worker_task.cancel()
        tts_task.cancel()
        try:
            await worker_task
        except asyncio.CancelledError:
            pass
        try:
            await tts_task
        except asyncio.CancelledError:
            pass


@app.websocket("/ws/personaplex")
async def ws_personaplex(websocket: WebSocket):
    """PersonaPlex-7B full-duplex streaming endpoint.

    PersonaPlex operates frame-by-frame at 12.5 Hz (80ms per frame).
    Unlike VAD-triggered batch modes, it processes audio continuously:
    1. Accumulate incoming PCM into a buffer
    2. Every frame_size samples (1920 at 24kHz = 80ms):
       a. Encode frame with Mimi
       b. Step LMGen with input codes
       c. Decode output codes with Mimi
       d. Send text token + audio chunk to client
    """
    await websocket.accept()
    logger.info("PersonaPlex WebSocket connected")

    PERSONAPLEX_SAMPLE_RATE = 24000
    FRAME_RATE = 12.5
    FRAME_SIZE = int(PERSONAPLEX_SAMPLE_RATE / FRAME_RATE)  # 1920 samples

    audio_buffer = np.array([], dtype=np.float32)
    target_language = "French"
    loop = asyncio.get_event_loop()

    # Lazy load: unload other models, load PersonaPlex
    if not personaplex_model.loaded:
        try:
            logger.info("Loading PersonaPlex model on demand...")
            await websocket.send_json({"type": "status", "data": "loading_model"})
            await loop.run_in_executor(None, load_personaplex)
        except Exception as e:
            logger.error(f"Failed to load PersonaPlex model: {e}")
            await websocket.send_json({"type": "error", "message": f"Model load failed: {e}"})
            await websocket.close()
            return

    # Reset streaming state for new session
    personaplex_model.reset()

    try:
        await websocket.send_json({"type": "status", "data": "ready"})

        while True:
            raw = await websocket.receive_text()
            msg = json.loads(raw)

            if msg["type"] == "config":
                target_language = msg.get("targetLanguage", "French")
                logger.info(f"PersonaPlex config: target={target_language}")
                # Update the translation persona prompt
                await loop.run_in_executor(
                    None, personaplex_model.update_text_prompt, target_language
                )
                personaplex_model.reset()

            elif msg["type"] == "audio":
                chunk = decode_pcm_base64(msg["data"])
                audio_buffer = np.concatenate([audio_buffer, chunk])

                # Process complete frames
                while len(audio_buffer) >= FRAME_SIZE:
                    frame = audio_buffer[:FRAME_SIZE]
                    audio_buffer = audio_buffer[FRAME_SIZE:]

                    try:
                        # 1. Encode input frame to Mimi codes
                        input_codes = await loop.run_in_executor(
                            None, personaplex_model.encode_audio, frame
                        )

                        # 2. Step LMGen: get output codes + text token
                        output_codes, text_token = await loop.run_in_executor(
                            None, personaplex_model.step, input_codes
                        )

                        # 3. Send text token if non-empty
                        if text_token:
                            await websocket.send_json({
                                "type": "translated_text",
                                "data": text_token,
                            })

                        # 4. Decode output audio codes and send
                        if output_codes is not None:
                            audio_out = await loop.run_in_executor(
                                None, personaplex_model.decode_audio, output_codes
                            )
                            # Convert float32 to int16 PCM base64
                            audio_int16 = np.clip(audio_out * 32767, -32768, 32767).astype(np.int16)
                            audio_b64 = base64.b64encode(audio_int16.tobytes()).decode("ascii")
                            await websocket.send_json({
                                "type": "audio",
                                "data": audio_b64,
                                "sampleRate": PERSONAPLEX_SAMPLE_RATE,
                            })

                    except Exception as e:
                        logger.warning(f"PersonaPlex frame processing error: {e}")

            elif msg["type"] == "stop":
                logger.info("PersonaPlex stop received")
                break

    except WebSocketDisconnect:
        logger.info("PersonaPlex WebSocket disconnected")
    except Exception as e:
        logger.error(f"PersonaPlex WebSocket error: {e}")
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host=HOST, port=PORT, reload=True)
