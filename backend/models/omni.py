import base64
import struct
import logging
import numpy as np
import torch
from transformers import AutoModelForCausalLM, AutoProcessor, AutoTokenizer
from config import OMNI_MODEL_NAME, DEVICE_MAP, TORCH_DTYPE, ATTN_IMPLEMENTATION, INPUT_SAMPLE_RATE, OUTPUT_SAMPLE_RATE, VAD_THRESHOLD, VAD_SILENCE_DURATION_MS

logger = logging.getLogger(__name__)


class OmniModel:
    def __init__(self):
        self.model = None
        self.processor = None
        self.tokenizer = None
        self.vad_model = None
        self.loaded = False

    def load(self):
        """Load Qwen3-Omni model and silero VAD."""
        logger.info(f"Loading Omni model: {OMNI_MODEL_NAME}")

        self.processor = AutoProcessor.from_pretrained(OMNI_MODEL_NAME, trust_remote_code=True)
        self.tokenizer = AutoTokenizer.from_pretrained(OMNI_MODEL_NAME, trust_remote_code=True)
        dtype = torch.float16 if TORCH_DTYPE == "float16" else torch.bfloat16
        self.model = AutoModelForCausalLM.from_pretrained(
            OMNI_MODEL_NAME,
            torch_dtype=dtype,
            device_map=DEVICE_MAP,
            attn_implementation=ATTN_IMPLEMENTATION,
            trust_remote_code=True,
        )
        self.model.eval()

        # Load silero VAD
        self.vad_model, vad_utils = torch.hub.load(
            repo_or_dir="snakers4/silero-vad",
            model="silero_vad",
            trust_repo=True,
        )
        self.vad_get_speech_timestamps = vad_utils[0]

        self.loaded = True
        logger.info("Omni model loaded successfully")

    def detect_speech_end(self, audio_np: np.ndarray, sample_rate: int) -> bool:
        """Use silero VAD to detect if speech has ended (silence at the tail).
        Silero VAD requires exactly 512 samples per call at 16kHz."""
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
            speech_prob = self.vad_model(audio_tensor, sample_rate).item()
            if speech_prob >= VAD_THRESHOLD:
                return False

        return True

    def translate(self, audio_np: np.ndarray, sample_rate: int, target_language: str) -> dict:
        """
        Run Qwen3-Omni inference on accumulated audio.
        Returns dict with 'text' and 'audio' (base64 PCM) keys.
        """
        if not self.loaded:
            raise RuntimeError("Model not loaded")

        system_prompt = (
            f"You are a professional simultaneous interpreter. "
            f"Listen to the audio and translate the speech into {target_language}. "
            f"Output ONLY the translation in both text and audio."
        )

        # Build conversation for the processor
        conversation = [
            {"role": "system", "content": [{"type": "text", "text": system_prompt}]},
            {
                "role": "user",
                "content": [{"type": "audio", "audio": (audio_np, sample_rate)}],
            },
        ]

        # Process inputs
        text_input = self.processor.apply_chat_template(
            conversation, add_generation_prompt=True, tokenize=False
        )
        inputs = self.processor(
            text=text_input,
            audio=(audio_np, sample_rate),
            return_tensors="pt",
            padding=True,
        )
        inputs = {k: v.to(self.model.device) for k, v in inputs.items()}

        with torch.no_grad():
            outputs = self.model.generate(
                **inputs,
                modalities=["text", "audio"],
                max_new_tokens=2048,
                speaker="Ethan",
            )

        result = {"text": "", "audio": None}

        # Extract text output
        if hasattr(outputs, "text") and outputs.text:
            text_ids = outputs.text[0]
            result["text"] = self.tokenizer.decode(text_ids, skip_special_tokens=True)
        elif isinstance(outputs, tuple) and len(outputs) > 0:
            result["text"] = self.tokenizer.decode(outputs[0][0], skip_special_tokens=True)

        # Extract audio output
        if hasattr(outputs, "audio") and outputs.audio is not None:
            audio_out = outputs.audio[0].cpu().numpy()
            # Convert float32 to int16 PCM
            audio_int16 = np.clip(audio_out * 32767, -32768, 32767).astype(np.int16)
            result["audio"] = base64.b64encode(audio_int16.tobytes()).decode("ascii")

        return result


    def unload(self):
        """Free GPU memory."""
        self.model = None
        self.processor = None
        self.tokenizer = None
        self.vad_model = None
        self.loaded = False
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        logger.info("Omni model unloaded")


# Singleton instance
omni_model = OmniModel()
