import { GEMINI_API_KEY } from './config.js';

export async function identifyMedication(base64Image, signal) {
  const startTime = performance.now();

  // 1. Check Local Cache (Visual Signature Simulation)
  // In a production app, we would generate a robust image hash.
  // For this PWA, we simulate a 'visual signature' match.
  const cached = await checkLocalVisualCache(base64Image);
  if (cached) {
    return { ...cached, cached: true, verifyMs: Math.round(performance.now() - startTime) };
  }

  // 2. Gemini 1.5 Flash Vision Pipeline
  const prompt = "Identify this medication. Extract: [Drug Name], [Manufacturer/Origin], [Indication/Disease], [Dosage Form], and [Expiry Pattern]. Cross-reference with openFDA standards. Return as JSON with fields: drugName, manufacturer, indication, dosageForm, expiryPattern, confidenceScore (0-100), and originVerified (boolean).";

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: "image/jpeg", data: base64Image.split(',')[1] } }
          ]
        }]
      })
    });

    const data = await response.json();
    const resultText = data.candidates[0].content.parts[0].text;
    const visionResult = JSON.parse(resultText.replace(/```json|```/g, ''));

    // 3. Validation Layer (RxNorm Cross-Reference)
    const isValidated = await validateWithRxNorm(visionResult.drugName);

    const finalResult = {
      ...visionResult,
      authentic: visionResult.confidenceScore >= 85 && isValidated,
      manualReviewRequired: visionResult.confidenceScore < 85,
      verifyMs: Math.round(performance.now() - startTime),
      timestamp: new Date().toISOString()
    };

    // Cache for offline use
    if (finalResult.confidenceScore >= 95) {
      await cacheVisualSignature(base64Image, finalResult);
    }

    return finalResult;
  } catch (err) {
    if (err.name === 'AbortError') throw err; // Propagate abort to app.js
    console.error("Vision Pipeline Error:", err);
    return { error: "MedSwift Vision Unavailable", authentic: false };
  }
}

async function validateWithRxNorm(drugName) {
  // Mocking RxNorm validation against our local Dexie referenceData
  const Dexie = (await import('./db.js')).db;
  const match = await Dexie.referenceData.where('brandName').equalsIgnoreCase(drugName).first();
  return !!match;
}

async function checkLocalVisualCache(image) {
  // Simplified: In a real app, use a perceptual hash
  return null;
}

async function cacheVisualSignature(image, result) {
  const Dexie = (await import('./db.js')).db;
  await Dexie.visualCache.put({ imageHash: 'simulated_hash', ...result });
}

export async function captureFrame(videoEl) {
  const canvas = document.createElement('canvas');
  canvas.width = videoEl.videoWidth;
  canvas.height = videoEl.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(videoEl, 0, 0);
  return canvas.toDataURL('image/jpeg', 0.8);
}

export async function startCamera(videoEl) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' }
    });
    videoEl.srcObject = stream;
    await videoEl.play();
    return stream;
  } catch (err) {
    console.error("Camera Access Error:", err);
    return null;
  }
}

