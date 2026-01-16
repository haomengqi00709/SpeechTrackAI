import { useState, useEffect, useRef, useCallback } from 'react';

interface UseSpeechRecognitionReturn {
  isListening: boolean;
  transcript: string;
  startListening: () => void;
  stopListening: () => void;
  resetTranscript: () => void;
  notSupported: boolean;
}

export const useSpeechRecognition = (): UseSpeechRecognitionReturn => {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [notSupported, setNotSupported] = useState(false);
  const recognitionRef = useRef<any>(null);
  
  // Track intention to listen to handle auto-restart
  const shouldBeListeningRef = useRef(false);

  useEffect(() => {
    // Check for browser support
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setNotSupported(true);
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US'; // Default to English, could be configurable

    recognition.onstart = () => {
      setIsListening(true);
    };

    recognition.onend = () => {
      // If we still want to be listening, restart it (fixes "no-speech" stopping everything)
      if (shouldBeListeningRef.current) {
        try {
            recognition.start();
        } catch (e) {
            // If restart fails, then we stop
            setIsListening(false);
            shouldBeListeningRef.current = false;
        }
      } else {
        setIsListening(false);
      }
    };

    recognition.onresult = (event: any) => {
      let finalTranscript = '';
      let interimTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript;
        } else {
          interimTranscript += event.results[i][0].transcript;
        }
      }
      
      // We mainly care about the latest stream of words for matching
      setTranscript(finalTranscript + interimTranscript);
    };

    recognition.onerror = (event: any) => {
      // "no-speech" is a common, benign error when the user is silent for a while.
      if (event.error === 'no-speech') {
        // We do not stop here, we let onend handle the restart
        return;
      }
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
         shouldBeListeningRef.current = false;
         setIsListening(false);
      }
      console.error("Speech recognition error", event.error);
    };

    recognitionRef.current = recognition;

    return () => {
      if (recognitionRef.current) {
        shouldBeListeningRef.current = false;
        recognitionRef.current.stop();
      }
    };
  }, []);

  const startListening = useCallback(() => {
    if (recognitionRef.current && !isListening) {
      try {
        shouldBeListeningRef.current = true;
        recognitionRef.current.start();
      } catch (e) {
        console.error("Already started", e);
      }
    }
  }, [isListening]);

  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      shouldBeListeningRef.current = false;
      recognitionRef.current.stop();
    }
  }, []);

  const resetTranscript = useCallback(() => {
    setTranscript('');
  }, []);

  return {
    isListening,
    transcript,
    startListening,
    stopListening,
    resetTranscript,
    notSupported,
  };
};