import React, { useEffect, useState, useRef, useMemo } from 'react';
import { ArrowLeft, Mic, MicOff, RotateCcw, ChevronLeft, ChevronRight, Globe, Loader2, Languages, PanelRight, Quote } from 'lucide-react';
import { useSpeechRecognition } from '../hooks/useSpeechRecognition';
import { useGeminiLive } from '../hooks/useGeminiLive';
import { WordItem, LANGUAGES, SupportedLanguage } from '../types';
import { PDFViewer } from './PDFViewer';

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
      connect: connectLive, 
      disconnect: disconnectLive 
  } = useGeminiLive();

  const [activeIndex, setActiveIndex] = useState(0);
  const [fontSize, setFontSize] = useState(48);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const wordRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const interpretationRef = useRef<HTMLDivElement>(null);

  const [showSubtitles, setShowSubtitles] = useState(false);
  const [showRightPanel, setShowRightPanel] = useState(true);
  const [targetLanguage, setTargetLanguage] = useState<SupportedLanguage>('French');

  const [currentSlide, setCurrentSlide] = useState(1);
  const [totalSlides, setTotalSlides] = useState(0);

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

  useEffect(() => {
      if (showSubtitles) {
          connectLive({ targetLanguage });
      } else {
          disconnectLive();
      }
      return () => disconnectLive();
  }, [showSubtitles, targetLanguage, connectLive, disconnectLive]);

  useEffect(() => {
    if (interpretationRef.current) {
        interpretationRef.current.scrollTop = interpretationRef.current.scrollHeight;
    }
  }, [liveSubtitle, liveSource]);

  useEffect(() => {
    if (!transcript) return;
    const transcriptWords = transcript.toLowerCase().replace(/[^\w\s]|_/g, "").split(/\s+/).filter(w => w !== "");
    if (transcriptWords.length === 0) return;
    const lastSpokenWord = transcriptWords[transcriptWords.length - 1];
    const secondLastSpokenWord = transcriptWords.length > 1 ? transcriptWords[transcriptWords.length - 2] : null;
    const searchWindow = 20;
    const searchEndIndex = Math.min(activeIndex + searchWindow, words.length);

    for (let i = activeIndex; i < searchEndIndex; i++) {
        const scriptWord = words[i].cleanWord;
        if (scriptWord === lastSpokenWord) {
            if (secondLastSpokenWord && i > 0 && words[i-1].cleanWord === secondLastSpokenWord) {
                setActiveIndex(i + 1);
                return;
            }
            if (activeIndex === 0) {
                setActiveIndex(i + 1);
                return;
            }
        }
    }
  }, [transcript, words, activeIndex]);

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

  return (
    <div className="flex flex-col h-full bg-black text-gray-400 font-sans">
      <div className="flex items-center justify-between p-4 bg-gray-900 border-b border-gray-800 z-50 shrink-0 shadow-lg">
        <button onClick={onExit} className="text-gray-400 hover:text-white flex items-center gap-2 transition-colors">
          <ArrowLeft className="w-5 h-5" /> Back to Editor
        </button>

        <div className="flex items-center gap-4">
            <div className="flex items-center bg-gray-800 rounded-full px-2 py-1 border border-gray-700 shadow-inner">
                <button 
                    onClick={() => setShowSubtitles(!showSubtitles)}
                    disabled={isLiveConnecting}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-all duration-300 ${showSubtitles ? 'bg-indigo-600 text-white shadow-lg' : 'text-gray-400 hover:text-gray-200'} ${isLiveConnecting ? 'opacity-80 cursor-wait' : ''}`}
                >
                    {isLiveConnecting ? <Loader2 className="animate-spin w-4 h-4" /> : <Languages className="w-4 h-4" />}
                    {isLiveConnecting ? 'Connecting AI...' : (showSubtitles ? 'Live AI On' : 'Start Translation')}
                </button>
                {showSubtitles && !isLiveConnecting && (
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
                                {isLiveConnecting ? <span className="opacity-40 italic font-normal">Syncing...</span> : (liveSubtitle.split('.').slice(-2).join('.') || <span className="opacity-30 font-normal">Capturing your speech...</span>)}
                            </p>
                        </div>
                    </div>
                )}
            </div>
         )}

         {/* Right Side: Pro Prompter + Live Bilingual Feed */}
         <div className="flex-1 flex overflow-hidden bg-black relative">
            <div ref={scrollContainerRef} className="flex-1 overflow-y-auto relative py-[45vh] text-center no-scrollbar">
                <div className="max-w-4xl mx-auto leading-[1.6] transition-all duration-300 px-12" style={{ fontSize: `${fontSize}px` }}>
                    {words.map((item, i) => (
                        <span key={i} ref={(el) => { wordRefs.current[i] = el; }} className={`inline-block mx-2 px-1 rounded transition-all duration-300 select-none ${i === activeIndex ? 'text-white scale-110 font-black bg-green-500/20 ring-4 ring-green-500/30' : i < activeIndex ? 'text-gray-800' : 'text-gray-400 hover:text-white'}`}>
                            {item.word}
                        </span>
                    ))}
                </div>
            </div>

            {/* LIVE FEED SIDEBAR (The Stream Interface) */}
            {showRightPanel && showSubtitles && (
                <div className="w-96 bg-gray-900/70 backdrop-blur-3xl border-l border-white/5 flex flex-col animate-in slide-in-from-right duration-500 shadow-2xl">
                    <div className="p-5 border-b border-white/5 flex items-center justify-between bg-black/40">
                        <div className="flex items-center gap-3">
                            <div className="relative flex items-center justify-center">
                                <div className="w-3 h-3 rounded-full bg-red-500 animate-ping absolute opacity-50" />
                                <div className="w-2.5 h-2.5 rounded-full bg-red-600 relative" />
                            </div>
                            <span className="text-[10px] font-black uppercase tracking-[0.2em] text-gray-300">Live Dual Feed</span>
                        </div>
                        <div className="text-right">
                            <span className="text-[9px] text-gray-500 font-bold uppercase block tracking-widest">Interpretation</span>
                            <span className="text-xs font-mono text-indigo-400 font-black">{targetLanguage}</span>
                        </div>
                    </div>
                    
                    <div ref={interpretationRef} className="flex-1 overflow-y-auto p-8 scroll-smooth no-scrollbar space-y-10">
                        {isLiveConnecting ? (
                            <div className="flex flex-col items-center justify-center h-full opacity-30 py-40 space-y-6">
                                <Loader2 className="w-10 h-10 animate-spin text-indigo-500" />
                                <p className="text-xs font-bold tracking-widest uppercase">Connecting Neural Engine</p>
                            </div>
                        ) : (
                            <>
                                {/* Source Speech (What user said) - Modified real-time */}
                                <div className="space-y-3 opacity-60 hover:opacity-100 transition-opacity">
                                    <div className="flex items-center gap-2 text-[9px] font-black text-gray-500 tracking-tighter uppercase">
                                        <Quote className="w-3 h-3" /> Source Voice
                                    </div>
                                    <p className="text-gray-300 text-sm leading-relaxed font-sans italic line-clamp-4">
                                        {liveSource || "Waiting for signal..."}
                                    </p>
                                </div>

                                <div className="h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />

                                {/* Target Translation - Modified real-time */}
                                <div className="space-y-3">
                                    <div className="flex items-center gap-2 text-[9px] font-black text-indigo-400 tracking-tighter uppercase">
                                        <Languages className="w-3 h-3" /> {targetLanguage} Output
                                    </div>
                                    <p className="text-white text-xl font-serif leading-relaxed animate-in fade-in duration-300">
                                        {liveSubtitle || <span className="opacity-20 italic">Translating speech...</span>}
                                    </p>
                                </div>
                            </>
                        )}
                    </div>

                    <div className="p-6 border-t border-white/5 bg-black/60 backdrop-blur-md space-y-4">
                        <div className="flex justify-between items-center px-1">
                            <span className="text-[9px] font-black text-gray-600 tracking-tighter uppercase">Audio Intelligence</span>
                            <div className={`text-[9px] font-mono px-2 py-0.5 rounded border ${isLiveConnected ? 'text-green-500 border-green-500/20 bg-green-500/5' : 'text-gray-500 border-gray-700'}`}>
                                {isLiveConnected ? 'OPTIMIZED' : 'INITIALIZING'}
                            </div>
                        </div>
                        <div className="bg-gray-800/50 h-3 rounded-full overflow-hidden flex border border-white/5 p-0.5">
                            <div className={`h-full transition-all duration-75 rounded-full ${liveVolume > 0.4 ? 'bg-indigo-400 shadow-[0_0_15px_rgba(129,140,248,0.5)]' : 'bg-gray-600'}`} style={{ width: `${Math.min(100, liveVolume * 350)}%` }} />
                        </div>
                    </div>
                </div>
            )}
         </div>
      </div>
    </div>
  );
};
