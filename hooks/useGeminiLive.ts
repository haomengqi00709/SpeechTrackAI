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
  connect: (options?: { targetLanguage?: string }) => Promise<void>;
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
  
  const sessionRef = useRef<Promise<any> | null>(null); 
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

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

  const disconnect = useCallback(() => {
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

    if (sessionRef.current) {
        sessionRef.current.then(session => {
            try { session.close(); } catch (e) {}
        }).catch(() => {});
        sessionRef.current = null;
    }
    
    setIsConnected(false);
    setIsConnecting(false);
    setVolume(0);
  }, []);

  const connect = useCallback(async (options?: { targetLanguage?: string }) => {
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
      
      const systemInstruction = `You are a professional simultaneous interpreter. 
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
          },
          onmessage: (msg: LiveServerMessage) => {
            // "Modify after display" logic: 
            // The API sends outputTranscription fragments. We append them.
            // When turnComplete is true, we could technically "finalize" a block.
            
            const outputText = msg.serverContent?.outputTranscription?.text;
            if (outputText) {
               setTranscript(prev => prev + outputText);
            }

            const inputText = msg.serverContent?.inputTranscription?.text;
            if (inputText) {
               setSourceTranscript(prev => prev + inputText);
            }

            // If a turn is complete, we could add a separator for clarity
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
  }, [disconnect]);

  return { isConnected, isConnecting, transcript, sourceTranscript, volume, connect, disconnect, error };
};
