import { GoogleGenAI, Type } from "@google/genai";
import { ScriptAnalysis } from "../types";

const apiKey = process.env.API_KEY || '';

// Initialize Gemini
const ai = new GoogleGenAI({ apiKey });

export const analyzeScript = async (scriptText: string): Promise<ScriptAnalysis> => {
  if (!apiKey) {
    throw new Error("API Key is missing.");
  }

  const prompt = `Analyze the following speech script for a speaker. Provide a JSON response with:
  1. The overall tone (e.g., Serious, Inspiring, Casual).
  2. Estimated duration (e.g., "2 minutes").
  3. A suggestion on pacing (e.g., "Slow down at the beginning").
  4. A list of 3 key bullet points.
  5. A readability score from 0 to 100 (100 being easiest).

  Script: "${scriptText}"`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            tone: { type: Type.STRING },
            estimatedDuration: { type: Type.STRING },
            pacingSuggestion: { type: Type.STRING },
            keyPoints: { 
              type: Type.ARRAY, 
              items: { type: Type.STRING } 
            },
            readabilityScore: { type: Type.NUMBER },
          },
          required: ["tone", "estimatedDuration", "pacingSuggestion", "keyPoints", "readabilityScore"],
        },
      },
    });

    if (response.text) {
      return JSON.parse(response.text) as ScriptAnalysis;
    }
    throw new Error("No response text generated");
  } catch (error) {
    console.error("Gemini Analysis Error:", error);
    throw error;
  }
};

export const polishScript = async (scriptText: string): Promise<string> => {
    if (!apiKey) {
      throw new Error("API Key is missing.");
    }
  
    const prompt = `Rewrite the following text to make it sound more professional, engaging, and suitable for a public speech. Maintain the original meaning but improve flow and clarity. \n\nOriginal Text: ${scriptText}`;
  
    try {
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
      });
  
      return response.text || scriptText;
    } catch (error) {
      console.error("Gemini Polish Error:", error);
      throw error;
    }
  };