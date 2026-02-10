import os
import platform
import torch

# Model names (override via environment variables)
OMNI_MODEL_NAME = os.environ.get("OMNI_MODEL_NAME", "Qwen/Qwen3-Omni-30B-A3B-Instruct")
ASR_MODEL_NAME = os.environ.get("ASR_MODEL_NAME", "Qwen/Qwen3-ASR-0.6B")
TRANSLATION_MODEL_NAME = os.environ.get("TRANSLATION_MODEL_NAME", "Qwen/Qwen3-4B-Instruct-2507")
TTS_MODEL_NAME = os.environ.get("TTS_MODEL_NAME", "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice")
PERSONAPLEX_MODEL_NAME = os.environ.get("PERSONAPLEX_MODEL_NAME", "nvidia/personaplex-7b-v1")
PERSONAPLEX_VOICE = os.environ.get("PERSONAPLEX_VOICE", "NATM1")

# Device settings — auto-detect Mac vs CUDA
IS_MAC = platform.system() == "Darwin"
if os.environ.get("DEVICE_MAP"):
    DEVICE_MAP = os.environ["DEVICE_MAP"]
elif torch.cuda.is_available() or (IS_MAC and torch.backends.mps.is_available()):
    DEVICE_MAP = "auto"  # "auto" works for both CUDA and MPS in transformers 4.57+
else:
    DEVICE_MAP = "cpu"

# Mac doesn't support flash_attention_2; use float16 (well-supported on MPS)
TORCH_DTYPE = "float16" if IS_MAC else "bfloat16"
ATTN_IMPLEMENTATION = "eager" if IS_MAC else "flash_attention_2"

# Audio parameters
INPUT_SAMPLE_RATE = 16000
OUTPUT_SAMPLE_RATE = 24000
AUDIO_CHUNK_SIZE = 4096

# VAD settings
VAD_THRESHOLD = 0.3  # Lower = stricter (more confidence needed to count as "speech")
VAD_SILENCE_DURATION_MS = 1000  # ms of silence before triggering inference
MIN_SPEECH_DURATION_S = 1.0  # Minimum seconds of audio before processing (skip short noise)

# Server settings
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8000"))
CORS_ORIGINS = os.environ.get("CORS_ORIGINS", "http://localhost:3000").split(",")
