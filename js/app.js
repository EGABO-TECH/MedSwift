import { appState } from './state.js';
import { seedDemoData } from './db.js';
import { startCamera, captureFrame, identifyMedication, isScannerBusy, scanBarcode, scanBarcodeFromImage } from './scanner.js';

let activeStream = null;
let scanInterval = null;
let analysisController = null;
let lastDetectedBarcode = null;

// ─── UI ELEMENT REGISTRY ───
const els = {
  // Scanner view
  video:             document.getElementById('scanner-video'),
  placeholder:       document.getElementById('scanner-placeholder'),
  beam:              document.getElementById('scanner-beam'),
  shimmer:           document.getElementById('holo-shimmer'),
  prompt:            document.getElementById('scanner-prompt'),
  resultCard:        document.getElementById('scan-result-card'),
  controls:          document.getElementById('scanner-controls'),
  btnStartScan:      document.getElementById('btn-start-scan'),
  btnUploadScan:     document.getElementById('btn-upload-scan'),
  uploadInput:       document.getElementById('upload-input'),
  dismissScan:       document.getElementById('dismiss-scan'),
  verificationZone:  document.getElementById('verification-zone'),
  intelligenceIcon:  document.getElementById('intelligence-icon'),
  cancelAnalysisBox: document.getElementById('analysis-cancel-box'),
  btnCancelAnalysis: document.getElementById('btn-cancel-analysis'),
  btnDownloadPdf:    document.getElementById('btn-download-pdf'),
  uploadPreview:     document.getElementById('scanner-upload-preview'),

  // Result card fields
  resultIconBg:      document.getElementById('result-icon-bg'),
  resultIcon:        document.getElementById('result-icon'),
  resultTitle:       document.getElementById('result-title'),
  resultDataRows:    document.getElementById('result-data-rows'),
  resultDetailsBox:  document.getElementById('result-details-box'),

  // Audit Trail
  auditList:         document.getElementById('audit-trail-list')
};

// ─── INITIALIZATION ───
document.addEventListener('DOMContentLoaded', async () => {
  await seedDemoData();
  setupEventListeners();
});

// ─── EVENT LISTENERS ───
function setupEventListeners() {

  // ── Start Live Vision ──
  els.btnStartScan.addEventListener('click', async () => {
    appState.set('scanStatus', 'scanning');
    showScannerActive();

    activeStream = await startCamera(els.video);
    if (!activeStream) {
      showCameraError();
      return;
    }

    // MedVision Hybrid Sentinel:
    // 1. High-frequency Barcode Scan (Local, Lightweight)
    // 2. Periodic Vision Analysis (Cloud AI)
    scanInterval = setInterval(async () => {
      const status = appState.get('scanStatus');
      if (status !== 'scanning') return;

      // Part A: Barcode Detection (Every 1s)
      const barcodeText = await scanBarcode(els.video);
      if (barcodeText && barcodeText !== lastDetectedBarcode) {
        lastDetectedBarcode = barcodeText;
        handleBarcodeDetection(barcodeText);
      }

      // Part B: Vision Analysis (Every 4s, if not already processing)
      if (!isScannerBusy()) {
        const frame = await captureFrame(els.video);
        if (frame) await processVisionFrame(frame);
      }
    }, 1000); 
  });

  // ── Upload Image ──
  els.btnUploadScan.addEventListener('click', () => els.uploadInput.click());

  els.uploadInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      let base64Image = event.target.result;
      
      // Optimize image for AI (Resize to max 1280px while keeping aspect ratio)
      try {
        base64Image = await resizeImage(base64Image, 1280);
      } catch (e) {
        console.warn('Image optimization skipped:', e);
      }
      
      // Part 1: Setup UI for the uploaded asset
      stopCamera(); 
      if (scanInterval) clearInterval(scanInterval);
      
      els.uploadPreview.src = base64Image;
      els.uploadPreview.classList.remove('hidden');
      els.placeholder.classList.add('hidden');
      els.video.classList.remove('is-active');
      
      showScannerActive(); // Shows beam, hides controls

      // Part 2: Trigger the Sentinel Analysis
      // Attempt barcode scan from the image first
      const barcodeText = await scanBarcodeFromImage(els.uploadPreview);
      if (barcodeText) {
        handleBarcodeDetection(barcodeText);
      }

      // Run Vision analysis
      await processVisionFrame(base64Image);
      
      els.uploadInput.value = ''; 
    };
    reader.readAsDataURL(file);
  });

  // ── Cancel Analysis ──
  els.btnCancelAnalysis.addEventListener('click', () => {
    if (analysisController) {
      analysisController.abort();
      analysisController = null;
    }
    resetScannerUI();
  });

  // ── Dismiss Result Card ──
  els.dismissScan.addEventListener('click', resetScannerUI);

  // ── PDF Download ──
  if (els.btnDownloadPdf) {
    els.btnDownloadPdf.addEventListener('click', async () => {
      const result = appState.get('lastResult');
      if (!result) return;
      
      const originalHTML = els.btnDownloadPdf.innerHTML;
      els.btnDownloadPdf.innerHTML = '<span class="btn-spinner" style="width:14px;height:14px;border-width:2px;"></span> GENERATING...';
      els.btnDownloadPdf.disabled = true;

      await generatePDFReport(result);

      els.btnDownloadPdf.innerHTML = originalHTML;
      els.btnDownloadPdf.disabled = false;
    });
  }
}

// ─── SCANNER UI STATE ───
function showScannerActive() {
  els.placeholder.classList.add('hidden');
  els.video.classList.add('is-active');
  els.beam.classList.remove('hidden');
  els.prompt.classList.add('hidden');
  els.controls.classList.add('hidden');
  els.verificationZone.classList.remove('hidden');
}

function showCameraError() {
  resetScannerUI();
  // Show a brief toast-style error
  const toast = document.createElement('div');
  toast.style.cssText = `
    position: fixed; bottom: 100px; left: 50%; transform: translateX(-50%);
    background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.4);
    color: #EF4444; padding: 12px 24px; border-radius: 8px; font-size: 13px;
    font-family: 'DM Sans', sans-serif; font-weight: 500; z-index: 9999;
    backdrop-filter: blur(10px); animation: slideUp 0.3s ease;
  `;
  toast.textContent = '⚠ Camera access denied. Please allow camera permissions and try again.';
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ─── VISION PROCESSING CORE ───
async function processVisionFrame(frame) {
  if (isScannerBusy()) return; // Double-guard

  appState.set('scanStatus', 'verifying');
  els.beam.classList.add('intelligence-glow');
  els.shimmer.classList.remove('hidden');
  els.intelligenceIcon.classList.add('status-pulse');
  els.cancelAnalysisBox.classList.remove('hidden');

  analysisController = new AbortController();

  try {
    const result = await identifyMedication(frame, analysisController.signal);

    // Null means the scanner was already busy — silently ignore
    if (result === null) {
      appState.set('scanStatus', 'scanning');
      return;
    }

    if (result.error) {
      // Non-fatal error — stay in scanning mode and show a brief message
      appState.set('scanStatus', 'scanning');
      els.beam.classList.remove('intelligence-glow');
      els.shimmer.classList.add('hidden');
      els.cancelAnalysisBox.classList.add('hidden');
      els.intelligenceIcon.classList.remove('status-pulse');
      showInlineError(result.error);
      return;
    }

    // Success — stop the scan loop and display results
    clearInterval(scanInterval);
    scanInterval = null;
    stopCamera();

    els.shimmer.classList.add('hidden');
    els.beam.classList.remove('intelligence-glow');
    els.cancelAnalysisBox.classList.add('hidden');
    els.intelligenceIcon.classList.remove('status-pulse');

    showResultCard(result);
    addToAuditTrail(result);

  } catch (err) {
    if (err.name === 'AbortError') {
      console.log('Analysis cancelled by user.');
    } else {
      console.error('Unexpected analysis error:', err);
      appState.set('scanStatus', 'scanning');
    }
  }
}

/**
 * Handles a successful barcode detection.
 * Parses the GS1 string and attempts a ledger lookup.
 */
async function handleBarcodeDetection(rawText) {
  const gs1Data = parseGS1(rawText);
  if (!gs1Data.gtin) return;

  console.log('MedVision Ledger: Searching for GTIN', gs1Data.gtin);
  
  // Visual feedback: emerald flash and beam lock
  els.intelligenceIcon.style.color = '#10B981';
  els.beam.style.background = 'linear-gradient(90deg, transparent, #10B981, #34D399, #10B981, transparent)';
  els.beam.style.boxShadow = '0 0 20px rgba(16, 185, 129, 0.6)';
  
  setTimeout(() => {
    els.intelligenceIcon.style.color = '';
    if (appState.get('scanStatus') === 'verifying') {
       // Keep the purple intelligence glow if vision is still running
    } else {
       els.beam.style.background = '';
       els.beam.style.boxShadow = '';
    }
  }, 1000);

  // Look up in our local medication ledger
  const { db } = await import('./db.js');
  const batch = await db.medicationBatch.where({ gtin: gs1Data.gtin, lot: gs1Data.lot }).first();

  if (batch) {
    console.log('MedVision Ledger: Batch found!', batch);
    // Store this in appState so showResultCard can use it
    appState.set('currentBatch', { ...gs1Data, ...batch, verified: true });
    
    // If we're already showing a card, update it live
    if (!els.resultCard.classList.contains('hidden')) {
      updateResultCardWithLedger(appState.get('currentBatch'));
    }
  } else {
    appState.set('currentBatch', { ...gs1Data, verified: false });
  }
}

/**
 * Simple GS1 DataMatrix Parser for common AIs
 * (01) GTIN, (10) Lot, (17) Expiry, (21) Serial
 */
function parseGS1(text) {
  const data = {};
  
  // Regex patterns for standard AIs
  const gtinMatch = text.match(/\(01\)(\d{14})/);
  const lotMatch = text.match(/\(10\)([A-Z0-9-]+)/);
  const expiryMatch = text.match(/\(17\)(\d{6})/);
  const serialMatch = text.match(/\(21\)([A-Z0-9-]+)/);

  if (gtinMatch) data.gtin = gtinMatch[1];
  if (lotMatch) data.lot = lotMatch[1];
  if (expiryMatch) data.expiry = expiryMatch[1];
  if (serialMatch) data.serial = serialMatch[1];

  return data;
}

function updateResultCardWithLedger(batch) {
  const ledgerEl = document.getElementById('ledger-sync-row');
  if (!ledgerEl) return;

  ledgerEl.innerHTML = `
    <span class="data-label">GS1 Ledger</span>
    <span class="data-value" style="color: #10B981; font-weight: 700;">
      <i data-lucide="check-circle" style="width:12px;height:12px;margin-right:6px;vertical-align:middle;"></i>SYNCHRONIZED
    </span>
  `;
  
  // Add Batch/Serial details to the bottom
  const details = els.resultDetailsBox;
  const existingBatch = document.getElementById('ledger-audit-block');
  if (existingBatch) existingBatch.remove();

  const batchBlock = document.createElement('div');
  batchBlock.id = 'ledger-audit-block';
  batchBlock.className = 'detail-block';
  batchBlock.style.border = '1px solid rgba(16, 185, 129, 0.2)';
  batchBlock.style.background = 'rgba(16, 185, 129, 0.03)';
  batchBlock.innerHTML = `
    <div class="detail-title" style="color: #10B981;"><i data-lucide="database" style="width:12px;height:12px;"></i> Supply Chain Audit</div>
    <div class="detail-text" style="font-family: 'JetBrains Mono', monospace; font-size: 11px; color: #10B981; opacity: 0.9;">
      GTIN: ${batch.gtin} <br>
      LOT: ${batch.lot} <br>
      SERIAL: ${batch.serial} <br>
      EXPIRY: ${batch.expiry}
    </div>
  `;
  details.appendChild(batchBlock);
  lucide.createIcons();
}

// ─── RESULT CARD ───
function showResultCard(result) {
  const isOk     = result.authentic === true;
  const isManual = result.manualReviewRequired === true;
  const isLow    = !isOk && !isManual;

  // Card class / glow state
  els.resultCard.className = 'result-card slide-up truth-report';
  if (isManual) els.resultCard.classList.add('manual-review');
  if (isLow)    els.resultCard.classList.add('unverified');

  // Icon & Title
  const iconName  = isOk ? 'shield-check' : (isManual ? 'alert-circle' : 'shield-alert');
  const titleText = isOk ? 'Authentic' : (isManual ? 'Manual Review' : 'Unverified');
  els.resultIcon.setAttribute('data-lucide', iconName);
  els.resultTitle.textContent = `Truth Report: ${titleText}`;

  // Core data rows
  const confidence = result.confidenceScore ?? 0;
  const confColor  = confidence >= 80 ? '#10B981' : (confidence >= 50 ? '#EAB308' : '#EF4444');

  els.resultDataRows.innerHTML = `
    <div class="data-row">
      <span class="data-label">Product Name</span>
      <span class="data-value" style="font-family: 'Playfair Display', serif; font-size: 16px;">${escapeHtml(result.drugName || 'Unknown')}</span>
    </div>
    ${result.genericName ? `
    <div class="data-row">
      <span class="data-label">Generic ID</span>
      <span class="data-value" style="font-size: 12px; color: var(--teal-primary); opacity: 0.9;">${escapeHtml(result.genericName)}</span>
    </div>` : ''}
    <div class="data-row">
      <span class="data-label">Manufacturer</span>
      <span class="data-value">${escapeHtml(result.manufacturer || 'Unverified')}</span>
    </div>
    <div class="data-row">
      <span class="data-label">Verification Score</span>
      <span class="data-value" style="color: ${confColor}; font-weight: 800;">${confidence}%</span>
    </div>
    <div class="data-row" id="ledger-sync-row">
      <span class="data-label">GS1 Ledger</span>
      <span class="data-value" style="opacity: 0.4; font-size: 11px; font-weight: 800; letter-spacing: 1px;">AWAITING BARCODE</span>
    </div>
  `;

  // Detail blocks (clinical intelligence)
  const hasIndication = result.indication && result.indication !== 'null';
  const hasDosage     = result.dosageInstructions && result.dosageInstructions !== 'null';
  const hasWarning    = result.warnings && result.warnings !== 'null';

  els.resultDetailsBox.innerHTML = `
    ${hasIndication ? `
    <div class="detail-block">
      <div class="detail-title"><i data-lucide="activity"></i> Primary Indication</div>
      <div class="detail-text">${escapeHtml(result.indication)}</div>
    </div>` : ''}

    ${hasWarning ? `
    <div class="detail-block" style="border: 1px solid rgba(239, 68, 68, 0.2); background: rgba(239, 68, 68, 0.02);">
      <div class="detail-title" style="color: #EF4444;"><i data-lucide="alert-triangle"></i> Critical Warning</div>
      <div class="detail-text" style="color: #EF4444; font-weight: 500;">${escapeHtml(result.warnings)}</div>
    </div>` : ''}

    ${hasDosage ? `
    <div class="detail-block">
      <div class="detail-title"><i data-lucide="pill"></i> Dosage Instructions</div>
      <div class="detail-text">${escapeHtml(result.dosageInstructions)}</div>
    </div>` : ''}

    <div class="detail-block">
      <div class="detail-title"><i data-lucide="thermometer"></i> Storage Conditions</div>
      <div class="detail-text">${escapeHtml(result.storage || 'Standard pharmaceutical storage (Cool, dry place).')}</div>
    </div>

    ${result.confidenceRationale ? `
    <div class="detail-block" style="background: rgba(13, 148, 136, 0.05); border-color: rgba(13, 148, 136, 0.2);">
      <div class="detail-title" style="color: var(--teal-primary);"><i data-lucide="brain"></i> Confidence Rationale</div>
      <div class="detail-text" style="font-size: 11px; font-style: italic;">${escapeHtml(result.confidenceRationale)}</div>
    </div>` : ''}

    <div class="detail-block">
      <div class="detail-title"><i data-lucide="shield"></i> Institutional Verification</div>
      <div class="detail-text">${result.originVerified
        ? 'Origin verified against GS1 Global Pharma Index.'
        : 'Manufacturer origin data is outside verified supply chain databases.'
      }</div>
    </div>

    <div class="detail-block" style="background: rgba(255, 255, 255, 0.01); border: 1px dashed rgba(255, 255, 255, 0.05);">
      <div class="detail-text" style="font-size: 10px; opacity: 0.4; text-transform: uppercase; letter-spacing: 1px; font-family: 'JetBrains Mono', monospace;">
        Ref: ${Date.now()} | Engine: MedVision 2.5 | Latency: ${result.verifyMs ?? '—'}ms
      </div>
    </div>
  `;

  // Update state and icons
  appState.set('lastResult', result);
  els.resultCard.classList.remove('hidden');
  lucide.createIcons();
}

// ─── INLINE ERROR (scan still active) ───
function showInlineError(message) {
  const existing = document.getElementById('scan-inline-error');
  if (existing) existing.remove();

  const el = document.createElement('div');
  el.id = 'scan-inline-error';
  el.style.cssText = `
    position: absolute; bottom: 80px; left: 50%; transform: translateX(-50%);
    background: rgba(239,68,68,0.12); border: 1px solid rgba(239,68,68,0.3);
    color: #EF4444; padding: 8px 16px; border-radius: 6px; font-size: 11px;
    font-family: 'DM Sans', sans-serif; font-weight: 500; z-index: 20;
    white-space: nowrap; backdrop-filter: blur(8px);
  `;
  el.textContent = `⚠ ${message}`;
  els.resultCard.parentElement.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ─── SCANNER TEARDOWN ───
function stopCamera() {
  if (activeStream) {
    activeStream.getTracks().forEach(track => track.stop());
    activeStream = null;
  }
}

function resetScannerUI() {
  appState.set('scanStatus', 'idle');
  appState.set('currentBatch', null);
  lastDetectedBarcode = null;

  els.resultCard.classList.add('hidden');
  els.uploadPreview.classList.add('hidden');
  els.uploadPreview.src = '';
  els.prompt.classList.remove('hidden');
  els.controls.classList.remove('hidden');
  els.placeholder.classList.remove('hidden');
  els.video.classList.remove('is-active');
  els.verificationZone.classList.add('hidden');
  els.intelligenceIcon.classList.remove('status-pulse');
  els.cancelAnalysisBox.classList.add('hidden');
  els.beam.classList.add('hidden');
  els.beam.classList.remove('intelligence-glow');
  els.shimmer.classList.add('hidden');

  const inlineErr = document.getElementById('scan-inline-error');
  if (inlineErr) inlineErr.remove();

  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }
  stopCamera();
}

// ─── AUDIT TRAIL ───
function addToAuditTrail(result) {
  const history = appState.get('scanHistory') || [];
  history.unshift(result);
  appState.set('scanHistory', history.slice(0, 50));
  renderAuditTrail();
}

function renderAuditTrail() {
  const history = appState.get('scanHistory') || [];
  if (history.length === 0) return;

  els.auditList.innerHTML = history.map((scan, i) => {
    const ok     = scan.authentic;
    const manual = scan.manualReviewRequired;
    const color  = ok ? 'var(--success)' : (manual ? '#EAB308' : 'var(--danger)');
    const bg     = ok ? 'rgba(34,197,94,0.1)' : (manual ? 'rgba(234,179,8,0.1)' : 'rgba(239,68,68,0.1)');
    const icon   = ok ? 'check' : (manual ? 'alert-circle' : 'x');
    const name   = scan.drugName || 'Unknown Product';
    const time   = scan.timestamp ? new Date(scan.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

    return `
      <div class="audit-item" style="
        animation: slideUp 0.3s ease ${i * 0.05}s forwards;
        opacity: 0;
        transform: translateY(10px);
        border-color: ${color};
      ">
        <div class="audit-item-icon" style="background: ${bg};">
          <i data-lucide="${icon}" style="width: 14px; height: 14px; color: ${color};"></i>
        </div>
        <div class="audit-item-info">
          <div class="audit-item-header">
            <span class="audit-item-name">${escapeHtml(name)}</span>
            <span class="audit-item-badge" style="background: ${bg}; color: ${color};">${scan.confidenceScore ?? '—'}%</span>
          </div>
          <div class="audit-item-meta">
            ${escapeHtml(scan.manufacturer || 'Unknown')}
            ${scan.verifyMs ? ` • ${scan.verifyMs}ms` : ''}
            ${time ? ` • ${time}` : ''}
            ${scan.cached ? ' • <span style="color: var(--purple-glow);">Cached</span>' : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');

  lucide.createIcons();
}

// ─── PDF REPORT GENERATION ───
/**
 * Generates an Institutional-Grade Audit Report.
 * Constructing a clean, high-contrast template specifically for PDF.
 */
async function generatePDFReport(result) {
  const isOk = result.authentic === true;
  const statusColor = isOk ? '#10B981' : (result.manualReviewRequired ? '#EAB308' : '#EF4444');
  const statusText = isOk ? 'AUTHENTIC' : (result.manualReviewRequired ? 'MANUAL REVIEW REQUIRED' : 'UNVERIFIED / COUNTERFEIT RISK');
  
  // Construct the template
  const reportEl = document.createElement('div');
  reportEl.style.width = '700px';
  reportEl.style.padding = '60px';
  reportEl.style.background = '#FFFFFF';
  reportEl.style.color = '#000000';
  reportEl.style.fontFamily = "'Inter', sans-serif";
  reportEl.style.position = 'absolute';
  reportEl.style.left = '-9999px';
  reportEl.style.top = '-9999px';

  reportEl.innerHTML = `
    <!-- Header -->
    <div style="border-bottom: 2px solid #000; padding-bottom: 20px; margin-bottom: 40px; display: flex; justify-content: space-between; align-items: flex-end;">
      <div>
        <h1 style="font-family: 'Playfair Display', serif; font-size: 32px; margin: 0; letter-spacing: -1px;">MedVision Audit</h1>
        <p style="font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 2px; color: #666; margin-top: 5px;">Official Pharmaceutical Verification Report</p>
      </div>
      <div style="text-align: right;">
        <p style="font-size: 10px; color: #999; margin: 0;">Ref No: MV-${Date.now()}</p>
        <p style="font-size: 10px; color: #999; margin: 0;">Date: ${new Date().toLocaleString()}</p>
      </div>
    </div>

    <!-- Status Banner -->
    <div style="background: ${statusColor}; color: #FFF; padding: 20px; border-radius: 4px; margin-bottom: 40px; text-align: center;">
      <h2 style="margin: 0; font-size: 14px; font-weight: 800; text-transform: uppercase; letter-spacing: 4px;">REPORT STATUS: ${statusText}</h2>
    </div>

    <!-- Core Findings Grid -->
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin-bottom: 40px;">
      <div>
        <h3 style="font-size: 11px; border-bottom: 1px solid #EEE; padding-bottom: 8px; margin-bottom: 16px; text-transform: uppercase; letter-spacing: 1px;">Product Identity</h3>
        <table style="width: 100%; font-size: 13px; border-collapse: collapse;">
          <tr style="border-bottom: 1px solid #F9F9F9;"><td style="padding: 10px 0; color: #666;">Drug Name</td><td style="padding: 10px 0; font-weight: 700; text-align: right;">${result.drugName}</td></tr>
          <tr style="border-bottom: 1px solid #F9F9F9;"><td style="padding: 10px 0; color: #666;">Manufacturer</td><td style="padding: 10px 0; font-weight: 700; text-align: right;">${result.manufacturer}</td></tr>
          <tr style="border-bottom: 1px solid #F9F9F9;"><td style="padding: 10px 0; color: #666;">Verification Score</td><td style="padding: 10px 0; font-weight: 700; text-align: right; color: ${statusColor}">${result.confidenceScore}%</td></tr>
        </table>
      </div>
      <div>
        <h3 style="font-size: 11px; border-bottom: 1px solid #EEE; padding-bottom: 8px; margin-bottom: 16px; text-transform: uppercase; letter-spacing: 1px;">Supply Chain Intel</h3>
        <table style="width: 100%; font-size: 13px; border-collapse: collapse;">
          <tr style="border-bottom: 1px solid #F9F9F9;"><td style="padding: 10px 0; color: #666;">Ledger Status</td><td style="padding: 10px 0; font-weight: 700; text-align: right;">${appState.get('currentBatch') ? 'SYNCHRONIZED' : 'INCOMPLETE'}</td></tr>
          <tr style="border-bottom: 1px solid #F9F9F9;"><td style="padding: 10px 0; color: #666;">Origin DB</td><td style="padding: 10px 0; font-weight: 700; text-align: right;">${result.originVerified ? 'VERIFIED' : 'UNVERIFIED'}</td></tr>
          <tr style="border-bottom: 1px solid #F9F9F9;"><td style="padding: 10px 0; color: #666;">Source</td><td style="padding: 10px 0; font-weight: 700; text-align: right;">${result.cached ? 'Visual Offline Cache' : 'Gemini Vision AI'}</td></tr>
        </table>
      </div>
    </div>

    <!-- Clinical Analysis Section -->
    <div style="margin-bottom: 40px; background: #FBFBFC; padding: 30px; border-radius: 8px; border: 1px solid #F0F0F2;">
      <h3 style="font-size: 11px; margin-bottom: 20px; text-transform: uppercase; letter-spacing: 1px; color: #666;">Intelligence Summary</h3>
      
      <div style="margin-bottom: 24px;">
        <p style="font-size: 10px; font-weight: 800; color: #0D9488; margin-bottom: 8px; text-transform: uppercase;">Primary Indication</p>
        <p style="font-size: 14px; margin: 0; line-height: 1.6;">${result.indication || 'No clinical indications identified in current scan.'}</p>
      </div>

      <div style="margin-bottom: 24px;">
        <p style="font-size: 10px; font-weight: 800; color: #EF4444; margin-bottom: 8px; text-transform: uppercase;">Clinical Safety Warnings</p>
        <p style="font-size: 14px; margin: 0; line-height: 1.6; color: #EF4444; font-weight: 500;">${result.warnings || 'NO CRITICAL WARNINGS DETECTED'}</p>
      </div>

      <div>
        <p style="font-size: 10px; font-weight: 800; color: #666; margin-bottom: 8px; text-transform: uppercase;">Standard Dosage Instructions</p>
        <p style="font-size: 14px; margin: 0; line-height: 1.6;">${result.dosageInstructions || 'Instructions not detected. Please verify with a licensed pharmacist.'}</p>
      </div>
    </div>

    <!-- Footer Disclaimer -->
    <div style="margin-top: 60px; padding-top: 20px; border-top: 1px solid #EEE;">
      <p style="font-size: 9px; color: #AAA; text-align: center; line-height: 1.6;">
        MedVision is an AI-assisted verification tool. This report is for auditing purposes and does not constitute medical advice. 
        Always cross-reference with professional medical laboratory results and manufacturer's official documentation.
      </p>
    </div>
  `;

  document.body.appendChild(reportEl);

  const opt = {
    margin:       0,
    filename:     `MedVision_Audit_${result.drugName.replace(/\s/g, '_')}_${Date.now()}.pdf`,
    image:        { type: 'jpeg', quality: 0.98 },
    html2canvas:  { scale: 2, useCORS: true, letterRendering: true },
    jsPDF:        { unit: 'in', format: 'letter', orientation: 'portrait' }
  };

  try {
    await html2pdf().from(reportEl).set(opt).save();
    document.body.removeChild(reportEl);
  } catch (err) {
    console.error('PDF Engine Failure:', err);
    alert('PDF Generation failed. Please try again.');
    document.body.removeChild(reportEl);
  }
}

// ─── UTILITY ───
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Resizes a base64 image to a max dimension while maintaining aspect ratio.
 */
function resizeImage(base64, maxDimension) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let width = img.width;
      let height = img.height;

      if (width > height) {
        if (width > maxDimension) {
          height *= maxDimension / width;
          width = maxDimension;
        }
      } else {
        if (height > maxDimension) {
          width *= maxDimension / height;
          height = maxDimension;
        }
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = reject;
    img.src = base64;
  });
}
