// scripts/translate.js
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const jsonUrl = process.env.JSON_URL;
const geminiApiKey = process.env.GEMINI_API_KEY;
const resultFolder = 'result';

if (!jsonUrl || !geminiApiKey) {
  console.error('JSON_URL and GEMINI_API_KEY environment variables are required.');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(geminiApiKey);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

const systemInstruction = `You are a strict translator. Do not modify the story, characters, or intent. Preserve all names of people, but translate techniques/props/places/organizations when readability benefits. Prioritize natural English flow while keeping the original’s tone (humor, sarcasm, etc.). For idioms or culturally specific terms, translate literally if possible; otherwise, adapt with a footnote. Dialogue must match the original’s bluntness or subtlety, including punctuation.`;

async function translateContent(text) {
  const result = await model.generateContentStream([systemInstruction, text]);
  let translatedText = '';
  for await (const chunk of result.stream) {
    translatedText += chunk.text();
  }
  return translatedText;
}

async function main() {
  try {
    console.log(`Fetching JSON from: ${jsonUrl}`);
    const response = await axios.get(jsonUrl);
    const chapters = response.data;
    console.log(`Found ${chapters.length} chapters to translate.`);

    const translatedChapters = [];
    for (const chapter of chapters) {
      console.log(`Translating chapter: ${chapter.title}`);
      const translatedContent = await translateContent(chapter.content);
      translatedChapters.push({
        title: chapter.title, // Assuming title does not need translation, or you can translate it as well
        content: translatedContent,
      });
    }

    const urlParts = jsonUrl.split('/');
    const jsonId = urlParts[urlParts.length - 1].replace('.json', '');
    const resultFilePath = path.join(resultFolder, `${jsonId}.json`);

    await fs.writeFile(resultFilePath, JSON.stringify(translatedChapters, null, 2));
    console.log(`Translation complete. Translated file saved to: ${resultFilePath}`);

  } catch (error) {
    console.error('An error occurred during the translation process:', error);
    process.exit(1);
  }
}

main();
