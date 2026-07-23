import { appState } from './state.js';
import { seedDemoData } from './db.js';
import { startCamera, captureFrame, identifyMedication, analyzeReportText, isScannerBusy, scanBarcode, scanBarcodeFromImage } from './scanner.js';

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
  modeMedication:    document.getElementById('mode-medication'),
  modeReport:        document.getElementById('mode-report'),
  reportTextPanel:   document.getElementById('report-text-panel'),
  reportTextInput:   document.getElementById('report-text-input'),
  btnAnalyzeText:    document.getElementById('btn-analyze-text'),
  scannerPrompt:     document.getElementById('scanner-prompt'),
  scanPromptText:    document.querySelector('#scanner-prompt .prompt-text'),
  scanPromptIcon:    document.querySelector('#scanner-prompt .prompt-icon i'),
  // Audit Trail
  auditList:         document.getElementById('audit-trail-list')
};

// ─── INITIALIZATION ───
document.addEventListener('DOMContentLoaded', async () => {
  await seedDemoData();
  setupEventListeners();
  // Enable multiple file upload for drug interaction checking
  if (els.uploadInput) {
    els.uploadInput.multiple = true;
  }
  // Ensure mode is initialized
  setAnalysisMode(appState.get('analysisMode') || 'medication');
});

// ─── EVENT LISTENERS ───
function setupEventListeners() {
  function addListenerSafe(el, ev, fn) {
    if (!el) {
      console.warn('Missing element for event listener:', ev, el);
      return;
    }
    el.addEventListener(ev, fn);
  }

  addListenerSafe(els.modeMedication, 'click', () => setAnalysisMode('medication'));
  addListenerSafe(els.modeReport, 'click', () => setAnalysisMode('report'));

  addListenerSafe(els.btnAnalyzeText, 'click', async () => {
    const text = (els.reportTextInput?.value || '').trim();
    if (!text) { showInlineError('Please paste a medical report before summarizing.'); return; }
    appState.set('scanStatus', 'verifying');
    showScannerActive();
    if (els.reportTextInput) els.reportTextInput.disabled = true;
    if (els.btnAnalyzeText) { els.btnAnalyzeText.disabled = true; els.btnAnalyzeText.innerHTML = '<span class="btn-spinner" style="width:14px;height:14px;border-width:2px;"></span> Summarizing...'; }
    try {
      const result = await analyzeReportText(text);
      if (result?.error) { showInlineError(result.error); appState.set('scanStatus', 'idle'); resetScannerUI(); return; }
      showResultCard(result, 'report');
      addToAuditTrail(result);
    } catch (err) { console.error(err); showInlineError('Report summarization failed. Please try again.'); }
    finally { if (els.reportTextInput) els.reportTextInput.disabled = false; if (els.btnAnalyzeText) { els.btnAnalyzeText.disabled = false; els.btnAnalyzeText.innerHTML = 'Summarize Report'; } }
  });

  addListenerSafe(els.btnStartScan, 'click', async () => {
    appState.set('scanStatus', 'scanning');
    showScannerActive();
    activeStream = await startCamera(els.video);
    if (!activeStream) { showCameraError(); return; }

    async function scannerTick() {
      const status = appState.get('scanStatus'); if (status !== 'scanning') { scanInterval = null; return; }
      if (appState.get('analysisMode') === 'medication') {
        try {
          const barcodeText = await scanBarcode(els.video);
          if (barcodeText && barcodeText !== lastDetectedBarcode) {
            lastDetectedBarcode = barcodeText;
            handleBarcodeDetection(barcodeText).catch(err => console.error('Error in barcode detection handling:', err));
          }
        } catch (e) {}
      }
      if (appState.get('scanStatus') === 'scanning' && !isScannerBusy()) {
        const frame = await captureFrame(els.video);
        if (frame) await processVisionFrame(frame);
      }
      if (appState.get('scanStatus') === 'scanning') scanInterval = setTimeout(scannerTick, 1000);
    }
    scanInterval = setTimeout(scannerTick, 1000);
  });

  addListenerSafe(els.btnUploadScan, 'click', () => { if (els.uploadInput) els.uploadInput.click(); });

  addListenerSafe(els.uploadInput, 'change', async (e) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    // Handle multiple files
    if (files.length > 1) {
      // Store files for later processing (e.g., for interaction checking)
      const filesArray = Array.from(files);
      appState.set('pendingUploadFiles', filesArray);

      // Update UI to show multiple files selected
      if (els.uploadPreview) {
        // Show first image as preview
        const file = files[0];
        try {
          const base64Image = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (event) => {
              let base64Image = event.target.result;
              try {
                base64Image = resizeImage(base64Image, 1280);
              } catch (e) {
                console.warn('Image optimization skipped:', e);
              }
              resolve(base64Image);
            };
            reader.onerror = (e) => reject(e);
            reader.readAsDataURL(file);
          });

          if (els.uploadPreview) {
            els.uploadPreview.src = base64Image;
            els.uploadPreview.classList.remove('hidden');
          }
        } catch (err) {
          console.error('Error processing first file for preview:', err);
          // Continue anyway - show UI even if preview fails
        }
      }

      // Hide scan controls and show multi-file ready state
      els.placeholder.classList.add('hidden');
      els.video.classList.remove('is-active');
      els.beam.classList.add('hidden');
      els.prompt.classList.add('hidden');
      els.controls.classList.add('hidden');
      els.verificationZone.classList.remove('hidden');

      // Show indication that multiple files are ready for interaction check
      const verificationZone = document.getElementById('verification-zone');
      if (verificationZone) {
        verificationZone.innerHTML = `
          <div style="text-align: center; padding: 20px; color: var(--teal-primary);">
            <i data-lucide="check-circle" style="width:32px;height:32px;margin-bottom:12px;"></i>
            <p>${files.length} files selected for analysis</p>
            <button id="btn-check-interactions" style="background: var(--teal-primary); color: white; border: none; padding: 8px 16px; border-radius: 4px; font-weight: 500; cursor: pointer;">
              Check Drug Interactions
            </button>
          </div>
        `;
        lucide.createIcons();

        // Add listener for the interaction check button
        setTimeout(() => {
          const btnCheckInteractions = document.getElementById('btn-check-interactions');
          if (btnCheckInteractions) {
            btnCheckInteractions.addEventListener('click', async () => {
              await handleMultiFileInteractionCheck();
            });
          }
        }, 100);
      }
    } else {
      // Single file handling (original logic)
      const file = files[0];
      try {
        const base64Image = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (event) => {
            let base64Image = event.target.result;
            try {
              base64Image = resizeImage(base64Image, 1280);
            } catch (e) {
              console.warn('Image optimization skipped:', e);
            }
            resolve(base64Image);
          };
          reader.onerror = (e) => reject(e);
          reader.readAsDataURL(file);
        });

        stopCamera();
        if (scanInterval) clearTimeout(scanInterval);
        if (els.uploadPreview) {
          els.uploadPreview.src = base64Image;
          els.uploadPreview.classList.remove('hidden');
        }
        if (els.placeholder) els.placeholder.classList.add('hidden');
        if (els.video) els.video.classList.remove('is-active');
        showScannerActive();
        if (appState.get('analysisMode') === 'medication') {
          const barcodeText = await scanBarcodeFromImage(els.uploadPreview);
          if (barcodeText) handleBarcodeDetection(barcodeText).catch(err => console.error('Error in barcode detection handling:', err));
        }
        await processVisionFrame(base64Image);
        if (els.uploadInput) els.uploadInput.value = '';
      } catch (err) {
        console.error('Error processing file:', err);
        showInlineError('Failed to process image. Please try again.');
        resetScannerUI();
      }
    }
  });

  addListenerSafe(els.btnCancelAnalysis, 'click', () => { if (analysisController) { analysisController.abort(); analysisController = null; } resetScannerUI(); });
  addListenerSafe(els.dismissScan, 'click', resetScannerUI);
  if (els.btnDownloadPdf) els.btnDownloadPdf.addEventListener('click', async () => { const result = appState.get('lastResult'); if (!result) return; const originalHTML = els.btnDownloadPdf.innerHTML; els.btnDownloadPdf.innerHTML = '<span class="btn-spinner" style="width:14px;height:14px;border-width:2px;"></span> GENERATING...'; els.btnDownloadPdf.disabled = true; await generatePDFReport(result); els.btnDownloadPdf.innerHTML = originalHTML; els.btnDownloadPdf.disabled = false; });
}

// ─── SCANNER UI STATE ───
function setAnalysisMode(mode) {
  const normalizedMode = mode === 'report' ? 'report' : 'medication';
  if (appState.get('analysisMode') === normalizedMode) {
    return;
  }

  appState.set('analysisMode', normalizedMode);
  resetScannerUI();

  const isMedication = normalizedMode === 'medication';
  els.modeMedication.classList.toggle('btn-accent', isMedication);
  els.modeMedication.classList.toggle('btn-ghost', !isMedication);
  els.modeMedication.setAttribute('aria-pressed', String(isMedication));
  els.modeMedication.style.background = isMedication ? '' : 'rgba(255,255,255,0.04)';
  els.modeReport.classList.toggle('btn-accent', !isMedication);
  els.modeReport.classList.toggle('btn-ghost', isMedication);
  els.modeReport.setAttribute('aria-pressed', String(!isMedication));
  els.modeReport.style.background = !isMedication ? '' : 'rgba(255,255,255,0.04)';

  if (els.reportTextPanel) {
    els.reportTextPanel.classList.toggle('hidden', isMedication);
  }

  if (els.scanPromptText) {
    els.scanPromptText.textContent = isMedication ? 'Focus Medication' : 'Capture Medical Report';
  }
  if (els.scanPromptIcon) {
    els.scanPromptIcon.setAttribute('data-lucide', isMedication ? 'scan-eye' : 'file-text');
  }
  if (els.btnStartScan) {
    els.btnStartScan.innerHTML = isMedication
      ? '<i data-lucide="brain-circuit"></i> Start Vision'
      : '<i data-lucide="file-text"></i> Analyze Report';
  }
  if (els.btnUploadScan) {
    els.btnUploadScan.innerHTML = isMedication
      ? '<i data-lucide="image-plus"></i> Upload Image'
      : '<i data-lucide="file-image"></i> Upload Report Image';
  }
  if (els.btnDownloadPdf) {
    els.btnDownloadPdf.innerHTML = isMedication
      ? '<i data-lucide="download"></i> Download PDF Report'
      : '<i data-lucide="download"></i> Download Medical PDF';
  }

  lucide.createIcons();
}

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

// ─── MULTI-FILE INTERACTION CHECK ───
async function handleMultiFileInteractionCheck() {
  const files = appState.get('pendingUploadFiles');
  if (!files || !files.length) {
    showInlineError('No files selected for analysis');
    return;
  }

  appState.set('scanStatus', 'verifying');
  showScannerActive(); // Show scanning UI
  els.beam.classList.add('intelligence-glow');
  els.shimmer.classList.remove('hidden');
  els.intelligenceIcon.classList.add('status-pulse');
  els.cancelAnalysisBox.classList.remove('hidden');

  // Show processing status
  const verificationZone = document.getElementById('verification-zone');
  let statusUpdateInterval = null;

  try {
    // Process all files to extract medication information
    const medicationResults = [];

    // Update UI to show processing started
    if (verificationZone) {
      verificationZone.innerHTML = `
        <div style="text-align: center; padding: 20px; color: var(--teal-primary);">
          <i data-lucide="loader" style="width:24px;height:24px;margin-bottom:12px;"></i>
          <p>Processing ${files.length} images...</p>
          <p id="process-status">0/${files.length} completed</p>
        </div>
      `;
      lucide.createIcons();
    }

    // Process files sequentially to avoid conflicts with the _isProcessing lock in identifyMedication
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        // Update status
        if (document.getElementById('process-status')) {
          document.getElementById('process-status').textContent = `${i}/${files.length} completed`;
        }

        const base64Image = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (event) => {
            let base64Image = event.target.result;
            try {
              // Process image for medication identification
              base64Image = resizeImage(base64Image, 1280);
            } catch (e) {
              console.warn('Image optimization skipped:', e);
            }
            resolve(base64Image);
          };
          reader.onerror = (e) => reject(e);
          reader.readAsDataURL(file);
        });

        // Use existing identifyMedication function to get drug info
        const controller = new AbortController();
        const result = await identifyMedication(
          base64Image,
          controller.signal,
          appState.get('analysisMode')
        );

        medicationResults.push({
          index: i,
          name: file.name,
          result: result.error ? null : result,
          error: result.error
        });

        // Small delay to prevent overwhelming the system
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (err) {
        medicationResults.push({
          index: i,
          name: file.name,
          result: null,
          error: err.message || 'Processing failed'
        });
        console.error(`Error processing file ${file.name}:`, err);
      }
    }

    // Final status update
    if (document.getElementById('process-status')) {
      document.getElementById('process-status').textContent = `${files.length}/${files.length} completed`;
    }

    // Brief pause to show completion
    await new Promise(resolve => setTimeout(resolve, 500));

    // Filter out failed processes
    const validResults = medicationResults
      .filter(r => !r.error && r.result)
      .map(r => r.result);

    if (validResults.length < 2) {
      throw new Error(`Need at least 2 successfully processed medications to check interactions. Successfully processed: ${validResults.length}/${files.length}`);
    }

    // Prepare data for interaction analysis
    const medications = validResults.map(result => ({
      drugName: result.drugName || 'Unknown',
      genericName: result.genericName || '',
      manufacturer: result.manufacturer || '',
      indication: result.indication || ''
    }));

    // Update UI for analysis phase
    if (verificationZone) {
      verificationZone.innerHTML = `
        <div style="text-align: center; padding: 20px; color: var(--teal-primary);">
          <i data-lucide="loader" style="width:24px;height:24px;margin-bottom:12px;"></i>
          <p>Analyzing drug interactions...</p>
        </div>
      `;
      lucide.createIcons();
    }

    // Call API for interaction analysis
    const interactionResult = await analyzeDrugInteractions(medications);

    // Display results
    if (interactionResult.error) {
      throw new Error(interactionResult.error);
    }

    showResultCard(interactionResult, 'interaction');
    addToAuditTrail(interactionResult);

  } catch (err) {
    console.error('Multi-file interaction check error:', err);
    showInlineError(err.message || 'Interaction analysis failed');
  } finally {
    // Clear status update interval if it exists
    if (statusUpdateInterval) {
      clearInterval(statusUpdateInterval);
    }

    // Reset UI scanning state
    els.beam.classList.remove('intelligence-glow');
    els.shimmer.classList.add('hidden');
    els.intelligenceIcon.classList.remove('status-pulse');
    els.cancelAnalysisBox.classList.add('hidden');
    appState.set('scanStatus', 'scanning');
    // Clear pending files
    appState.set('pendingUploadFiles', null);

    // Reset verification zone to show ready state for multiple files if any remain
    const remainingFiles = appState.get('pendingUploadFiles');
    if (remainingFiles && remainingFiles.length > 1) {
      setTimeout(() => {
        if (verificationZone) {
          verificationZone.innerHTML = `
            <div style="text-align: center; padding: 20px; color: var(--teal-primary);">
              <i data-lucide="check-circle" style="width:32px;height:32px;margin-bottom:12px;"></i>
              <p>${remainingFiles.length} files selected for analysis</p>
              <button id="btn-check-interactions" style="background: var(--teal-primary); color: white; border: none; padding: 8px 16px; border-radius: 4px; font-weight: 500; cursor: pointer;">
                Check Drug Interactions
              </button>
            </div>
          `;
          lucide.createIcons();

          // Re-add listener for the interaction check button
          setTimeout(() => {
            const btnCheckInteractions = document.getElementById('btn-check-interactions');
            if (btnCheckInteractions) {
              btnCheckInteractions.addEventListener('click', async () => {
                await handleMultiFileInteractionCheck();
              });
            }
          }, 100);
        }
      }, 100);
    }
  }
}

// ─── DRUG INTERACTION ANALYSIS ───
async function analyzeDrugInteractions(medications) {
  try {
    const response = await fetch('/api/identify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'interaction',
        medications: medications
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `Server error: ${response.status}`);
    }

    return await response.json();
  } catch (err) {
    throw new Error(`Interaction analysis failed: ${err.message}`);
  }
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
    const result = await identifyMedication(frame, analysisController.signal, appState.get('analysisMode'));

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
    clearTimeout(scanInterval);
    scanInterval = null;
    stopCamera();

    els.shimmer.classList.add('hidden');
    els.beam.classList.remove('intelligence-glow');
    els.cancelAnalysisBox.classList.add('hidden');
    els.intelligenceIcon.classList.remove('status-pulse');

    showResultCard(result, appState.get('analysisMode'));
    addToAuditTrail(result);

  } catch (err) {
    if (err.name === 'AbortError') {
      console.log('Analysis cancelled by user.');
    } else {
      console.error('Unexpected analysis error:', err);
      // Revert verifying state UI changes when error occurs
      els.beam.classList.remove('intelligence-glow');
      els.shimmer.classList.add('hidden');
      els.intelligenceIcon.classList.remove('status-pulse');
      els.cancelAnalysisBox.classList.add('hidden');
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
  const refData = await db.referenceData.where('gtin').equals(gs1Data.gtin).first();

  if (batch) {
    console.log('MedVision Ledger: Batch found!', batch);
    // Store this in appState so showResultCard can use it
    appState.set('currentBatch', { ...gs1Data, ...batch, verified: true });

    if (refData) {
      const offlineResult = buildOfflineReferenceResult(refData, { ...gs1Data, ...batch });
      appState.set('lastResult', offlineResult);
      showResultCard(offlineResult, 'medication');
      addToAuditTrail(offlineResult);
    }

    // If we're already showing a card, update it live
    if (!els.resultCard.classList.contains('hidden')) {
      updateResultCardWithLedger(appState.get('currentBatch'));
    }
  } else {
    appState.set('currentBatch', { ...gs1Data, verified: false });
  }
}

function buildOfflineReferenceResult(reference, batch = null) {
  const baseName = reference?.brandName || batch?.gtin || 'Medication';
  return {
    drugName: baseName,
    genericName: reference?.genericName || '',
    manufacturer: reference?.manufacturer || 'Offline Reference Database',
    indication: reference?.indication || reference?.dosageForm || 'Local reference verification only',
    dosageInstructions: reference?.dosageInstructions || 'Follow package directions or pharmacist guidance.',
    warnings: reference?.warnings || 'Please confirm product details with a licensed professional.',
    storage: reference?.storage || 'Cool, dry place as directed on the label.',
    confidenceScore: 65,
    originVerified: false,
    confidenceRationale: 'Offline fallback activated. The app switched to the local medication reference matrix because provider intelligence is unavailable.',
    regulatoryStatus: reference?.regulatoryStatus || 'Offline reference only',
    therapeuticClass: reference?.therapeuticClass || '',
    pathway: reference?.pathway || '',
    isEssentialMedicine: reference?.isEssentialMedicine ?? false,
    lifestyleNudge: reference?.lifestyleNudge || 'Use the packaging and your pharmacist as the verification source until network intelligence is restored.',
    suggestedBiomarkers: reference?.suggestedBiomarkers || [],
    proactiveInsight: reference?.proactiveInsight || 'Local fallback mode is protecting continuity of service.',
    authentic: false,
    manualReviewRequired: true,
    offlineFallback: true,
    verifyMs: 0,
    engine: 'Local Reference Matrix',
    timestamp: new Date().toISOString(),
    batch: batch || null
  };
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
function showResultCard(result, mode = appState.get('analysisMode')) {
  if (mode === 'report') {
    const isOk     = result.authentic === true;
    const isManual = result.manualReviewRequired === true;
    const isLow    = !isOk && !isManual;

    els.resultCard.className = 'result-card slide-up truth-report';
    if (isManual) els.resultCard.classList.add('manual-review');
    if (isLow)    els.resultCard.classList.add('unverified');

    const confidence = Number(result.confidenceScore ?? 0);
    const confColor  = confidence >= 80 ? '#10B981' : (confidence >= 50 ? '#EAB308' : '#EF4444');
    const titleText = result.title || 'Scanned Report Summary';
    const summary = result.summary || 'No concise summary was generated from the scanned document.';
    const findings = Array.isArray(result.keyFindings) && result.keyFindings.length > 0 ? result.keyFindings : [];
    const recommendations = Array.isArray(result.recommendations) && result.recommendations.length > 0 ? result.recommendations : [];
    const followUp = result.followUp || 'Discuss the findings with the treating clinician.';
    const assessmentText = isOk
      ? 'The current scan produced a high-confidence summary.'
      : (isManual
        ? 'This summary is provisional and should be reviewed by a clinician or pharmacist.'
        : 'The available scan context did not produce a reliable match.');

    els.resultIcon.setAttribute('data-lucide', isOk ? 'file-check-2' : (isManual ? 'alert-circle' : 'file-warning'));
    els.resultTitle.textContent = titleText;

    els.resultDataRows.innerHTML = `
      <div class="data-row">
        <span class="data-label">Document Type</span>
        <span class="data-value" style="font-family: 'Playfair Display', serif; font-size: 16px;">Written Medical Report</span>
      </div>
      <div class="data-row">
        <span class="data-label">Assessment</span>
        <span class="data-value" style="font-size: 12px; color: ${confColor}; opacity: 0.95;">${escapeHtml(assessmentText)}</span>
      </div>
      <div class="data-row">
        <span class="data-label">Confidence</span>
        <span class="data-value" style="color: ${confColor}; font-weight: 800;">${confidence}%</span>
      </div>
      <div class="data-row">
        <span class="data-label">Source Context</span>
        <span class="data-value" style="font-size: 12px; color: var(--teal-primary); opacity: 0.9;">${escapeHtml(result.sourceContext || 'Clinical documentation')}</span>
      </div>
    `;

    els.resultDetailsBox.innerHTML = `
      <div class="detail-block" style="border: 1px solid rgba(16, 185, 129, 0.3); background: rgba(16, 185, 129, 0.05);">
        <div class="detail-title" style="color: #10B981;"><i data-lucide="file-text"></i> Concise Summary</div>
        <div class="detail-text">${escapeHtml(summary)}</div>
      </div>
      <div class="detail-block" style="background: rgba(255, 255, 255, 0.01); border: 1px dashed rgba(255, 255, 255, 0.05);">
        <div class="detail-title"><i data-lucide="shield-alert"></i> Evidence Status</div>
        <div class="detail-text">${escapeHtml(assessmentText)}</div>
      </div>
      ${findings.length > 0 ? `
      <div class="detail-block">
        <div class="detail-title"><i data-lucide="list-checks"></i> Key Findings</div>
        <div class="detail-text">
          <ul style="margin: 0; padding-left: 16px; display: grid; gap: 6px;">
            ${findings.map(item => `<li>${escapeHtml(item)}</li>`).join('')}
          </ul>
        </div>
      </div>` : ''}
      ${recommendations.length > 0 ? `
      <div class="detail-block">
        <div class="detail-title"><i data-lucide="stethoscope"></i> Recommendations</div>
        <div class="detail-text">
          <ul style="margin: 0; padding-left: 16px; display: grid; gap: 6px;">
            ${recommendations.map(item => `<li>${escapeHtml(item)}</li>`).join('')}
          </ul>
        </div>
      </div>` : ''}
      <div class="detail-block" style="background: rgba(234, 179, 8, 0.05); border: 1px solid rgba(234, 179, 8, 0.2);">
        <div class="detail-title" style="color: #EAB308;"><i data-lucide="calendar-check-2"></i> Follow-Up</div>
        <div class="detail-text">${escapeHtml(followUp)}</div>
      </div>
      <div class="detail-block" style="background: rgba(255, 255, 255, 0.01); border: 1px dashed rgba(255, 255, 255, 0.05);">
        <div class="detail-text" style="font-size: 10px; opacity: 0.4; text-transform: uppercase; letter-spacing: 1px; font-family: 'JetBrains Mono', monospace;">
          Ref: ${Date.now()} | Engine: ${result.engine || 'MedSwift Report AI'} | Latency: ${result.verifyMs ?? '—'}ms
        </div>
      </div>
    `;

    appState.set('lastResult', result);
    els.resultCard.classList.remove('hidden');
    lucide.createIcons();
    return;
  }

  if (mode === 'interaction') {
    const isOk     = result.authentic === true;
    const isManual = result.manualReviewRequired === true;
    const isLow    = !isOk && !isManual;

    els.resultCard.className = 'result-card slide-up truth-report';
    if (isManual) els.resultCard.classList.add('manual-review');
    if (isLow)    els.resultCard.classList.add('unverified');

    const confidence = Number(result.confidenceScore ?? 0);
    const risk = result.interactionRiskLevel || 'UNKNOWN';
    const evidence = result.evidenceLevel || 'Low';
    const primaryConcern = result.primaryConcern || 'No specific interaction concern stated.';
    const overallAssessment = result.overallAssessment || 'Interaction analysis unavailable.';
    const compatibility = result.therapeuticCompatibility || 'No compatibility assessment available.';
    const dosing = result.dosingConsiderations || 'No dosing guidance available.';
    const monitoring = Array.isArray(result.monitoringRecommendations) && result.monitoringRecommendations.length > 0 ? result.monitoringRecommendations : [];
    const alternatives = Array.isArray(result.alternativeRecommendations) && result.alternativeRecommendations.length > 0 ? result.alternativeRecommendations : [];
    const counseling = result.patientCounseling || 'No patient counseling statement provided.';

    els.resultIcon.setAttribute('data-lucide', isOk ? 'shield-check' : (isManual ? 'alert-circle' : 'shield-alert'));
    els.resultTitle.textContent = `Drug Interaction Review: ${risk}`;

    els.resultDataRows.innerHTML = `
      <div class="data-row">
        <span class="data-label">Risk Level</span>
        <span class="data-value" style="font-size: 16px; font-weight: 800; color: ${risk === 'HIGH' || risk === 'CONTRAINDICATED' ? '#EF4444' : (risk === 'MODERATE' ? '#EAB308' : '#10B981')};">${escapeHtml(risk)}</span>
      </div>
      <div class="data-row">
        <span class="data-label">Confidence</span>
        <span class="data-value" style="color: ${confidence >= 80 ? '#10B981' : (confidence >= 50 ? '#EAB308' : '#EF4444')}; font-weight: 800;">${confidence}%</span>
      </div>
      <div class="data-row">
        <span class="data-label">Evidence</span>
        <span class="data-value">${escapeHtml(evidence)}</span>
      </div>
      <div class="data-row">
        <span class="data-label">Primary Concern</span>
        <span class="data-value">${escapeHtml(primaryConcern)}</span>
      </div>
    `;

    els.resultDetailsBox.innerHTML = `
      <div class="detail-block">
        <div class="detail-title"><i data-lucide="shield"></i> Overall Assessment</div>
        <div class="detail-text">${escapeHtml(overallAssessment)}</div>
      </div>
      <div class="detail-block">
        <div class="detail-title"><i data-lucide="activity"></i> Therapeutic Compatibility</div>
        <div class="detail-text">${escapeHtml(compatibility)}</div>
      </div>
      <div class="detail-block">
        <div class="detail-title"><i data-lucide="pill"></i> Dosing Considerations</div>
        <div class="detail-text">${escapeHtml(dosing)}</div>
      </div>
      ${monitoring.length > 0 ? `
      <div class="detail-block">
        <div class="detail-title"><i data-lucide="list-checks"></i> Monitoring Recommendations</div>
        <div class="detail-text">
          <ul style="margin: 0; padding-left: 16px; display: grid; gap: 6px;">
            ${monitoring.map(item => `<li>${escapeHtml(item)}</li>`).join('')}
          </ul>
        </div>
      </div>` : ''}
      ${alternatives.length > 0 ? `
      <div class="detail-block">
        <div class="detail-title"><i data-lucide="stethoscope"></i> Alternative Recommendations</div>
        <div class="detail-text">
          <ul style="margin: 0; padding-left: 16px; display: grid; gap: 6px;">
            ${alternatives.map(item => `<li>${escapeHtml(item)}</li>`).join('')}
          </ul>
        </div>
      </div>` : ''}
      <div class="detail-block">
        <div class="detail-title"><i data-lucide="heart"></i> Patient Counseling</div>
        <div class="detail-text">${escapeHtml(counseling)}</div>
      </div>
      <div class="detail-block" style="background: rgba(255, 255, 255, 0.01); border: 1px dashed rgba(255, 255, 255, 0.05);">
        <div class="detail-text" style="font-size: 10px; opacity: 0.4; text-transform: uppercase; letter-spacing: 1px; font-family: 'JetBrains Mono', monospace;">
          Ref: ${Date.now()} | Engine: ${result.engine || 'MedSwift Interaction AI'} | Latency: ${result.verifyMs ?? '—'}ms
        </div>
      </div>
    `;

    appState.set('lastResult', result);
    els.resultCard.classList.remove('hidden');
    lucide.createIcons();
    return;
  }

  const isOk     = result.authentic === true;
  const isManual = result.manualReviewRequired === true;
  const isLow    = !isOk && !isManual;

  // Card class / glow state
  els.resultCard.className = 'result-card slide-up truth-report';
  if (isManual) els.resultCard.classList.add('manual-review');
  if (isLow)    els.resultCard.classList.add('unverified');

  // Icon & Title
  const iconName  = isOk ? 'shield-check' : (isManual ? 'alert-circle' : 'shield-alert');
  const titleText = result.drugName || 'Unidentified medication';
  const statusText = isOk ? 'Validated scan match' : (isManual ? 'Manual review required' : 'No confident medication match');
  els.resultIcon.setAttribute('data-lucide', iconName);
  els.resultTitle.textContent = `Scanned product: ${titleText}`;

  // Core data rows
  const confidence = Number(result.confidenceScore ?? 0);
  const confColor  = confidence >= 80 ? '#10B981' : (confidence >= 50 ? '#EAB308' : '#EF4444');

  els.resultDataRows.innerHTML = `
    <div class="data-row">
      <span class="data-label">Product Name</span>
      <span class="data-value" style="font-family: 'Playfair Display', serif; font-size: 16px;">${escapeHtml(titleText)}</span>
    </div>
    <div class="data-row">
      <span class="data-label">Assessment</span>
      <span class="data-value" style="font-size: 12px; color: ${confColor}; opacity: 0.95;">${escapeHtml(statusText)}</span>
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

async function generateMedicalReportPDF(result) {
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
      logoTag = `<img src="${logoDataUrl}" style="width:48px;height:48px;display:block;" alt="Logo" />`;
    }
  } catch (e) { console.warn('Medical PDF logo skipped:', e); }

  const title = escapeHtml(result.title || 'Concise Medical Report');
  const summary = escapeHtml(result.summary || 'No concise summary generated.');
  const findings = Array.isArray(result.keyFindings) ? result.keyFindings : [];
  const recommendations = Array.isArray(result.recommendations) ? result.recommendations : [];
  const followUp = escapeHtml(result.followUp || 'Discuss the findings with the treating clinician.');
  const refNo = `MR-${Date.now()}`;
  const dateStr = new Date().toLocaleString();

  const findingsHtml = findings.length > 0
    ? findings.map(item => `<li style="margin-bottom: 6px;">${escapeHtml(item)}</li>`).join('')
    : '<li>No specific findings were extracted.</li>';
  const recommendationsHtml = recommendations.length > 0
    ? recommendations.map(item => `<li style="margin-bottom: 6px;">${escapeHtml(item)}</li>`).join('')
    : '<li>No treatment recommendations were extracted.</li>';

  const htmlString = `
    <div style="width: 680px; padding: 50px; background: #FFFFFF; color: #111111; font-family: Arial, sans-serif; box-sizing: border-box;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="padding-bottom: 20px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td width="60" valign="middle">${logoTag}</td>
                <td valign="middle" style="padding-left: 16px;">
                  <div style="font-size: 18px; font-weight: 700; color: #111; text-transform: uppercase; letter-spacing: 3px;">MedSwift Report</div>
                  <div style="font-size: 10px; color: #6B7280; text-transform: uppercase; letter-spacing: 2px; margin-top: 3px;">Concise Clinical Summary</div>
                </td>
                <td valign="middle" align="right">
                  <div style="font-size: 9px; color: #9CA3AF;">Ref: ${refNo}</div>
                  <div style="font-size: 9px; color: #9CA3AF; margin-top: 2px;">${dateStr}</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr><td height="2" bgcolor="#10B981" style="font-size:0;line-height:0;padding-bottom:24px;">&nbsp;</td></tr>
        <tr>
          <td style="padding-bottom: 18px;">
            <div style="font-size: 22px; font-weight: 700; color: #111;">${title}</div>
            <div style="font-size: 12px; color: #6B7280; margin-top: 8px;">Generated from a scanned written medical report using OCR and AI summarization.</div>
          </td>
        </tr>
        <tr>
          <td style="padding-bottom: 24px;">
            <div style="background: #F9FAFB; border: 1px solid #E5E7EB; padding: 16px; border-radius: 8px;">
              <div style="font-size: 10px; font-weight: 700; color: #10B981; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px;">Summary</div>
              <div style="font-size: 12px; color: #374151; line-height: 1.6;">${summary}</div>
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding-bottom: 24px;">
            <div style="background: #F9FAFB; border: 1px solid #E5E7EB; padding: 16px; border-radius: 8px;">
              <div style="font-size: 10px; font-weight: 700; color: #10B981; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px;">Key Findings</div>
              <ul style="margin: 0; padding-left: 16px; font-size: 12px; color: #374151; line-height: 1.6;">${findingsHtml}</ul>
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding-bottom: 24px;">
            <div style="background: #F9FAFB; border: 1px solid #E5E7EB; padding: 16px; border-radius: 8px;">
              <div style="font-size: 10px; font-weight: 700; color: #10B981; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px;">Recommendations</div>
              <ul style="margin: 0; padding-left: 16px; font-size: 12px; color: #374151; line-height: 1.6;">${recommendationsHtml}</ul>
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding-bottom: 24px;">
            <div style="background: rgba(234, 179, 8, 0.05); border: 1px solid rgba(234, 179, 8, 0.2); padding: 16px; border-radius: 8px;">
              <div style="font-size: 10px; font-weight: 700; color: #EAB308; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px;">Follow-Up</div>
              <div style="font-size: 12px; color: #374151; line-height: 1.6;">${followUp}</div>
            </div>
          </td>
        </tr>
        <tr>
          <td style="border-top: 1px solid #E5E7EB; padding-top: 16px;">
            <div style="font-size: 8px; color: #9CA3AF; text-transform: uppercase; letter-spacing: 0.5px; line-height: 1.6;">
              Informational Use Only: This report is an AI-assisted summary of a clinical document and should be reviewed by a qualified professional.
            </div>
          </td>
        </tr>
      </table>
    </div>`;

  const opt = {
    margin: 0.3,
    filename: 'medswift-medical-report.pdf',
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2 },
    jsPDF: { unit: 'in', format: 'a4', orientation: 'portrait' }
  };

  await html2pdf().set(opt).from(htmlString).save();
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
  if (els.reportTextInput) els.reportTextInput.value = '';
  if (els.btnAnalyzeText) els.btnAnalyzeText.innerHTML = 'Summarize Report';
  if (els.reportTextInput) els.reportTextInput.disabled = false;
  if (els.btnAnalyzeText) els.btnAnalyzeText.disabled = false;

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
    clearTimeout(scanInterval);
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
    const name   = scan.drugName || scan.title || 'Unknown Report';
    return `
      <div class="audit-item">
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
  if ((appState.get('analysisMode') || 'medication') === 'report') {
    await generateMedicalReportPDF(result);
    return;
  }

  // 1. Pre-load logo as base64 to ensure it renders in the isolated PDF context
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
      logoTag = `<img src="${logoDataUrl}" style="width:48px;height:48px;display:block;" alt="Logo" />`;
    }
  } catch (e) { console.warn('PDF logo skipped:', e); }

  // 2. Prepare data with safe escaping
  const drugName       = escapeHtml(result.drugName || 'Unknown');
  const manufacturer   = escapeHtml(result.manufacturer || 'Unverified');
  const origin         = result.originVerified ? 'Verified source metadata' : 'Source metadata not independently verified';
  const classification = escapeHtml(result.therapeuticClass || 'Uncategorized');
  const indication     = escapeHtml(result.indication || 'Symptom management');
  const dosage         = escapeHtml(result.dosageInstructions || 'Verify with a licensed pharmacist.');
  const nudge          = escapeHtml(result.lifestyleNudge || '');
  const confidence     = Number(result.confidenceScore || 0);
  const status         = result.authentic ? 'Validated scan match' : (result.manualReviewRequired ? 'Manual review required' : 'No confident match');
  const warnings       = escapeHtml(result.warnings || 'None detected.');
  const interaction    = escapeHtml(result.proactiveInsight || 'No known conflicts detected.');
  const refNo          = `MV-${Date.now()}`;
  const dateStr        = new Date().toLocaleString();

  // 3. Construct self-contained HTML String
  // Using an HTML string instead of a DOM element bypasses all visibility/scrolling issues.
  const htmlString = `
    <div style="width: 680px; padding: 50px; background: #FFFFFF; color: #111111; font-family: Arial, sans-serif; box-sizing: border-box;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <!-- HEADER -->
        <tr>
          <td style="padding-bottom: 20px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td width="60" valign="middle">${logoTag}</td>
                <td valign="middle" style="padding-left: 16px;">
                  <div style="font-size: 18px; font-weight: 700; color: #111; text-transform: uppercase; letter-spacing: 3px;">MedSwift Vision</div>
                  <div style="font-size: 10px; color: #6B7280; text-transform: uppercase; letter-spacing: 2px; margin-top: 3px;">Scan Assessment</div>
                </td>
                <td valign="middle" align="right">
                  <div style="font-size: 9px; color: #9CA3AF;">Ref: ${refNo}</div>
                  <div style="font-size: 9px; color: #9CA3AF; margin-top: 2px;">${dateStr}</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr><td height="2" bgcolor="#F97316" style="font-size:0;line-height:0;padding-bottom:32px;">&nbsp;</td></tr>
        
        <!-- PROFILE -->
        <tr>
          <td style="padding-bottom: 28px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top: 1px solid #E5E7EB; border-bottom: 1px solid #E5E7EB;">
              <tr>
                <td width="50%" valign="top" style="padding: 16px 16px 16px 0;">
                  <div style="font-size: 9px; font-weight: 700; color: #10B981; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 6px;">Product</div>
                  <div style="font-size: 22px; font-weight: 700; color: #111;">${drugName}</div>
                </td>
                <td width="50%" valign="top" style="padding: 16px 0 16px 16px; border-left: 1px solid #E5E7EB;">
                  <div style="margin-bottom: 10px;">
                    <div style="font-size: 9px; font-weight: 700; color: #6B7280; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 3px;">Manufacturer & Origin</div>
                    <div style="font-size: 12px; font-weight: 500; color: #111;">${manufacturer} &mdash; Origin: ${origin}</div>
                  </div>
                  <div>
                    <div style="font-size: 9px; font-weight: 700; color: #6B7280; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 3px;">Classification</div>
                    <div style="font-size: 12px; font-weight: 500; color: #111;">${classification}</div>
                  </div>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- ANALYSIS -->
        <tr><td style="padding-bottom: 12px; font-size: 10px; font-weight: 700; color: #111; text-transform: uppercase; letter-spacing: 3px;">The Truth Analysis</td></tr>
        <tr>
          <td style="padding-bottom: 28px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr valign="top">
                <td width="32%" style="background: #F9FAFB; border: 1px solid #F0F0F0; padding: 16px;">
                  <div style="font-size: 9px; font-weight: 700; color: #10B981; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px;">The Purpose</div>
                  <div style="font-size: 11px; color: #374151; line-height: 1.6;">Targeting primary indications. Designed to assist with ${indication}.</div>
                </td>
                <td width="2%">&nbsp;</td>
                <td width="32%" style="background: #F9FAFB; border: 1px solid #F0F0F0; padding: 16px;">
                  <div style="font-size: 9px; font-weight: 700; color: #10B981; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px;">The Protocol</div>
                  <div style="font-size: 11px; color: #374151; line-height: 1.6;">${dosage} ${nudge}</div>
                </td>
                <td width="2%">&nbsp;</td>
                <td width="32%" style="background: #F9FAFB; border: 1px solid #F0F0F0; padding: 16px;">
                  <div style="font-size: 9px; font-weight: 700; color: #10B981; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px;">The Verification</div>
                  <div style="font-size: 11px; color: #374151; line-height: 1.6;">Confidence Score: <strong>${confidence}%</strong>. Status: <strong>${status}</strong>.</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- SAFETY -->
        <tr>
          <td style="padding-bottom: 40px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td width="3" bgcolor="#F97316" style="font-size:0;">&nbsp;</td>
                <td style="padding-left: 16px;">
                  <div style="font-size: 10px; font-weight: 700; color: #111; text-transform: uppercase; letter-spacing: 3px; margin-bottom: 14px;">Safety Insights</div>
                  <div style="font-size: 9px; font-weight: 700; color: #F97316; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px;">Critical Avoidance:</div>
                  <div style="font-size: 11px; color: #374151; margin-bottom: 12px;">${warnings}</div>
                  <div style="font-size: 9px; font-weight: 700; color: #F97316; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px;">Potential Interaction:</div>
                  <div style="font-size: 11px; color: #374151;">${interaction}</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- FOOTER -->
        <tr>
          <td style="border-top: 1px solid #E5E7EB; padding-top: 16px;">
            <div style="font-size: 8px; color: #9CA3AF; text-transform: uppercase; letter-spacing: 0.5px; line-height: 1.6;">
              Informational Use Only: MedSwift AI identification is cross-referenced with global pharma datasets. This is not medical advice. Always consult a professional before consumption.
            </div>
          </td>
        </tr>
      </table>
    </div>
  `;

  // 4. Trigger PDF Generation via htmlString
  const opt = {
    margin:       [10, 10, 10, 10],
    filename:     `MedVision_Audit_${(result.drugName || 'Unknown').replace(/\s/g, '_')}_${Date.now()}.pdf`,
    image:        { type: 'jpeg', quality: 0.98 },
    html2canvas:  { scale: 2, useCORS: true, logging: false },
    jsPDF:        { unit: 'mm', format: 'a4', orientation: 'portrait' }
  };

  try {
    // Using string-based rendering is the most reliable way to prevent blank pages
    // as it creates its own isolated rendering context.
    await html2pdf().set(opt).from(htmlString).save();
  } catch (err) {
    console.error('PDF Engine Failure:', err);
    alert('PDF Generation failed. Please check your internet connection and try again.');
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
