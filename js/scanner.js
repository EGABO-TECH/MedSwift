/**
 * MedVision Scanner Engine
 * Handles camera, frame capture, AI identification, and local caching.
 */

// ─── PROCESSING LOCK & ENGINES ───
let _isProcessing = false;
const codeReader = new ZXing.BrowserMultiFormatReader();

export function isScannerBusy() {
  return _isProcessing;
}

// ─── BARCODE SCANNING ───
/**
 * Scans a video element for 2D GS1 DataMatrix or QR codes.
 */
export async function scanBarcode(videoEl) {
  try {
    // We attempt a single-frame decode to keep the loop performant
    const result = await codeReader.decodeFromVideoElement(videoEl);
    if (result) {
      console.log('MedVision: Barcode detected:', result.text);
      return result.text;
    }
  } catch (err) {
    // ZXing throws if no code is found in the frame; we ignore this.
    return null;
  }
  return null;
}

/**
 * Scans a static image element for barcodes.
 */
export async function scanBarcodeFromImage(imgEl) {
  try {
    const result = await codeReader.decodeFromImageElement(imgEl);
    if (result) {
      console.log('MedVision: Barcode detected in image:', result.text);
      return result.text;
    }
  } catch (err) {
    return null;
  }
  return null;
}

// ─── CAMERA ───
export async function startCamera(videoEl) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' }, // Prefer rear camera
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    });
    videoEl.srcObject = stream;
    await videoEl.play();
    return stream;
  } catch (err) {
    console.error('Camera Access Error:', err.name, err.message);
    return null;
  }
}

// ─── FRAME CAPTURE ───
export async function captureFrame(videoEl) {
  if (!videoEl.videoWidth || !videoEl.videoHeight) return null;
  const canvas = document.createElement('canvas');
  canvas.width = videoEl.videoWidth;
  canvas.height = videoEl.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(videoEl, 0, 0);
  return canvas.toDataURL('image/jpeg', 0.85);
}

// ─── MAIN IDENTIFICATION FUNCTION ───
export async function identifyMedication(base64Image, signal) {
  if (_isProcessing) {
    return null; // Silently drop — a scan is already underway
  }
  _isProcessing = true;
  const startTime = performance.now();

  try {
    // 1. Check Local Visual Cache (Perceptual Hash)
    const imageHash = await computeImageHash(base64Image);
    const cached = await checkLocalVisualCache(imageHash);
    if (cached) {
      console.log('MedVision: Cache hit — returning offline result.');
      return {
        ...cached,
        cached: true,
        verifyMs: Math.round(performance.now() - startTime)
      };
    }

    // 2. Secure Proxy Call → Gemini 1.5 Flash via Vercel Serverless
    const mimeMatch = base64Image.match(/^data:(image\/[a-zA-Z+]+);base64,/);
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';

    const response = await fetch('/api/identify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({ 
        image: base64Image.split(',')[1],
        mimeType: mimeType
      })
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({ error: 'Unknown proxy error' }));
      throw new Error(errData.error || `Proxy returned ${response.status}`);
    }

    const visionResult = await response.json();

    // 3. Local RxNorm/openFDA Cross-Reference Validation
    const localRef = await validateWithLocalDB(visionResult.drugName, visionResult.genericName);

    const finalResult = {
      ...visionResult,
      // Enhance with our richer local DB data if we have a match
      ...(localRef ? {
        dosageInstructions: localRef.dosageInstructions || visionResult.dosageInstructions,
        warnings:           localRef.warnings           || visionResult.warnings,
        isEssentialMedicine: localRef.isEssentialMedicine ?? visionResult.isEssentialMedicine ?? false,
        lifestyleNudge:     localRef.lifestyleNudge     || visionResult.lifestyleNudge,
        suggestedBiomarkers: localRef.suggestedBiomarkers || visionResult.suggestedBiomarkers,
        proactiveInsight:   localRef.proactiveInsight   || visionResult.proactiveInsight,
        therapeuticClass:   localRef.therapeuticClass   || visionResult.therapeuticClass,
        pathway:            localRef.pathway            || visionResult.pathway,
        regulatoryStatus:   localRef.regulatoryStatus   || visionResult.regulatoryStatus,
        localDbMatch:       true
      } : {
        isEssentialMedicine: visionResult.isEssentialMedicine ?? false,
        localDbMatch:       false
      }),
      authentic:            (visionResult.confidenceScore ?? 0) >= 80 && visionResult.originVerified,
      manualReviewRequired: (visionResult.confidenceScore ?? 0) > 0 && (visionResult.confidenceScore ?? 0) < 80,
      verifyMs:             Math.round(performance.now() - startTime),
      timestamp:            new Date().toISOString()
    };

    // 4. Cache High-Confidence Results for Offline Use
    if ((finalResult.confidenceScore ?? 0) >= 90) {
      await cacheVisualSignature(imageHash, finalResult);
    }

    return finalResult;

  } catch (err) {
    if (err.name === 'AbortError') throw err; // Propagate user cancellation
    console.error('MedVision Pipeline Error:', err.message);
    return { error: err.message || 'MedSwift Vision Unavailable', authentic: false };
  } finally {
    _isProcessing = false;
  }
}

// ─── LOCAL DATABASE VALIDATION ───
// Cross-references Gemini output against our seeded Dexie RxNorm/openFDA subset.
async function validateWithLocalDB(brandName, genericName) {
  try {
    const { db } = await import('./db.js');
    let match = null;

    if (brandName) {
      match = await db.referenceData
        .where('brandName').equalsIgnoreCase(brandName).first();
    }
    if (!match && genericName) {
      // Fallback: search by a partial keyword from the generic name
      const keyword = genericName.split(' ')[0]; // e.g. "Metformin" from "Metformin HCl 500mg"
      match = await db.referenceData
        .filter(r => r.genericName && r.genericName.toLowerCase().includes(keyword.toLowerCase()))
        .first();
    }
    return match || null;
  } catch (e) {
    console.warn('Local DB validation skipped:', e.message);
    return null;
  }
}

// ─── VISUAL CACHE (IndexedDB via Dexie) ───
async function checkLocalVisualCache(imageHash) {
  try {
    const { db } = await import('./db.js');
    return await db.visualCache.where('imageHash').equals(imageHash).first() || null;
  } catch (e) {
    return null;
  }
}

async function cacheVisualSignature(imageHash, result) {
  try {
    const { db } = await import('./db.js');
    await db.visualCache.put({ imageHash, ...result, cachedAt: new Date().toISOString() });
    console.log('MedVision: Result cached for offline use.');
  } catch (e) {
    console.warn('Cache write failed:', e.message);
  }
}

// ─── PERCEPTUAL HASH ───
// A lightweight, fast hash using the WebCrypto API.
// Downsamples the image and hashes the pixel data — similar images get similar hashes.
async function computeImageHash(base64Image) {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const ctx = canvas.getContext('2d');

    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = base64Image;
    });

    ctx.drawImage(img, 0, 0, 16, 16);
    const pixelData = ctx.getImageData(0, 0, 16, 16).data;

    // Compute mean brightness
    let total = 0;
    const grayscale = [];
    for (let i = 0; i < pixelData.length; i += 4) {
      const gray = (pixelData[i] * 0.299 + pixelData[i+1] * 0.587 + pixelData[i+2] * 0.114);
      grayscale.push(gray);
      total += gray;
    }
    const mean = total / grayscale.length;

    // Build binary hash: 1 if pixel is above mean, 0 otherwise
    return grayscale.map(v => (v >= mean ? '1' : '0')).join('');
  } catch (e) {
    // Fallback: use a simple string length hash
    return `fallback-${base64Image.length}`;
  }
}
