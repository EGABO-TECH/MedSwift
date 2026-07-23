import { readFile } from 'node:fs/promises';
import path from 'node:path';

const offlineReferenceCache = { data: null, loaded: false };

async function loadOfflineReferenceData() {
  if (offlineReferenceCache.loaded) return offlineReferenceCache.data;

  try {
    const dataPath = path.join(process.cwd(), 'data', 'offline_db.json');
    const raw = await readFile(dataPath, 'utf8');
    offlineReferenceCache.data = JSON.parse(raw);
  } catch (e) {
    offlineReferenceCache.data = [];
    console.warn('Offline reference data unavailable:', e.message);
  }

  offlineReferenceCache.loaded = true;
  return offlineReferenceCache.data;
}

function normalizeText(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenize(text) {
  return normalizeText(text).split(' ').filter(Boolean);
}

function chooseBestOfflineMatch(dataset, extractedText, medications = []) {
  const sources = [
    extractedText,
    ...medications.map(m => `${m.drugName || ''} ${m.genericName || ''} ${m.manufacturer || ''}`).filter(Boolean)
  ].filter(Boolean);

  let bestMatch = null;
  let bestScore = 0;

  for (const item of dataset) {
    const itemSearchText = normalizeText(`${item.brandName || ''} ${item.genericName || ''} ${item.manufacturer || ''} ${item.dosageForm || ''}`);

    for (const source of sources) {
      const sourceText = normalizeText(source);
      if (!sourceText) continue;

      let score = 0;
      if (itemSearchText.includes(sourceText)) score += 100;
      if (sourceText.includes(itemSearchText)) score += 80;

      const sourceTokens = tokenize(sourceText);
      const matchTokens = sourceTokens.filter(token => itemSearchText.includes(token));
      score += matchTokens.length * 12;

      if (score > bestScore) {
        bestScore = score;
        bestMatch = item;
      }
    }
  }

  return bestScore > 0 ? bestMatch : null;
}

async function createOfflineFallbackResult(mode, extractedText, medications = []) {
  const dataset = await loadOfflineReferenceData();
  const match = chooseBestOfflineMatch(dataset, extractedText, medications);
  const fallbackName = normalizeText(extractedText || medications.map(m => m.drugName || m.genericName).filter(Boolean).join(' '));

  if (mode === 'report') {
    return {
      title: 'Offline Clinical Summary',
      summary: extractedText || 'Offline mode is active. The app is now serving its local clinical reference matrix while the network-backed intelligence is unavailable.',
      keyFindings: ['Local fallback mode engaged', 'Verification is limited to the device reference data'],
      recommendations: ['Review the saved medication information with a pharmacist or clinician', 'Reconnect intelligence services to refresh verification'],
      followUp: 'Continue using the local reference matrix until network verification is available again.',
      confidenceScore: 64,
      sourceContext: 'Offline PWA fallback',
      authentic: false,
      manualReviewRequired: true,
      verifyMs: 0,
      engine: 'Local Reference Matrix',
      timestamp: new Date().toISOString()
    };
  }

  if (mode === 'interaction') {
    return {
      interactionRiskLevel: 'LOW',
      interactingPairs: [],
      therapeuticCompatibility: 'Interaction analysis is unavailable while the network intelligence layer is offline. The app is using the local medication matrix only.',
      dosingConsiderations: 'Review medication instructions from the package insert or a licensed pharmacist.',
      monitoringRecommendations: ['Monitor for unexpected side effects', 'Verify any new prescription combinations before administration'],
      alternativeRecommendations: ['Consider discussing the combination with your clinician'],
      patientCounseling: 'Do not make medication changes based on this offline fallback alone.',
      overallAssessment: 'Offline-only analysis is active. This result should be treated as a continuity placeholder until network-backed intelligence is restored.',
      confidenceScore: 55,
      evidenceLevel: 'Low',
      primaryConcern: 'Provider intelligence unavailable',
      recommendedAction: 'CONSULT_SPECIALIST',
      authentic: false,
      manualReviewRequired: true,
      verifyMs: 0,
      engine: 'Local Reference Matrix',
      timestamp: new Date().toISOString()
    };
  }

  const labelSource = (extractedText || medications.map(m => m.drugName || m.genericName).filter(Boolean).join(' ') || 'Medication').trim();

  return {
    drugName: match?.brandName || labelSource || 'Medication',
    genericName: match?.genericName || '',
    manufacturer: match?.manufacturer || 'Unable to verify manufacturer from local matrix',
    indication: match?.indication || match?.dosageForm || 'Medication details could not be fully verified by the external intelligence layer.',
    dosageInstructions: match?.dosageInstructions || 'No dosage guidance can be confirmed because the drug could not be confidently matched in the offline reference set.',
    warnings: match?.warnings || 'No reliable medication warning data was available from the offline reference path.',
    storage: match?.storage || 'Package storage could not be confirmed offline.',
    confidenceScore: match ? 65 : 20,
    originVerified: false,
    confidenceRationale: match
      ? 'The network intelligence layer is unavailable, so MedSwift is using the closest matching local medication reference for continuity.'
      : 'The drug could not be matched to the local reference matrix. MedSwift is not inventing medication guidance and is returning only the extracted label context available in the request.',
    regulatoryStatus: match?.regulatoryStatus || 'Unavailable in offline fallback',
    therapeuticClass: match?.therapeuticClass || '',
    pathway: match?.pathway || '',
    isEssentialMedicine: match?.isEssentialMedicine ?? false,
    lifestyleNudge: match?.lifestyleNudge || 'Use the product label and a licensed pharmacist or clinician as the current source of truth until network-backed verification returns.',
    suggestedBiomarkers: match?.suggestedBiomarkers || [],
    proactiveInsight: match?.proactiveInsight || 'Offline fallback mode is active. No unsupported clinical guidance is being generated.',
    authentic: false,
    manualReviewRequired: true,
    offlineFallback: true,
    verifyMs: 0,
    engine: 'Local Reference Matrix',
    timestamp: new Date().toISOString()
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { image, mimeType = 'image/jpeg', mode = 'medication', text = '', medications = [] } = req.body;
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const openRouterKey = process.env.OPENROUTER_API_KEY;

  const openaiCompatibleProviders = [
    { name: 'NVIDIA NIM', envVar: 'NVIDIA_NIM_API_KEY' },
    { name: 'DeepSeek', envVar: 'DEEPSEEK_API_KEY' },
    { name: 'Groq', envVar: 'GROQ_API_KEY' },
    { name: 'SambaNova', envVar: 'SAMBANOVA_API_KEY' },
    { name: 'Fireworks AI', envVar: 'FIREWORKS_API_KEY' },
    { name: 'Cohere', envVar: 'COHERE_API_KEY' },
    { name: 'Kimi (Moonshot)', envVar: 'KIMI_API_KEY' },
    { name: 'Minimax', envVar: 'MINIMAX_API_KEY' },
    { name: 'Z.AI', envVar: 'ZAI_API_KEY' },
    { name: 'Mistral', envVar: 'MISTRAL_API_KEY' }
  ];

  const hasOpenAIProvider = openaiCompatibleProviders.some(p => process.env[p.envVar]);
  const hasAnyProvider = Boolean(geminiApiKey || openRouterKey || hasOpenAIProvider);

  try {
    // ─── STAGE 1: OCR PRE-PROCESSOR ───
    let extractedText = typeof text === 'string' ? text.trim() : '';
    if (!extractedText && image) {
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
    }

    // ─── STAGE 2: MULTI-PROVIDER RESILIENCE PIPELINE ───
    let prompt = '';
    if (mode === 'report') {
      prompt = `You are a senior clinical documentation assistant. Analyze the doctor's written note below and rewrite it into a concise, clinically useful summary.

Rules:
- Use only the supplied text as your evidence source.
- Do not invent findings, medications, diagnoses, or diagnoses that are not stated in the note.
- If information is missing, say "Not stated in the provided note."
- Prefer short, plain-language, high-signal wording intended for a clinician or pharmacist.
- Return no prose outside the JSON object.

Source note:
"${extractedText}"

Return ONLY a raw JSON object with exactly these keys:
- title (short, professional title, 5-8 words max)
- summary (2 short sentences summarizing the main point clearly)
- keyFindings (array of 3-5 short bullet points)
- recommendations (array of 2-4 practical next steps)
- followUp (1 short sentence for follow-up)
- confidenceScore (0-100, based on how clearly the note supports the summary)
- sourceContext (brief note on the document type or context)
`;
    } else if (mode === 'interaction') {
      const medsList = medications.map((med, idx) =>
        `${idx + 1}. ${med.drugName || 'Unknown'} (${med.genericName || ''}) - ${med.indication || 'No indication provided'}`)
        .join('\n');
      prompt = `You are a Clinical Pharmacist specializing in drug interactions and polypharmacy safety. Analyze the following medications for potential interactions and provide guidance on their combined use.

Medications to analyze:
${medsList}

Provide a comprehensive interaction analysis in JSON format with:
- interactionRiskLevel: "LOW" | "MODERATE" | "HIGH" | "CONTRAINDICATED"
- interactingPairs: Array of objects with drug1, drug2, severity, description, clinicalSignificance
- therapeuticCompatibility: Assessment of whether these medications can be used together safely
- dosingConsiderations: Any special dosing adjustments needed when used together
- monitoringRecommendations: What parameters to monitor and how frequently
- alternativeRecommendations: Safer alternatives if interactions are significant
- patientCounseling: Key points to communicate to the patient about taking these medications together
- overallAssessment: Summary statement about the safety and appropriateness of this combination
- confidenceScore: (0-100) confidence in this interaction assessment
- evidenceLevel: "High" | "Moderate" | "Low" based on available interaction data
- primaryConcern: The most significant interaction concern, if any
- recommendedAction: "PROCEED_WITH_CAUTION", "DO_NOT_COMBINE", "CONSULT_SPECIALIST", etc.

Return ONLY the raw JSON object.`;
    } else {
      // Default medication mode
      prompt = `You are a Senior Clinical Pharmacist and Regulatory Auditor. Identify this medication based on the image and text.
Label context: "${extractedText}"
Cross-reference your internal knowledge with the following Gold Standard Datasets:
1. OpenFDA & EMA for manufacturer, regulatory status, and origin.
2. Health Canada DPD for therapeutic class.
3. DrugBank & CH EMBL for biochemical pathway.
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
    }

    // Configure available AI providers in order of preference
    const providers = [];

    // Add Gemini/Google AI Studio if key is available
    if (process.env.GEMINI_API_KEY) {
      providers.push({
        name: 'Google AI Studio (Gemini)',
        key: process.env.GEMINI_API_KEY,
        type: 'gemini',
        models: {
          flash: [
            'gemini-2.0-flash',
            'gemini-2.0-flash-lite',
            'gemini-1.5-flash'
          ],
          pro: [
            'gemini-2.5-flash-preview-04-17', // Latest high-reasoning model
            'gemini-1.5-pro',                 // Legacy pro fallback
            'gemini-1.5-pro-latest'           // Last-resort alias
          ]
        }
      });
    }

    // Add OpenRouter if key is available
    if (process.env.OPENROUTER_API_KEY) {
      providers.push({
        name: 'OpenRouter',
        key: process.env.OPENROUTER_API_KEY,
        type: 'openrouter',
        models: [
          'google/gemini-2.0-flash-001',
          'anthropic/claude-3.5-sonnet',
          'openai/gpt-4o-mini',
          'meta-llama/llama-3-70b-instruct',
          'mistralai/mistral-large-latest',
          'nvidia/nemotron-4-340b-instruct',
          'deepseek/deepseek-chat-v3-0324',
          'cohere/command-r-plus',
          'moonshotai/kimi-k2-0905-preview',
          'minimax/minimax-m1-80k',
          'groq/llama-3.1-70b-versatile',
          'sambanova/Models-Llama-3.1-70B-Instruct',
          'fireworks/llama-v3p1-70b-instruct',
          '01-ai/yi-large'
        ]
      });
    }

    // Add Direct OpenAI-compatible providers
    const openaiCompatibleProviderDefs = [
      { name: 'NVIDIA NIM', envVar: 'NVIDIA_NIM_API_KEY', baseUrl: 'https://ai.api.nvidia.com/v1', models: ['nemotron-4-340b-instruct'] },
      { name: 'DeepSeek', envVar: 'DEEPSEEK_API_KEY', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat'] },
      { name: 'Groq', envVar: 'GROQ_API_KEY', baseUrl: 'https://api.groq.com/openai/v1', models: ['llama3-70b-8192', 'mixtral-8x7b-32768'] },
      { name: 'SambaNova', envVar: 'SAMBANOVA_API_KEY', baseUrl: 'https://api.sambanova.ai/v1', models: ['Meta-Llama-3.1-70B-Instruct'] },
      { name: 'Fireworks AI', envVar: 'FIREWORKS_API_KEY', baseUrl: 'https://api.fireworks.ai/inference/v1', models: ['accounts/fireworks/models/llama-v3p1-70b-instruct'] },
      { name: 'Cohere', envVar: 'COHERE_API_KEY', baseUrl: 'https://api.cohere.ai/v1', models: ['command-r-plus'], special: true },
      { name: 'Kimi (Moonshot)', envVar: 'KIMI_API_KEY', baseUrl: 'https://api.moonshot.cn/v1', models: ['kimi-k2-0905-preview'] },
      { name: 'Minimax', envVar: 'MINIMAX_API_KEY', baseUrl: 'https://api.minimaxi.com/v1', models: ['abab6.5s-chat'] },
      { name: 'Z.AI', envVar: 'ZAI_API_KEY', baseUrl: 'https://api.z.ai/v1', models: ['z-ai-plus'] },
      { name: 'Mistral', envVar: 'MISTRAL_API_KEY', baseUrl: 'https://api.mistral.ai/v1', models: ['pixtral-large-latest'] }
    ];

    for (const providerDef of openaiCompatibleProviderDefs) {
      if (process.env[providerDef.envVar]) {
        providers.push({
          name: providerDef.name,
          key: process.env[providerDef.envVar],
          type: 'openai-compatible',
          baseUrl: providerDef.baseUrl,
          models: providerDef.models,
          special: providerDef.special
        });
      }
    }

    if (providers.length === 0) {
      console.warn('No intelligence providers configured. Returning offline fallback result.');
      return res.status(200).json(await createOfflineFallbackResult(mode, extractedText, medications));
    }

    let visionResult = null;
    const errors = [];

    // Try each provider in order until one succeeds
    for (const provider of providers) {
      if (visionResult) break; // Success, exit early

      try {
        console.log(`Trying ${provider.name}...`);

        switch (provider.type) {
          case 'gemini':
            // Try flash models first (fast), then pro models (reasoning)
            const modelSets = [
              { models: provider.models.flash, tier: 'Flash' },
              { models: provider.models.pro, tier: 'Pro' }
            ];

            for (const modelSet of modelSets) {
              if (visionResult) break;

              for (const model of modelSet.models) {
                try {
                  console.log(`${provider.name} ${modelSet.tier}: Attempting ${model}...`);
                  visionResult = await callGemini(model, prompt, image, mimeType, provider.key);
                  if (visionResult) {
                    console.log(`Success with ${provider.name} ${model}`);
                    break;
                  }
                } catch (e) {
                  errors.push(`${provider.name} ${modelSet.tier}(${model}): ${e.message}`);
                  if (e.message.includes('not found') || e.message.includes('NOT_FOUND') || e.message.includes('not supported')) {
                    continue; // Try next model in set
                  }
                  break; // Stop trying models in this set on other errors
                }
              }
            }
            break;

          case 'openrouter':
            // Try each model via OpenRouter
            for (const model of provider.models) {
              try {
                console.log(`OpenRouter: Attempting ${model}...`);
                visionResult = await callOpenRouter(model, prompt, image, mimeType, provider.key);
                if (visionResult) {
                  console.log(`Success with OpenRouter ${model}`);
                  break;
                }
              } catch (e) {
                errors.push(`OpenRouter(${model}): ${e.message}`);
                // Continue to next model
              }
            }
            break;

          case 'openai-compatible':
            // Try every configured OpenAI-compatible model for this provider.
            for (const model of provider.models) {
              try {
                console.log(`${provider.name}: Attempting ${model}...`);
                visionResult = await callOpenAICompatible(
                  model,
                  prompt,
                  image,
                  mimeType,
                  provider.key,
                  provider.baseUrl,
                  provider.special
                );

                if (visionResult) {
                  console.log(`Success with ${provider.name} ${model}`);
                  break;
                }
              } catch (e) {
                errors.push(`${provider.name}(${model}): ${e.message}`);
                // Continue to the next configured model instead of stopping at the first failure.
              }
            }
            break;
        }
      } catch (err) {
        errors.push(`${provider.name} provider failed: ${err.message}`);
      }
    }

    if (!visionResult) {
      const isQuotaError = errors.some(e => e.includes('QuotaFailure') || e.includes('429') || e.includes('rate limit'));
      if (isQuotaError) {
        console.warn('Provider quota exhausted. Falling back to the local reference matrix.');
        return res.status(200).json(await createOfflineFallbackResult(mode, extractedText, medications));
      }

      console.warn('All provider attempts failed. Falling back to the local reference matrix.');
      return res.status(200).json(await createOfflineFallbackResult(mode, extractedText, medications));
    }

    // Return successful response
    return res.status(200).json(visionResult);
  } catch (err) {
    console.error('MedVision System-Wide Failure:', err.message);
    const cleanMsg = typeof err.message === 'string' ? err.message : JSON.stringify(err.message);
    console.warn('Using offline fallback after catch path:', cleanMsg);
    return res.status(200).json(await createOfflineFallbackResult(mode, extractedText, medications));
  }
}

/**
 * Native Google Gemini Call
 */
async function callGemini(modelName, prompt, imageData, mimeType, apiKey) {
  // 20-second timeout — generous enough for 2.5 Pro but safe under our 25s maxDuration
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);

  const parts = [{ text: prompt }];
  if (imageData) {
    parts.push({ inline_data: { mime_type: mimeType, data: imageData } });
  }

  let response;
  try {
    // CRITICAL FIX: Use v1beta endpoint — it supports ALL Gemini models
    // (both stable and preview). The v1 stable endpoint only supports a restricted
    // set of GA models and returned 'not found' for all gemini-1.5-* and gemini-2.0-*
    // model names, causing every scan to fail silently through all 6 model tiers.
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          contents: [{
            parts
          }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json' // Request JSON directly to skip regex parsing
          }
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
  const content = imageData
    ? [
        { "type": "text", "text": prompt },
        { "type": "image_url", "image_url": { "url": `data:${mimeType};base64,${imageData}` } }
      ]
    : prompt;

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
          "content": content
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

/**
 * OpenAI-Compatible Multi-Model Call
 * For services like NVIDIA NIM, DeepSeek, Groq, SambaNova, Fireworks AI, etc.
 */
async function callOpenAICompatible(modelName, prompt, imageData, mimeType, apiKey, baseUrl, isSpecial = false) {
  const content = imageData
    ? [
        { "type": "text", "text": prompt },
        { "type": "image_url", "image_url": { "url": `data:${mimeType};base64,${imageData}` } }
      ]
    : prompt;

  // Special handling for Cohere which has a different API structure
  if (isSpecial && modelName.includes('command')) {
    // Cohere API call
    const response = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message: prompt,
        model: modelName,
        // Note: Cohere doesn't support image input in chat endpoint as of this writing
        // For vision capabilities, would need to use their different endpoint
        // For now, we'll pass image description in prompt if needed
      })
    });

    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    let text = data.text || '{}';

    // Robustly extract JSON block even if conversational text is present
    let cleanText = text;
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
    res.engine = `Specialist (${modelName})`;
    return res;
  }

  // Standard OpenAI-compatible API call
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://medswift.app", // Optional
      "X-Title": "MedSwift Vision"
    },
    body: JSON.stringify({
      model: modelName,
      messages: [
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
  let text = data.choices[0].message.content || '{}';

  // Robustly extract JSON block even if conversational text is present
  let cleanText = text;
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
  res.engine = `Specialist (${modelName})`;
  return res;
}
