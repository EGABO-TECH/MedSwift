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
    // ─── STAGE 1: OCR PRE-PROCESSOR (OCR.space) ───
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

    // ─── STAGE 2: ELITE CLINICAL REASONING (Gemini 1.5 Pro) ───
    const prompt = `You are a Senior Clinical Pharmacist and Forensic Drug Identity Expert.
TASK: Perform a high-precision identification of the medication in this image.

METHODOLOGY:
1. Scan for pharmaceutical imprints (e.g., M367, L484), NDC numbers, or GTINs.
2. Analyze the label text provided: "${extractedText}"
3. Cross-reference visual aesthetics (manufacturer logos, bottle shape) with known pharmaceutical databases.
4. Use your search grounding to confirm the latest regulatory status and clinical safety warnings.

Return an institutional-grade JSON report:
{
  "drugName": "Full Brand Name",
  "genericName": "Scientific Generic Name",
  "manufacturer": "Official Manufacturer Name",
  "indication": "Clinical indications and use cases",
  "dosageForm": "e.g., Tablet, Capsule, Liquid",
  "dosageInstructions": "Standard administration guidelines",
  "warnings": "CRITICAL safety warnings and side effects",
  "storage": "Proper storage conditions (temp, light, humidity)",
  "confidenceScore": number (0-100),
  "confidenceRationale": "Brief explanation of how you identified this drug",
  "originVerified": boolean (true if from a globally recognized manufacturer)
}`;

    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: mimeType, data: image } }
            ]
          }],
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
          ],
          tools: [{
            google_search_retrieval: {
              dynamic_retrieval_config: {
                mode: "MODE_DYNAMIC",
                dynamic_threshold: 0.1 // Maximum intelligence grounding
              }
            }
          }],
          generationConfig: {
            temperature: 0.05, // High precision
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
          }
        })
      }
    );

    const geminiData = await geminiResponse.json();
    
    if (geminiData.promptFeedback?.blockReason) {
       return res.status(200).json({
          drugName: "Identification Restricted",
          confidenceScore: 0,
          indication: "The intelligence engine's clinical safety filters restricted this identification. This occurs when the image content is highly ambiguous.",
          originVerified: false,
          authentic: false
       });
    }

    const rawResult = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!rawResult) {
      throw new Error('Intelligence engine returned an empty response.');
    }

    const visionResult = JSON.parse(rawResult);
    visionResult.analysisTimestamp = new Date().toISOString();
    visionResult.ocrEnhanced = extractedText.length > 0;
    visionResult.authentic = visionResult.confidenceScore >= 80 && visionResult.originVerified;

    return res.status(200).json(visionResult);

  } catch (err) {
    console.error('MedVision Intelligence Failure:', err.message);
    return res.status(500).json({ error: "Clinical Engine Unavailable", details: err.message });
  }
}
