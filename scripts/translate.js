const { GoogleGenerativeAI } = require("@google/generative-ai");
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const CHAPTERS_PER_REQUEST = 3;

const systemInstruction = "You are a strict translator. Do not modify the story, characters, or intent. Preserve all names of people, but translate techniques/props/places/organizations when readability benefits. Prioritize natural English flow while keeping the original’s tone (humor, sarcasm, etc.). For idioms or culturally specific terms, translate literally if possible; otherwise, adapt with a footnote. Dialogue must match the original’s bluntness or subtlety, including punctuation.";

async function translateContent(apiKey, chapters) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const prompt = chapters.map(chapter => `Title: ${chapter.title}\nContent:\n${chapter.content}`).join('\n\n---\n\n');

  try {
    const result = await model.generateContentStream([systemInstruction, prompt]);
    let translatedText = '';
    for await (const chunk of result.stream) {
      translatedText += chunk.text();
    }
    return translatedText.split('\n\n---\n\n').map(part => {
      const titleMatch = part.match(/Title: (.*)/);
      const contentMatch = part.replace(/Title: .*\nContent:\n/, '');
      return {
        title: titleMatch ? titleMatch[1] : '',
        content: contentMatch.trim()
      };
    });
  } catch (error) {
    console.error("Error during translation:", error);
    return chapters.map(() => ({ title: 'Translation Failed', content: '' }));
  }
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEY environment variable not set.");
    process.exit(1);
  }
  
  const args = process.argv.slice(2);
  const jsonUrlIndex = args.indexOf('--json-url');
  let jsonUrl;

  if (jsonUrlIndex > -1 && args[jsonUrlIndex + 1]) {
    jsonUrl = args[jsonUrlIndex + 1];
  } else {
    console.error("Usage: node script/translate.js --json-url <URL>");
    process.exit(1);
  }

  try {
    console.log(`Fetching JSON from: ${jsonUrl}`);
    const response = await fetch(jsonUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch JSON: ${response.statusText}`);
    }
    const chapters = await response.json();
    console.log(`Found ${chapters.length} chapters to translate.`);

    const translatedChapters = [];
    for (let i = 0; i < chapters.length; i += CHAPTERS_PER_REQUEST) {
      const batch = chapters.slice(i, i + CHAPTERS_PER_REQUEST);
      console.log(`Translating chapters ${i + 1} to ${i + batch.length}...`);
      const translatedBatch = await translateContent(apiKey, batch);
      translatedChapters.push(...translatedBatch);
    }

    const fileId = path.basename(new URL(jsonUrl).pathname, '.json');
    // Save the output to the 'data' folder instead of 'result'
    const outputFolderPath = path.join(process.cwd(), 'data');
    const outputFilePath = path.join(outputFolderPath, `${fileId}.json`);

    fs.writeFileSync(outputFilePath, JSON.stringify(translatedChapters, null, 2), 'utf-8');
    console.log(`Translation complete. Translated file saved to: ${outputFilePath}`);

  } catch (error) {
    console.error("An error occurred:", error.message);
    process.exit(1);
  }
}

main();
