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

    // ─── STAGE 2: ADVANCED PHARMA REASONING ───
    const prompt = `You are a professional pharmaceutical identification tool. 
Task: Identify the medication in this image (it may be a bottle, a box, or loose pills).
Context from OCR: "${extractedText}"

If loose pills are shown: Identify them by color, shape, and any imprints (e.g., "M367", "WATSON"). 
If you are uncertain: Provide your best professional identification based on visual characteristics. 
CRITICAL: You must ALWAYS return a JSON object. If identification is impossible, set drugName to "Unknown Medication" and provide a visual description in the indication field.

Return this exact JSON:
{
  "drugName": "string",
  "genericName": "string",
  "manufacturer": "string",
  "indication": "string",
  "dosageForm": "string",
  "dosageInstructions": "string",
  "warnings": "string",
  "expiryPattern": "string",
  "confidenceScore": number,
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
                dynamic_threshold: 0.2
              }
            }
          }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json',
            // ─── SCHEMA ENFORCEMENT ───
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
                expiryPattern: { type: "STRING" },
                confidenceScore: { type: "NUMBER" },
                originVerified: { type: "BOOLEAN" }
              },
              required: ["drugName", "confidenceScore", "originVerified"]
            }
          }
        })
      }
    );

    const geminiData = await geminiResponse.json();
    
    // Check for safety blocks
    if (geminiData.promptFeedback?.blockReason) {
       return res.status(200).json({
          drugName: "Identification Restricted",
          confidenceScore: 0,
          indication: "The vision engine's safety filters restricted this identification. This often happens with loose pills without packaging.",
          originVerified: false,
          authentic: false
       });
    }

    const rawResult = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!rawResult) {
      return res.status(200).json({
        drugName: "Unable to Identify",
        confidenceScore: 0,
        indication: "No clear pharmaceutical markers detected. Please try an image with a clearer label or higher contrast.",
        originVerified: false,
        authentic: false
      });
    }

    const visionResult = JSON.parse(rawResult);
    visionResult.analysisTimestamp = new Date().toISOString();
    visionResult.ocrEnhanced = extractedText.length > 0;
    
    // Map internal 'authentic' state based on AI confidence
    visionResult.authentic = visionResult.confidenceScore >= 80 && visionResult.originVerified;

    return res.status(200).json(visionResult);

  } catch (err) {
    console.error('MedVision API Failure:', err.message);
    return res.status(500).json({ error: "Intelligence Engine Unavailable", details: err.message });
  }
}
