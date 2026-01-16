import React, { useState } from 'react';
import { ScriptEditor } from './components/ScriptEditor';
import { Teleprompter } from './components/Teleprompter';
import { AppMode } from './types';
import { Mic, Radio } from 'lucide-react';

const App: React.FC = () => {
  const [mode, setMode] = useState<AppMode>(AppMode.EDIT);
  const [script, setScript] = useState<string>("");
  const [pdfFile, setPdfFile] = useState<File | null>(null);

  return (
    <div className="h-screen w-screen flex flex-col bg-gray-950 text-gray-100 overflow-hidden font-sans selection:bg-blue-500/30">
      
      {mode === AppMode.EDIT && (
        <>
            <header className="h-16 border-b border-gray-800 bg-gray-900/50 backdrop-blur flex items-center justify-between px-6 shrink-0">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-gradient-to-br from-blue-600 to-indigo-600 rounded-xl flex items-center justify-center shadow-lg shadow-blue-900/20">
                        <Radio className="text-white w-6 h-6" />
                    </div>
                    <div>
                        <h1 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-indigo-400">
                            SpeechTrack AI
                        </h1>
                        <p className="text-xs text-gray-500 font-medium">Smart Teleprompter</p>
                    </div>
                </div>
                <div className="text-sm text-gray-500 hidden md:block">
                    Powered by Gemini 2.5
                </div>
            </header>
            
            <main className="flex-1 p-4 md:p-6 min-h-0 overflow-hidden">
                <div className="max-w-6xl mx-auto h-full">
                    <ScriptEditor 
                        script={script} 
                        setScript={setScript}
                        setPdfFile={setPdfFile}
                        onStartReading={() => setMode(AppMode.READ)} 
                    />
                </div>
            </main>
        </>
      )}

      {mode === AppMode.READ && (
        <Teleprompter 
            script={script} 
            pdfFile={pdfFile}
            onExit={() => setMode(AppMode.EDIT)} 
        />
      )}
    </div>
  );
};

export default App;