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

    // ─── STAGE 2: UNFETTERED AI REASONING ───
    // We use v1beta for access to safety control and search tools.
    const prompt = `Identify the medication in this image. 
Context from label: "${extractedText}"
You are a pharmaceutical verification tool. Provide factual identification. 
If unsure, use your search tool to verify the manufacturer and generic name.

Return ONLY a JSON object:
{
  "drugName": "string",
  "genericName": "string",
  "manufacturer": "string",
  "indication": "string",
  "dosageForm": "string",
  "dosageInstructions": "string",
  "warnings": "string",
  "expiryPattern": "string",
  "confidenceScore": number (0-100),
  "originVerified": boolean
}`;

    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey}`,
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
          // ─── DISABLE SAFETY FILTERS ───
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
          ],
          // ─── ENABLE GOOGLE SEARCH GROUNDING ───
          tools: [{
            google_search_retrieval: {
              dynamic_retrieval_config: {
                mode: "MODE_DYNAMIC",
                dynamic_threshold: 0.1
              }
            }
          }],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: 'application/json'
          }
        })
      }
    );

    const geminiData = await geminiResponse.json();
    
    // Check if Gemini blocked the response despite our settings
    if (geminiData.promptFeedback?.blockReason) {
      throw new Error(`Gemini Safety Block: ${geminiData.promptFeedback.blockReason}`);
    }

    let rawResult = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
    
    // ─── FALLSAFE PARSING ───
    if (!rawResult) {
      // If candidates are empty but no block reason, the model might have returned an empty part.
      return res.status(200).json({
        drugName: "Unidentified",
        confidenceScore: 0,
        authentic: false,
        error: "Vision engine could not process this specific image content."
      });
    }

    const visionResult = JSON.parse(rawResult);
    visionResult.analysisTimestamp = new Date().toISOString();
    visionResult.ocrEnhanced = extractedText.length > 0;

    return res.status(200).json(visionResult);

  } catch (err) {
    console.error('MedVision Critical Failure:', err.message);
    return res.status(500).json({ 
      error: "MedVision Intelligence Failure",
      details: err.message,
      authentic: false 
    });
  }
}
