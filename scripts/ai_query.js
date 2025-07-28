import { GoogleGenAI } from "@google/genai";
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ai = new GoogleGenAI({});
const MODEL_NAME = "gemini-2.5-flash-lite";
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

  // Validate range
  if (isNaN(start)) start = 1;
  if (isNaN(end)) end = maxItems;
  if (start < 1) start = 1;
  if (end > maxItems) end = maxItems;
  if (start > end) [start, end] = [end, start];

  return { start, end };
}

async function translateItem(item) {
  try {
    const combinedText = `[TITLE]${item.title}[/TITLE]\n[CONTENT]${item.content}[/CONTENT]`;
    
    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: combinedText,
      config: {
        systemInstruction: `Translate Chinese to English while maintaining:
        1. Preserve numbers and special characters
        2. Keep proper nouns unchanged
        3. Maintain original formatting
        4. Return in format:
           [TITLE]Translation[/TITLE]
           [CONTENT]Translation[/CONTENT]`,
        safetySettings: safetySettings,
      }
    });

    if (response?.text) {
      const titleMatch = response.text.match(/\[TITLE\](.*?)\[\/TITLE\]/s);
      const contentMatch = response.text.match(/\[CONTENT\](.*?)\[\/CONTENT\]/s);
      
      if (titleMatch && contentMatch) {
        return {
          title: titleMatch[1].trim(),
          content: contentMatch[1].trim(),
          translated: true,
          model: MODEL_NAME
        };
      }
      throw new Error('Failed to parse response');
    }
    throw new Error('Empty API response');
  } catch (error) {
    console.error('Translation failed:', error.message);
    return {
      title: item.title,
      content: item.content,
      translated: false,
      model: FALLBACK_MODEL
    };
  }
}

async function main(jsonUrl, rangeStr) {
  try {
    const jsonData = await fetchJson(jsonUrl);
    if (!Array.isArray(jsonData)) throw new Error('Expected JSON array');

    const { start, end } = parseRange(rangeStr, jsonData.length);
    console.log(`Processing items ${start}-${end} of ${jsonData.length}`);

    const resultsDir = path.join(__dirname, '../results');
    await fs.mkdir(resultsDir, { recursive: true });

    const filename = path.basename(jsonUrl, '.json');
    const outputPath = path.join(resultsDir, `${filename}_translated_${start}_${end}.json`);

    const translatedItems = [];
    let successCount = 0;

    for (let i = start - 1; i < end; i++) {
      const item = jsonData[i];
      console.log(`Translating ${i + 1}: ${item.title.substring(0, 30)}...`);
      
      const result = await translateItem(item);
      translatedItems.push(result);
      if (result.translated) successCount++;
    }

    await fs.writeFile(outputPath, JSON.stringify(translatedItems, null, 2));
    console.log(`\nCompleted: ${successCount} successful, ${end - start + 1 - successCount} failed`);
    console.log(`Saved to: ${outputPath}`);

  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

// Execute
const [jsonUrl, range] = process.argv.slice(2);
if (!jsonUrl || !range) {
  console.error('Usage: node ai_query.js <json_url> <range>');
  process.exit(1);
}

await main(jsonUrl, range);
