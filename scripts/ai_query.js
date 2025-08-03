import { GoogleGenAI } from "@google/genai";
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { Semaphore } from '../concurrency.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ai = new GoogleGenAI({});
const MODEL_NAME = "gemini-2.5-flash-lite";
const TITLE_MODEL = "gemini-2.5-flash-lite";
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
    console.error('Single title translation error:', error.message);
    return title;
  }
}

async function googleTranslateTitle(title) {
  const params = new URLSearchParams({
    client: 'gtx',
    sl: 'zh-CN',
    tl: 'en',
    dt: 't',
    q: title,
  });

  try {
    const { data } = await axios.get(
      'https://translate.googleapis.com/translate_a/single',
      { params, timeout: 10_000, headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    return data[0].map(seg => seg[0]).join('');
  } catch (err) {
    console.warn('Google title fallback failed:', err.message);
    return translateTitleSingle(title);
  }
}

async function translateContent(content, model = MODEL_NAME) {
  // 1️⃣ Try the requested model first
  try {
        console.log(`[translate] using model: ${model}`);
    const response = await ai.models.generateContent({
      model,
      contents: content,
      config: {
        systemInstruction:
          "You are a strict translator. Do not modify the story, characters, or intent. Preserve all names of people, but translate techniques/props/places/organizations when readability benefits. Prioritize natural English flow while keeping the original's tone (humor, sarcasm, etc.). For idioms or culturally specific terms, translate literally if possible; otherwise, adapt with a footnote. Dialogue must match the original's bluntness or subtlety, including punctuation.",
        safetySettings: safetySettings,
      },
    });

    if (response?.text) {
      return { translated: true, content: response.text, model };
    }
    throw new Error('Empty response');
  } catch (err) {
    // 2️⃣ If we hit quota on the primary model, retry once with flash
    if (
      (err?.status === 429 || err?.message?.toLowerCase().includes('quota')) &&
      model === MODEL_NAME && MODEL_NAME !== 'gemini-2.5-flash'
    ) {
      console.warn('Quota hit on content → retrying with gemini-2.5-flash');
      return translateContent(content, 'gemini-2.5-flash');
    }

    // 3️⃣ Internal 5xx → single retry on the same model
    if (err?.message?.toLowerCase().includes('internal') || err?.status >= 500) {
      console.warn(`${model} internal error, retrying once…`);
      try {
        const retry = await ai.models.generateContent({
          model,
          contents: content,
          config: {
 systemInstruction:
          "You are a strict translator. Do not modify the story, characters, or intent. Preserve all names of people, but translate techniques/props/places/organizations when readability benefits. Prioritize natural English flow while keeping the original's tone (humor, sarcasm, etc.). For idioms or culturally specific terms, translate literally if possible; otherwise, adapt with a footnote. Dialogue must match the original's bluntness or subtlety, including punctuation.",
        safetySettings: safetySettings,
          },
        });
        if (retry?.text) {
          return { translated: true, content: retry.text, model };
        }
      } catch (_) {
      }
    }

    // 4️⃣ All else → Google Translate fallback with chunking & retries
    console.warn(`${model} failed → falling back to Google: ${err.message}`);

    const MAX_RETRIES = 3;
    let attempt = 0;
    let lastError;

    while (attempt < MAX_RETRIES) {
      try {
        const CHUNK_SIZE = 1000;
        const reSentence = /[.!?！？。]+/g;
        const sentences = content.split(reSentence);
        const chunks = [];
        let buf = '';
        for (const s of sentences) {
          const next = buf + s;
          if (next.length > CHUNK_SIZE && buf) {
            chunks.push(buf.trim());
            buf = s;
          } else {
            buf = next;
          }
        }
        if (buf.trim()) chunks.push(buf.trim());

        let translated = '';
        for (const chunk of chunks) {
          const params = new URLSearchParams({
            client: 'gtx',
            sl: 'zh-CN',
            tl: 'en',
            hl: 'en',
            ie: 'UTF-8',
            oe: 'UTF-8',
            dt: 't',
            q: chunk,
          });

          const { data } = await axios.get(
            'https://translate.googleapis.com/translate_a/single',
            { params, timeout: 10_000, headers: { 'User-Agent': 'Mozilla/5.0' } }
          );
          translated += data[0].map(seg => seg[0]).join('');
        }

        return { translated: true, content: translated, model: 'google translate' };
      } catch (axiosErr) {
        lastError = axiosErr;
        attempt++;
        console.warn(
          `Google fallback attempt ${attempt}/${MAX_RETRIES} failed: ${axiosErr.message}`
        );
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 500 * attempt));
        }
      }
    }

    console.error('Google fallback failed after all retries:', lastError.message);
    return { translated: false, content, model: 'google translate' };
  }
}

async function main(jsonUrl, rangeStr) {
  try {
    const jsonData = await fetchJson(jsonUrl);
    if (!Array.isArray(jsonData)) {
      throw new Error('Invalid JSON format: Expected an array');
    }

async function translateContentParallel(items) {
  const DELAY = 4_000;               // 4_000 - 4 s between starts, 12_000 - 5s
  const promises = items.map((item, idx) =>
    new Promise(resolve => {
      setTimeout(async () => {
        console.log(`[${idx + 1}/${items.length}] Translating: ${item.title}`);
        const res = await translateContent(item.content);
        resolve({
          title:   item.title,
          content: res.content,
          model:   res.model,
          ok:      res.translated,
        });
      }, idx * DELAY);
    })
  );

  const results = await Promise.all(promises);

  const successCount = results.filter(r => r.ok).length;
  const failCount    = results.length - successCount;

  return {
    translatedItems: results.map(({ ok, ...rest }) => rest),
    successCount,
    failCount,
  };
}
    
    const { start, end } = parseRange(rangeStr, jsonData.length);
    console.log(`Processing items ${start} to ${end} of ${jsonData.length}`);

    const resultsDir = path.join(__dirname, '../results');
    await fs.mkdir(resultsDir, { recursive: true });

    const filename = path.basename(jsonUrl, '.json');
    const outputPath = path.join(resultsDir, `${filename}_translated_${start}_${end}.json`);

    // Extract items in range
    const itemsInRange = jsonData.slice(start - 1, end);
    const originalTitles = itemsInRange.map(item => item.title);

    // Try to translate all titles at once first
    console.log("Attempting to translate all titles in one batch...");
    let translatedTitles = await translateTitlesBatch(originalTitles);
    
if (!translatedTitles || translatedTitles.length !== originalTitles.length) {
  console.log('Batch translation failed, retrying with small Gemini batches…');

  const BATCH_SIZE = 20; 
  translatedTitles = [];

  for (let i = 0; i < originalTitles.length; i += BATCH_SIZE) {
    const slice = originalTitles.slice(i, i + BATCH_SIZE);

    // helper: translate one slice with Gemini
    async function translateSlice(titles) {
      const res = await translateTitlesBatch(titles);
      if (res && res.length === titles.length) return res;

      // slice failed → fall back to individual Google calls
      const singlePromises = titles.map(t => googleTranslateTitle(t));
      return Promise.all(singlePromises);
    }

    const batch = await translateSlice(slice);
    translatedTitles.push(...batch);

    if (i + BATCH_SIZE < originalTitles.length) {
      await new Promise(r => setTimeout(r, 1_000));
    }
  }
}

    // Prepare items with translated titles
    const itemsWithTranslatedTitles = itemsInRange.map((item, index) => ({
      title: translatedTitles[index] || item.title, 
      content: item.content
    }));

    // Translate content
     const { translatedItems, successCount, failCount } =
      await translateContentParallel(itemsWithTranslatedTitles);

    await fs.writeFile(outputPath, JSON.stringify(translatedItems, null, 2));
    console.log(`\nTranslation summary:`);
    console.log(`- Successfully translated (${MODEL_NAME}): ${successCount}`);
    console.log(`- Failed to translate (${FALLBACK_MODEL}): ${failCount}`);
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
