export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { image, mimeType = 'image/jpeg' } = req.body;
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const openRouterKey = process.env.OPENROUTER_API_KEY;

  if (!geminiApiKey && !openRouterKey) {
    return res.status(500).json({ error: 'No Intelligence Providers Configured (Gemini or OpenRouter)' });
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

    // ─── STAGE 2: TRIPLE-TIER RESILIENCE PIPELINE ───
    const prompt = `You are a Senior Clinical Pharmacist and Regulatory Auditor. Identify this medication based on the image and text.
Label context: "${extractedText}"
Cross-reference your internal knowledge with the following Gold Standard Datasets:
1. OpenFDA & EMA for manufacturer, regulatory status, and origin.
2. Health Canada DPD for therapeutic class.
3. DrugBank & ChEMBL for biochemical pathway.
4. WHO EML to check if it's a core essential medicine.

Return a JSON report with: 
- drugName (Brand name)
- genericName
- manufacturer
- indication
- dosageInstructions
- warnings
- storage
- confidenceScore (0-100)
- originVerified (boolean, verify against OpenFDA/EMA/ChEMBL)
- confidenceRationale (Explain your reasoning)
- regulatoryStatus (e.g., "FDA Approved, EMA Authorized")
- therapeuticClass (e.g., from Health Canada / AHFS)
- pathway (Biochemical mechanism from DrugBank/ChEMBL)
- isEssentialMedicine (boolean, from WHO EML)
- lifestyleNudge (An empathetic, human-centric suggestion on how to take the medication, e.g., "Works best with healthy fats. Try it with avocado toast.")
- suggestedBiomarkers (Array of strings, what lab work/biomarkers to track, e.g., ["Lipid Panel", "Liver Enzymes"])
- proactiveInsight (A proactive contextual highlight or safety insight)

Return ONLY the raw JSON object.`;

    let visionResult = null;
    let errors = [];

    // TIER 1: Gemini 1.5 Pro (Direct)
    if (geminiApiKey) {
      try {
        console.log('Tier 1: Attempting Google Pro...');
        visionResult = await callGemini('gemini-1.5-pro', prompt, image, mimeType, geminiApiKey);
      } catch (e) { errors.push(`Pro: ${e.message}`); }
    }

    // TIER 2: Gemini 1.5 Flash (Direct)
    if (!visionResult && geminiApiKey) {
      try {
        console.log('Tier 2: Falling back to Google Flash...');
        visionResult = await callGemini('gemini-1.5-flash', prompt, image, mimeType, geminiApiKey);
      } catch (e) { errors.push(`Flash: ${e.message}`); }
    }

    // TIER 3: OpenRouter (Claude 3.5 Sonnet) - The Ultimate Safety Net
    if (!visionResult && openRouterKey) {
      try {
        console.log('Tier 3: Activating OpenRouter Nuclear Option (Claude 3.5 Sonnet)...');
        visionResult = await callOpenRouter('anthropic/claude-3.5-sonnet', prompt, image, mimeType, openRouterKey);
      } catch (e) { errors.push(`OpenRouter: ${e.message}`); }
    }

    if (!visionResult) {
      throw new Error(`All intelligence providers failed. Errors: ${errors.join(' | ')}`);
    }

    visionResult.analysisTimestamp = new Date().toISOString();
    visionResult.ocrEnhanced = extractedText.length > 0;
    visionResult.authentic = visionResult.confidenceScore >= 80 && visionResult.originVerified;

    return res.status(200).json(visionResult);

  } catch (err) {
    console.error('MedVision System-Wide Failure:', err.message);
    return res.status(500).json({ error: "Intelligence Network Unavailable", details: err.message });
  }
}

/**
 * Native Google Gemini Call
 */
async function callGemini(modelName, prompt, imageData, mimeType, apiKey) {
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
        generationConfig: { temperature: 0.1, responseMimeType: 'application/json' }
      })
    }
  );

  if (!response.ok) throw new Error(await response.text());
  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  const res = JSON.parse(text);
  res.engine = modelName === 'gemini-1.5-pro' ? 'Elite Clinical Expert' : 'High-Speed Sentinel';
  return res;
}

/**
 * OpenRouter Multi-Model Call
 */
async function callOpenRouter(modelName, prompt, imageData, mimeType, apiKey) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://medswift.app", // Optional
      "X-Title": "MedSwift Vision"
    },
    body: JSON.stringify({
      "model": modelName,
      "messages": [
        {
          "role": "user",
          "content": [
            { "type": "text", "text": prompt },
            { "type": "image_url", "image_url": { "url": `data:${mimeType};base64,${imageData}` } }
          ]
        }
      ],
      "response_format": { "type": "json_object" }
    })
  });

  if (!response.ok) throw new Error(await response.text());
  const data = await response.json();
  const text = data.choices[0].message.content;
  const res = JSON.parse(text);
  res.engine = `Global Auditor (${modelName.split('/')[1]})`;
  return res;
}
