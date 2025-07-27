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
    text: "You are a strict translator. Do not modify the story, characters, or intent. " +
          "Preserve all names of people, but translate techniques/props/places/organizations " +
          "when readability benefits. Prioritize natural English flow while keeping the " +
          "original's tone (humor, sarcasm, etc.). For idioms or culturally specific terms, " +
          "translate literally if possible; otherwise, adapt with a footnote. Dialogue must " +
          "match the original's bluntness or subtlety, including punctuation. " +
          "IMPORTANT: Return the translation in EXACTLY the same JSON format as the input, " +
          "with each chapter having 'title' and 'content' fields."
  }]
};

async function translateChapters(chapters) {
  try {
    const prompt = `Translate the following chapters from Chinese to English exactly as they are. ` +
                   `Maintain the original JSON structure with 'title' and 'content' fields for each chapter. ` +
                   `Here is the input:\n\n${JSON.stringify(chapters, null, 2)}`;
    
    const result = await model.generateContent({
      contents: [
        { role: "user", parts: [{ text: prompt }] },
        systemInstruction
      ]
    });
    
    const response = await result.response;
    const translatedText = response.text();
    
    // Try to parse the response as JSON first
    try {
      const parsed = JSON.parse(translatedText);
      if (Array.isArray(parsed) && parsed.every(item => item.title && item.content)) {
        return parsed;
      }
    } catch (e) {
      console.log('Response was not direct JSON, attempting to extract...');
    }
    
    // Fallback: Try to extract JSON from markdown code blocks
    const codeBlockMatch = translatedText.match(/```(?:json)?\n([\s\S]*?)\n```/);
    if (codeBlockMatch) {
      try {
        const parsed = JSON.parse(codeBlockMatch[1]);
        if (Array.isArray(parsed) && parsed.every(item => item.title && item.content)) {
          return parsed;
        }
      } catch (e) {
        console.error('Failed to parse code block JSON:', e);
      }
    }
    
    // Final fallback: Manual parsing
    console.warn('Could not parse response as JSON, attempting manual parsing...');
    const lines = translatedText.split('\n');
    const translatedChapters = [];
    let currentChapter = null;
    
    for (const line of lines) {
      if (line.startsWith('Title:')) {
        if (currentChapter) translatedChapters.push(currentChapter);
        currentChapter = { title: line.replace('Title:', '').trim(), content: '' };
      } else if (line.startsWith('Content:')) {
        if (currentChapter) {
          currentChapter.content = line.replace('Content:', '').trim();
        }
      } else if (currentChapter && currentChapter.title) {
        currentChapter.content += '\n' + line.trim();
      }
    }
    
    if (currentChapter) translatedChapters.push(currentChapter);
    
    if (translatedChapters.length === 0) {
      throw new Error('Could not parse any chapters from the response');
    }
    
    return translatedChapters;
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
      await new Promise(resolve => setTimeout(resolve, 7000));
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
