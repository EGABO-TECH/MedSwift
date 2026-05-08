import { findBatchByGTIN, getReferenceData } from './db.js';

export function parseGS1(rawData) {
  const result = {};
  const aiPatterns = {
    gtin:   /(?:\(01\)|^01)(\d{14})/,
    lot:    /(?:\(10\)|10)([A-Z0-9\-]{1,20})/i,
    serial: /(?:\(21\)|21)([A-Z0-9\-]{1,20})/i
  };

  for (const [key, pattern] of Object.entries(aiPatterns)) {
    const match = rawData.match(pattern);
    if (match) result[key] = match[1];
  }
  if (!result.gtin && /^\d{14}$/.test(rawData.trim())) result.gtin = rawData.trim();
  return result;
}

export async function verifyScannedCode(rawData) {
  const startTime = performance.now();
  const gs1 = parseGS1(rawData);

  if (!gs1.gtin) {
    return { authentic: false, rawData, verifyMs: Math.round(performance.now() - startTime) };
  }

  // 1. Check local offline reference data (RxNorm/openFDA subset)
  const referenceData = await getReferenceData(gs1.gtin);
  
  // 2. Check internal medication batch tracking
  const batch = await findBatchByGTIN(gs1.gtin, gs1.lot);
  
  const isAuthentic = !!batch && !!referenceData;

  return {
    authentic: isAuthentic,
    gs1,
    batch,
    fdaEnrichment: referenceData,
    timestamp: new Date().toISOString(),
    verifyMs: Math.round(performance.now() - startTime)
  };
}

export async function startCamera(videoEl, onResult) {
  const reader = new ZXing.BrowserMultiFormatReader();
  try {
    const devices = await reader.listVideoInputDevices();
    const backCamera = devices.find(d => /back|rear|environment/i.test(d.label)) || devices[0];
    
    if (!backCamera) throw new Error('No camera');
    
    await reader.decodeFromVideoDevice(backCamera.deviceId, videoEl, (result) => {
      if (result) onResult(result.getText());
    });
    return reader;
  } catch (err) {
    console.error(err);
    return null;
  }
}
