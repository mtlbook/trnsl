// Import using dynamic import() since we won't have package.json
async function run() {
  try {
    const { GoogleGenAI } = await import('@google/genai');
    const fs = await import('fs');
    const path = await import('path');
    
    const ai = new GoogleGenAI({});

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: "Explain how AI works in a few words",
    });
    
    const outputDir = path.join(process.cwd(), '../data');
    const outputFile = path.join(outputDir, 'ai_output.txt');
    
    // Ensure data directory exists
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    // Write response to file
    fs.writeFileSync(outputFile, response.text);
    console.log(`Output saved to ${outputFile}`);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

run();
