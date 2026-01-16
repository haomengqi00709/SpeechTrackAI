import React, { useState, useRef } from 'react';
import { ScriptAnalysis } from '../types';
import { analyzeScript, polishScript } from '../services/geminiService';
import { Loader2, Sparkles, Zap, ArrowRight, Wand2, FileText, FileCheck, Presentation } from 'lucide-react';

interface ScriptEditorProps {
  script: string;
  setScript: (s: string) => void;
  setPdfFile: (f: File | null) => void;
  onStartReading: () => void;
}

export const ScriptEditor: React.FC<ScriptEditorProps> = ({ script, setScript, setPdfFile, onStartReading }) => {
  const [analysis, setAnalysis] = useState<ScriptAnalysis | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isPolishing, setIsPolishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleAnalyze = async () => {
    if (!script.trim()) return;
    setIsAnalyzing(true);
    setError(null);
    try {
      const result = await analyzeScript(script);
      setAnalysis(result);
    } catch (err) {
      setError("Failed to analyze script. Please check your connection or API key.");
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handlePolish = async () => {
    if (!script.trim()) return;
    setIsPolishing(true);
    setError(null);
    try {
      const result = await polishScript(script);
      setScript(result);
    } catch (err) {
      setError("Failed to polish script.");
    } finally {
      setIsPolishing(false);
    }
  };

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (file.type !== 'application/pdf') {
      setError("Please upload a valid PDF file.");
      return;
    }

    // Just attach the file for display, do not extract text
    setPdfFile(file);
    setUploadedFileName(file.name);
    setError(null);

    // Reset input so same file can be selected again if needed
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className="flex flex-col h-full gap-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold text-white flex items-center gap-2">
          <Zap className="text-yellow-400" />
          Script Editor
        </h2>
        <div className="flex gap-3">
          <input 
            type="file" 
            ref={fileInputRef} 
            onChange={handleFileUpload} 
            accept="application/pdf" 
            className="hidden" 
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors border ${uploadedFileName ? 'bg-indigo-900/30 border-indigo-500 text-indigo-300' : 'bg-gray-700 hover:bg-gray-600 text-white border-gray-600'}`}
          >
            {uploadedFileName ? <FileCheck className="w-4 h-4" /> : <Presentation className="w-4 h-4" />}
            {uploadedFileName ? 'Slides Attached' : 'Attach PDF Slides'}
          </button>
          
          <button
            onClick={handlePolish}
            disabled={isPolishing || !script}
            className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors disabled:opacity-50"
          >
            {isPolishing ? <Loader2 className="animate-spin w-4 h-4" /> : <Wand2 className="w-4 h-4" />}
            Polish with AI
          </button>
          <button
            onClick={handleAnalyze}
            disabled={isAnalyzing || !script}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors disabled:opacity-50"
          >
            {isAnalyzing ? <Loader2 className="animate-spin w-4 h-4" /> : <Sparkles className="w-4 h-4" />}
            Analyze
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 flex-1 min-h-0">
        <div className="lg:col-span-2 flex flex-col gap-4 relative">
          <textarea
            value={script}
            onChange={(e) => setScript(e.target.value)}
            placeholder="Paste your speech script here..."
            className="w-full h-full p-6 bg-gray-800 text-gray-100 rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 text-lg leading-relaxed border border-gray-700 font-mono"
          />
          {!script && (
             <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="text-gray-600 flex flex-col items-center">
                    <FileText className="w-12 h-12 mb-2 opacity-20" />
                    <p className="opacity-40">Paste your script text here</p>
                    {uploadedFileName && <p className="text-xs text-indigo-400 mt-2">(Slides "{uploadedFileName}" will appear on left)</p>}
                </div>
             </div>
          )}
        </div>

        <div className="lg:col-span-1 flex flex-col gap-4">
          {error && (
            <div className="p-4 bg-red-900/50 border border-red-700 text-red-200 rounded-xl text-sm animate-fade-in">
              {error}
            </div>
          )}

          {analysis ? (
            <div className="bg-gray-800 rounded-xl p-6 border border-gray-700 flex flex-col gap-4 h-full overflow-y-auto">
              <h3 className="font-semibold text-lg text-blue-400">AI Analysis</h3>
              
              <div>
                <span className="text-gray-400 text-sm block">Tone</span>
                <span className="text-white">{analysis.tone}</span>
              </div>
              
              <div>
                <span className="text-gray-400 text-sm block">Estimated Duration</span>
                <span className="text-white">{analysis.estimatedDuration}</span>
              </div>

              <div>
                <span className="text-gray-400 text-sm block">Pacing Suggestion</span>
                <p className="text-gray-300 text-sm mt-1">{analysis.pacingSuggestion}</p>
              </div>

              <div>
                <span className="text-gray-400 text-sm block">Readability (0-100)</span>
                <div className="w-full bg-gray-700 rounded-full h-2.5 mt-2">
                  <div 
                    className={`h-2.5 rounded-full ${analysis.readabilityScore > 80 ? 'bg-green-500' : analysis.readabilityScore > 50 ? 'bg-yellow-500' : 'bg-red-500'}`} 
                    style={{ width: `${analysis.readabilityScore}%` }}
                  ></div>
                </div>
              </div>

              <div>
                <span className="text-gray-400 text-sm block mb-2">Key Points</span>
                <ul className="list-disc pl-5 space-y-1 text-sm text-gray-300">
                  {analysis.keyPoints.map((point, i) => (
                    <li key={i}>{point}</li>
                  ))}
                </ul>
              </div>
            </div>
          ) : (
            <div className="bg-gray-800/50 rounded-xl p-6 border border-gray-700 border-dashed h-full flex flex-col items-center justify-center text-gray-500 text-center">
              <Sparkles className="w-8 h-8 mb-2 opacity-50" />
              <p>Click "Analyze" to get AI insights about your speech.</p>
            </div>
          )}
        </div>
      </div>

      <div className="flex justify-end pt-4 border-t border-gray-800">
        <button
          onClick={onStartReading}
          disabled={!script.trim()}
          className="flex items-center gap-2 px-8 py-4 bg-green-600 hover:bg-green-700 text-white text-lg font-bold rounded-full shadow-lg hover:shadow-green-900/50 transition-all transform hover:-translate-y-1 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Start Presentation Mode
          <ArrowRight className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
};
