export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { image } = req.body;
  const geminiApiKey = process.env.GEMINI_API_KEY;

  if (!geminiApiKey) {
    return res.status(500).json({ error: 'Gemini API Key not configured in Vercel' });
  }

  try {
    // ─── STAGE 1: RAW OCR EXTRACTION (OCR.space API) ───
    // Leveraging OCR.space for high-volume raw text extraction as a pre-processor
    let extractedText = "";
    try {
      const form = new URLSearchParams();
      // 'helloworld' is the generous free-tier test key for OCR.space
      form.append('apikey', process.env.OCR_SPACE_KEY || 'helloworld');
      form.append('base64Image', `data:image/jpeg;base64,${image}`);
      form.append('language', 'eng');

      const ocrResponse = await fetch('https://api.ocr.space/parse/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form
      });
      
      const ocrData = await ocrResponse.json();
      if (ocrData && !ocrData.IsErroredOnProcessing && ocrData.ParsedResults) {
        extractedText = ocrData.ParsedResults[0].ParsedText;
        console.log("MedVision Stage 1: OCR.space extracted label text.");
      }
    } catch (e) {
      console.warn("OCR.space engine skipped, routing directly to Gemini:", e);
    }

    // ─── STAGE 2: MULTI-MODAL REASONING & GROUNDING (Gemini 1.5 Flash) ───
    // We feed both the image AND the pre-extracted OCR text (if any) to Gemini
    const prompt = `You are MedVision, an advanced pharmaceutical verification AI. Identify the medication in the provided image.
${extractedText ? `\nPRE-EXTRACTED LABEL TEXT (from Stage 1 OCR):\n"${extractedText}"\n` : ''}
Heavily leverage your knowledge of global medical databases (openFDA, DailyMed, RxNorm, DrugBank, ChEMBL) and Google's database to verify this drug.

Extract and provide highly accurate information for:
1. Drug Name: Brand and generic.
2. Manufacturer/Origin: Verified manufacturer.
3. Indication/Disease: Specific diseases/disorders it cures or treats.
4. Dosage Prescriptions: Standard dosage forms and guidelines.
5. Expiry Pattern: Standard shelf-life.

Return ONLY a strictly formatted JSON object (without markdown blocks) with the following exact keys:
"drugName", "manufacturer", "indication", "dosageForm", "expiryPattern", "confidenceScore" (number 0-100), and "originVerified" (boolean, true if it matches known global databases).`;

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: "image/jpeg", data: image } }
          ]
        }],
        tools: [
          {
            googleSearchRetrieval: {
              dynamicRetrievalConfig: {
                mode: "MODE_DYNAMIC",
                dynamicThreshold: 0.3
              }
            }
          }
        ]
      })
    });

    const data = await response.json();
    if (!data.candidates || data.candidates.length === 0) {
      return res.status(500).json({ error: 'MedVision AI returned no results' });
    }

    const resultText = data.candidates[0].content.parts[0].text;
    const visionResult = JSON.parse(resultText.replace(/```json|```/g, ''));
    
    return res.status(200).json(visionResult);
  } catch (err) {
    console.error("MedVision Pipeline Error:", err);
    return res.status(500).json({ error: 'Vision analysis failed' });
  }
}
