const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Get arguments
const jsonUrl = process.argv[2];
const chaptersPerRequest = parseInt(process.argv[3]) || 5;
const geminiApiKey = process.env.GEMINI_API_KEY;

if (!jsonUrl) {
  console.error('Please provide a JSON URL as the first argument');
  process.exit(1);
}

if (!geminiApiKey) {
  console.error('GEMINI_API_KEY environment variable is not set');
  process.exit(1);
}

// Extract ID from URL (assuming format like .../288571.json)
const fileId = path.basename(jsonUrl, '.json');

// Create results directory if it doesn't exist
const resultsDir = path.join(__dirname, '../results');
if (!fs.existsSync(resultsDir)) {
  fs.mkdirSync(resultsDir);
}

// Initialize Gemini
const genAI = new GoogleGenerativeAI(geminiApiKey);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

const systemInstruction = `
You are a strict translator. Do not modify the story, characters, or intent. 
Preserve all names of people, but translate techniques/props/places/organizations when readability benefits. 
Prioritize natural English flow while keeping the original's tone (humor, sarcasm, etc.). 
For idioms or culturally specific terms, translate literally if possible; otherwise, adapt with a footnote. 
Dialogue must match the original's bluntness or subtlety, including punctuation.

Return the JSON with the exact same structure but with translated text.
`;

async function translateChapters(chapters) {
  const prompt = `
  ${systemInstruction}
  
  Translate the following JSON array of chapters from Chinese to English. 
  Maintain the exact same JSON structure, only translating the text content.
  
  Input JSON:
  ${JSON.stringify(chapters, null, 2)}
  
  Translated JSON:
  `;

  try {
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    // Extract JSON from the response (Gemini might add markdown formatting)
    const jsonStart = text.indexOf('[');
    const jsonEnd = text.lastIndexOf(']') + 1;
    const jsonString = text.slice(jsonStart, jsonEnd);
    
    return JSON.parse(jsonString);
  } catch (error) {
    console.error('Translation error:', error);
    throw error;
  }
}

async function processJson() {
  try {
    // Fetch the JSON
    const response = await axios.get(jsonUrl);
    const chapters = response.data;
    
    if (!Array.isArray(chapters)) {
      throw new Error('Invalid JSON format: expected an array of chapters');
    }
    
    // Process in batches
    const translatedChapters = [];
    for (let i = 0; i < chapters.length; i += chaptersPerRequest) {
      const batch = chapters.slice(i, i + chaptersPerRequest);
      console.log(`Translating chapters ${i + 1}-${Math.min(i + chaptersPerRequest, chapters.length)}/${chapters.length}`);
      
      const translatedBatch = await translateChapters(batch);
      translatedChapters.push(...translatedBatch);
      
      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Save the result
    const outputPath = path.join(resultsDir, `${fileId}.json`);
    fs.writeFileSync(outputPath, JSON.stringify(translatedChapters, null, 2));
    console.log(`Translation complete. Saved to ${outputPath}`);
    
  } catch (error) {
    console.error('Error processing JSON:', error);
    process.exit(1);
  }
}

processJson();
