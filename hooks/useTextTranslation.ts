import { useState, useCallback, useRef, useEffect } from 'react';
import { GoogleGenAI, Modality } from "@google/genai";

const apiKey = process.env.API_KEY || '';
const ai = new GoogleGenAI({ apiKey });

// Audio playback helper for Gemini TTS
const playGeminiAudio = async (base64Data: string, sampleRate: number = 24000): Promise<void> => {
  return new Promise((resolve) => {
    const AudioContextClass = (window as any).AudioContext || (window as any).webkitAudioContext;
    const ctx = new AudioContextClass({ sampleRate });

    // Decode base64 to Int16 PCM
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const int16 = new Int16Array(bytes.buffer);

    // Convert Int16 to Float32 for Web Audio API
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }

    // Create and play audio buffer
    const audioBuffer = ctx.createBuffer(1, float32.length, sampleRate);
    audioBuffer.getChannelData(0).set(float32);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    source.onended = () => {
      ctx.close();
      resolve();
    };
    source.start(0);
  });
};

type TTSMode = 'browser' | 'gemini';

// Map language names to BCP 47 language codes for browser TTS
const LANGUAGE_CODES: Record<string, string> = {
  'English': 'en-US',
  'French': 'fr-FR',
  'Spanish': 'es-ES',
  'German': 'de-DE',
  'Italian': 'it-IT',
  'Portuguese': 'pt-BR',
  'Japanese': 'ja-JP',
  'Korean': 'ko-KR',
  'Chinese': 'zh-CN',
  'Russian': 'ru-RU',
  'Arabic': 'ar-SA',
  'Hindi': 'hi-IN',
};

interface UseTextTranslationReturn {
  isActive: boolean;
  translatedText: string;
  sourceText: string;
  isSpeaking: boolean;
  start: (options?: { targetLanguage?: string; useExternalTranscript?: boolean; ttsMode?: TTSMode }) => void;
  stop: () => void;
  feedTranscript: (transcript: string) => void; // For external transcript (from tracking)
  error: string | null;
}

export const useTextTranslation = (): UseTextTranslationReturn => {
  const [isActive, setIsActive] = useState(false);
  const [translatedText, setTranslatedText] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const targetLanguageRef = useRef<string>('French');
  const lastProcessedRef = useRef<string>('');
  const lastProcessedTimeRef = useRef<number>(0);
  const lastActivityTimeRef = useRef<number>(0);
  const isTranslatingRef = useRef(false);
  const recognitionRef = useRef<any>(null);
  const fullTranscriptRef = useRef<string>('');
  const isActiveRef = useRef(false);
  const useExternalTranscriptRef = useRef(false);
  const ttsModeRef = useRef<TTSMode>('browser');

  // TTS queue
  const ttsQueueRef = useRef<string[]>([]);
  const isTTSSpeakingRef = useRef(false);

  // Process TTS queue - supports both browser and Gemini voices
  const processQueue = useCallback(async () => {
    if (isTTSSpeakingRef.current || ttsQueueRef.current.length === 0) {
      return;
    }

    const text = ttsQueueRef.current.shift();
    if (!text) return;

    isTTSSpeakingRef.current = true;
    setIsSpeaking(true);

    try {
      if (ttsModeRef.current === 'gemini') {
        // Use Gemini AI voice (higher quality, slower)
        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash-preview-tts',
          contents: [{ role: 'user', parts: [{ text }] }],
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }
            }
          }
        });

        const parts = response.candidates?.[0]?.content?.parts;
        if (parts) {
          for (const part of parts) {
            if (part.inlineData?.mimeType?.startsWith('audio/') && part.inlineData?.data) {
              await playGeminiAudio(part.inlineData.data);
            }
          }
        }
      } else {
        // Use browser TTS (faster, robotic)
        await new Promise<void>((resolve) => {
          const utterance = new SpeechSynthesisUtterance(text);
          // Set the language to match the target translation language
          const langCode = LANGUAGE_CODES[targetLanguageRef.current] || 'en-US';
          utterance.lang = langCode;
          utterance.rate = 1.0;
          utterance.pitch = 1.0;
          utterance.onend = () => resolve();
          utterance.onerror = () => resolve();
          speechSynthesis.speak(utterance);
        });
      }
    } catch (e) {
      console.error('TTS error:', e);
    } finally {
      isTTSSpeakingRef.current = false;
      setIsSpeaking(ttsQueueRef.current.length > 0);
      processQueue(); // Process next in queue
    }
  }, []);

  // Translate text using Gemini with timeout
  const translateText = useCallback(async (text: string) => {
    if (!text.trim()) return;

    // Force reset if stuck for too long
    if (isTranslatingRef.current) {
      const timeSinceActivity = Date.now() - lastActivityTimeRef.current;
      if (timeSinceActivity > 10000) {
        // Stuck for 10+ seconds, force reset
        console.warn('Translation stuck, forcing reset');
        isTranslatingRef.current = false;
      } else {
        // Still working, skip this request
        return;
      }
    }

    isTranslatingRef.current = true;
    lastProcessedTimeRef.current = Date.now();
    lastActivityTimeRef.current = Date.now();
    const targetLang = targetLanguageRef.current;

    // Create abort controller for timeout
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      abortController.abort();
    }, 15000); // 15 second timeout

    try {
      const result = await ai.models.generateContentStream({
        model: 'gemini-2.0-flash',
        contents: [{
          role: 'user',
          parts: [{
            text: `Translate the following to ${targetLang}. Output ONLY the translation, nothing else:\n\n${text}`
          }]
        }],
      });

      let fullTranslation = '';
      for await (const chunk of result) {
        lastActivityTimeRef.current = Date.now(); // Update activity time
        const chunkText = chunk.text || '';
        fullTranslation += chunkText;
        setTranslatedText(prev => prev + chunkText);
      }

      clearTimeout(timeoutId);

      // Add space after translation for readability
      setTranslatedText(prev => prev + ' ');

      // Add to TTS queue
      if (fullTranslation.trim()) {
        ttsQueueRef.current.push(fullTranslation.trim());
        processQueue();
      }

    } catch (err: any) {
      clearTimeout(timeoutId);
      console.error('Translation error:', err);
      // Don't set error state for aborts, just log
      if (err.name !== 'AbortError') {
        setError(err.message || 'Translation failed');
      }
    } finally {
      isTranslatingRef.current = false;
      lastActivityTimeRef.current = Date.now();
    }
  }, [processQueue]);

  // Process transcript and decide when to translate
  const processTranscript = useCallback((transcript: string) => {
    if (!transcript) return;

    fullTranscriptRef.current = transcript;
    setSourceText(transcript);

    // Find new content since last processed
    const lastProcessed = lastProcessedRef.current;
    if (transcript === lastProcessed) return;

    // Detect if speech recognition was reset (transcript is shorter than what we processed)
    // This happens when the browser restarts recognition
    let newContent: string;
    if (transcript.length < lastProcessed.length || !transcript.startsWith(lastProcessed.slice(0, Math.min(50, lastProcessed.length)))) {
      // Transcript was reset - treat entire transcript as new
      newContent = transcript.trim();
      console.log('Transcript reset detected, processing full transcript');
    } else {
      newContent = transcript.slice(lastProcessed.length).trim();
    }

    if (!newContent) return;

    // Check conditions for triggering translation
    const hasCompleteSentence = /[.!?,;:]/.test(newContent);
    const wordCount = newContent.split(/\s+/).length;

    // Translate when: sentence boundary OR 5+ words
    if (hasCompleteSentence || wordCount >= 5) {
      lastProcessedRef.current = transcript;
      translateText(newContent);
    }
  }, [translateText]);

  // Start speech recognition
  const startRecognition = useCallback(() => {
    if (!isActiveRef.current) return;

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setError('Speech recognition not supported');
      return;
    }

    // Stop existing recognition if any
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (e) {}
      recognitionRef.current = null;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognition.maxAlternatives = 1;

    recognition.onresult = (event: any) => {
      lastActivityTimeRef.current = Date.now();
      let finalTranscript = '';
      let interimTranscript = '';

      for (let i = 0; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += transcript;
        } else {
          interimTranscript += transcript;
        }
      }

      const fullText = finalTranscript + interimTranscript;
      processTranscript(fullText);
    };

    recognition.onerror = (event: any) => {
      console.error('Speech recognition error:', event.error);
      lastActivityTimeRef.current = Date.now();

      // Don't show error for common non-critical errors
      if (!['no-speech', 'aborted', 'network'].includes(event.error)) {
        setError(`Recognition error: ${event.error}`);
      }
    };

    recognition.onend = () => {
      console.log('Speech recognition ended, isActive:', isActiveRef.current);
      // Restart if still active
      if (isActiveRef.current) {
        setTimeout(() => {
          if (isActiveRef.current) {
            startRecognition();
          }
        }, 100);
      }
    };

    try {
      recognition.start();
      recognitionRef.current = recognition;
      console.log('Speech recognition started');
    } catch (e) {
      console.error('Failed to start speech recognition:', e);
      // Retry after a delay
      setTimeout(() => {
        if (isActiveRef.current) {
          startRecognition();
        }
      }, 500);
    }
  }, [processTranscript]);

  // Feed external transcript (when tracking mode is providing it)
  const feedTranscript = useCallback((transcript: string) => {
    if (!isActiveRef.current || !useExternalTranscriptRef.current) return;
    lastActivityTimeRef.current = Date.now();
    processTranscript(transcript);
  }, [processTranscript]);

  // Start the text translation mode
  const start = useCallback((options?: { targetLanguage?: string; useExternalTranscript?: boolean }) => {
    // Stop any existing internal recognition first
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (e) {}
      recognitionRef.current = null;
    }

    setError(null);
    setTranslatedText('');
    setSourceText('');
    lastProcessedRef.current = '';
    lastProcessedTimeRef.current = Date.now();
    lastActivityTimeRef.current = Date.now();
    fullTranscriptRef.current = '';
    ttsQueueRef.current = [];
    isTranslatingRef.current = false;
    isTTSSpeakingRef.current = false;

    targetLanguageRef.current = options?.targetLanguage || 'French';
    useExternalTranscriptRef.current = options?.useExternalTranscript || false;
    ttsModeRef.current = options?.ttsMode || 'browser';

    // Load browser voices if using browser TTS
    if (ttsModeRef.current === 'browser') {
      speechSynthesis.getVoices();
    }

    isActiveRef.current = true;
    setIsActive(true);

    // Only start internal recognition if not using external transcript
    if (!options?.useExternalTranscript) {
      startRecognition();
    }
  }, [startRecognition]);

  // Stop the text translation mode
  const stop = useCallback(() => {
    isActiveRef.current = false;

    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (e) {}
      recognitionRef.current = null;
    }

    // Cancel browser TTS if active
    if (ttsModeRef.current === 'browser') {
      speechSynthesis.cancel();
    }

    setIsActive(false);
    ttsQueueRef.current = [];
    isTTSSpeakingRef.current = false;
    isTranslatingRef.current = false;
    setIsSpeaking(false);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isActiveRef.current = false;
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch (e) {}
      }
    };
  }, []);

  // Store callbacks in refs to avoid circular dependencies
  const translateTextRef = useRef(translateText);
  const startRecognitionRef = useRef(startRecognition);
  const processQueueRef = useRef(processQueue);

  useEffect(() => {
    translateTextRef.current = translateText;
    startRecognitionRef.current = startRecognition;
    processQueueRef.current = processQueue;
  }, [translateText, startRecognition, processQueue]);

  // Time-based trigger and health check
  useEffect(() => {
    if (!isActive) return;

    const interval = setInterval(() => {
      const now = Date.now();

      // Check if translation is needed
      const timeSinceLastTranslation = now - lastProcessedTimeRef.current;
      const fullTranscript = fullTranscriptRef.current;
      const lastProcessed = lastProcessedRef.current;

      // If 2+ seconds since last translation and there's unprocessed content
      if (timeSinceLastTranslation >= 2000 && fullTranscript.length > lastProcessed.length) {
        const newContent = fullTranscript.slice(lastProcessed.length).trim();
        if (newContent && newContent.split(/\s+/).length >= 2) {
          console.log('Time-based translation trigger:', newContent);
          lastProcessedRef.current = fullTranscript;
          translateTextRef.current(newContent);
        }
      }

      // Health check: if no activity for 30 seconds, restart recognition
      const timeSinceActivity = now - lastActivityTimeRef.current;
      if (timeSinceActivity > 30000 && isActiveRef.current) {
        console.warn('No activity for 30s, restarting recognition');
        startRecognitionRef.current();
        lastActivityTimeRef.current = now;
      }

      // Note: Gemini TTS doesn't need the same stuck detection as browser TTS
      // The async/await pattern handles completion naturally
    }, 500);

    return () => clearInterval(interval);
  }, [isActive]);

  return {
    isActive,
    translatedText,
    sourceText,
    isSpeaking,
    start,
    stop,
    feedTranscript,
    error
  };
};
