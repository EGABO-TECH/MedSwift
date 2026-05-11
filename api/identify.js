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

      // Timeout the OCR call at 3s so it never blocks the Gemini pipeline
      const ocrCtrl = new AbortController();
      const ocrTimer = setTimeout(() => ocrCtrl.abort(), 3000);
      const ocrResponse = await fetch('https://api.ocr.space/parse/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
        signal: ocrCtrl.signal
      });
      clearTimeout(ocrTimer);
      const ocrData = await ocrResponse.json();
      extractedText = ocrData?.ParsedResults?.[0]?.ParsedText || '';
    } catch (e) {
      console.warn('OCR Skip/Timeout:', e.message);
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

    // TIER 1: Gemini 1.5 Flash (Multi-Flavor Search)
    if (geminiApiKey) {
      const flashModels = ['gemini-1.5-flash', 'gemini-1.5-flash-latest', 'gemini-1.5-flash-001'];
      for (const m of flashModels) {
        try {
          console.log(`Tier 1: Attempting ${m}...`);
          visionResult = await callGemini(m, prompt, image, mimeType, geminiApiKey);
          if (visionResult) break;
        } catch (e) { 
          errors.push(`Flash(${m}): ${e.message}`);
          if (e.message.includes('not found')) continue; 
          break; 
        }
      }
    }

    // TIER 2: Gemini 1.5 Pro (Multi-Flavor Search)
    if (!visionResult && geminiApiKey) {
      const proModels = ['gemini-1.5-pro', 'gemini-1.5-pro-latest', 'gemini-1.5-pro-001'];
      for (const m of proModels) {
        try {
          console.log(`Tier 2: Attempting ${m}...`);
          visionResult = await callGemini(m, prompt, image, mimeType, geminiApiKey);
          if (visionResult) break;
        } catch (e) {
          errors.push(`Pro(${m}): ${e.message}`);
          if (e.message.includes('not found')) continue;
          break;
        }
      }
    }

    // TIER 3: OpenRouter (Claude 3.5 Sonnet) - The Ultimate Safety Net
    if (!visionResult && openRouterKey) {
      try {
        console.log('Tier 3: Activating OpenRouter Safety Net (Claude 3.5 Sonnet)...');
        visionResult = await callOpenRouter('anthropic/claude-3.5-sonnet', prompt, image, mimeType, openRouterKey);
      } catch (e) { errors.push(`OpenRouter: ${e.message}`); }
    }

    if (!visionResult) {
      const isQuotaError = errors.some(e => e.includes('QuotaFailure') || e.includes('429'));
      if (isQuotaError) {
        throw new Error("Intelligence Network Quota Exceeded. Please try again in a minute.");
      }
      // Return the most relevant error for the UI
      const primaryError = errors[0] || 'Unknown Analysis Failure';
      throw new Error(`MedVision Core Failure: ${primaryError}. (Check API Key and Region support)`);
    }

    visionResult.analysisTimestamp = new Date().toISOString();
    visionResult.ocrEnhanced = extractedText.length > 0;

    // Bug #7 Fix: Compute both clinical flags here so the raw API response is
    // self-consistent for any consumer (mobile clients, future integrations).
    // scanner.js will recompute these after local DB enrichment — that's correct.
    const cs = visionResult.confidenceScore || 0;
    visionResult.authentic            = cs >= 80 && visionResult.originVerified === true;
    visionResult.manualReviewRequired = cs > 0 && cs < 80;

    return res.status(200).json(visionResult);

  } catch (err) {
    console.error('MedVision System-Wide Failure:', err.message);
    // If the error message is an object (from stringification of Error), we want it clean
    const cleanMsg = typeof err.message === 'string' ? err.message : JSON.stringify(err.message);
    return res.status(500).json({ error: cleanMsg });
  }
}

/**
 * Native Google Gemini Call
 */
async function callGemini(modelName, prompt, imageData, mimeType, apiKey) {
  // 8-second timeout prevents Vercel's 10s limit from being breached
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);

  let response;
  try {
    // Switching to v1 stable endpoint
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1/models/${modelName}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: mimeType, data: imageData } }
            ]
          }],
          generationConfig: { temperature: 0.1 } // v1 might not support responseMimeType in all tiers
        })
      }
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const errText = await response.text();
    let errJson;
    try { errJson = JSON.parse(errText); } catch(e) {}
    
    // Extract the specific message from Google's error structure
    const msg = errJson?.error?.message || (typeof errJson?.error === 'string' ? errJson.error : null) || errText;
    throw new Error(msg || `Google API Error ${response.status}`);
  }

  const data = await response.json();

  // Handle case where API succeeds but returns no content (Safety/Policy Block)
  if (!data.candidates || data.candidates.length === 0) {
    const reason = data.promptFeedback?.blockReason || 'Content Filtered';
    throw new Error(`Safety Block: ${reason}`);
  }

  const text = data.candidates[0].content.parts[0].text || '{}';
  let cleanText = text;
  
  // Robustly extract JSON block even if conversational text is present
  const jsonMatch = cleanText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    cleanText = jsonMatch[1];
  } else {
    const braceMatch = cleanText.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      cleanText = braceMatch[0];
    }
  }
  
  const res = JSON.parse(cleanText);
  res.engine = modelName.includes('pro') ? 'Elite Clinical Expert' : 'High-Speed Sentinel';
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
  const text = data.choices[0].message.content || '{}';
  let cleanText = text;
  
  // Robustly extract JSON block even if conversational text is present
  const jsonMatch = cleanText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    cleanText = jsonMatch[1];
  } else {
    const braceMatch = cleanText.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      cleanText = braceMatch[0];
    }
  }
  
  const res = JSON.parse(cleanText);
  res.engine = `Global Auditor (${modelName.split('/')[1]})`;
  return res;
}
