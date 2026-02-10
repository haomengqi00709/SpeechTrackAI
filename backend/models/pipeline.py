import base64
import logging
import numpy as np
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from config import (
    ASR_MODEL_NAME,
    TRANSLATION_MODEL_NAME,
    TTS_MODEL_NAME,
    DEVICE_MAP,
    TORCH_DTYPE,
    IS_MAC,
    INPUT_SAMPLE_RATE,
    OUTPUT_SAMPLE_RATE,
    VAD_THRESHOLD,
    VAD_SILENCE_DURATION_MS,
)

logger = logging.getLogger(__name__)


class ASRModel:
    def __init__(self):
        self.model = None
        self.loaded = False

    def load(self):
        logger.info(f"Loading ASR model: {ASR_MODEL_NAME}")
        from qwen_asr import Qwen3ASRModel

        self.model = Qwen3ASRModel.from_pretrained(ASR_MODEL_NAME)
        self.loaded = True
        logger.info("ASR model loaded successfully")

    def unload(self):
        self.model = None
        self.loaded = False
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        logger.info("ASR model unloaded")

    def transcribe(self, audio_np: np.ndarray, sample_rate: int, language: str = "English") -> str:
        """Transcribe audio to text in the specified language."""
        if not self.loaded:
            raise RuntimeError("ASR model not loaded")

        result = self.model.transcribe(audio=(audio_np, sample_rate), language=language)
        # Extract text from ASRTranscription object(s)
        if isinstance(result, str):
            return result
        if isinstance(result, list):
            # List of ASRTranscription objects — join their .text fields
            texts = []
            for item in result:
                if hasattr(item, 'text'):
                    texts.append(item.text)
                elif isinstance(item, dict):
                    texts.append(item.get('text', ''))
                else:
                    texts.append(str(item))
            return ' '.join(t for t in texts if t)
        if hasattr(result, 'text'):
            return result.text
        if isinstance(result, dict):
            return result.get("text", "")
        return str(result)


class TranslationModel:
    def __init__(self):
        self.model = None
        self.tokenizer = None
        self.loaded = False

    def load(self):
        logger.info(f"Loading translation model: {TRANSLATION_MODEL_NAME}")
        self.tokenizer = AutoTokenizer.from_pretrained(TRANSLATION_MODEL_NAME)
        dtype = torch.float16 if TORCH_DTYPE == "float16" else torch.bfloat16
        self.model = AutoModelForCausalLM.from_pretrained(
            TRANSLATION_MODEL_NAME,
            torch_dtype=dtype,
            device_map=DEVICE_MAP,
        )
        self.model.eval()
        self.loaded = True
        logger.info("Translation model loaded successfully")

    def unload(self):
        self.model = None
        self.tokenizer = None
        self.loaded = False
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        logger.info("Translation model unloaded")

    def translate(self, text: str, target_language: str) -> str:
        """Translate text to target language."""
        if not self.loaded:
            raise RuntimeError("Translation model not loaded")

        messages = [
            {
                "role": "system",
                "content": f"You are a translator. Translate the following text to {target_language}. Output ONLY the translation, nothing else.",
            },
            {"role": "user", "content": text},
        ]

        input_text = self.tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True
        )
        inputs = self.tokenizer(input_text, return_tensors="pt").to(self.model.device)

        with torch.no_grad():
            outputs = self.model.generate(
                **inputs,
                max_new_tokens=512,
                do_sample=False,
            )

        # Decode only the generated tokens (skip the prompt)
        generated_ids = outputs[0][inputs["input_ids"].shape[1] :]
        return self.tokenizer.decode(generated_ids, skip_special_tokens=True).strip()

    def translate_stream(self, text: str, target_language: str, context_turns: list[dict] | None = None):
        """Translate text with streaming output. Yields text chunks.

        If context_turns is provided, they're inserted as prior user/assistant chat turns
        so the model naturally continues the translation style and coherence.
        """
        if not self.loaded:
            raise RuntimeError("Translation model not loaded")

        system_prompt = f"You are a translator. Translate the following text to {target_language}. Output ONLY the translation, nothing else."

        messages = [{"role": "system", "content": system_prompt}]

        # Add prior translation turns as chat history
        if context_turns:
            messages.extend(context_turns)

        # Add the new text to translate
        messages.append({"role": "user", "content": text})

        input_text = self.tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True
        )
        inputs = self.tokenizer(input_text, return_tensors="pt").to(self.model.device)

        from transformers import TextIteratorStreamer
        from threading import Thread

        streamer = TextIteratorStreamer(self.tokenizer, skip_prompt=True, skip_special_tokens=True)

        generation_kwargs = {
            **inputs,
            "max_new_tokens": 512,
            "do_sample": False,
            "streamer": streamer,
        }

        thread = Thread(target=self.model.generate, kwargs=generation_kwargs)
        thread.start()

        for text_chunk in streamer:
            if text_chunk:
                yield text_chunk

        thread.join()


class TTSModel:
    def __init__(self):
        self.model = None
        self.loaded = False
        self.sample_rate = OUTPUT_SAMPLE_RATE

    def load(self):
        logger.info(f"Loading TTS model: {TTS_MODEL_NAME}")
        from qwen_tts import Qwen3TTSModel

        # Force CPU on Mac — MPS doesn't support >65536 output channels needed by TTS
        tts_device = "cpu" if IS_MAC else DEVICE_MAP
        dtype = torch.float32 if IS_MAC else (torch.float16 if TORCH_DTYPE == "float16" else torch.bfloat16)
        self.model = Qwen3TTSModel.from_pretrained(
            TTS_MODEL_NAME,
            device_map=tts_device,
            dtype=dtype,
        )
        self.loaded = True
        logger.info("TTS model loaded successfully")

    def unload(self):
        self.model = None
        self.loaded = False
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        logger.info("TTS model unloaded")

    def synthesize(self, text: str, language: str = "Auto") -> str:
        """Synthesize speech from text. Returns base64-encoded PCM int16 audio."""
        if not self.loaded:
            raise RuntimeError("TTS model not loaded")

        wavs, sr = self.model.generate_custom_voice(
            text=text,
            language=language,
            speaker="aiden",
            max_new_tokens=2048,
        )
        self.sample_rate = sr

        audio_np = wavs[0]
        if isinstance(audio_np, torch.Tensor):
            audio_np = audio_np.cpu().numpy()

        # Ensure 1D
        if audio_np.ndim > 1:
            audio_np = audio_np.squeeze()

        # Convert to int16 PCM
        audio_int16 = np.clip(audio_np * 32767, -32768, 32767).astype(np.int16)
        return base64.b64encode(audio_int16.tobytes()).decode("ascii")


class VADDetector:
    """Shared VAD detector for the pipeline."""

    def __init__(self):
        self.model = None
        self.loaded = False

    def load(self):
        logger.info("Loading silero VAD for pipeline")
        self.model, vad_utils = torch.hub.load(
            repo_or_dir="snakers4/silero-vad",
            model="silero_vad",
            trust_repo=True,
        )
        self.loaded = True
        logger.info("VAD loaded successfully")

    def unload(self):
        self.model = None
        self.loaded = False
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        logger.info("VAD unloaded")

    def detect_speech_end(self, audio_np: np.ndarray, sample_rate: int) -> bool:
        """Check if the tail of the audio buffer is silence.
        Silero VAD requires exactly 512 samples per call at 16kHz."""
        # Need at least a few windows to check
        window_size = 512 if sample_rate == 16000 else 256
        num_tail_windows = int(VAD_SILENCE_DURATION_MS / 1000 * sample_rate / window_size)
        num_tail_windows = max(num_tail_windows, 2)

        if len(audio_np) < window_size * num_tail_windows:
            return False

        # Check the last N windows — if all are below threshold, speech has ended
        tail_start = len(audio_np) - (window_size * num_tail_windows)
        for i in range(num_tail_windows):
            chunk = audio_np[tail_start + i * window_size : tail_start + (i + 1) * window_size]
            audio_tensor = torch.from_numpy(chunk).float()
            if audio_tensor.abs().max() > 0:
                audio_tensor = audio_tensor / audio_tensor.abs().max()
            speech_prob = self.model(audio_tensor, sample_rate).item()
            if speech_prob >= VAD_THRESHOLD:
                return False  # Still speaking in at least one window

        return True  # All tail windows are silence


# Singleton instances
asr_model = ASRModel()
translation_model = TranslationModel()
tts_model = TTSModel()
vad_detector = VADDetector()
