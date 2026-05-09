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
      const base64Image = event.target.result;
      
      // Part 1: Setup UI for the uploaded asset
      stopCamera(); // Stop live camera if running
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
    els.btnDownloadPdf.addEventListener('click', generatePDFReport);
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
    <span class="data-value" style="color: var(--success); font-weight: 600;">
      <i data-lucide="check-circle" style="width:11px;height:11px;margin-right:4px;"></i>Synchronized
    </span>
  `;
  
  // Add Batch/Serial details to the bottom
  const details = els.resultDetailsBox;
  const existingBatch = document.getElementById('ledger-audit-block');
  if (existingBatch) existingBatch.remove();

  const batchBlock = document.createElement('div');
  batchBlock.id = 'ledger-audit-block';
  batchBlock.className = 'detail-block';
  batchBlock.style.borderTop = '1px solid rgba(255,255,255,0.06)';
  batchBlock.style.paddingTop = '10px';
  batchBlock.innerHTML = `
    <div class="detail-title"><i data-lucide="database" style="width:12px;height:12px;"></i> Supply Chain Audit</div>
    <div class="detail-text" style="font-family: 'JetBrains Mono', monospace; font-size: 10px;">
      Lot: ${batch.lot} <br>
      Serial: ${batch.serial} <br>
      Expiry: ${batch.expiry}
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
  const titleText = isOk ? 'Truth Report: Authentic' : (isManual ? 'Manual Review Required' : 'Truth Report: Unverified');
  els.resultIcon.setAttribute('data-lucide', iconName);
  els.resultTitle.textContent = titleText;

  // Core data rows
  const confidence = result.confidenceScore ?? 0;
  const confColor  = confidence >= 80 ? 'var(--success)' : (confidence >= 50 ? '#EAB308' : 'var(--danger)');

  els.resultDataRows.innerHTML = `
    <div class="data-row">
      <span class="data-label">Drug Name</span>
      <span class="data-value">${escapeHtml(result.drugName || 'Unknown')}</span>
    </div>
    ${result.genericName ? `
    <div class="data-row">
      <span class="data-label">Generic</span>
      <span class="data-value" style="font-size: 11px; opacity: 0.8;">${escapeHtml(result.genericName)}</span>
    </div>` : ''}
    <div class="data-row">
      <span class="data-label">Manufacturer</span>
      <span class="data-value">${escapeHtml(result.manufacturer || 'Unverified')}</span>
    </div>
    <div class="data-row">
      <span class="data-label">Confidence</span>
      <span class="data-value" style="color: ${confColor}; font-weight: 600;">${confidence}%</span>
    </div>
    ${result.isEssentialMedicine ? `
    <div class="data-row">
      <span class="data-label">WHO Status</span>
      <span class="data-value" style="color: var(--teal); font-weight: 600;">
        <i data-lucide="star" style="width:12px;height:12px;margin-right:4px;"></i>Essential Medicine
      </span>
    </div>` : ''}
    ${result.cached ? `
    <div class="data-row">
      <span class="data-label">Source</span>
      <span class="data-value" style="color: var(--purple-glow); font-size: 11px;">
        <i data-lucide="database" style="width:11px;height:11px;margin-right:3px;"></i>Offline Cache
      </span>
    </div>` : ''}
    <div class="data-row" id="ledger-sync-row">
      <span class="data-label">GS1 Ledger</span>
      <span class="data-value" style="opacity: 0.5; font-size: 11px;">No Barcode Found</span>
    </div>
  `;

  // Check if we already have batch data from the sentinel
  const currentBatch = appState.get('currentBatch');
  if (currentBatch && currentBatch.verified) {
    setTimeout(() => updateResultCardWithLedger(currentBatch), 10);
  }

  // Detail blocks (clinical intelligence)
  const hasIndication = result.indication && result.indication !== 'null';
  const hasDosage     = result.dosageInstructions && result.dosageInstructions !== 'null';
  const hasWarning    = result.warnings && result.warnings !== 'null';

  els.resultDetailsBox.innerHTML = `
    ${hasIndication ? `
    <div class="detail-block">
      <div class="detail-title"><i data-lucide="activity" style="width:12px;height:12px;"></i> Indication</div>
      <div class="detail-text">${escapeHtml(result.indication)}</div>
    </div>` : ''}

    ${hasDosage ? `
    <div class="detail-block">
      <div class="detail-title"><i data-lucide="pill" style="width:12px;height:12px;"></i> Dosage Instructions</div>
      <div class="detail-text">${escapeHtml(result.dosageInstructions)}</div>
    </div>` : ''}

    ${hasWarning ? `
    <div class="detail-block" style="border-left: 2px solid rgba(239,68,68,0.5);">
      <div class="detail-title" style="color: #EF4444;"><i data-lucide="alert-triangle" style="width:12px;height:12px;"></i> Clinical Warning</div>
      <div class="detail-text" style="color: rgba(255,255,255,0.75);">${escapeHtml(result.warnings)}</div>
    </div>` : ''}

    <div class="detail-block">
      <div class="detail-title"><i data-lucide="shield" style="width:12px;height:12px;"></i> Origin Verification</div>
      <div class="detail-text">${result.originVerified
        ? '✓ Manufacturer cross-referenced with global pharma databases.'
        : '✗ Origin data could not be verified against known databases.'
      }</div>
    </div>

    <div class="detail-block">
      <div class="detail-title"><i data-lucide="package" style="width:12px;height:12px;"></i> Supply Chain</div>
      <div class="detail-text">
        Shelf-life: ${escapeHtml(result.expiryPattern || 'N/A')} &nbsp;|&nbsp;
        Ledger: ${result.cached ? 'Offline (Cached)' : 'Live'} &nbsp;|&nbsp;
        OCR Enhanced: ${result.ocrEnhanced ? 'Yes' : 'No'}
      </div>
    </div>

    <div class="detail-block" style="border-top: 1px solid rgba(255,255,255,0.06); padding-top: 10px; margin-top: 4px;">
      <div class="detail-text" style="font-size: 10px; opacity: 0.4;">
        Analysis time: ${result.verifyMs ?? '—'}ms &nbsp;|&nbsp;
        ${result.timestamp ? new Date(result.timestamp).toLocaleString() : ''}
        ${result.localDbMatch ? '&nbsp;|&nbsp; ✓ Local DB Match' : ''}
      </div>
    </div>
  `;

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
function generatePDFReport() {
  const originalHTML = els.btnDownloadPdf.innerHTML;
  els.btnDownloadPdf.innerHTML = `
    <span class="btn-spinner" style="width:14px;height:14px;border-width:2px;"></span>
    <span style="margin-left:8px;">Generating PDF...</span>
  `;
  els.btnDownloadPdf.disabled = true;

  const element = els.resultCard.cloneNode(true);

  // Strip interactive elements from the PDF clone
  element.querySelector('.result-close')?.remove();
  element.querySelector('.result-actions')?.remove();
  document.getElementById('scan-inline-error')?.remove();

  // Add official document header
  element.insertAdjacentHTML('afterbegin', `
    <div style="text-align:center; margin-bottom:28px; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:20px;">
      <h2 style="font-family:'Playfair Display',serif; color:#FFFFFF; font-size:26px; margin:0 0 6px 0; letter-spacing:1px;">
        MedSwift Vision
      </h2>
      <p style="color:rgba(255,255,255,0.5); font-size:12px; margin:0; text-transform:uppercase; letter-spacing:3px;">
        Official Pharmaceutical Verification Report
      </p>
      <p style="color:rgba(255,255,255,0.3); font-size:10px; margin:8px 0 0 0;">
        Generated: ${new Date().toLocaleString()} &nbsp;|&nbsp; MedSwift Platform v2.0
      </p>
    </div>
  `);

  // PDF rendering styles
  element.style.cssText = `
    padding: 40px;
    background: #080808;
    color: #FFFFFF;
    width: 800px;
    box-sizing: border-box;
    border-radius: 0;
    box-shadow: none;
    position: relative;
  `;

  // Fix SVG sizes for pdf rendering
  element.querySelectorAll('svg').forEach(svg => {
    svg.style.width = '14px';
    svg.style.height = '14px';
  });

  // Temporarily mount off-screen
  const offscreen = document.createElement('div');
  offscreen.style.cssText = 'position:absolute; left:-9999px; top:0;';
  offscreen.appendChild(element);
  document.body.appendChild(offscreen);

  const drugName = els.resultTitle.textContent.replace(/[^a-z0-9]/gi, '_').slice(0, 40);
  const filename = `MedSwift_Report_${drugName}_${Date.now()}.pdf`;

  html2pdf().set({
    margin: 10,
    filename,
    image:       { type: 'jpeg', quality: 0.97 },
    html2canvas: { scale: 2, useCORS: true, backgroundColor: '#080808' },
    jsPDF:       { unit: 'mm', format: 'a4', orientation: 'portrait' }
  }).from(element).save().then(() => {
    document.body.removeChild(offscreen);
    els.btnDownloadPdf.innerHTML = originalHTML;
    els.btnDownloadPdf.disabled = false;
    lucide.createIcons();
  }).catch(err => {
    console.error('PDF Generation Error:', err);
    document.body.removeChild(offscreen);
    els.btnDownloadPdf.innerHTML = originalHTML;
    els.btnDownloadPdf.disabled = false;
    lucide.createIcons();
  });
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
