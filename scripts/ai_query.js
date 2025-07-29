import { GoogleGenAI } from "@google/genai";
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ai = new GoogleGenAI({});
const MODEL_PRIORITY_LIST = [
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-2.5-flash-lite"
];
const FALLBACK_MODEL = "original content";

let currentModelIndex = 0;

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

async function translateWithModel(content, modelName) {
  try {
    const response = await ai.models.generateContent({
      model: modelName,
      contents: content,
      config: {
        systemInstruction: "You are a strict translator. Do not modify the story, characters, or intent. Preserve all names of people, but translate techniques/props/places/organizations when readability benefits. Prioritize natural English flow while keeping the original's tone (humor, sarcasm, etc.). For idioms or culturally specific terms, translate literally if possible; otherwise, adapt with a footnote. Dialogue must match the original's bluntness or subtlety, including punctuation.",
        safetySettings: safetySettings,
      }
    });

    if (response && response.text) {
      return {
        success: true,
        content: response.text,
        model: modelName
      };
    }
    throw new Error('Empty response from API');
  } catch (error) {
    return {
      success: false,
      error: error,
      model: modelName
    };
  }
}

function isProhibitedContentError(error) {
  return error?.error?.message?.toLowerCase().includes("prohibited") || 
         error?.error?.message?.toLowerCase().includes("safety");
}

async function translateContent(content) {
  // Try with current model first
  let result = await translateWithModel(content, MODEL_PRIORITY_LIST[currentModelIndex]);
  
  // Check if error is quota-related (429)
  if (!result.success && result.error?.error?.code === 429) {
    console.log(`Quota exceeded for ${MODEL_PRIORITY_LIST[currentModelIndex]}, trying next model...`);
    
    // Try next models in priority list
    for (let i = currentModelIndex + 1; i < MODEL_PRIORITY_LIST.length; i++) {
      result = await translateWithModel(content, MODEL_PRIORITY_LIST[i]);
      if (result.success) {
        currentModelIndex = i; // Switch to this working model
        return {
          translated: true,
          content: result.content,
          model: result.model
        };
      }
      // Stop if error is not quota-related
      if (result.error?.error?.code !== 429) break;
    }
  }

  // Handle prohibited content (don't retry with other models)
  if (!result.success && isProhibitedContentError(result.error)) {
    console.log(`Prohibited content detected, keeping original content`);
    return {
      translated: false,
      content: content,
      model: FALLBACK_MODEL,
      error: "prohibited content"
    };
  }

  // If successful with any model
  if (result.success) {
    return {
      translated: true,
      content: result.content,
      model: result.model
    };
  }

  // If all models failed (except for prohibited content)
  console.error(`Translation failed for content. Error: ${result.error?.message}`);
  return {
    translated: false,
    content: content,
    model: FALLBACK_MODEL,
    error: result.error?.message
  };
}

async function main(jsonUrl, rangeStr) {
  try {
    // Fetch and parse the JSON
    const jsonData = await fetchJson(jsonUrl);
    if (!Array.isArray(jsonData)) {
      throw new Error('Invalid JSON format: Expected an array');
    }

    // Parse the range
    const { start, end } = parseRange(rangeStr, jsonData.length);
    console.log(`Processing items ${start} to ${end} of ${jsonData.length}`);

    // Create results directory
    const resultsDir = path.join(__dirname, '../results');
    await fs.mkdir(resultsDir, { recursive: true });

    // Extract filename from URL and create output filename with range
    const filename = path.basename(jsonUrl, '.json');
    const outputPath = path.join(resultsDir, `${filename}_translated_${start}_${end}.json`);

    // Process each item in range
    const translatedItems = [];
    let successCount = 0;
    let failCount = 0;
    let prohibitedCount = 0;
    let usedModels = {};

    for (let i = start - 1; i < end; i++) {
      const item = jsonData[i];
      console.log(`Translating item ${i + 1}: ${item.title}`);
      
      const translationResult = await translateContent(item.content);
      translatedItems.push({
        title: item.title,
        content: translationResult.content,
        translated: translationResult.translated,
        model: translationResult.model,
        ...(translationResult.error && { error: translationResult.error })
      });

      // Track model usage and error types
      usedModels[translationResult.model] = (usedModels[translationResult.model] || 0) + 1;
      
      if (translationResult.translated) {
        successCount++;
      } else {
        failCount++;
        if (translationResult.error === "prohibited content") {
          prohibitedCount++;
        }
      }

      // Small delay between requests
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Save results and show summary
    await fs.writeFile(outputPath, JSON.stringify(translatedItems, null, 2));
    
    console.log(`\nTranslation summary:`);
    console.log(`- Successfully translated: ${successCount}`);
    console.log(`- Failed due to prohibited content: ${prohibitedCount}`);
    console.log(`- Failed for other reasons: ${failCount - prohibitedCount}`);
    console.log(`Models used:`);
    Object.entries(usedModels).forEach(([model, count]) => {
      console.log(`  - ${model}: ${count} items`);
    });
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
