const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

// Get arguments
const jsonUrl = process.argv[2];
const chaptersPerRequest = 1; // Process one at a time for reliability

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
    text: `You are a professional Chinese-to-English translator. Follow these rules:
1. Translate ONLY the content text (do not modify or translate the title)
2. Preserve all names and proper nouns
3. Keep original tone and style
4. Maintain all formatting (paragraphs, line breaks, etc.)
5. Return ONLY the translated text with no additional commentary`
  }]
};

async function translateContent(content, retries = 3) {
  try {
    const prompt = `Translate the following Chinese text to English exactly as it is.
Maintain all formatting and special characters.
Do not add any notes or commentary.

Text to translate:
${content}

Translated text:`;
    
    const result = await model.generateContent({
      contents: [
        { role: "user", parts: [{ text: prompt }] },
        systemInstruction
      ]
    });
    
    const response = await result.response;
    return response.text();
  } catch (error) {
    if (retries > 0) {
      console.log(`Retrying... (${retries} attempts remaining)`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      return translateContent(content, retries - 1);
    }
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
    
    // Process chapters
    const translatedChapters = [];
    for (let i = 0; i < chapters.length; i++) {
      console.log(`Translating chapter ${i+1}/${chapters.length}: ${chapters[i].title}`);
      
      try {
        const translatedContent = await translateContent(chapters[i].content);
        translatedChapters.push({
          title: chapters[i].title, // Keep original title
          content: translatedContent.trim()
        });
        
        // Save progress after each chapter
        const resultsDir = path.join(__dirname, '../results');
        if (!fs.existsSync(resultsDir)) {
          fs.mkdirSync(resultsDir);
        }
        const tempPath = path.join(resultsDir, `${id}_temp.json`);
        fs.writeFileSync(tempPath, JSON.stringify(translatedChapters, null, 2));
        
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 1500));
      } catch (error) {
        console.error(`Failed to translate chapter ${i+1}:`, error);
        // Save partial results
        translatedChapters.push({
          title: chapters[i].title,
          content: "[TRANSLATION FAILED] " + chapters[i].content
        });
      }
    }
    
    // Save final results
    const resultsDir = path.join(__dirname, '../results');
    const outputPath = path.join(resultsDir, `${id}.json`);
    fs.writeFileSync(outputPath, JSON.stringify(translatedChapters, null, 2));
    console.log(`Translation completed and saved to ${outputPath}`);
    
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();
