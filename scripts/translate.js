const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- Configuration ---
const CHAPTERS_PER_REQUEST = 5; // How many chapters to translate in a single API call

// --- Environment Variables ---
const jsonUrl = process.env.JSON_URL;
const geminiApiKey = process.env.GEMINI_API_KEY;
const resultFolder = 'result';

// --- Validation ---
if (!jsonUrl || !geminiApiKey) {
  console.error('JSON_URL and GEMINI_API_KEY environment variables are required.');
  process.exit(1);
}

// --- Gemini AI Setup ---
const genAI = new GoogleGenerativeAI(geminiApiKey);
// ** THE FIX IS HERE **
// We add generationConfig to increase the maximum number of tokens the model can output.
const model = genAI.getGenerativeModel({
  model: 'gemini-2.5-flash',
  generationConfig: {
    maxOutputTokens: 40000, // A higher limit to ensure the full JSON response fits.
  },
});

const systemInstruction = `You are a strict translator. Your task is to translate a JSON array of chapter objects. Each object has a 'title' and a 'content' key. Do not modify the story, characters, or intent. Preserve all names of people, but translate techniques/props/places/organizations when readability benefits. Prioritize natural English flow while keeping the original’s tone (humor, sarcasm, etc.). For idioms or culturally specific terms, translate literally if possible; otherwise, adapt with a footnote. Dialogue must match the original’s bluntness or subtlety, including punctuation.

Your response MUST be a valid JSON array with the exact same number of objects as the input. Do not include any other text, explanations, or markdown code fences like \`\`\`json.`;

/**
 * Translates a batch of chapters in a single API call.
 * @param {Array<Object>} chapterBatch An array of chapter objects.
 * @returns {Promise<Array<Object>>} A promise that resolves to an array of translated chapter objects.
 */
async function translateBatch(chapterBatch) {
  if (!chapterBatch || chapterBatch.length === 0) {
    return [];
  }

  const prompt = `Please translate the following JSON data:\n\n${JSON.stringify(chapterBatch, null, 2)}`;
  
  // Set the response mime type to ensure it returns clean JSON
  const result = await model.generateContent([systemInstruction, prompt], { response_mime_type: "application/json" });
  const responseText = result.response.text();

  try {
    return JSON.parse(responseText);
  } catch (error) {
    console.error('Failed to parse JSON response from API for batch.');
    console.error('API Response was:', responseText);
    throw new Error('API did not return valid JSON.');
  }
}

/**
 * Main function to fetch, batch, translate, and save the data.
 */
async function main() {
  try {
    console.log(`Fetching JSON from: ${jsonUrl}`);
    const response = await axios.get(jsonUrl);
    const chapters = response.data;
    const totalChapters = chapters.length;
    console.log(`Found ${totalChapters} chapters to translate.`);

    let translatedChapters = [];
    const totalBatches = Math.ceil(totalChapters / CHAPTERS_PER_REQUEST);

    for (let i = 0; i < totalChapters; i += CHAPTERS_PER_REQUEST) {
      const batch = chapters.slice(i, i + CHAPTERS_PER_REQUEST);
      const currentBatchNumber = (i / CHAPTERS_PER_REQUEST) + 1;

      console.log(`--- Translating Batch ${currentBatchNumber} of ${totalBatches} (chapters ${i + 1} to ${Math.min(i + CHAPTERS_PER_REQUEST, totalChapters)}) ---`);
      
      const translatedBatchResult = await translateBatch(batch);

      if (translatedBatchResult.length !== batch.length) {
         throw new Error(`Mismatch in chapter count for batch ${currentBatchNumber}. Expected ${batch.length}, got ${translatedBatchResult.length}.`);
      }
      
      translatedChapters.push(...translatedBatchResult);
    }

    const urlParts = jsonUrl.split('/');
    const jsonId = urlParts[urlParts.length - 1].replace('.json', '');
    const resultFilePath = path.join(resultFolder, `${jsonId}.json`);

    await fs.writeFile(resultFilePath, JSON.stringify(translatedChapters, null, 2), 'utf-8');
    console.log(`✅ Translation complete. All ${totalChapters} chapters translated. File saved to: ${resultFilePath}`);

  } catch (error) {
    console.error('❌ An error occurred during the translation process:', error.message);
    process.exit(1);
  }
}

main();
