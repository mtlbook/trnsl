import { GoogleGenAI } from "@google/genai";
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ai = new GoogleGenAI({});

async function main() {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: "Explain how AI works in a few words",
    });
    
    const outputDir = path.join(__dirname, '../data');
    const outputFile = path.join(outputDir, 'ai_output.txt');
    
    // Ensure data directory exists
    await fs.mkdir(outputDir, { recursive: true });
    
    // Write response to file
    await fs.writeFile(outputFile, response.text);
    console.log(`Output saved to ${outputFile}`);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

await main();
