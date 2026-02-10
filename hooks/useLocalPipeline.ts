import { useState, useCallback, useRef } from 'react';

const backendUrl = process.env.LOCAL_BACKEND_URL || 'ws://localhost:8000';

export type PipelineAsrMode = 'browser' | 'local';

interface UseLocalPipelineReturn {
  isActive: boolean;
  translatedText: string;
  sourceText: string;
  isSpeaking: boolean;
  volume: number;
  start: (options?: { targetLanguage?: string; asrMode?: PipelineAsrMode }) => void;
  stop: () => void;
  feedTranscript: (transcript: string) => void;
  error: string | null;
}

export const useLocalPipeline = (): UseLocalPipelineReturn => {
  const [isActive, setIsActive] = useState(false);
  const [translatedText, setTranslatedText] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [volume, setVolume] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const asrModeRef = useRef<PipelineAsrMode>('local');
  const recognitionRef = useRef<any>(null);
  const isActiveRef = useRef(false);

  // Draft+Refine text tracking
  const committedTextRef = useRef('');
  const draftTextRef = useRef('');

  // Audio playback refs
  const playbackContextRef = useRef<AudioContext | null>(null);
  const nextPlayTimeRef = useRef(0);
  const activeSourceCountRef = useRef(0);

  // Helper to convert Float32 audio to PCM Int16 Base64
  const pcmToBase64 = (data: Float32Array): string => {
    const l = data.length;
    const int16 = new Int16Array(l);
    for (let i = 0; i < l; i++) {
      const s = Math.max(-1, Math.min(1, data[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    let binary = '';
    const bytes = new Uint8Array(int16.buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  };

  // Play audio chunk and track speaking state
  const playAudioChunk = useCallback(async (base64Data: string, sampleRate: number = 24000) => {
    if (!playbackContextRef.current) {
      const AudioContextClass = (window as any).AudioContext || (window as any).webkitAudioContext;
      playbackContextRef.current = new AudioContextClass({ sampleRate });
    }

    const ctx = playbackContextRef.current;
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    // Decode base64 to Int16 PCM
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const int16 = new Int16Array(bytes.buffer);

    // Convert Int16 to Float32
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }

    const audioBuffer = ctx.createBuffer(1, float32.length, sampleRate);
    audioBuffer.getChannelData(0).set(float32);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    const currentTime = ctx.currentTime;
    const startTime = Math.max(currentTime, nextPlayTimeRef.current);
    source.start(startTime);
    nextPlayTimeRef.current = startTime + audioBuffer.duration;

    activeSourceCountRef.current++;
    setIsSpeaking(true);

    source.onended = () => {
      activeSourceCountRef.current--;
      if (activeSourceCountRef.current <= 0) {
        activeSourceCountRef.current = 0;
        setIsSpeaking(false);
      }
    };
  }, []);

  const stop = useCallback(() => {
    isActiveRef.current = false;

    if (wsRef.current) {
      try {
        wsRef.current.send(JSON.stringify({ type: 'stop' }));
        wsRef.current.close();
      } catch (e) {}
      wsRef.current = null;
    }

    // Stop browser speech recognition
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch (e) {}
      recognitionRef.current = null;
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }
    if (sourceRef.current) sourceRef.current.disconnect();
    if (processorRef.current) processorRef.current.disconnect();
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
    }
    audioContextRef.current = null;

    if (playbackContextRef.current) {
      playbackContextRef.current.close().catch(() => {});
      playbackContextRef.current = null;
    }
    nextPlayTimeRef.current = 0;
    activeSourceCountRef.current = 0;

    setIsActive(false);
    setIsSpeaking(false);
    setVolume(0);
  }, []);

  const start = useCallback((options?: { targetLanguage?: string; asrMode?: PipelineAsrMode }) => {
    if (wsRef.current) stop();

    setError(null);
    setTranslatedText('');
    setSourceText('');
    setIsSpeaking(false);
    committedTextRef.current = '';
    draftTextRef.current = '';

    const targetLang = options?.targetLanguage || 'French';
    const asrMode = options?.asrMode || 'local';
    asrModeRef.current = asrMode;

    // Start browser speech recognition (for browser ASR mode)
    const startBrowserRecognition = () => {
      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (!SpeechRecognition) {
        setError('Speech recognition not supported in this browser');
        return;
      }

      if (recognitionRef.current) {
        try { recognitionRef.current.stop(); } catch (e) {}
      }

      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'en-US';
      recognition.maxAlternatives = 1;

      recognition.onresult = (event: any) => {
        let finalTranscript = '';
        let interimTranscript = '';
        for (let i = 0; i < event.results.length; i++) {
          const t = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            finalTranscript += t;
          } else {
            interimTranscript += t;
          }
        }
        const fullText = finalTranscript + interimTranscript;
        // isFinal when browser has finalized all current results (no interim left)
        const isFinal = finalTranscript.length > 0 && interimTranscript.length === 0;
        if (fullText) {
          setSourceText(fullText);
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'text', data: fullText, isFinal }));
          }
        }
      };

      recognition.onerror = (event: any) => {
        console.warn('[LocalPipeline] Speech recognition error:', event.error);
        if (!['no-speech', 'aborted', 'network'].includes(event.error)) {
          setError(`Recognition error: ${event.error}`);
        }
      };

      recognition.onend = () => {
        // Auto-restart if still active
        if (isActiveRef.current && asrModeRef.current === 'browser') {
          setTimeout(() => {
            if (isActiveRef.current) startBrowserRecognition();
          }, 100);
        }
      };

      try {
        recognition.start();
        recognitionRef.current = recognition;
        console.log('[LocalPipeline] Browser speech recognition started');
      } catch (e) {
        console.error('[LocalPipeline] Failed to start speech recognition:', e);
        setTimeout(() => {
          if (isActiveRef.current) startBrowserRecognition();
        }, 500);
      }
    };

    const startAsync = async () => {
      try {
        const ws = new WebSocket(`${backendUrl}/ws/pipeline`);
        wsRef.current = ws;

        ws.onopen = () => {
          console.log(`[LocalPipeline] WebSocket connected (asrMode=${asrMode})`);
          isActiveRef.current = true;
          setIsActive(true);

          // Send config with ASR mode
          ws.send(JSON.stringify({ type: 'config', targetLanguage: targetLang, asrMode }));

          // Browser ASR mode: start speech recognition
          if (asrMode === 'browser') {
            startBrowserRecognition();
          }

          // Local ASR mode: start audio capture
          if (asrMode === 'local') {
            const startAudioCapture = async () => {
              try {
                const AudioContextClass = (window as any).AudioContext || (window as any).webkitAudioContext;
                const audioCtx = new AudioContextClass({ sampleRate: 16000 });
                audioContextRef.current = audioCtx;

                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                mediaStreamRef.current = stream;

                const source = audioCtx.createMediaStreamSource(stream);
                const processor = audioCtx.createScriptProcessor(4096, 1, 1);

                processor.onaudioprocess = (e) => {
                  const inputData = e.inputBuffer.getChannelData(0);

                  // Compute volume for visual feedback
                  let sum = 0;
                  for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
                  setVolume(Math.min(1, Math.sqrt(sum / inputData.length) * 15));

                  const base64Data = pcmToBase64(inputData);
                  if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'audio', data: base64Data, sampleRate: 16000 }));
                  }
                };

                source.connect(processor);
                processor.connect(audioCtx.destination);
                sourceRef.current = source;
                processorRef.current = processor;
              } catch (err: any) {
                console.error('[LocalPipeline] Audio capture failed:', err);
                setError(err.message || 'Microphone access failed');
              }
            };
            startAudioCapture();
          }
        };

        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data);
          console.log('[LocalPipeline] Received:', msg.type, msg.type === 'audio' ? '(audio data)' : msg.data);

          switch (msg.type) {
            case 'source_text_interim':
              // Only update source text from server in local ASR mode
              // In browser mode, source text is set directly by feedTranscript
              if (asrModeRef.current === 'local') {
                setSourceText(prev => {
                  const lastNewline = prev.lastIndexOf('\n');
                  const committed = lastNewline >= 0 ? prev.substring(0, lastNewline + 1) : '';
                  return committed + msg.data;
                });
              }
              break;
            case 'source_text':
              if (asrModeRef.current === 'local') {
                setSourceText(prev => {
                  const lastNewline = prev.lastIndexOf('\n');
                  const committed = lastNewline >= 0 ? prev.substring(0, lastNewline + 1) : '';
                  return committed + msg.data + '\n';
                });
              }
              break;
            case 'translated_text_draft':
              draftTextRef.current += msg.data;
              setTranslatedText(committedTextRef.current + draftTextRef.current);
              break;
            case 'translated_text_final':
              // Refined text replaces all draft text
              committedTextRef.current += msg.data + ' ';
              draftTextRef.current = '';
              setTranslatedText(committedTextRef.current);
              break;
            case 'translated_text':
              // Backward compat
              committedTextRef.current += msg.data;
              setTranslatedText(committedTextRef.current);
              break;
            case 'audio':
              playAudioChunk(msg.data, msg.sampleRate || 24000);
              break;
            case 'error':
              setError(msg.message);
              break;
            case 'status':
              break;
          }
        };

        ws.onclose = () => {
          setIsActive(false);
        };

        ws.onerror = (err) => {
          console.warn('Local Pipeline WebSocket error:', err);
          setError('Connection failed');
          setIsActive(false);
        };

      } catch (err: any) {
        setError(err.message || 'Connection failed');
        setIsActive(false);
      }
    };

    startAsync();
  }, [stop, playAudioChunk]);

  // Feed transcript from browser Speech API (browser ASR mode)
  const feedTranscript = useCallback((transcript: string) => {
    if (!transcript || asrModeRef.current !== 'browser') return;

    // Set source text directly (no server round-trip needed)
    setSourceText(transcript);

    // Send to backend for translation + TTS
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'text', data: transcript, isFinal: false }));
    }
  }, []);

  return {
    isActive,
    translatedText,
    sourceText,
    isSpeaking,
    volume,
    start,
    stop,
    feedTranscript,
    error,
  };
};
