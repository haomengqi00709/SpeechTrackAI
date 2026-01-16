export interface ScriptAnalysis {
  tone: string;
  estimatedDuration: string;
  pacingSuggestion: string;
  keyPoints: string[];
  readabilityScore: number;
}

export enum AppMode {
  EDIT = 'EDIT',
  READ = 'READ',
}

export interface WordItem {
  word: string;
  cleanWord: string; // Lowercase, no punctuation for matching
  index: number;
}

export type SupportedLanguage = 
  | 'English'
  | 'French';

export const LANGUAGES: SupportedLanguage[] = [
  'English', 'French'
];