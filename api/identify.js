import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { extractClinicalStructure, normalizeReportResult, isClinicallyMeaningful } from './report-normalizer.js';

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
    // Parse the scanned text for actual clinical structure
    const clinical = extractClinicalStructure(extractedText);
    
    const titleCand = clinical.diagnoses.length > 0 ? clinical.diagnoses[0] : 
                      (clinical.complaints.length > 0 ? `Evaluation of ${clinical.complaints[0]}` : 'Clinical Assessment');
    
    const summaryParts = [];
    if (clinical.complaints.length > 0) summaryParts.push(`Patient presents with ${clinical.complaints.slice(0, 2).join(', ')}.`);
    if (clinical.findings.length > 0) summaryParts.push(`Findings include ${clinical.findings.slice(0, 2).join(', ')}.`);
    if (clinical.diagnoses.length > 0) summaryParts.push(`Assessment: ${clinical.diagnoses[0]}.`);
    
    const summaryText = summaryParts.join(' ').slice(0, 180);
    
    return {
      title: titleCand.slice(0, 60),
      summary: summaryText || 'Clinical assessment completed. Provider review recommended.',
      keyFindings: clinical.findings.slice(0, 3).filter(f => isClinicallyMeaningful(f)) || ['Clinical examination performed'],
      recommendations: clinical.plan.slice(0, 2).filter(p => isClinicallyMeaningful(p)) || ['Follow-up with provider'],
      followUp: 'Schedule follow-up as clinically indicated.',
      confidenceScore: 52,
      sourceContext: 'Offline clinical parsing',
      authentic: false,
      manualReviewRequired: true,
      verifyMs: 0,
      engine: 'Offline Clinical Parser',
      timestamp: new Date().toISOString()
    };
  }

  if (mode === 'interaction') {
    return {
      interactionRiskLevel: 'LOW',
      interactingPairs: [],
      therapeuticCompatibility: 'Interaction analysis unavailable offline. Local medication matrix only.',
      dosingConsiderations: 'Review medication instructions from licensed provider.',
      monitoringRecommendations: ['Monitor for unexpected effects', 'Verify combinations with clinician'],
      alternativeRecommendations: ['Discuss with clinician'],
      patientCounseling: 'Consult provider before making medication changes.',
      overallAssessment: 'Offline analysis active. Confirm with network intelligence when available.',
      confidenceScore: 45,
      evidenceLevel: 'Low',
      primaryConcern: 'Provider intelligence unavailable',
      recommendedAction: 'CONSULT_SPECIALIST',
      authentic: false,
      manualReviewRequired: true,
      verifyMs: 0,
      engine: 'Offline Matrix',
      timestamp: new Date().toISOString()
    };
  }

  const labelSource = (extractedText || medications.map(m => m.drugName || m.genericName).filter(Boolean).join(' ') || 'Medication').trim();

  return {
    drugName: match?.brandName || labelSource || 'Medication',
    genericName: match?.genericName || '',
    manufacturer: match?.manufacturer || 'Offline verification',
    indication: match?.indication || 'Offline fallback',
    dosageInstructions: match?.dosageInstructions || 'See package insert',
    warnings: match?.warnings || 'Consult pharmacist',
    storage: match?.storage || 'Per package label',
    confidenceScore: match ? 55 : 25,
    originVerified: false,
    confidenceRationale: 'Offline fallback mode active.',
    regulatoryStatus: match?.regulatoryStatus || 'Offline',
    therapeuticClass: match?.therapeuticClass || '',
    pathway: match?.pathway || '',
    isEssentialMedicine: match?.isEssentialMedicine ?? false,
    lifestyleNudge: match?.lifestyleNudge || 'Consult provider.',
    suggestedBiomarkers: match?.suggestedBiomarkers || [],
    proactiveInsight: match?.proactiveInsight || 'Network intelligence offline.',
    authentic: false,
    manualReviewRequired: true,
    offlineFallback: true,
    verifyMs: 0,
    engine: 'Offline Matrix',
    timestamp: new Date().toISOString()
  };
}

function finalizeResultForMode(result, mode, sourceText) {
  if (mode === 'report') {
    return normalizeReportResult(result, sourceText);
  }
  return result;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { image, mimeType = 'image/jpeg', mode = 'medication', text = '', medications = [] } = req.body;
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const openRouterKey = process.env.OPENROUTER_API_KEY;

  try {
    let extractedText = typeof text === 'string' ? text.trim() : '';
    
    if (!extractedText && image) {
      try {
        const ocrKey = process.env.OCR_SPACE_KEY || 'helloworld';
        const form = new URLSearchParams();
        form.append('apikey', ocrKey);
        form.append('base64Image', `data:${mimeType};base64,${image}`);
        form.append('language', 'eng');
        form.append('OCREngine', '2');

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

    let prompt = '';
    if (mode === 'report') {
      prompt = `You are a clinical documentation specialist. Your task is to extract and structure clinical information from a scanned medical note into a clear, actionable summary suitable for provider review.

**RULES:**
1. Extract ONLY information explicitly stated in the document.
2. Never invent diagnoses, tests, findings, or medications.
3. Structure the output as: Chief Complaint → Findings → Assessment → Plan
4. Ignore administrative text, form fields, repeated labels, and boilerplate unless clinically relevant.
5. If a section is missing, note "Not stated in the provided note."
6. Use professional medical terminology but keep language plain and direct.
7. Return ONLY valid JSON with no markdown code blocks, no prose, no extra text.

**SOURCE DOCUMENT TEXT:**
"${extractedText}"

**RETURN EXACTLY THIS JSON (nothing else):**
{
  "title": "Brief clinical title (3-8 words, e.g. 'Hypertension Follow-up' or 'Acute Bronchitis Diagnosis')",
  "summary": "One to two sentences. State the patient's chief complaint and main assessment. Example: 'Patient presents with shortness of breath and cough for 3 days. Lung exam reveals bilateral crackles. Working diagnosis: acute bronchitis. Started on azithromycin and inhaled bronchodilators.'",
  "keyFindings": [
    "Most critical clinical finding (e.g. 'Bilateral crackles on lung auscultation')",
    "Second finding if present (e.g. 'Temperature 101.2°F, HR 102')",
    "Third finding if present (e.g. 'CXR shows infiltrates in lower lobes')"
  ],
  "recommendations": [
    "Specific actionable recommendation (e.g. 'Continue azithromycin 500mg daily for 5 days')",
    "Follow-up action (e.g. 'Return if symptoms worsen or persist beyond 7 days')"
  ],
  "followUp": "When and how to follow up (e.g. 'Call office in 3 days if no improvement or fever persists. Return sooner if difficulty breathing worsens.')",
  "confidenceScore": 85,
  "sourceContext": "Type of document (e.g. 'Clinic Visit Note' or 'Urgent Care Encounter')"
}`;
    } else if (mode === 'interaction') {
      const medsList = medications.map((med, idx) =>
        `${idx + 1}. ${med.drugName || 'Unknown'} (${med.genericName || ''}) - ${med.indication || 'No indication provided'}`)
        .join('\n');
      prompt = `You are a Clinical Pharmacist. Analyze medications for interactions:\n\n${medsList}\n\nReturn JSON with: interactionRiskLevel, interactingPairs, therapeuticCompatibility, dosingConsiderations, monitoringRecommendations, patientCounseling, overallAssessment, confidenceScore, recommendedAction.`;
    } else {
      prompt = `You are a Senior Pharmacist Auditor. Identify this medication and return JSON with: drugName, genericName, manufacturer, indication, dosageInstructions, warnings, storage, confidenceScore, originVerified, regulatoryStatus.`;
    }

    // List of AI providers in order of preference
    const providers = [];

    if (process.env.GEMINI_API_KEY) {
      providers.push({
        name: 'Google AI Studio',
        key: process.env.GEMINI_API_KEY,
        type: 'gemini',
        models: {
          flash: ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash'],
          pro: ['gemini-2.5-flash-preview-04-17', 'gemini-1.5-pro', 'gemini-1.5-pro-latest']
        }
      });
    }

    if (process.env.OPENROUTER_API_KEY) {
      providers.push({
        name: 'OpenRouter',
        key: process.env.OPENROUTER_API_KEY,
        type: 'openrouter',
        models: ['google/gemini-2.0-flash-001', 'anthropic/claude-3.5-sonnet', 'openai/gpt-4o-mini']
      });
    }

    if (providers.length === 0) {
      console.warn('No providers configured. Using offline fallback.');
      const fallbackResult = await createOfflineFallbackResult(mode, extractedText, medications);
      return res.status(200).json(finalizeResultForMode(fallbackResult, mode, extractedText));
    }

    let visionResult = null;
    const errors = [];

    for (const provider of providers) {
      if (visionResult) break;

      try {
        if (provider.type === 'gemini') {
          for (const modelSet of [{ models: provider.models.flash, tier: 'Flash' }, { models: provider.models.pro, tier: 'Pro' }]) {
            if (visionResult) break;
            for (const model of modelSet.models) {
              try {
                visionResult = await callGemini(model, prompt, image, mimeType, provider.key);
                if (visionResult) break;
              } catch (e) {
                errors.push(`${model}: ${e.message}`);
              }
            }
          }
        } else if (provider.type === 'openrouter') {
          for (const model of provider.models) {
            try {
              visionResult = await callOpenRouter(model, prompt, image, mimeType, provider.key);
              if (visionResult) break;
            } catch (e) {
              errors.push(`OpenRouter ${model}: ${e.message}`);
            }
          }
        }
      } catch (err) {
        errors.push(`${provider.name}: ${err.message}`);
      }
    }

    if (!visionResult) {
      const fallbackResult = await createOfflineFallbackResult(mode, extractedText, medications);
      return res.status(200).json(finalizeResultForMode(fallbackResult, mode, extractedText));
    }

    return res.status(200).json(finalizeResultForMode(visionResult, mode, extractedText));
  } catch (err) {
    console.error('Handler error:', err.message);
    const fallbackResult = await createOfflineFallbackResult(mode, extractedText, '');
    return res.status(200).json(finalizeResultForMode(fallbackResult, mode, ''));
  }
}

async function callGemini(modelName, prompt, imageData, mimeType, apiKey) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);

  const parts = [{ text: prompt }];
  if (imageData) {
    parts.push({ inline_data: { mime_type: mimeType, data: imageData } });
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json'
          }
        })
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(errText || `Google API Error ${response.status}`);
    }

    const data = await response.json();
    if (!data.candidates || data.candidates.length === 0) {
      throw new Error(data.promptFeedback?.blockReason || 'No response');
    }

    const text = data.candidates[0].content.parts[0].text || '{}';
    let cleanText = text;
    
    const jsonMatch = cleanText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      cleanText = jsonMatch[1];
    } else {
      const braceMatch = cleanText.match(/\{[\s\S]*\}/);
      if (braceMatch) cleanText = braceMatch[0];
    }
    
    const res = JSON.parse(cleanText);
    res.engine = modelName.includes('pro') ? 'Clinical Expert' : 'High-Speed Parser';
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenRouter(modelName, prompt, imageData, mimeType, apiKey) {
  const content = imageData
    ? [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageData}` } }
      ]
    : prompt;

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://medswift.app',
      'X-Title': 'MedSwift'
    },
    body: JSON.stringify({
      model: modelName,
      messages: [{ role: 'user', content }],
      response_format: { type: 'json_object' }
    })
  });

  if (!response.ok) throw new Error(await response.text());
  
  const data = await response.json();
  const text = data.choices[0].message.content || '{}';
  let cleanText = text;
  
  const jsonMatch = cleanText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    cleanText = jsonMatch[1];
  } else {
    const braceMatch = cleanText.match(/\{[\s\S]*\}/);
    if (braceMatch) cleanText = braceMatch[0];
  }
  
  const res = JSON.parse(cleanText);
  res.engine = `Global Auditor (${modelName.split('/')[1] || modelName})`;
  return res;
}
