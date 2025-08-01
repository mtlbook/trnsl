import { GoogleGenAI } from "@google/genai";
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ai = new GoogleGenAI({});
const TITLE_MODEL = "gemini-2.5-pro"; // More capable model for titles
const CONTENT_MODEL = "gemini-2.5-flash"; // Faster model for content
const FALLBACK_MODEL = "google translate";

const safetySettings = [
  {
    category: "HARM_CATEGORY_HARASSMENT",
    threshold: "BLOCK_NONE",
  },
  {
    category: "HARM_CATEGORY_HATE_SPEECH",
    threshold: "BLOCK_NONE",
  },
  {
    category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
    threshold: "BLOCK_NONE",
  },
  {
    category: "HARM_CATEGORY_DANGEROUS_CONTENT",
    threshold: "BLOCK_NONE",
  },
  {
    category: "HARM_CATEGORY_CIVIC_INTEGRITY",
    threshold: "BLOCK_NONE",
  }
];

async function fetchJson(url) {
  try {
    const response = await axios.get(url);
    return response.data;
  } catch (error) {
    console.error('Error fetching JSON:', error);
    process.exit(1);
  }
}

function parseRange(rangeStr, maxItems) {
  const [startStr, endStr] = rangeStr.split('-');
  let start = parseInt(startStr);
  let end = endStr ? parseInt(endStr) : start;

  if (isNaN(start)) start = 1;
  if (isNaN(end)) end = maxItems;
  if (start < 1) start = 1;
  if (end > maxItems) end = maxItems;
  if (start > end) [start, end] = [end, start];

  return { start, end };
}

async function translateWithModel(content, modelName, isTitle = false) {
  try {
    const systemInstruction = isTitle 
      ? "You are a strict translator for novel/book titles. Preserve the original meaning and style while making it natural in English. Keep character names but translate other elements when it improves readability. Maintain the original tone (mysterious, dramatic, humorous, etc.)."
      : "You are a strict translator. Do not modify the story, characters, or intent. Preserve all names of people, but translate techniques/props/places/organizations when readability benefits. Prioritize natural English flow while keeping the original's tone (humor, sarcasm, etc.). For idioms or culturally specific terms, translate literally if possible; otherwise, adapt with a footnote. Dialogue must match the original's bluntness or subtlety, including punctuation.";

    const response = await ai.models.generateContent({
      model: modelName,
      contents: content,
      config: {
        systemInstruction: systemInstruction,
        safetySettings: safetySettings,
      }
    });

    if (response && response.text) {
      return {
        translated: true,
        content: response.text,
        model: modelName
      };
    }
    throw new Error('Empty response from API');
  } catch (error) {
    console.error(`Translation error (${modelName}):`, error.message);
    return {
      translated: false,
      content: content,
      model: FALLBACK_MODEL
    };
  }
}

async function translateTitles(items) {
  console.log("\nTranslating all titles first...");
  const titleResults = [];
  
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    process.stdout.write(`Translating title ${i + 1}/${items.length}: ${item.title}... `);
    
    const result = await translateWithModel(item.title, TITLE_MODEL, true);
    titleResults.push({
      original: item.title,
      translated: result.content,
      success: result.translated
    });
    
    process.stdout.write(result.translated ? "✓\n" : "✗ (using original)\n");
    
    // Add small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  return titleResults;
}

async function main(jsonUrl, rangeStr) {
  try {
    // Fetch and parse the JSON
    const jsonData = await fetchJson(jsonUrl);
    if (!Array.isArray(jsonData)) {
      throw new Error('Invalid JSON format: Expected an array');
    }

    // First translate all titles
    const titleTranslations = await translateTitles(jsonData);
    
    // Parse the range
    const { start, end } = parseRange(rangeStr, jsonData.length);
    console.log(`\nProcessing content for items ${start} to ${end} of ${jsonData.length}`);

    // Create results directory
    const resultsDir = path.join(__dirname, '../results');
    await fs.mkdir(resultsDir, { recursive: true });

    // Extract filename from URL and create output filename with range
    const filename = path.basename(jsonUrl, '.json');
    const outputPath = path.join(resultsDir, `${filename}_translated_${start}_${end}.json`);

    // Process each item in range
    const translatedItems = [];
    let contentSuccessCount = 0;
    let contentFailCount = 0;

    for (let i = start - 1; i < end; i++) {
      const item = jsonData[i];
      const titleResult = titleTranslations[i];
      
      console.log(`\nTranslating item ${i + 1}:`);
      console.log(`Original title: ${item.title}`);
      console.log(`Translated title: ${titleResult.translated}`);
      
      // Translate content
      console.log(`Translating content...`);
      const contentResult = await translateWithModel(item.content, CONTENT_MODEL);
      
      translatedItems.push({
        originalTitle: item.title,
        title: titleResult.translated,
        content: contentResult.content,
        titleTranslated: titleResult.success,
        contentTranslated: contentResult.translated,
        titleModel: titleResult.success ? TITLE_MODEL : FALLBACK_MODEL,
        contentModel: contentResult.model
      });

      if (contentResult.translated) {
        contentSuccessCount++;
      } else {
        contentFailCount++;
      }
    }

    // Save the translated items
    await fs.writeFile(outputPath, JSON.stringify(translatedItems, null, 2));
    console.log(`\nTranslation summary:`);
    console.log(`- Titles translated (${TITLE_MODEL}): ${titleTranslations.filter(t => t.success).length}/${titleTranslations.length}`);
    console.log(`- Content successfully translated (${CONTENT_MODEL}): ${contentSuccessCount}`);
    console.log(`- Content failed to translate (${FALLBACK_MODEL}): ${contentFailCount}`);
    console.log(`Translated results saved to ${outputPath}`);

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

// Get command line arguments
const [jsonUrl, range] = process.argv.slice(2);
if (!jsonUrl || !range) {
  console.error('Usage: node ai_query.js <json_url> <range>');
  process.exit(1);
}

await main(jsonUrl, range);
