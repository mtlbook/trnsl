import { GoogleGenAI } from "@google/genai";
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ai = new GoogleGenAI({});
const MODEL_NAME = "gemini-2.5-flash";
const TITLE_MODEL = "gemini-2.5-pro";
const FALLBACK_MODEL = "google_translate";

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

async function translateWithGoogle(text) {
  try {
    const url = new URL('https://translate.googleapis.com/translate_a/single');
    const params = {
      client: 'gtx',
      sl: 'zh-TW',
      tl: 'en',
      dt: 't',
      q: text,
      hl: 'en',
      ie: 'UTF-8',
      oe: 'UTF-8'
    };
    Object.keys(params).forEach(key => url.searchParams.append(key, params[key]));

    const response = await axios.get(url.toString());
    if (response.data && Array.isArray(response.data[0])) {
      return response.data[0].map(item => item[0]).join('');
    }
    return text; // Return original text if translation fails
  } catch (error) {
    console.error('Google Translate fallback error:', error.message);
    return text; // Return original text on error
  }
}

async function translateTitlesBatch(titles) {
  try {
    const response = await ai.models.generateContent({
      model: TITLE_MODEL,
      contents: titles.join('\n'),
      config: {
        systemInstruction: "Translate these novel titles accurately to English, preserving their original meaning and style. Return each translated title on a new line in the same order.",
        safetySettings: safetySettings,
      }
    });

    if (response && response.text) {
      return response.text.split('\n');
    }
    throw new Error('Empty response from API');
  } catch (error) {
    console.error('Batch title translation error:', error.message);
    return null;
  }
}

async function translateTitleSingle(title) {
  try {
    const response = await ai.models.generateContent({
      model: TITLE_MODEL,
      contents: title,
      config: {
        systemInstruction: "Translate this novel title accurately to English, preserving its original meaning and style.",
        safetySettings: safetySettings,
      }
    });

    if (response && response.text) {
      return response.text;
    }
    throw new Error('Empty response from API');
  } catch (error) {
    console.error(`Single title translation error for "${title}":`, error.message);
    console.log(`Falling back to Google Translate for title: "${title}"`);
    return await translateWithGoogle(title);
  }
}

async function translateContent(content) {
  try {
    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: content,
      config: {
        systemInstruction: "You are a strict translator. Do not modify the story, characters, or intent. Preserve all names of people, but translate techniques/props/places/organizations when readability benefits. Prioritize natural English flow while keeping the original's tone (humor, sarcasm, etc.). For idioms or culturally specific terms, translate literally if possible; otherwise, adapt with a footnote. Dialogue must match the original's bluntness or subtlety, including punctuation.",
        safetySettings: safetySettings,
      }
    });

    if (response && response.text) {
      return {
        translated: true,
        content: response.text,
        model: MODEL_NAME
      };
    }
    throw new Error('Empty response from API');
  } catch (error) {
    console.error('Translation error:', error.message);
    console.log("Falling back to Google Translate for content.");
    const translatedContent = await translateWithGoogle(content);
    return {
      translated: translatedContent !== content,
      content: translatedContent,
      model: FALLBACK_MODEL
    };
  }
}

async function main(jsonUrl, rangeStr) {
  try {
    const jsonData = await fetchJson(jsonUrl);
    if (!Array.isArray(jsonData)) {
      throw new Error('Invalid JSON format: Expected an array');
    }

    const { start, end } = parseRange(rangeStr, jsonData.length);
    console.log(`Processing items ${start} to ${end} of ${jsonData.length}`);

    const resultsDir = path.join(__dirname, '../results');
    await fs.mkdir(resultsDir, { recursive: true });

    const filename = path.basename(jsonUrl, '.json');
    const outputPath = path.join(resultsDir, `${filename}_translated_${start}_${end}.json`);

    const itemsInRange = jsonData.slice(start - 1, end);
    const originalTitles = itemsInRange.map(item => item.title);

    console.log("Attempting to translate all titles in one batch...");
    let translatedTitles = await translateTitlesBatch(originalTitles);
    
    if (!translatedTitles || translatedTitles.length !== originalTitles.length) {
      console.log("Batch title translation failed, falling back to smaller batches or individual translation...");
      translatedTitles = [];
      const BATCH_SIZE = 20;
      
      for (let i = 0; i < originalTitles.length; i += BATCH_SIZE) {
        const batch = originalTitles.slice(i, i + BATCH_SIZE);
        console.log(`Translating title batch ${i + 1}-${i + batch.length}`);
        
        const batchResult = await translateTitlesBatch(batch);
        if (batchResult && batchResult.length === batch.length) {
          translatedTitles.push(...batchResult);
        } else {
          console.log("Batch failed, translating titles individually...");
          for (const title of batch) {
            const translated = await translateTitleSingle(title);
            translatedTitles.push(translated);
          }
        }
      }
    }

    const itemsWithTranslatedTitles = itemsInRange.map((item, index) => ({
      title: translatedTitles[index] || item.title,
      content: item.content
    }));

    const translatedItems = [];
    let successCount = 0;
    let fallbackCount = 0;

    for (const item of itemsWithTranslatedTitles) {
      console.log(`Translating content for: ${item.title}`);
      
      const translationResult = await translateContent(item.content);
      translatedItems.push({
        title: item.title,
        content: translationResult.content,
        translated: translationResult.translated,
        model: translationResult.model
      });

      if (translationResult.model === FALLBACK_MODEL) {
        fallbackCount++;
      } else {
        successCount++;
      }
    }

    await fs.writeFile(outputPath, JSON.stringify(translatedItems, null, 2));
    console.log(`\nTranslation summary:`);
    console.log(`- Successfully translated (${MODEL_NAME}): ${successCount}`);
    console.log(`- Translated with fallback (${FALLBACK_MODEL}): ${fallbackCount}`);
    console.log(`Translated results saved to ${outputPath}`);

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

const [jsonUrl, range] = process.argv.slice(2);
if (!jsonUrl || !range) {
  console.error('Usage: node ai_query.js <json_url> <range>');
  process.exit(1);
}

await main(jsonUrl, range);
