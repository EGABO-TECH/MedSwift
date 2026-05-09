export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { image } = req.body;
  const geminiApiKey = process.env.GEMINI_API_KEY;

  if (!geminiApiKey) {
    return res.status(500).json({ error: 'Gemini API Key not configured in Vercel' });
  }

  if (!image) {
    return res.status(400).json({ error: 'No image data provided' });
  }

  try {
    // ─── STAGE 1: RAW OCR EXTRACTION (OCR.space API) ───
    // Leverages OCR.space for high-volume label text extraction as a pre-processor.
    let extractedText = '';
    try {
      const ocrKey = process.env.OCR_SPACE_KEY || 'helloworld';
      const form = new URLSearchParams();
      form.append('apikey', ocrKey);
      form.append('base64Image', `data:image/jpeg;base64,${image}`);
      form.append('language', 'eng');
      form.append('isTable', 'false');
      form.append('OCREngine', '2'); // Engine 2 is better for printed text on labels

      const ocrResponse = await fetch('https://api.ocr.space/parse/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form
      });

      const ocrData = await ocrResponse.json();
      if (ocrData && !ocrData.IsErroredOnProcessing && ocrData.ParsedResults?.[0]?.ParsedText) {
        extractedText = ocrData.ParsedResults[0].ParsedText.trim();
        console.log('MedVision Stage 1 (OCR.space): Text extracted successfully.');
      }
    } catch (e) {
      // OCR is a pre-processor only — failure is non-fatal, Gemini handles it alone.
      console.warn('OCR.space pre-processor skipped. Routing directly to Gemini:', e.message);
    }

    // ─── STAGE 2: MULTIMODAL REASONING (Gemini 2.0 Flash) ───
    // Feeds image + pre-extracted text into Gemini for deep pharmaceutical analysis.
    // NOTE: googleSearchRetrieval is NOT compatible with vision (inline_data) requests.
    // Gemini's own training data on openFDA, DailyMed, RxNorm, and DrugBank is used instead.
    const prompt = `You are MedVision, an elite pharmaceutical verification AI integrated into a medical safety PWA.
Analyze the provided medication image with maximum precision.
${extractedText ? `\nSTAGE 1 PRE-EXTRACTED LABEL TEXT (OCR.space Engine 2):\n"${extractedText}"\nUse this text as strong supporting evidence for your analysis.\n` : ''}
Cross-reference your findings against global pharmaceutical databases you were trained on: openFDA, DailyMed, RxNorm, DrugBank, ChEMBL, and WHO Essential Medicines List.

Your task is to extract and verify:
1. Drug Name: Brand name AND generic INN name.
2. Manufacturer/Distributor: Full verified name and country of origin.
3. Primary Indication: The specific disease(s) or condition(s) it treats.
4. Dosage Form & Standard Instructions: How it is taken, standard adult dose.
5. Key Warnings: Up to 2 critical contraindications or safety warnings.
6. Expiry Pattern: Typical shelf-life from manufacture date.
7. Confidence Score: Your confidence in this identification (0-100).
8. Origin Verified: Whether the manufacturer matches a known, verified pharmaceutical company (true/false).

CRITICAL RULES:
- You MUST return ONLY a raw JSON object. No markdown, no code fences, no explanation text.
- Use null for any field you cannot determine from the image.
- If the image is not a medication or is completely unreadable, set confidenceScore to 0 and drugName to "Unidentified".

Return ONLY this exact JSON structure:
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
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: 'image/jpeg', data: image } }
            ]
          }],
          generationConfig: {
            temperature: 0.1,       // Low temp for factual, deterministic output
            topK: 32,
            topP: 0.95,
            maxOutputTokens: 1024,
            responseMimeType: 'application/json' // Force JSON response mode
          }
        })
      }
    );

    if (!geminiResponse.ok) {
      const errBody = await geminiResponse.text();
      console.error('Gemini API error:', geminiResponse.status, errBody);
      return res.status(502).json({ error: `Gemini API error: ${geminiResponse.status}` });
    }

    const geminiData = await geminiResponse.json();

    if (!geminiData.candidates || geminiData.candidates.length === 0) {
      console.error('Gemini returned no candidates:', JSON.stringify(geminiData));
      return res.status(500).json({ error: 'MedVision AI returned no results. The image may be unclear.' });
    }

    const rawText = geminiData.candidates[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
      return res.status(500).json({ error: 'MedVision AI returned an empty response.' });
    }

    // ─── STAGE 3: ROBUST JSON PARSING ───
    // Strips any accidental markdown fences before parsing.
    let visionResult;
    try {
      const cleanedText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
      visionResult = JSON.parse(cleanedText);
    } catch (parseError) {
      console.error('JSON parse failed. Raw Gemini output:', rawText);
      return res.status(500).json({ error: 'AI response format error. Please try again with a clearer image.' });
    }

    // ─── STAGE 4: RESPONSE ENRICHMENT ───
    // Attach metadata about the pipeline used.
    visionResult.ocrEnhanced = extractedText.length > 0;
    visionResult.analysisTimestamp = new Date().toISOString();

    console.log(`MedVision Analysis Complete: ${visionResult.drugName} (Confidence: ${visionResult.confidenceScore}%)`);
    return res.status(200).json(visionResult);

  } catch (err) {
    console.error('MedVision Pipeline Critical Error:', err);
    return res.status(500).json({ error: 'Vision analysis pipeline failed. Please try again.' });
  }
}
