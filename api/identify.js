export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { image, mimeType = 'image/jpeg' } = req.body;
  const geminiApiKey = process.env.GEMINI_API_KEY;

  if (!geminiApiKey) {
    return res.status(500).json({ error: 'Gemini API Key not configured' });
  }

  if (!image) {
    return res.status(400).json({ error: 'No image data provided' });
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
      if (ocrData?.ParsedResults?.[0]?.ParsedText) {
        extractedText = ocrData.ParsedResults[0].ParsedText.trim();
      }
    } catch (e) {
      console.warn('OCR Pre-processor failed:', e.message);
    }

    // ─── STAGE 2: STABLE VISION REASONING (Gemini 1.5 Flash) ───
    // Using 1.5 Flash for maximum stability and widespread regional support.
    const prompt = `Identify the medication in this image.
${extractedText ? `Supporting text from label: "${extractedText}"` : ''}
Extract: brand drugName, genericName, manufacturer, primary indication, dosage instructions, clinical warnings, and typical expiryPattern.
Rate your confidence (0-100) and set originVerified:true if the manufacturer is a known pharmaceutical company.

Return ONLY this JSON:
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
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json'
          }
        })
      }
    );

    if (!geminiResponse.ok) {
      const errText = await geminiResponse.text();
      throw new Error(`Gemini API ${geminiResponse.status}: ${errText}`);
    }

    const geminiData = await geminiResponse.json();
    const rawResult = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!rawResult) throw new Error('Empty AI response');

    const visionResult = JSON.parse(rawResult);
    visionResult.ocrEnhanced = extractedText.length > 0;
    visionResult.analysisTimestamp = new Date().toISOString();

    return res.status(200).json(visionResult);

  } catch (err) {
    console.error('MedVision API Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
