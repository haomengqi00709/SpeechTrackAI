import { useState, useCallback, useRef } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";

const apiKey = process.env.API_KEY || '';
const ai = new GoogleGenAI({ apiKey });

interface InterpretationTurn {
  id: string;
  source: string;
  target: string;
  isComplete: boolean;
}

interface UseGeminiLiveReturn {
  isConnected: boolean;
  isConnecting: boolean;
  transcript: string; // This will now be the "Target" (translated) text
  sourceTranscript: string; // This will be the "Source" (user) text
  volume: number;
  audioPlaybackCount: number; // Increments each time an audio chunk finishes playing
  connect: (options?: { targetLanguage?: string; quickResponse?: boolean }) => Promise<void>;
  disconnect: () => void;
  error: string | null;
}

export const useGeminiLive = (): UseGeminiLiveReturn => {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [transcript, setTranscript] = useState(''); // Translated text stream
  const [sourceTranscript, setSourceTranscript] = useState(''); // User speech stream
  const [volume, setVolume] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [audioPlaybackCount, setAudioPlaybackCount] = useState(0); // Increments when audio finishes
  
  const sessionRef = useRef<Promise<any> | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  // Audio playback refs
  const playbackContextRef = useRef<AudioContext | null>(null);
  const audioQueueRef = useRef<AudioBuffer[]>([]);
  const isPlayingRef = useRef(false);
  const nextPlayTimeRef = useRef(0);

  // Quick mode nudge interval
  const nudgeIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Helper to convert Float32 audio to PCM Int16
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

  // Helper to decode base64 PCM audio and play it
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

    // Convert Int16 to Float32 for Web Audio API
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }

    // Create audio buffer
    const audioBuffer = ctx.createBuffer(1, float32.length, sampleRate);
    audioBuffer.getChannelData(0).set(float32);

    // Schedule playback
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    const currentTime = ctx.currentTime;
    const startTime = Math.max(currentTime, nextPlayTimeRef.current);
    source.start(startTime);
    nextPlayTimeRef.current = startTime + audioBuffer.duration;

    // Signal when audio finishes playing
    source.onended = () => {
      setAudioPlaybackCount(prev => prev + 1);
    };
  }, []);

  const disconnect = useCallback(() => {
    // Clean up nudge interval
    if (nudgeIntervalRef.current) {
      clearInterval(nudgeIntervalRef.current);
      nudgeIntervalRef.current = null;
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

    // Clean up playback context
    if (playbackContextRef.current) {
        playbackContextRef.current.close().catch(() => {});
        playbackContextRef.current = null;
    }
    nextPlayTimeRef.current = 0;

    if (sessionRef.current) {
        sessionRef.current.then(session => {
            try { session.close(); } catch (e) {}
        }).catch(() => {});
        sessionRef.current = null;
    }

    setIsConnected(false);
    setIsConnecting(false);
    setVolume(0);
    setAudioPlaybackCount(0);
  }, []);

  const connect = useCallback(async (options?: { targetLanguage?: string; quickResponse?: boolean }) => {
    if (sessionRef.current) disconnect();

    setError(null);
    setTranscript('');
    setSourceTranscript('');
    setIsConnecting(true);

    try {
      const AudioContextClass = (window as any).AudioContext || (window as any).webkitAudioContext;
      const audioCtx = new AudioContextClass({ sampleRate: 16000 });
      audioContextRef.current = audioCtx;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const targetLang = options?.targetLanguage || 'French';
      const isQuickMode = options?.quickResponse || false;

      // Different system instructions based on response mode
      const systemInstruction = isQuickMode
        ? `You are a real-time simultaneous interpreter providing instant translation into ${targetLang}.
           CRITICAL RULES:
           1. Translate IMMEDIATELY - do NOT wait for complete sentences.
           2. Output translation every 3-5 words, even mid-sentence.
           3. Use short, quick phrases. Speed is more important than perfect grammar.
           4. If speaker pauses, output what you have immediately.
           5. Keep translating continuously as you hear speech.`
        : `You are a professional simultaneous interpreter.
           1. Listen to the user's speech and translate it immediately into ${targetLang}.
           2. Output ONLY the translated text.
           3. Maintain a natural, flowy style.
           4. If the user corrects themselves, update your output if possible, otherwise continue.`;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO], 
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } }
          },
          // Enable both input and output transcription for a "bilingual feed"
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          systemInstruction: systemInstruction,
        },
        callbacks: {
          onopen: () => {
            setIsConnected(true);
            setIsConnecting(false);

            const source = audioCtx.createMediaStreamSource(stream);
            const processor = audioCtx.createScriptProcessor(4096, 1, 1);

            processor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              let sum = 0;
              for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
              setVolume(Math.min(1, Math.sqrt(sum / inputData.length) * 15));

              const base64Data = pcmToBase64(inputData);
              if (sessionRef.current === sessionPromise) {
                sessionPromise.then(session => {
                    session.sendRealtimeInput({
                        media: { mimeType: "audio/pcm;rate=16000", data: base64Data }
                    });
                }).catch(() => {});
              }
            };

            source.connect(processor);
            processor.connect(audioCtx.destination);
            sourceRef.current = source;
            processorRef.current = processor;

            // Quick mode: send periodic nudges to prompt faster translation
            if (isQuickMode) {
              nudgeIntervalRef.current = setInterval(() => {
                if (sessionRef.current === sessionPromise) {
                  sessionPromise.then(session => {
                    session.sendClientContent({
                      turns: [{ role: 'user', parts: [{ text: 'Translate now.' }] }],
                      turnComplete: true
                    });
                  }).catch(() => {});
                }
              }, 2500); // Nudge every 2.5 seconds
            }
          },
          onmessage: (msg: LiveServerMessage) => {
            // Handle audio output - play the translated speech
            const parts = msg.serverContent?.modelTurn?.parts;
            if (parts) {
              for (const part of parts) {
                if (part.inlineData?.mimeType?.startsWith('audio/') && part.inlineData?.data) {
                  playAudioChunk(part.inlineData.data);
                }
              }
            }

            // Handle transcription text
            const outputText = msg.serverContent?.outputTranscription?.text;
            if (outputText) {
               setTranscript(prev => prev + outputText);
            }

            const inputText = msg.serverContent?.inputTranscription?.text;
            if (inputText) {
               setSourceTranscript(prev => prev + inputText);
            }

            // If a turn is complete, add a separator for clarity
            if (msg.serverContent?.turnComplete) {
                setTranscript(prev => prev + " ");
                setSourceTranscript(prev => prev + " ");
            }
          },
          onclose: () => {
            setIsConnected(false);
            setIsConnecting(false);
          },
          onerror: (err) => {
            console.warn("Live API error:", err);
            setError("Connection reset");
            setIsConnected(false);
          }
        }
      });

      sessionRef.current = sessionPromise; 
    } catch (err: any) {
      setError(err.message || "Connection failed");
      setIsConnected(false);
      setIsConnecting(false);
    }
  }, [disconnect, playAudioChunk]);

  return { isConnected, isConnecting, transcript, sourceTranscript, volume, audioPlaybackCount, connect, disconnect, error };
};
