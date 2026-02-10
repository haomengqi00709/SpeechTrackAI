import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { ArrowLeft, Mic, MicOff, RotateCcw, ChevronLeft, ChevronRight, Globe, Loader2, Languages, PanelRight, Quote, Zap, Radio, Volume2, Cpu, GitBranch } from 'lucide-react';
import { useSpeechRecognition } from '../hooks/useSpeechRecognition';
import { useGeminiLive } from '../hooks/useGeminiLive';
import { useTextTranslation } from '../hooks/useTextTranslation';
import { useLocalOmni } from '../hooks/useLocalOmni';
import { useLocalPipeline, PipelineAsrMode } from '../hooks/useLocalPipeline';
import { usePersonaPlex } from '../hooks/usePersonaPlex';
import { WordItem, LANGUAGES, SupportedLanguage } from '../types';
import { PDFViewer } from './PDFViewer';

type TranslationMode = 'live' | 'text' | 'local-omni' | 'local-pipeline' | 'personaplex';

interface TeleprompterProps {
  script: string;
  pdfFile: File | null;
  onExit: () => void;
}

export const Teleprompter: React.FC<TeleprompterProps> = ({ script, pdfFile, onExit }) => {
  const { isListening, transcript, startListening, stopListening, resetTranscript, notSupported } = useSpeechRecognition();
  
  const {
      isConnected: isLiveConnected,
      isConnecting: isLiveConnecting,
      transcript: liveSubtitle,
      sourceTranscript: liveSource,
      volume: liveVolume,
      audioPlaybackCount,
      connect: connectLive,
      disconnect: disconnectLive
  } = useGeminiLive();

  const {
      isActive: isTextActive,
      translatedText: textSubtitle,
      sourceText: textSource,
      isSpeaking: isTextSpeaking,
      start: startTextTranslation,
      stop: stopTextTranslation,
      feedTranscript: feedTextTranscript,
      error: textError
  } = useTextTranslation();

  const {
      isConnected: isLocalOmniConnected,
      isConnecting: isLocalOmniConnecting,
      transcript: localOmniSubtitle,
      sourceTranscript: localOmniSource,
      volume: localOmniVolume,
      audioPlaybackCount: localOmniPlaybackCount,
      connect: connectLocalOmni,
      disconnect: disconnectLocalOmni
  } = useLocalOmni();

  const {
      isActive: isLocalPipelineActive,
      translatedText: localPipelineSubtitle,
      sourceText: localPipelineSource,
      isSpeaking: isLocalPipelineSpeaking,
      volume: localPipelineVolume,
      start: startLocalPipeline,
      stop: stopLocalPipeline,
      feedTranscript: feedLocalPipelineTranscript,
  } = useLocalPipeline();

  const {
      isConnected: isPersonaPlexConnected,
      isConnecting: isPersonaPlexConnecting,
      transcript: personaPlexSubtitle,
      sourceTranscript: personaPlexSource,
      volume: personaPlexVolume,
      audioPlaybackCount: personaPlexPlaybackCount,
      connect: connectPersonaPlex,
      disconnect: disconnectPersonaPlex,
  } = usePersonaPlex();

  const [translationMode, setTranslationMode] = useState<TranslationMode>('live');
  const [pipelineAsrMode, setPipelineAsrMode] = useState<PipelineAsrMode>('browser');
  const [activeIndex, setActiveIndex] = useState(0);
  const [fontSize, setFontSize] = useState(48);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const wordRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const interpretationRef = useRef<HTMLDivElement>(null);

  const [showSubtitles, setShowSubtitles] = useState(false);
  const [showRightPanel, setShowRightPanel] = useState(true);
  const [targetLanguage, setTargetLanguage] = useState<SupportedLanguage>('French');
  const [quickResponse, setQuickResponse] = useState(false); // Hidden for now, can re-enable later
  const [voiceMode, setVoiceMode] = useState<'browser' | 'gemini'>('browser'); // Fast mode voice selection

  const [currentSlide, setCurrentSlide] = useState(1);
  const [totalSlides, setTotalSlides] = useState(0);

  // Resizable panel state
  const [rightPanelWidth, setRightPanelWidth] = useState(384); // Default w-96 = 384px
  const isDraggingRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const words: WordItem[] = useMemo(() => {
    return script.split(/\s+/).map((word, index) => ({
      word,
      cleanWord: word.toLowerCase().replace(/[^\w\s]|_/g, ""),
      index
    })).filter(w => w.word.trim() !== "");
  }, [script]);

  useEffect(() => {
    wordRefs.current = wordRefs.current.slice(0, words.length);
  }, [words]);

  // Track previous isListening state to detect changes
  const prevIsListeningRef = useRef(isListening);

  // Disconnect all translation modes
  const disconnectAll = useCallback(() => {
      disconnectLive();
      stopTextTranslation();
      disconnectLocalOmni();
      stopLocalPipeline();
      disconnectPersonaPlex();
  }, [disconnectLive, stopTextTranslation, disconnectLocalOmni, stopLocalPipeline, disconnectPersonaPlex]);

  // Handle translation start/stop based on mode
  useEffect(() => {
      if (showSubtitles) {
          if (translationMode === 'live') {
              stopTextTranslation();
              disconnectLocalOmni();
              stopLocalPipeline();
              disconnectPersonaPlex();
              connectLive({ targetLanguage, quickResponse });
          } else if (translationMode === 'text') {
              disconnectLive();
              disconnectLocalOmni();
              stopLocalPipeline();
              disconnectPersonaPlex();
              startTextTranslation({ targetLanguage, useExternalTranscript: isListening, ttsMode: voiceMode });
          } else if (translationMode === 'local-omni') {
              disconnectLive();
              stopTextTranslation();
              stopLocalPipeline();
              disconnectPersonaPlex();
              connectLocalOmni({ targetLanguage });
          } else if (translationMode === 'local-pipeline') {
              disconnectLive();
              stopTextTranslation();
              disconnectLocalOmni();
              disconnectPersonaPlex();
              startLocalPipeline({ targetLanguage, asrMode: pipelineAsrMode });
          } else if (translationMode === 'personaplex') {
              disconnectLive();
              stopTextTranslation();
              disconnectLocalOmni();
              stopLocalPipeline();
              connectPersonaPlex({ targetLanguage });
          }
      } else {
          disconnectAll();
      }
      return () => {
          disconnectAll();
      };
  }, [showSubtitles, translationMode, targetLanguage, quickResponse, voiceMode, pipelineAsrMode, connectLive, disconnectLive, startTextTranslation, stopTextTranslation, connectLocalOmni, disconnectLocalOmni, startLocalPipeline, stopLocalPipeline, connectPersonaPlex, disconnectPersonaPlex, disconnectAll]);
  // Note: isListening intentionally NOT in deps - handled by separate effect below

  // Handle tracking mode changes while Fast translation is active
  useEffect(() => {
      const wasListening = prevIsListeningRef.current;
      prevIsListeningRef.current = isListening;

      // Only handle if Fast translation is active and tracking state changed
      if (showSubtitles && translationMode === 'text' && wasListening !== isListening) {
          // Restart Fast translation with new setting
          stopTextTranslation();
          // Small delay to ensure clean stop before restart
          setTimeout(() => {
              if (showSubtitles && translationMode === 'text') {
                  startTextTranslation({ targetLanguage, useExternalTranscript: isListening, ttsMode: voiceMode });
              }
          }, 100);
      }
  }, [isListening, showSubtitles, translationMode, targetLanguage, voiceMode, startTextTranslation, stopTextTranslation]);

  // Feed tracking transcript to text translation when both are active
  useEffect(() => {
      if (showSubtitles && translationMode === 'text' && isListening && transcript) {
          feedTextTranscript(transcript);
      }
  }, [showSubtitles, translationMode, isListening, transcript, feedTextTranscript]);

  // Feed tracking transcript to local pipeline when browser ASR mode is active
  useEffect(() => {
      if (showSubtitles && translationMode === 'local-pipeline' && pipelineAsrMode === 'browser' && isListening && transcript) {
          feedLocalPipelineTranscript(transcript);
      }
  }, [showSubtitles, translationMode, pipelineAsrMode, isListening, transcript, feedLocalPipelineTranscript]);

  useEffect(() => {
    if (interpretationRef.current) {
        interpretationRef.current.scrollTop = interpretationRef.current.scrollHeight;
    }
  }, [liveSubtitle, liveSource, textSubtitle, textSource, localOmniSubtitle, localOmniSource, localPipelineSubtitle, localPipelineSource, personaPlexSubtitle, personaPlexSource]);

  useEffect(() => {
    if (!transcript) return;
    const transcriptWords = transcript.toLowerCase().replace(/[^\w\s]|_/g, "").split(/\s+/).filter(w => w !== "");
    if (transcriptWords.length === 0) return;

    // Get last 3 spoken words for matching
    const lastWord = transcriptWords[transcriptWords.length - 1];
    const secondLastWord = transcriptWords.length > 1 ? transcriptWords[transcriptWords.length - 2] : null;
    const thirdLastWord = transcriptWords.length > 2 ? transcriptWords[transcriptWords.length - 3] : null;

    const searchWindow = 20;
    const searchEndIndex = Math.min(activeIndex + searchWindow, words.length);

    // Search with distance-based confirmation requirements
    for (let i = activeIndex; i < searchEndIndex; i++) {
      const distance = i - activeIndex;
      const scriptWord = words[i].cleanWord;

      if (scriptWord === lastWord) {
        // Check how many consecutive words match (looking backwards)
        let matchCount = 1;
        if (secondLastWord && i > 0 && words[i - 1].cleanWord === secondLastWord) {
          matchCount = 2;
          if (thirdLastWord && i > 1 && words[i - 2].cleanWord === thirdLastWord) {
            matchCount = 3;
          }
        }

        // Distance-based confirmation requirements:
        // 0-1 words ahead: single word OK (immediate next word)
        // 2-10 words ahead: need 2 consecutive words
        // 11+ words ahead: need 3 consecutive words
        let requiredMatches = 1;
        if (distance >= 2 && distance <= 10) {
          requiredMatches = 2;
        } else if (distance > 10) {
          requiredMatches = 3;
        }

        // Accept match if we have enough confirmation
        if (matchCount >= requiredMatches) {
          setActiveIndex(i + 1);
          return;
        }
      }
    }
  }, [transcript, words, activeIndex]);

  // Translation tracking disabled for now
  // const prevAudioCountRef = useRef(0);
  // const prevSourceLengthRef = useRef(0);

  useEffect(() => {
    if (wordRefs.current[activeIndex] && scrollContainerRef.current) {
      const activeEl = wordRefs.current[activeIndex];
      const container = scrollContainerRef.current;
      if (activeEl) {
        const top = activeEl.offsetTop - (container.clientHeight / 2) + (activeEl.clientHeight / 2);
        container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      }
    }
  }, [activeIndex]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (pdfFile) {
          if ([' ', 'Enter', 'ArrowRight'].includes(e.key)) {
              e.preventDefault();
              setCurrentSlide(prev => Math.min(prev + 1, totalSlides));
          } else if (e.key === 'ArrowLeft') {
              e.preventDefault();
              setCurrentSlide(prev => Math.max(prev - 1, 1));
          }
      } else {
          if (e.key === 'ArrowRight' || e.key === 'ArrowDown') setActiveIndex(prev => Math.min(prev + 1, words.length - 1));
          else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') setActiveIndex(prev => Math.max(prev - 1, 0));
          else if (e.key === ' ') {
              e.preventDefault();
              if(isListening) stopListening(); else startListening();
          }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [words.length, isListening, startListening, stopListening, pdfFile, totalSlides]);

  // Handle panel resize dragging
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current || !containerRef.current) return;

      const containerRect = containerRef.current.getBoundingClientRect();
      const newWidth = containerRect.right - e.clientX;

      // Clamp between 200px and 600px
      const clampedWidth = Math.max(200, Math.min(600, newWidth));
      setRightPanelWidth(clampedWidth);
    };

    const handleMouseUp = () => {
      isDraggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  // Helper functions for active mode data
  const activeSource = (): string => {
    switch (translationMode) {
      case 'live': return liveSource;
      case 'text': return textSource;
      case 'local-omni': return localOmniSource;
      case 'local-pipeline': return localPipelineSource;
      case 'personaplex': return personaPlexSource;
    }
  };

  const activeSubtitle = (): string => {
    switch (translationMode) {
      case 'live': return liveSubtitle;
      case 'text': return textSubtitle;
      case 'local-omni': return localOmniSubtitle;
      case 'local-pipeline': return localPipelineSubtitle;
      case 'personaplex': return personaPlexSubtitle;
    }
  };

  const activeIsConnected = (): boolean => {
    switch (translationMode) {
      case 'live': return isLiveConnected;
      case 'text': return isTextActive;
      case 'local-omni': return isLocalOmniConnected;
      case 'local-pipeline': return isLocalPipelineActive;
      case 'personaplex': return isPersonaPlexConnected;
    }
  };

  const activeIsConnecting = (): boolean => {
    switch (translationMode) {
      case 'live': return isLiveConnecting;
      case 'local-omni': return isLocalOmniConnecting;
      case 'personaplex': return isPersonaPlexConnecting;
      default: return false;
    }
  };

  const activeIsSpeaking = (): boolean => {
    switch (translationMode) {
      case 'text': return isTextSpeaking;
      case 'local-pipeline': return isLocalPipelineSpeaking;
      default: return false;
    }
  };

  const activeModeColor = (): string => {
    switch (translationMode) {
      case 'live': return 'purple';
      case 'text': return 'emerald';
      case 'local-omni': return 'amber';
      case 'local-pipeline': return 'cyan';
      case 'personaplex': return 'rose';
    }
  };

  const activeModeLabel = (): string => {
    switch (translationMode) {
      case 'live': return 'Live Mode';
      case 'text': return 'Fast Mode';
      case 'local-omni': return 'Omni Mode';
      case 'local-pipeline': return 'Pipeline Mode';
      case 'personaplex': return 'PersonaPlex';
    }
  };

  const activeFeedLabel = (): string => {
    switch (translationMode) {
      case 'live': return 'Live Audio Feed';
      case 'text': return 'Fast Text Feed';
      case 'local-omni': return 'Local Omni Feed';
      case 'local-pipeline': return 'Local Pipeline Feed';
      case 'personaplex': return 'PersonaPlex Feed';
    }
  };

  const activeEngineLabel = (): string => {
    switch (translationMode) {
      case 'live': return 'Gemini Live';
      case 'text': return 'Text → TTS';
      case 'local-omni': return 'Qwen3-Omni';
      case 'local-pipeline': return pipelineAsrMode === 'browser' ? 'Browser ASR → LLM → TTS' : 'Local ASR → LLM → TTS';
      case 'personaplex': return 'PersonaPlex 7B';
    }
  };

  // All local modes show volume bar for mic feedback
  const isOmniStyle = translationMode === 'live' || translationMode === 'local-omni' || translationMode === 'personaplex';
  const activeVolume = (() => {
    switch (translationMode) {
      case 'live': return liveVolume;
      case 'local-omni': return localOmniVolume;
      case 'local-pipeline': return localPipelineVolume;
      case 'personaplex': return personaPlexVolume;
      default: return 0;
    }
  })();

  return (
    <div className="flex flex-col h-full bg-black text-gray-400 font-sans">
      <div className="flex items-center justify-between p-4 bg-gray-900 border-b border-gray-800 z-50 shrink-0 shadow-lg">
        <button onClick={onExit} className="text-gray-400 hover:text-white flex items-center gap-2 transition-colors">
          <ArrowLeft className="w-5 h-5" /> Back to Editor
        </button>

        <div className="flex items-center gap-4">
            {/* Translation Mode Toggle - 4 modes */}
            <div className="flex items-center bg-gray-800 rounded-lg p-1 border border-gray-700 gap-0.5">
                {/* API Group */}
                <span className="text-[8px] text-gray-600 font-bold uppercase tracking-wider px-1.5">API</span>
                <button
                    onClick={() => setTranslationMode('live')}
                    disabled={showSubtitles}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all ${
                        translationMode === 'live'
                            ? 'bg-purple-600 text-white'
                            : 'text-gray-400 hover:text-gray-200'
                    } ${showSubtitles ? 'opacity-50 cursor-not-allowed' : ''}`}
                    title="Gemini Live: Audio-to-audio translation"
                >
                    <Radio className="w-3 h-3" />
                    Live
                </button>
                <button
                    onClick={() => setTranslationMode('text')}
                    disabled={showSubtitles}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all ${
                        translationMode === 'text'
                            ? 'bg-emerald-600 text-white'
                            : 'text-gray-400 hover:text-gray-200'
                    } ${showSubtitles ? 'opacity-50 cursor-not-allowed' : ''}`}
                    title="Text Pipeline: Faster text display, then TTS audio"
                >
                    <Zap className="w-3 h-3" />
                    Fast
                </button>

                <div className="w-px h-5 bg-gray-600 mx-1"></div>

                {/* Local Group */}
                <span className="text-[8px] text-gray-600 font-bold uppercase tracking-wider px-1.5">Local</span>
                <button
                    onClick={() => setTranslationMode('local-omni')}
                    disabled={showSubtitles}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all ${
                        translationMode === 'local-omni'
                            ? 'bg-amber-600 text-white'
                            : 'text-gray-400 hover:text-gray-200'
                    } ${showSubtitles ? 'opacity-50 cursor-not-allowed' : ''}`}
                    title="Local Omni: Qwen3-Omni end-to-end audio translation"
                >
                    <Cpu className="w-3 h-3" />
                    Omni
                </button>
                <button
                    onClick={() => setTranslationMode('local-pipeline')}
                    disabled={showSubtitles}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all ${
                        translationMode === 'local-pipeline'
                            ? 'bg-cyan-600 text-white'
                            : 'text-gray-400 hover:text-gray-200'
                    } ${showSubtitles ? 'opacity-50 cursor-not-allowed' : ''}`}
                    title="Local Pipeline: Qwen3 ASR → Translation → TTS"
                >
                    <GitBranch className="w-3 h-3" />
                    Pipeline
                </button>

                <div className="w-px h-5 bg-gray-600 mx-1"></div>

                {/* NVIDIA Group */}
                <span className="text-[8px] text-gray-600 font-bold uppercase tracking-wider px-1.5">NVIDIA</span>
                <button
                    onClick={() => setTranslationMode('personaplex')}
                    disabled={showSubtitles}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all ${
                        translationMode === 'personaplex'
                            ? 'bg-rose-600 text-white'
                            : 'text-gray-400 hover:text-gray-200'
                    } ${showSubtitles ? 'opacity-50 cursor-not-allowed' : ''}`}
                    title="NVIDIA PersonaPlex: 7B full-duplex speech-to-speech"
                >
                    <Cpu className="w-3 h-3" />
                    PersonaPlex
                </button>
            </div>

            {/* ASR Mode Toggle - Only for Pipeline mode */}
            {translationMode === 'local-pipeline' && (
                <div className="flex items-center bg-gray-800 rounded-full p-1 border border-gray-700">
                    <Mic className="w-3 h-3 text-gray-500 mx-1.5" />
                    <button
                        onClick={() => setPipelineAsrMode('browser')}
                        disabled={showSubtitles}
                        className={`px-2 py-1 rounded-full text-xs font-medium transition-all ${
                            pipelineAsrMode === 'browser'
                                ? 'bg-cyan-600 text-white'
                                : 'text-gray-400 hover:text-gray-200'
                        } ${showSubtitles ? 'opacity-50 cursor-not-allowed' : ''}`}
                        title="Browser ASR: Fast speech recognition via Google (requires internet)"
                    >
                        Browser
                    </button>
                    <button
                        onClick={() => setPipelineAsrMode('local')}
                        disabled={showSubtitles}
                        className={`px-2 py-1 rounded-full text-xs font-medium transition-all ${
                            pipelineAsrMode === 'local'
                                ? 'bg-cyan-600 text-white'
                                : 'text-gray-400 hover:text-gray-200'
                        } ${showSubtitles ? 'opacity-50 cursor-not-allowed' : ''}`}
                        title="Local ASR: Qwen3-ASR running on device (slower, fully offline)"
                    >
                        Local
                    </button>
                </div>
            )}

            {/* Voice Mode Toggle - Only for Fast mode */}
            {translationMode === 'text' && (
                <div className="flex items-center bg-gray-800 rounded-full p-1 border border-gray-700">
                    <Volume2 className="w-3 h-3 text-gray-500 mx-1.5" />
                    <button
                        onClick={() => setVoiceMode('browser')}
                        disabled={showSubtitles}
                        className={`px-2 py-1 rounded-full text-xs font-medium transition-all ${
                            voiceMode === 'browser'
                                ? 'bg-emerald-600 text-white'
                                : 'text-gray-400 hover:text-gray-200'
                        } ${showSubtitles ? 'opacity-50 cursor-not-allowed' : ''}`}
                        title="Browser TTS: Fast but robotic voice"
                    >
                        Fast
                    </button>
                    <button
                        onClick={() => setVoiceMode('gemini')}
                        disabled={showSubtitles}
                        className={`px-2 py-1 rounded-full text-xs font-medium transition-all ${
                            voiceMode === 'gemini'
                                ? 'bg-emerald-600 text-white'
                                : 'text-gray-400 hover:text-gray-200'
                        } ${showSubtitles ? 'opacity-50 cursor-not-allowed' : ''}`}
                        title="Gemini TTS: Natural voice but slower"
                    >
                        Natural
                    </button>
                </div>
            )}

            <div className="flex items-center bg-gray-800 rounded-full px-2 py-1 border border-gray-700 shadow-inner">
                <button
                    onClick={() => setShowSubtitles(!showSubtitles)}
                    disabled={activeIsConnecting()}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-all duration-300 ${showSubtitles ? `bg-${activeModeColor()}-600 text-white shadow-lg` : 'text-gray-400 hover:text-gray-200'} ${activeIsConnecting() ? 'opacity-80 cursor-wait' : ''}`}
                    style={showSubtitles ? {
                        backgroundColor: translationMode === 'live' ? '#9333ea' :
                                        translationMode === 'text' ? '#059669' :
                                        translationMode === 'local-omni' ? '#d97706' :
                                        translationMode === 'personaplex' ? '#e11d48' : '#0891b2'
                    } : {}}
                >
                    {activeIsConnecting() ? <Loader2 className="animate-spin w-4 h-4" /> : <Languages className="w-4 h-4" />}
                    {activeIsConnecting() ? 'Connecting...' : (showSubtitles ? activeModeLabel() : 'Start Translation')}
                </button>
                {showSubtitles && !activeIsConnecting() && (
                    <>
                        <div className="w-px h-4 bg-gray-600 mx-2"></div>
                        <div className="flex items-center gap-2 pr-2">
                            <Globe className="w-3 h-3 text-indigo-400" />
                            <select
                                value={targetLanguage}
                                onChange={(e) => setTargetLanguage(e.target.value as SupportedLanguage)}
                                className="bg-transparent text-sm text-gray-200 focus:outline-none cursor-pointer"
                            >
                                {LANGUAGES.map(lang => (
                                    <option key={lang} value={lang} className="bg-gray-800">{lang}</option>
                                ))}
                            </select>
                        </div>
                    </>
                )}
            </div>

            <button 
                onClick={() => setShowRightPanel(!showRightPanel)}
                className={`p-2 rounded-lg transition-all ${showRightPanel ? 'text-blue-400 bg-blue-900/20 shadow-inner ring-1 ring-blue-500/20' : 'text-gray-500 hover:bg-gray-800'}`}
                title="Toggle Live Interpretation Side Panel"
            >
                <PanelRight className="w-5 h-5" />
            </button>

            <button
                onClick={() => { setActiveIndex(0); resetTranscript(); setCurrentSlide(1); }}
                className="p-2 hover:bg-gray-800 rounded-full transition-colors text-gray-500 hover:text-white"
                title="Restart Presentation"
            >
                <RotateCcw className="w-5 h-5" />
            </button>

            {notSupported ? (
                <span className="text-red-500 text-xs">Unsupported</span>
            ) : (
                <button
                    onClick={isListening ? stopListening : startListening}
                    className={`flex items-center gap-2 px-5 py-2.5 rounded-full font-bold transition-all ${
                        isListening ? 'bg-red-500/20 text-red-400 ring-1 ring-red-500/50' : 'bg-green-600 hover:bg-green-700 text-white shadow-lg shadow-green-900/40'
                    }`}
                >
                    {isListening ? <><MicOff className="w-4 h-4" /> Stop Tracking</> : <><Mic className="w-4 h-4" /> Tracking Mode</>}
                </button>
            )}
        </div>
      </div>

      <div className="flex-1 min-h-0 flex overflow-hidden">
         {/* Left Side: PDF Viewer with High-Impact Captions */}
         {pdfFile && (
            <div className="w-1/2 border-r border-gray-800 bg-gray-950 flex flex-col relative group">
                <PDFViewer file={pdfFile} pageNumber={currentSlide} onLoadSuccess={setTotalSlides} />
                {showSubtitles && (
                    <div className="absolute bottom-12 left-0 right-0 px-16 flex justify-center pointer-events-none z-20">
                        <div className="bg-black/60 backdrop-blur-2xl p-6 rounded-3xl max-w-3xl text-center shadow-2xl border border-white/5 animate-in fade-in slide-in-from-bottom-8 duration-700">
                            <p className="text-white text-3xl font-bold leading-tight tracking-tight drop-shadow-xl">
                                {activeIsConnecting() ? (
                                    <span className="opacity-40 italic font-normal">Syncing...</span>
                                ) : (
                                    activeSubtitle().split('.').slice(-2).join('.') ||
                                    <span className="opacity-30 font-normal">Capturing your speech...</span>
                                )}
                            </p>
                        </div>
                    </div>
                )}
            </div>
         )}

         {/* Right Side: Pro Prompter + Live Bilingual Feed */}
         <div ref={containerRef} className="flex-1 flex overflow-hidden bg-black relative">
            <div ref={scrollContainerRef} className="flex-1 overflow-y-auto relative py-[45vh] text-center no-scrollbar">
                <div className="max-w-4xl mx-auto leading-[1.6] transition-all duration-300 px-12" style={{ fontSize: `${fontSize}px` }}>
                    {words.map((item, i) => {
                        // Determine word styling based on speech tracking position
                        let wordClass = 'text-gray-400 hover:text-white'; // Default: upcoming

                        if (i === activeIndex) {
                            // Current active word (speech tracking position)
                            wordClass = 'text-white scale-110 font-black bg-green-500/20 ring-4 ring-green-500/30';
                        } else if (i < activeIndex) {
                            // Already spoken (dimmed)
                            wordClass = 'text-gray-600 hover:text-gray-400';
                        }

                        return (
                            <span
                                key={i}
                                ref={(el) => { wordRefs.current[i] = el; }}
                                onClick={() => setActiveIndex(i)}
                                className={`inline-block mx-2 px-1 rounded transition-all duration-300 cursor-pointer ${wordClass}`}
                            >
                                {item.word}
                            </span>
                        );
                    })}
                </div>
            </div>

            {/* LIVE FEED SIDEBAR (The Stream Interface) */}
            {showRightPanel && showSubtitles && (
                <>
                {/* Draggable Divider */}
                <div
                    onMouseDown={handleMouseDown}
                    className="w-2 bg-gray-800 hover:bg-indigo-500 transition-colors cursor-col-resize flex items-center justify-center group shrink-0"
                    title="Drag to resize"
                >
                    <div className="w-0.5 h-16 bg-gray-600 group-hover:bg-white/50 rounded-full transition-colors" />
                </div>
                <div
                    className="bg-gray-900/70 backdrop-blur-3xl border-l border-white/5 flex flex-col animate-in slide-in-from-right duration-500 shadow-2xl shrink-0"
                    style={{ width: `${rightPanelWidth}px` }}
                >
                    <div className="p-5 border-b border-white/5 flex items-center justify-between bg-black/40">
                        <div className="flex items-center gap-3">
                            <div className="relative flex items-center justify-center">
                                <div className={`w-3 h-3 rounded-full animate-ping absolute opacity-50`} style={{ backgroundColor: translationMode === 'live' ? '#a855f7' : translationMode === 'text' ? '#10b981' : translationMode === 'local-omni' ? '#f59e0b' : translationMode === 'personaplex' ? '#fb7185' : '#06b6d4' }} />
                                <div className={`w-2.5 h-2.5 rounded-full relative`} style={{ backgroundColor: translationMode === 'live' ? '#9333ea' : translationMode === 'text' ? '#059669' : translationMode === 'local-omni' ? '#d97706' : translationMode === 'personaplex' ? '#e11d48' : '#0891b2' }} />
                            </div>
                            <span className="text-[10px] font-black uppercase tracking-[0.2em] text-gray-300">
                                {activeFeedLabel()}
                            </span>
                        </div>
                        <div className="text-right">
                            <span className="text-[9px] text-gray-500 font-bold uppercase block tracking-widest">
                                {activeEngineLabel()}
                            </span>
                            <span className="text-xs font-mono font-black" style={{ color: translationMode === 'live' ? '#c084fc' : translationMode === 'text' ? '#34d399' : translationMode === 'local-omni' ? '#fbbf24' : translationMode === 'personaplex' ? '#fda4af' : '#22d3ee' }}>{targetLanguage}</span>
                        </div>
                    </div>

                    <div ref={interpretationRef} className="flex-1 overflow-y-auto p-8 scroll-smooth no-scrollbar space-y-10">
                        {activeIsConnecting() ? (
                            <div className="flex flex-col items-center justify-center h-full opacity-30 py-40 space-y-6">
                                <Loader2 className="w-10 h-10 animate-spin text-indigo-500" />
                                <p className="text-xs font-bold tracking-widest uppercase">Connecting Neural Engine</p>
                            </div>
                        ) : (
                            <>
                                {/* Source Speech (What user said) */}
                                <div className="space-y-3 opacity-60 hover:opacity-100 transition-opacity">
                                    <div className="flex items-center gap-2 text-[9px] font-black text-gray-500 tracking-tighter uppercase">
                                        <Quote className="w-3 h-3" /> Source Voice
                                    </div>
                                    <p className="text-gray-300 text-sm leading-relaxed font-sans italic">
                                        {activeSource() || "Waiting for signal..."}
                                    </p>
                                </div>

                                <div className="h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />

                                {/* Target Translation */}
                                <div className="space-y-3">
                                    <div className="flex items-center gap-2 text-[9px] font-black tracking-tighter uppercase" style={{ color: translationMode === 'live' ? '#c084fc' : translationMode === 'text' ? '#34d399' : translationMode === 'local-omni' ? '#fbbf24' : translationMode === 'personaplex' ? '#fda4af' : '#22d3ee' }}>
                                        <Languages className="w-3 h-3" /> {targetLanguage} Output
                                        {activeIsSpeaking() && (
                                            <span className="ml-2 text-[8px] px-1.5 py-0.5 rounded-full animate-pulse" style={{ backgroundColor: translationMode === 'text' ? 'rgba(16,185,129,0.2)' : 'rgba(6,182,212,0.2)' }}>Speaking...</span>
                                        )}
                                    </div>
                                    <p className="text-white text-xl font-serif leading-relaxed animate-in fade-in duration-300">
                                        {activeSubtitle() || <span className="opacity-20 italic">Translating speech...</span>}
                                    </p>
                                </div>
                            </>
                        )}
                    </div>

                    <div className="p-6 border-t border-white/5 bg-black/60 backdrop-blur-md space-y-4">
                        <div className="flex justify-between items-center px-1">
                            <span className="text-[9px] font-black text-gray-600 tracking-tighter uppercase">
                                {isOmniStyle || translationMode === 'local-pipeline' ? 'Audio Intelligence' : 'TTS Status'}
                            </span>
                            <div className="text-[9px] font-mono px-2 py-0.5 rounded border" style={
                                activeIsConnected()
                                    ? {
                                        color: translationMode === 'live' ? '#c084fc' : translationMode === 'text' ? '#34d399' : translationMode === 'local-omni' ? '#fbbf24' : translationMode === 'personaplex' ? '#fda4af' : '#22d3ee',
                                        borderColor: translationMode === 'live' ? 'rgba(168,85,247,0.2)' : translationMode === 'text' ? 'rgba(52,211,153,0.2)' : translationMode === 'local-omni' ? 'rgba(245,158,11,0.2)' : translationMode === 'personaplex' ? 'rgba(251,113,133,0.2)' : 'rgba(6,182,212,0.2)',
                                        backgroundColor: translationMode === 'live' ? 'rgba(168,85,247,0.05)' : translationMode === 'text' ? 'rgba(52,211,153,0.05)' : translationMode === 'local-omni' ? 'rgba(245,158,11,0.05)' : translationMode === 'personaplex' ? 'rgba(251,113,133,0.05)' : 'rgba(6,182,212,0.05)',
                                      }
                                    : { color: '#6b7280', borderColor: '#374151' }
                            }>
                                {isOmniStyle
                                    ? (activeIsConnected() ? 'STREAMING' : 'INITIALIZING')
                                    : (activeIsConnected() ? (activeIsSpeaking() ? 'SPEAKING' : 'READY') : 'INITIALIZING')
                                }
                            </div>
                        </div>
                        {/* Volume bar for modes that capture mic audio */}
                        {(isOmniStyle || translationMode === 'local-pipeline') ? (
                            <div className="bg-gray-800/50 h-3 rounded-full overflow-hidden flex border border-white/5 p-0.5">
                                <div
                                    className={`h-full transition-all duration-75 rounded-full ${activeVolume > 0.4 ? '' : 'bg-gray-600'}`}
                                    style={{
                                        width: `${Math.min(100, activeVolume * 350)}%`,
                                        ...(activeVolume > 0.4 ? {
                                            backgroundColor: translationMode === 'live' ? '#c084fc' : translationMode === 'local-omni' ? '#fbbf24' : translationMode === 'personaplex' ? '#fda4af' : '#22d3ee',
                                            boxShadow: translationMode === 'live' ? '0 0 15px rgba(168,85,247,0.5)' : translationMode === 'local-omni' ? '0 0 15px rgba(245,158,11,0.5)' : translationMode === 'personaplex' ? '0 0 15px rgba(251,113,133,0.5)' : '0 0 15px rgba(6,182,212,0.5)',
                                        } : {})
                                    }}
                                />
                            </div>
                        ) : (
                            /* Speaking indicator for text/API pipeline mode (no direct mic) */
                            <div className="bg-gray-800/50 h-3 rounded-full overflow-hidden flex border border-white/5 p-0.5">
                                <div
                                    className={`h-full transition-all duration-300 rounded-full ${activeIsSpeaking() ? 'animate-pulse' : 'bg-gray-600'}`}
                                    style={{
                                        width: activeIsSpeaking() ? '100%' : '0%',
                                        ...(activeIsSpeaking() ? {
                                            backgroundColor: '#34d399',
                                            boxShadow: '0 0 15px rgba(52,211,153,0.5)',
                                        } : {})
                                    }}
                                />
                            </div>
                        )}
                    </div>
                </div>
                </>
            )}
         </div>
      </div>
    </div>
  );
};
