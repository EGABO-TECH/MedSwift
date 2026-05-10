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

  // ─── AUGUST INTELLIGENCE INITIALIZATION ───
  // Request Notification permission for Empathetic Nudges & Alerts
  if ('Notification' in window && Notification.permission !== 'granted' && Notification.permission !== 'denied') {
    // We delay the request slightly so it doesn't block the initial render
    setTimeout(() => {
      Notification.requestPermission();
    }, 3000);
  }
  
  // Trigger Background Agent Check
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.ready.then(registration => {
      if (registration.active) {
        // Send the offline history to the background agent for cross-referencing
        const history = appState.get('scanHistory') || [];
        registration.active.postMessage({ type: 'TRIGGER_AGENT_CHECK', history });
      }
    });
  }
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
    ${result.isEssentialMedicine ? `
    <div class="detail-block" style="border: 1px solid rgba(16, 185, 129, 0.3); background: rgba(16, 185, 129, 0.05);">
      <div class="detail-title" style="color: #10B981;"><i data-lucide="star"></i> WHO Essential Medicine</div>
      <div class="detail-text" style="color: #10B981; font-weight: 500;">Listed on the WHO Model List of Essential Medicines.</div>
    </div>` : ''}

    ${hasIndication ? `
    <div class="detail-block">
      <div class="detail-title"><i data-lucide="activity"></i> Primary Indication</div>
      <div class="detail-text">${escapeHtml(result.indication)}</div>
    </div>` : ''}

    ${result.pathway ? `
    <div class="detail-block">
      <div class="detail-title"><i data-lucide="microscope"></i> Mechanism / Pathway</div>
      <div class="detail-text">${escapeHtml(result.pathway)}</div>
    </div>` : ''}

    ${result.therapeuticClass ? `
    <div class="detail-block">
      <div class="detail-title"><i data-lucide="bookmark"></i> Therapeutic Class</div>
      <div class="detail-text" style="font-family: 'JetBrains Mono', monospace; font-size: 11px;">${escapeHtml(result.therapeuticClass)}</div>
    </div>` : ''}

    ${result.regulatoryStatus ? `
    <div class="detail-block">
      <div class="detail-title"><i data-lucide="globe"></i> Regulatory Status</div>
      <div class="detail-text" style="font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--teal-primary);">${escapeHtml(result.regulatoryStatus)}</div>
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

    ${result.lifestyleNudge ? `
    <div class="detail-block" style="background: rgba(16, 185, 129, 0.05); border-left: 3px solid #10B981; border-radius: 4px; padding-left: 12px;">
      <div class="detail-title" style="color: #10B981;"><i data-lucide="heart"></i> Clinical Companion Nudge</div>
      <div class="detail-text" style="font-style: italic; color: #E2E8F0;">"${escapeHtml(result.lifestyleNudge)}"</div>
    </div>` : ''}

    ${result.suggestedBiomarkers && result.suggestedBiomarkers.length > 0 ? `
    <div class="detail-block" style="border: 1px solid rgba(13, 148, 136, 0.2); background: rgba(13, 148, 136, 0.03);">
      <div class="detail-title" style="color: var(--teal-primary);"><i data-lucide="activity"></i> Biomarker Tracking</div>
      <div class="detail-text" style="color: #94A3B8; font-size: 13px;">Based on this medication, consider discussing these labs with your provider:</div>
      <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px;">
        ${result.suggestedBiomarkers.map(b => `<span style="background: rgba(13, 148, 136, 0.15); color: #2DD4BF; padding: 4px 8px; border-radius: 4px; font-size: 11px; font-family: 'JetBrains Mono', monospace;">${escapeHtml(b)}</span>`).join('')}
      </div>
    </div>` : ''}

    ${result.proactiveInsight ? `
    <div class="detail-block" style="background: rgba(234, 179, 8, 0.05); border: 1px solid rgba(234, 179, 8, 0.2);">
      <div class="detail-title" style="color: #EAB308;"><i data-lucide="lightbulb"></i> Proactive Insight</div>
      <div class="detail-text" style="color: #FDE047;">${escapeHtml(result.proactiveInsight)}</div>
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
        Ref: ${Date.now()} | Engine: ${result.engine || 'MedVision AI'} | Latency: ${result.verifyMs ?? '—'}ms
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
    max-width: 90%; overflow: hidden; text-overflow: ellipsis;
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
  // Pre-load logo as base64 to avoid CORS/path failures in html2canvas
  let logoTag = '<div style="width:48px;height:48px;background:#10B981;border-radius:8px;display:inline-block;"></div>';
  try {
    const logoResp = await fetch('Assets/MedSwift-Symbol.png');
    if (logoResp.ok) {
      const blob = await logoResp.blob();
      const logoDataUrl = await new Promise((res) => {
        const reader = new FileReader();
        reader.onloadend = () => res(reader.result);
        reader.readAsDataURL(blob);
      });
      logoTag = `<img src="${logoDataUrl}" style="width:48px;height:48px;" alt="Logo" />`;
    }
  } catch (e) { console.warn('PDF logo skipped:', e); }

  // ── KEY FIX: Use visibility:hidden at top:0/left:0 so html2canvas can render it.
  // Positioning at left:-9999px causes html2canvas to produce a blank white canvas.
  const reportEl = document.createElement('div');
  reportEl.style.cssText = `
    width: 700px;
    padding: 60px;
    box-sizing: border-box;
    background: #FFFFFF;
    color: #111111;
    font-family: 'DM Sans', sans-serif;
    position: fixed;
    top: 0;
    left: 0;
    visibility: hidden;
    z-index: -9999;
    pointer-events: none;
  `;

  reportEl.innerHTML = `
    <!-- 1. The Header: Identity & Authority -->
    <div style="display: flex; align-items: center; gap: 20px; padding-bottom: 24px;">
      ${logoTag}
      <div>
        <h1 style="font-family: 'DM Sans', sans-serif; font-size: 20px; font-weight: 700; text-transform: uppercase; letter-spacing: 4px; margin: 0; color: #111;">
          MedSwift Vision Truth Report
        </h1>
      </div>
    </div>
    <!-- Status Bar: Thin Orange Line -->
    <div style="width: 100%; height: 2px; background-color: #F97316; margin-bottom: 40px;"></div>

    <!-- 2. The Body: The "Truth" Section -->
    <div style="display: flex; flex-direction: column; gap: 40px;">
      
      <!-- A. Identification Profile -->
      <div style="display: grid; grid-template-columns: 1fr 1fr; border-top: 1px solid #E5E7EB; border-bottom: 1px solid #E5E7EB; padding: 20px 0;">
        <div>
          <p style="font-size: 10px; font-weight: 700; color: #10B981; text-transform: uppercase; letter-spacing: 2px; margin: 0 0 4px 0;">Product</p>
          <p style="font-family: 'Playfair Display', serif; font-size: 24px; font-weight: 700; margin: 0; color: #111;">${escapeHtml(result.drugName || 'Unknown')}</p>
        </div>
        <div style="display: flex; flex-direction: column; gap: 12px; border-left: 1px solid #E5E7EB; padding-left: 20px;">
          <div>
            <p style="font-size: 9px; font-weight: 700; color: #6B7280; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 2px 0;">Manufacturer & Origin</p>
            <p style="font-size: 13px; font-weight: 500; margin: 0; color: #111;">${escapeHtml(result.manufacturer || 'Unverified')} | Origin: ${result.originVerified ? 'Verified' : 'Unverified'}</p>
          </div>
          <div>
            <p style="font-size: 9px; font-weight: 700; color: #6B7280; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 2px 0;">Classification</p>
            <p style="font-size: 13px; font-weight: 500; margin: 0; color: #111;">${escapeHtml(result.therapeuticClass || 'Uncategorized')}</p>
          </div>
        </div>
      </div>

      <!-- B. The "Truth" Analysis -->
      <div>
        <h2 style="font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 3px; color: #111; margin: 0 0 20px 0;">The Truth Analysis</h2>
        
        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 20px;">
          <!-- Pillar 1: The Purpose -->
          <div style="background: #F9FAFB; padding: 20px; border: 1px solid #F3F4F6;">
            <p style="font-size: 10px; font-weight: 700; color: #10B981; text-transform: uppercase; letter-spacing: 1.5px; margin: 0 0 12px 0;">The Purpose</p>
            <p style="font-size: 12px; line-height: 1.6; margin: 0; color: #374151;">
              Targeting primary indications. Designed to assist with ${escapeHtml(result.indication || 'symptom management')}.
            </p>
          </div>
          
          <!-- Pillar 2: The Protocol -->
          <div style="background: #F9FAFB; padding: 20px; border: 1px solid #F3F4F6;">
            <p style="font-size: 10px; font-weight: 700; color: #10B981; text-transform: uppercase; letter-spacing: 1.5px; margin: 0 0 12px 0;">The Protocol</p>
            <p style="font-size: 12px; line-height: 1.6; margin: 0; color: #374151;">
              ${escapeHtml(result.dosageInstructions || 'Instructions not detected.')} ${escapeHtml(result.lifestyleNudge || '')}
            </p>
          </div>

          <!-- Pillar 3: The Verification -->
          <div style="background: #F9FAFB; padding: 20px; border: 1px solid #F3F4F6;">
            <p style="font-size: 10px; font-weight: 700; color: #10B981; text-transform: uppercase; letter-spacing: 1.5px; margin: 0 0 12px 0;">The Verification</p>
            <p style="font-size: 12px; line-height: 1.6; margin: 0; color: #374151;">
              Cross-referenced internal knowledge. Confidence Score: ${result.confidenceScore}%. Status: ${result.authentic ? 'Authentic' : 'Unverified'}.
            </p>
          </div>
        </div>
      </div>

      <!-- C. Safety Insights -->
      <div style="border-left: 3px solid #F97316; padding-left: 20px; margin-top: 10px;">
        <h2 style="font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 3px; color: #111; margin: 0 0 16px 0;">Safety Insights</h2>
        
        <div style="display: flex; flex-direction: column; gap: 12px;">
          <div>
            <span style="font-size: 10px; font-weight: 700; color: #F97316; text-transform: uppercase; letter-spacing: 1.5px;">Critical Avoidance:</span>
            <span style="font-size: 12px; color: #374151; margin-left: 8px;">${escapeHtml(result.warnings || 'None detected.')}</span>
          </div>
          <div>
            <span style="font-size: 10px; font-weight: 700; color: #F97316; text-transform: uppercase; letter-spacing: 1.5px;">Potential Interaction:</span>
            <span style="font-size: 12px; color: #374151; margin-left: 8px;">${escapeHtml(result.proactiveInsight || 'No known conflicts detected in current context.')}</span>
          </div>
        </div>
      </div>

    </div>

    <!-- 3. The Footer: The Guardrail -->
    <div style="margin-top: 60px; padding-top: 20px; border-top: 1px solid #E5E7EB;">
      <p style="font-size: 9px; color: #9CA3AF; text-align: left; line-height: 1.6; text-transform: uppercase; letter-spacing: 0.5px; margin: 0;">
        Informational Use Only: MedSwift AI identification is cross-referenced with global pharma datasets. This is not medical advice. Always consult a professional before consumption.
      </p>
    </div>
  `;

  document.body.appendChild(reportEl);

  // Allow the browser 300ms to fully lay out the DOM before html2canvas captures it
  await new Promise(resolve => setTimeout(resolve, 300));

  const opt = {
    margin:       [10, 10, 10, 10],
    filename:     `MedVision_Audit_${(result.drugName || 'Unknown').replace(/\s/g, '_')}_${Date.now()}.pdf`,
    image:        { type: 'jpeg', quality: 0.98 },
    html2canvas:  {
      scale: 2,
      useCORS: true,
      letterRendering: true,
      logging: false,
      windowWidth: 820,
      backgroundColor: '#FFFFFF'
    },
    jsPDF:        { unit: 'mm', format: 'a4', orientation: 'portrait' }
  };

  try {
    await html2pdf().from(reportEl).set(opt).save();
  } catch (err) {
    console.error('PDF Engine Failure:', err);
    alert('PDF Generation failed. Please try again.');
  } finally {
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
