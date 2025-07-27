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
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// System instruction
const systemInstruction = {
  role: "model",
  parts: [{
    text: "You are a strict translator. Do not modify the story, characters, or intent. " +
          "Preserve all names of people, but translate techniques/props/places/organizations " +
          "when readability benefits. Prioritize natural English flow while keeping the " +
          "original's tone (humor, sarcasm, etc.). For idioms or culturally specific terms, " +
          "translate literally if possible; otherwise, adapt with a footnote. Dialogue must " +
          "match the original's bluntness or subtlety, including punctuation."
  }]
};

async function translateChapters(chapters) {
  try {
    const chapterTexts = chapters.map(ch => `Title: ${ch.title}\nContent: ${ch.content}`).join('\n\n---\n\n');
    
    const prompt = `Translate the following chapters from Chinese to English exactly as they are. ` +
                   `Do not modify the structure or add any commentary. Keep the JSON format:\n\n${chapterTexts}`;
    
    const result = await model.generateContent({
      contents: [
        { role: "user", parts: [{ text: prompt }] },
        systemInstruction
      ]
    });
    
    const response = await result.response;
    const translatedText = response.text();
    
    // Parse the translated text back into chapters
    // This is a simple parser - you might need to adjust based on Gemini's output
    const translatedChapters = [];
    const sections = translatedText.split(/Title: |Content: /).filter(s => s.trim());
    
    for (let i = 0; i < sections.length; i += 2) {
      translatedChapters.push({
        title: sections[i].trim(),
        content: sections[i+1].trim()
      });
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
    const response = await axios.get(jsonUrl);
    const chapters = response.data;
    
    // Process in batches
    const translatedChapters = [];
    for (let i = 0; i < chapters.length; i += chaptersPerRequest) {
      const batch = chapters.slice(i, i + chaptersPerRequest);
      console.log(`Translating chapters ${i+1} to ${Math.min(i+chaptersPerRequest, chapters.length)}...`);
      
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
