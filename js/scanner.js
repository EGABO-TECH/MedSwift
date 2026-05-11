/**
 * MedVision Scanner Engine
 * Handles camera, frame capture, AI identification, and local caching.
 */

// ─── PROCESSING LOCK & ENGINES ───
let _isProcessing = false;

// Bug #2 Fix: Lazy-initialize ZXing only when first needed.
// Instantiating at module-scope caused a ReferenceError because the ZXing CDN
// script had not finished executing when the ES module was first parsed.
let _codeReader = null;
function getCodeReader() {
  if (!_codeReader) {
    if (typeof ZXing === 'undefined') {
      console.error('MedVision: ZXing library not found in window scope.');
      return null;
    }
    _codeReader = new ZXing.BrowserMultiFormatReader();
    console.log('MedVision: ZXing Reader initialized.');
  }
  return _codeReader;
}

export function isScannerBusy() {
  return _isProcessing;
}

// ─── BARCODE SCANNING ───
/**
 * Scans a video element for 2D GS1 DataMatrix or QR codes.
 */
export async function scanBarcode(videoEl) {
  const reader = getCodeReader();
  if (!reader) return null;

  try {
    // We use a shorter timeout or just check once if possible
    // Note: decodeOnceFromVideoElement will wait until it finds a barcode.
    // This can block the vision loop. We wrap it in a timeout or race.
    const result = await Promise.race([
      reader.decodeOnceFromVideoElement(videoEl),
      new Promise((_, reject) => setTimeout(() => reject('timeout'), 800))
    ]);

    if (result) {
      console.log('MedVision: Barcode detected:', result.text);
      return result.text;
    }
  } catch (err) {
    // 'timeout' or NotFound is expected
    return null;
  }
  return null;
}

/**
 * Scans a static image element for barcodes.
 */
export async function scanBarcodeFromImage(imgEl) {
  try {
    const result = await getCodeReader().decodeFromImageElement(imgEl);
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
  console.log('MedVision: Starting camera...');
  try {
    const constraints = {
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    console.log('MedVision: getUserMedia success.');
    videoEl.srcObject = stream;
    videoEl.style.opacity = '1';
    videoEl.classList.add('is-active');
    
    if (videoEl.readyState >= 2) {
      await videoEl.play();
      console.log('MedVision: Video playing (immediate).');
      return stream;
    }

    return new Promise((resolve) => {
      videoEl.onloadedmetadata = () => {
        videoEl.play()
          .then(() => {
            console.log('MedVision: Video playing (event).');
            resolve(stream);
          })
          .catch(e => {
            console.warn('MedVision: Play interrupted:', e.message);
            resolve(stream);
          });
      };
      
      // Safety timeout
      setTimeout(() => {
        console.log('MedVision: Camera start timeout reached.');
        resolve(stream);
      }, 3000);
    });
  } catch (err) {
    console.error('MedVision: Camera Access Error:', err.name, err.message);
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
      // Bug #4 Fix: Re-derive manualReviewRequired from the cached confidence score.
      // It was not stored in earlier cache writes, so we recompute it here to ensure
      // the result card shows the correct clinical badge (e.g. "Manual Review" at 50%).
      const cs = cached.confidenceScore ?? 0;
      return {
        ...cached,
        authentic:            cs >= 80 && cached.originVerified,
        manualReviewRequired: cs > 0 && cs < 80,
        cached:               true,
        verifyMs:             Math.round(performance.now() - startTime)
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
    // Bug #4 Fix: Store the full finalResult (which already contains manualReviewRequired)
    // so future cache hits can correctly re-derive clinical flags.
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
