const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ... (keep previous constants and setup)

async function extractJsonFromText(text) {
  // First try parsing directly
  try {
    return JSON.parse(text);
  } catch (e) {
    // If failed, try extracting JSON from markdown or other formatting
    const jsonMatch = text.match(/```json\n([\s\S]*?)\n```|(\[\s*{[\s\S]*?}\s*\])/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1] || jsonMatch[2]);
      } catch (e) {
        console.error('Failed to parse extracted JSON:', e.message);
      }
    }
    throw new Error(`Could not extract valid JSON from response: ${text.substring(0, 100)}...`);
  }
}

async function translateChapters(chapters) {
  const prompt = `
  ${systemInstruction}
  
  Translate ONLY the text content of this JSON array from Chinese to English.
  Return JUST the JSON array with identical structure but translated text.
  Do not add any commentary or formatting outside the JSON.

  Input:
  ${JSON.stringify(chapters, null, 2)}
  `;

  try {
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    // Clean response and parse
    const cleanText = text.replace(/^```json|```$/g, '').trim();
    return await extractJsonFromText(cleanText);
    
  } catch (error) {
    console.error('Full error details:', {
      message: error.message,
      responseText: error.response?.text?.substring(0, 200) || 'N/A'
    });
    throw error;
  }
}

async function processJson() {
  try {
    const response = await axios.get(jsonUrl);
    const chapters = response.data;
    
    if (!Array.isArray(chapters)) {
      throw new Error('Expected JSON array');
    }

    const translatedChapters = [];
    let currentBatchSize = chaptersPerRequest;
    let i = 0;

    while (i < chapters.length) {
      const batch = chapters.slice(i, i + currentBatchSize);
      console.log(`Translating ${i + 1}-${Math.min(i + currentBatchSize, chapters.length)}/${chapters.length}`);
      
      try {
        const translated = await translateChapters(batch);
        translatedChapters.push(...translated);
        i += currentBatchSize;
        
        // Reset batch size if it was reduced
        currentBatchSize = chaptersPerRequest;
        
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        if (currentBatchSize > 1) {
          // Reduce batch size and retry
          currentBatchSize = Math.max(1, Math.floor(currentBatchSize / 2));
          console.log(`Reducing batch size to ${currentBatchSize} due to error`);
        } else {
          throw error;
        }
      }
    }

    const outputPath = path.join(resultsDir, `${fileId}.json`);
    fs.writeFileSync(outputPath, JSON.stringify(translatedChapters, null, 2));
    console.log(`Successfully saved ${translatedChapters.length} chapters to ${outputPath}`);
    
  } catch (error) {
    console.error('Fatal processing error:', error.message);
    process.exit(1);
  }
}

processJson();
