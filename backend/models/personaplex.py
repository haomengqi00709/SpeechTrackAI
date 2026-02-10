import base64
import logging
import numpy as np
import torch

logger = logging.getLogger(__name__)


class PersonaPlexModel:
    """NVIDIA PersonaPlex-7B-V1 wrapper using moshi package components.

    PersonaPlex is a real-time speech-to-speech model (based on Moshi architecture)
    that handles full-duplex conversation. It operates frame-by-frame at 12.5 Hz
    (one frame every 80ms).

    Components:
    - Mimi: Audio codec (encoder/decoder) — encodes PCM to discrete codes, decodes codes to PCM
    - LMGen: Streaming inference engine — takes audio codes in, produces text tokens + audio codes out
    - SentencePiece tokenizer: Decodes text tokens
    """

    def __init__(self):
        self.lm_gen = None       # LMGen streaming inference engine
        self.mimi = None         # Mimi audio codec (for encoding input)
        self.mimi_out = None     # Mimi audio codec (for decoding output)
        self.tokenizer = None    # SentencePiece text tokenizer
        self.loaded = False
        self.sample_rate = 24000
        self.frame_rate = 12.5   # Frames per second (one frame every 80ms)
        self.frame_size = int(self.sample_rate / self.frame_rate)  # 1920 samples per frame

    def load(self, voice_prompt: str = "NATM1", text_prompt: str | None = None):
        """Load model components from HuggingFace.

        Args:
            voice_prompt: Voice conditioning preset (e.g., "NATM1" for natural male voice 1).
            text_prompt: System prompt for the model. Defaults to translation persona.
        """
        from config import PERSONAPLEX_MODEL_NAME, PERSONAPLEX_VOICE

        voice_prompt = voice_prompt or PERSONAPLEX_VOICE

        logger.info(f"Loading PersonaPlex model: {PERSONAPLEX_MODEL_NAME}")

        try:
            from moshi.models.loaders import get_mimi, get_moshi_lm
            from moshi.models.lm_gen import LMGen
            import sentencepiece as spm
            from huggingface_hub import hf_hub_download
        except ImportError as e:
            raise ImportError(
                f"Missing dependency for PersonaPlex: {e}. "
                "Install with: pip install moshi sentencepiece huggingface_hub"
            )

        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

        # Load Mimi audio codec (two instances: one for input encoding, one for output decoding)
        logger.info("Loading Mimi audio codec...")
        self.mimi = get_mimi(PERSONAPLEX_MODEL_NAME, device=device)
        self.mimi.eval()
        self.mimi_out = get_mimi(PERSONAPLEX_MODEL_NAME, device=device)
        self.mimi_out.eval()

        # Load the LM and wrap in LMGen for streaming inference
        logger.info("Loading PersonaPlex LM...")
        lm = get_moshi_lm(PERSONAPLEX_MODEL_NAME, device=device)
        lm.eval()

        # Load voice prompt (.pt file) for voice conditioning
        voice_prompt_path = hf_hub_download(
            repo_id=PERSONAPLEX_MODEL_NAME,
            filename=f"voice_prompts/{voice_prompt}.pt",
        )
        voice_prompt_tensor = torch.load(voice_prompt_path, map_location=device, weights_only=True)

        # Build text prompt for translation persona
        if text_prompt is None:
            text_prompt = (
                "You are a professional simultaneous interpreter. "
                "Listen to the user's speech in English and respond with the French translation. "
                "Output ONLY the translation, nothing else."
            )

        self.lm_gen = LMGen(
            lm,
            voice_prompt=voice_prompt_tensor,
            text_prompt=text_prompt,
            device=device,
        )

        # Load SentencePiece tokenizer for text token decoding
        tokenizer_path = hf_hub_download(
            repo_id=PERSONAPLEX_MODEL_NAME,
            filename="tokenizer.model",
        )
        self.tokenizer = spm.SentencePieceProcessor(model_file=tokenizer_path)

        self.loaded = True
        logger.info("PersonaPlex model loaded successfully")

    def encode_audio(self, pcm_float32: np.ndarray) -> torch.Tensor:
        """Encode a PCM audio frame to Mimi codes (8 codebooks).

        Args:
            pcm_float32: Audio samples as float32, shape (frame_size,)

        Returns:
            Mimi codes tensor, shape (1, 8, 1)
        """
        if not self.loaded:
            raise RuntimeError("Model not loaded")

        device = next(self.mimi.parameters()).device
        # Mimi expects (batch, channels, samples)
        audio_tensor = torch.from_numpy(pcm_float32).float().unsqueeze(0).unsqueeze(0).to(device)

        with torch.no_grad():
            codes = self.mimi.encode(audio_tensor)  # (1, 8, num_frames)

        return codes

    def step(self, input_codes: torch.Tensor) -> tuple[torch.Tensor | None, str]:
        """Feed one frame of audio codes through the LM, get back output codes and text.

        Args:
            input_codes: Mimi codes for one input frame, shape (1, 8, 1)

        Returns:
            Tuple of (output_audio_codes or None, decoded_text_token)
        """
        if not self.loaded:
            raise RuntimeError("Model not loaded")

        with torch.no_grad():
            out = self.lm_gen.step(input_codes)

        text_token = ""
        output_codes = None

        if out is not None:
            text_token_id, audio_codes = out
            output_codes = audio_codes

            # Decode text token
            if text_token_id is not None:
                token_id = text_token_id.item()
                # Skip special tokens (padding, EOS, etc.)
                if 0 < token_id < self.tokenizer.get_piece_size():
                    text_token = self.tokenizer.id_to_piece(token_id)
                    # SentencePiece uses ▁ for word boundaries
                    text_token = text_token.replace("▁", " ")

        return output_codes, text_token

    def decode_audio(self, codes: torch.Tensor) -> np.ndarray:
        """Decode Mimi codes back to PCM audio.

        Args:
            codes: Mimi codes tensor, shape (1, 8, num_frames)

        Returns:
            PCM float32 audio samples as numpy array
        """
        if not self.loaded:
            raise RuntimeError("Model not loaded")

        with torch.no_grad():
            audio = self.mimi_out.decode(codes)  # (1, 1, samples)

        return audio.squeeze().cpu().numpy()

    def reset(self):
        """Reset the LMGen streaming state for a new session."""
        if self.lm_gen is not None:
            self.lm_gen.reset()

    def update_text_prompt(self, target_language: str):
        """Update the translation persona prompt for a new target language."""
        if self.lm_gen is not None:
            text_prompt = (
                f"You are a professional simultaneous interpreter. "
                f"Listen to the user's speech and translate it into {target_language}. "
                f"Output ONLY the translation, nothing else."
            )
            self.lm_gen.set_text_prompt(text_prompt)

    def unload(self):
        """Free GPU memory."""
        self.lm_gen = None
        self.mimi = None
        self.mimi_out = None
        self.tokenizer = None
        self.loaded = False
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        logger.info("PersonaPlex model unloaded")


# Singleton instance
personaplex_model = PersonaPlexModel()
