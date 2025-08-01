import { GoogleGenAI } from "@google/genai";
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ai = new GoogleGenAI({});
const TITLE_MODEL = "gemini-2.5-pro";
const CONTENT_MODEL = "gemini-2.5-flash";
const FALLBACK_CONTENT_MODEL = "gemini-2.5-flash-lite";
const FALLBACK_MODEL = "google translate";
const BATCH_SIZE = 20;
const DELAY_BETWEEN_REQUESTS = 200; // ms

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

async function translateTitleBatch(titles, modelName) {
  try {
    const joinedTitles = titles.map((t, i) => `Title ${i + 1}: ${t}`).join('\n');
    const prompt = `Translate these novel titles to English while preserving their original meaning and style. Keep character names but translate other elements when it improves readability. Maintain the original tone. Return only the translated titles in the same order, one per line.\n\n${joinedTitles}`;

    const response = await ai.models.generateContent({
      model: modelName,
      contents: prompt,
      config: {
        safetySettings: safetySettings,
        temperature: 0.3
      }
    });

    if (response && response.text) {
      const translatedTitles = response.text.split('\n')
        .map(line => line.replace(/^Title \d+: /, '').trim())
        .filter(Boolean);
      
      if (translatedTitles.length === titles.length) {
        return translatedTitles.map((translated, i) => ({
          original: titles[i],
          translated,
          success: true,
          model: modelName,
          batch: true
        }));
      }
    }
    throw new Error('Batch translation format mismatch');
  } catch (error) {
    console.error('Batch translation error:', error.message);
    return null;
  }
}

async function translateTitlesIndividually(titles, startIndex = 0) {
  const results = [];
  
  for (let i = 0; i < titles.length; i++) {
    const index = startIndex + i;
    process.stdout.write(`Translating title ${index + 1} individually... `);
    
    try {
      const response = await ai.models.generateContent({
        model: TITLE_MODEL,
        contents: `Translate this novel title to English while preserving its original meaning and style: "${titles[i]}"`,
        config: {
          systemInstruction: "You are a professional literary translator. Translate the title while maintaining its original tone and meaning. Keep proper names but translate other elements when it improves readability.",
          safetySettings: safetySettings,
          temperature: 0.3
        }
      });

      if (response && response.text) {
        results.push({
          original: titles[i],
          translated: response.text,
          success: true,
          model: TITLE_MODEL,
          batch: false
        });
        process.stdout.write("✓\n");
      } else {
        throw new Error('Empty response');
      }
    } catch (error) {
      console.error(`Error translating title ${index + 1}:`, error.message);
      results.push({
        original: titles[i],
        translated: titles[i],
        success: false,
        model: FALLBACK_MODEL,
        batch: false
      });
      process.stdout.write("✗\n");
    }
    
    await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_REQUESTS));
  }
  
  return results;
}

async function translateTitles(items) {
  console.log("\nStarting title translation...");
  const allTitles = items.map(item => item.title);
  let titleResults = [];
  
  // Try full batch first
  console.log("Attempting full batch translation...");
  const fullBatchResult = await translateTitleBatch(allTitles, TITLE_MODEL);
  
  if (fullBatchResult) {
    console.log("Full batch translation successful!");
    return fullBatchResult;
  }
  
  // Fallback to smaller batches
  console.log(`Falling back to ${BATCH_SIZE}-title batches...`);
  for (let i = 0; i < allTitles.length; i += BATCH_SIZE) {
    const batch = allTitles.slice(i, i + BATCH_SIZE);
    const batchResult = await translateTitleBatch(batch, TITLE_MODEL);
    
    if (batchResult) {
      titleResults.push(...batchResult);
      console.log(`Batch ${i / BATCH_SIZE + 1} successful (titles ${i + 1}-${Math.min(i + BATCH_SIZE, allTitles.length)})`);
    } else {
      console.log(`Batch ${i / BATCH_SIZE + 1} failed, translating individually...`);
      const individualResults = await translateTitlesIndividually(batch, i);
      titleResults.push(...individualResults);
    }
  }
  
  return titleResults;
}

function splitIntoSentences(text) {
  // Enhanced sentence splitting that handles Chinese punctuation
  return text.split(/(?<=[。！？；\n])+/g)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

async function translateContentByPhrases(content) {
  const phrases = splitIntoSentences(content);
  let translatedPhrases = [];
  let failedPhrases = 0;

  for (const [index, phrase] of phrases.entries()) {
    try {
      // First try with primary content model
      const response = await ai.models.generateContent({
        model: CONTENT_MODEL,
        contents: phrase,
        config: {
          systemInstruction: "Translate this text exactly without modification. Preserve names and special terms.",
          safetySettings: safetySettings,
          temperature: 0.3
        }
      });

      if (response && response.text) {
        translatedPhrases.push(response.text);
        continue;
      }
      throw new Error('Empty phrase response');
    } catch (error) {
      console.error(`Phrase ${index + 1}/${phrases.length} failed (${CONTENT_MODEL}), trying fallback model...`);
      
      // Fallback to lighter model
      try {
        const lightResponse = await ai.models.generateContent({
          model: FALLBACK_CONTENT_MODEL,
          contents: phrase,
          config: {
            safetySettings: safetySettings,
            temperature: 0.2
          }
        });

        if (lightResponse && lightResponse.text) {
          translatedPhrases.push(lightResponse.text);
        } else {
          throw new Error('Empty light model response');
        }
      } catch (lightError) {
        console.error(`Phrase ${index + 1}/${phrases.length} completely failed, keeping original`);
        translatedPhrases.push(`【保留原文】${phrase}`);
        failedPhrases++;
      }
    }

    await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_REQUESTS));
  }

  return {
    translated: failedPhrases < phrases.length / 2,
    content: translatedPhrases.join(' '),
    model: `${CONTENT_MODEL} + ${FALLBACK_CONTENT_MODEL}`,
    method: 'phrases',
    successRate: ((phrases.length - failedPhrases) / phrases.length * 100).toFixed(1) + '%',
    failedPhrases
  };
}

async function translateContent(content) {
  // First try full content translation
  try {
    const response = await ai.models.generateContent({
      model: CONTENT_MODEL,
      contents: content,
      config: {
        systemInstruction: "You are a strict translator. Do not modify the story, characters, or intent. Preserve all names of people, but translate techniques/props/places/organizations when readability benefits. Prioritize natural English flow while keeping the original's tone (humor, sarcasm, etc.). For idioms or culturally specific terms, translate literally if possible; otherwise, adapt with a footnote. Dialogue must match the original's bluntness or subtlety, including punctuation.",
        safetySettings: safetySettings,
        temperature: 0.5
      }
    });

    if (response && response.text) {
      return {
        translated: true,
        content: response.text,
        model: CONTENT_MODEL,
        method: 'full'
      };
    }
    throw new Error('Empty response from API');
  } catch (error) {
    console.error('Full content translation failed, trying phrase-by-phrase...');
    return await translateContentByPhrases(content);
  }
}

async function main(jsonUrl, rangeStr) {
  try {
    const jsonData = await fetchJson(jsonUrl);
    if (!Array.isArray(jsonData)) {
      throw new Error('Invalid JSON format: Expected an array');
    }

    // Parse the range FIRST
    const { start, end } = parseRange(rangeStr, jsonData.length);
    console.log(`Processing items ${start} to ${end} of ${jsonData.length}`);

    // Extract ONLY the items in range
    const itemsInRange = jsonData.slice(start - 1, end);

    // Translate ONLY the titles in range
    console.log(`Translating ${itemsInRange.length} titles...`);
    const titleTranslations = await translateTitles(itemsInRange);
    
    // Create results directory
    const resultsDir = path.join(__dirname, '../results');
    await fs.mkdir(resultsDir, { recursive: true });

    const filename = path.basename(jsonUrl, '.json');
    const outputPath = path.join(resultsDir, `${filename}_translated_${start}_${end}.json`);

    const translatedItems = [];
    let contentSuccessCount = 0;
    let contentFailCount = 0;

    for (let i = 0; i < itemsInRange.length; i++) {
      const item = itemsInRange[i];
      const titleResult = titleTranslations[i];
      
      console.log(`\n[Item ${start + i}]`);
      console.log(`Original Title: ${item.title}`);
      console.log(`Translated Title: ${titleResult.translated}`);
      
      console.log(`Translating content...`);
      const contentResult = await translateContent(item.content);
      
      translatedItems.push({
        originalTitle: item.title,
        title: titleResult.translated,
        content: contentResult.content,
        metadata: {
          titleTranslated: titleResult.success,
          titleModel: titleResult.model,
          titleBatch: titleResult.batch,
          contentTranslated: contentResult.translated,
          contentMethod: contentResult.method,
          contentModels: contentResult.model,
          contentSuccessRate: contentResult.successRate,
          contentFailedPhrases: contentResult.failedPhrases || 0
        }
      });

      if (contentResult.translated) {
        contentSuccessCount++;
      } else {
        contentFailCount++;
      }

      // Progress update
      const progress = ((i + 1) / itemsInRange.length * 100).toFixed(1);
      console.log(`Progress: ${progress}% (${i + 1}/${itemsInRange.length})`);
    }

    await fs.writeFile(outputPath, JSON.stringify(translatedItems, null, 2));
    
    const titleSuccessCount = titleTranslations.filter(t => t.success).length;
    const batchTitleCount = titleTranslations.filter(t => t.batch).length;
    
    console.log(`\n=== Translation Summary ===`);
    console.log(`Titles (${start}-${end}):`);
    console.log(`- Successfully translated: ${titleSuccessCount}/${itemsInRange.length}`);
    console.log(`  - Batch translated: ${batchTitleCount}`);
    console.log(`  - Individually translated: ${titleSuccessCount - batchTitleCount}`);
    console.log(`Content (${start}-${end}):`);
    console.log(`- Successfully translated: ${contentSuccessCount}`);
    console.log(`- Partially translated: ${contentFailCount}`);
    console.log(`- Average phrase success rate: ${translatedItems.reduce((sum, item) => {
      const rate = parseFloat(item.metadata.contentSuccessRate) || 0;
      return sum + rate;
    }, 0) / translatedItems.length}%`);
    console.log(`\nResults saved to: ${outputPath}`);

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

// Command line execution
const [jsonUrl, range] = process.argv.slice(2);
if (!jsonUrl || !range) {
  console.error('Usage: node ai_translator.js <json_url> <range>');
  console.error('Example: node ai_translator.js https://example.com/novel.json 1-200');
  process.exit(1);
}

await main(jsonUrl, range);
