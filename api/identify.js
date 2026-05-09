export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { image, mimeType = 'image/jpeg' } = req.body;
  const geminiApiKey = process.env.GEMINI_API_KEY;

  if (!geminiApiKey) {
    return res.status(500).json({ error: 'API Key Missing' });
  }

  try {
    // ─── STAGE 1: OCR PRE-PROCESSOR ───
    let extractedText = '';
    try {
      const ocrKey = process.env.OCR_SPACE_KEY || 'helloworld';
      const form = new URLSearchParams();
      form.append('apikey', ocrKey);
      form.append('base64Image', `data:${mimeType};base64,${image}`);
      form.append('language', 'eng');
      form.append('OCREngine', '2');

      const ocrResponse = await fetch('https://api.ocr.space/parse/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form
      });
      const ocrData = await ocrResponse.json();
      extractedText = ocrData?.ParsedResults?.[0]?.ParsedText || '';
    } catch (e) {
      console.warn('OCR Skip:', e.message);
    }

    // ─── STAGE 2: DUAL-MODEL RESILIENCE ENGINE ───
    const prompt = `You are a Senior Clinical Pharmacist. Identify this medication.
Label context: "${extractedText}"
Provide drug identity, generic name, manufacturer, indication, instructions, warnings, and storage.
Return a structured JSON report.`;

    const generationConfig = {
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema: {
        type: "OBJECT",
        properties: {
          drugName: { type: "STRING" },
          genericName: { type: "STRING" },
          manufacturer: { type: "STRING" },
          indication: { type: "STRING" },
          dosageForm: { type: "STRING" },
          dosageInstructions: { type: "STRING" },
          warnings: { type: "STRING" },
          storage: { type: "STRING" },
          confidenceScore: { type: "NUMBER" },
          confidenceRationale: { type: "STRING" },
          originVerified: { type: "BOOLEAN" }
        },
        required: ["drugName", "confidenceScore", "originVerified"]
      }
    };

    const safetySettings = [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
    ];

    // Attempt 1: Gemini 1.5 Pro (The Expert)
    let visionResult = null;
    try {
      console.log('MedVision: Attempting Expert Analysis (1.5 Pro)...');
      visionResult = await callGemini('gemini-1.5-pro', prompt, image, mimeType, geminiApiKey, generationConfig, safetySettings);
    } catch (err) {
      console.warn('Expert Analysis throttled or unavailable. Falling back to High-Speed Engine...');
      // Attempt 2: Gemini 1.5 Flash (The Sentinel)
      visionResult = await callGemini('gemini-1.5-flash', prompt, image, mimeType, geminiApiKey, generationConfig, safetySettings);
      visionResult.engine = "High-Speed Sentinel";
    }

    visionResult.analysisTimestamp = new Date().toISOString();
    visionResult.ocrEnhanced = extractedText.length > 0;
    visionResult.authentic = visionResult.confidenceScore >= 80 && visionResult.originVerified;

    return res.status(200).json(visionResult);

  } catch (err) {
    console.error('MedVision Critical Failure:', err.message);
    return res.status(500).json({ error: "Intelligence Engine Unavailable", details: err.message });
  }
}

/**
 * Helper to call a specific Gemini model
 */
async function callGemini(modelName, prompt, imageData, mimeType, apiKey, config, safety) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mimeType, data: imageData } }
          ]
        }],
        safetySettings: safety,
        generationConfig: config
      })
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Model ${modelName} failed with ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) throw new Error(`Model ${modelName} returned empty response`);

  const result = JSON.parse(rawText);
  result.engine = modelName === 'gemini-1.5-pro' ? "Elite Clinical Expert" : "High-Speed Sentinel";
  return result;
}
