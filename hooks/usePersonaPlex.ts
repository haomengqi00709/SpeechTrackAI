import { useState, useCallback, useRef } from 'react';

const backendUrl = process.env.LOCAL_BACKEND_URL || 'ws://localhost:8000';

interface UsePersonaPlexReturn {
  isConnected: boolean;
  isConnecting: boolean;
  transcript: string;        // translated text
  sourceTranscript: string;  // (empty — PersonaPlex doesn't separate source/translated)
  volume: number;
  audioPlaybackCount: number;
  connect: (options?: { targetLanguage?: string }) => Promise<void>;
  disconnect: () => void;
  error: string | null;
}

export const usePersonaPlex = (): UsePersonaPlexReturn => {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [sourceTranscript, setSourceTranscript] = useState('');
  const [volume, setVolume] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [audioPlaybackCount, setAudioPlaybackCount] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  // Audio playback refs
  const playbackContextRef = useRef<AudioContext | null>(null);
  const nextPlayTimeRef = useRef(0);

  // PersonaPlex native sample rate
  const SAMPLE_RATE = 24000;

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

  // Play audio chunk with scheduled buffering (same pattern as useGeminiLive/useLocalOmni)
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

    source.onended = () => {
      setAudioPlaybackCount(prev => prev + 1);
    };
  }, []);

  const disconnect = useCallback(() => {
    if (wsRef.current) {
      try {
        wsRef.current.send(JSON.stringify({ type: 'stop' }));
        wsRef.current.close();
      } catch (e) {}
      wsRef.current = null;
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

    setIsConnected(false);
    setIsConnecting(false);
    setVolume(0);
    setAudioPlaybackCount(0);
  }, []);

  const connect = useCallback(async (options?: { targetLanguage?: string }) => {
    if (wsRef.current) disconnect();

    setError(null);
    setTranscript('');
    setSourceTranscript('');
    setIsConnecting(true);

    try {
      // PersonaPlex uses 24kHz native sample rate (unlike Omni's 16kHz)
      const AudioContextClass = (window as any).AudioContext || (window as any).webkitAudioContext;
      const audioCtx = new AudioContextClass({ sampleRate: SAMPLE_RATE });
      audioContextRef.current = audioCtx;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const targetLang = options?.targetLanguage || 'French';

      const ws = new WebSocket(`${backendUrl}/ws/personaplex`);
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
        setIsConnecting(false);

        // Send config
        ws.send(JSON.stringify({ type: 'config', targetLanguage: targetLang }));

        // Start audio capture at 24kHz
        const source = audioCtx.createMediaStreamSource(stream);
        const processor = audioCtx.createScriptProcessor(4096, 1, 1);

        processor.onaudioprocess = (e) => {
          const inputData = e.inputBuffer.getChannelData(0);
          let sum = 0;
          for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
          setVolume(Math.min(1, Math.sqrt(sum / inputData.length) * 15));

          const base64Data = pcmToBase64(inputData);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'audio', data: base64Data, sampleRate: SAMPLE_RATE }));
          }
        };

        source.connect(processor);
        processor.connect(audioCtx.destination);
        sourceRef.current = source;
        processorRef.current = processor;
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);

        switch (msg.type) {
          case 'translated_text':
            setTranscript(prev => prev + msg.data);
            break;
          case 'audio':
            playAudioChunk(msg.data, msg.sampleRate || SAMPLE_RATE);
            break;
          case 'error':
            setError(msg.message);
            break;
          case 'status':
            break;
        }
      };

      ws.onclose = () => {
        setIsConnected(false);
        setIsConnecting(false);
      };

      ws.onerror = (err) => {
        console.warn('PersonaPlex WebSocket error:', err);
        setError('Connection failed');
        setIsConnected(false);
        setIsConnecting(false);
      };

    } catch (err: any) {
      setError(err.message || 'Connection failed');
      setIsConnected(false);
      setIsConnecting(false);
    }
  }, [disconnect, playAudioChunk]);

  return {
    isConnected,
    isConnecting,
    transcript,
    sourceTranscript,
    volume,
    audioPlaybackCount,
    connect,
    disconnect,
    error,
  };
};
