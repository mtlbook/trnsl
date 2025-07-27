const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

// Get arguments
const jsonUrl = process.argv[2];
const chaptersPerRequest = parseInt(process.argv[3]) || 5;

// Validate URL
if (!jsonUrl) {
  console.error('Please provide a JSON URL as the first argument');
  process.exit(1);
}

// Extract ID from URL
const idMatch = jsonUrl.match(/\/(\d+)\.json$/);
if (!idMatch) {
  console.error('Invalid JSON URL format. Expected URL ending with /ID.json');
  process.exit(1);
}
const id = idMatch[1];

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// System instruction
const systemInstruction = {
  role: "model",
  parts: [{
    text: `You are a strict Chinese-to-English translator. Follow these rules:
1. Maintain original structure as JSON array with "title" and "content" for each chapter
2. Preserve all names and proper nouns
3. Keep original tone and style
4. Output MUST be valid JSON that can be parsed directly
5. Do not add any commentary or notes

Example input format:
[{"title":"...","content":"..."},{"title":"...","content":"..."}]

Example output format:
[{"title":"...","content":"..."},{"title":"...","content":"..."}]`
  }]
};

async function translateChapters(chapters) {
  try {
    const prompt = `Translate the following chapters from Chinese to English exactly as they are.
Maintain the original JSON structure with 'title' and 'content' fields for each chapter.
Return ONLY the translated JSON with no additional text or commentary.

Input JSON:
${JSON.stringify(chapters, null, 2)}

Translated JSON:`;
    
    const result = await model.generateContent({
      contents: [
        { role: "user", parts: [{ text: prompt }] },
        systemInstruction
      ]
    });
    
    const response = await result.response;
    const translatedText = response.text();
    
    // Debug: Save raw response
    fs.writeFileSync('last_response.txt', translatedText);
    console.log('Raw response saved to last_response.txt');
    
    // Clean the response
    let cleanText = translatedText.trim();
    
    // Remove potential markdown code block markers
    cleanText = cleanText.replace(/```json/g, '').replace(/```/g, '').trim();
    
    // Remove any text before the first [ and after the last ]
    const jsonStart = cleanText.indexOf('[');
    const jsonEnd = cleanText.lastIndexOf(']');
    
    if (jsonStart === -1 || jsonEnd === -1) {
      throw new Error('No JSON array found in response');
    }
    
    cleanText = cleanText.slice(jsonStart, jsonEnd + 1);
    
    try {
      const parsed = JSON.parse(cleanText);
      
      if (!Array.isArray(parsed)) {
        throw new Error('Response is not an array');
      }
      
      // Validate each chapter
      for (const chapter of parsed) {
        if (!chapter.title || !chapter.content) {
          throw new Error('Invalid chapter format - missing title or content');
        }
      }
      
      return parsed;
    } catch (parseError) {
      console.error('Failed to parse response:', parseError);
      console.error('Response content:', cleanText);
      throw new Error('Could not parse valid JSON from response');
    }
  } catch (error) {
    console.error('Translation error:', error);
    throw error;
  }
}

async function main() {
  try {
    // Fetch the original JSON
    console.log(`Fetching JSON from ${jsonUrl}...`);
    const response = await axios.get(jsonUrl);
    const chapters = response.data;
    console.log(`Found ${chapters.length} chapters to translate`);
    
    // Process in batches
    const translatedChapters = [];
    for (let i = 0; i < chapters.length; i += chaptersPerRequest) {
      const batchEnd = Math.min(i + chaptersPerRequest, chapters.length);
      console.log(`Translating chapters ${i+1} to ${batchEnd}...`);
      
      const batch = chapters.slice(i, batchEnd);
      const translatedBatch = await translateChapters(batch);
      translatedChapters.push(...translatedBatch);
      
      // Small delay between requests to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    // Ensure results directory exists
    const resultsDir = path.join(__dirname, '../results');
    if (!fs.existsSync(resultsDir)) {
      fs.mkdirSync(resultsDir);
    }
    
    // Save the translated JSON
    const outputPath = path.join(resultsDir, `${id}.json`);
    fs.writeFileSync(outputPath, JSON.stringify(translatedChapters, null, 2));
    console.log(`Translation saved to ${outputPath}`);
    
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();
