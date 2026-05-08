import { appState } from './state.js';
import { seedDemoData } from './db.js';
import { startCamera, captureFrame, identifyMedication } from './scanner.js';

let activeStream = null;
let scanInterval = null;
let analysisController = null;

// UI Elements
const els = {
  // Scanner
  video: document.getElementById('scanner-video'),
  placeholder: document.getElementById('scanner-placeholder'),
  beam: document.getElementById('scanner-beam'),
  shimmer: document.getElementById('holo-shimmer'),
  prompt: document.getElementById('scanner-prompt'),
  resultCard: document.getElementById('scan-result-card'),
  controls: document.getElementById('scanner-controls'),
  btnStartScan: document.getElementById('btn-start-scan'),
  btnUploadScan: document.getElementById('btn-upload-scan'),
  uploadInput: document.getElementById('upload-input'),
  dismissScan: document.getElementById('dismiss-scan'),
  verificationZone: document.getElementById('verification-zone'),
  intelligenceIcon: document.getElementById('intelligence-icon'),
  cancelAnalysisBox: document.getElementById('analysis-cancel-box'),
  btnCancelAnalysis: document.getElementById('btn-cancel-analysis'),
  
  // Result
  resultIconBg: document.getElementById('result-icon-bg'),
  resultIcon: document.getElementById('result-icon'),
  resultTitle: document.getElementById('result-title'),
  resultDataRows: document.getElementById('result-data-rows'),
  resultDetailsBox: document.getElementById('result-details-box'),

  // Audit Trail
  auditList: document.getElementById('audit-trail-list')
};

// ─── INITIALIZATION ───
document.addEventListener('DOMContentLoaded', async () => {
  await seedDemoData();
  setupEventListeners();
});

// ─── EVENT LISTENERS ───
function setupEventListeners() {
  els.btnStartScan.addEventListener('click', async () => {
    appState.set('scanStatus', 'scanning');
    els.placeholder.classList.add('hidden');
    els.video.classList.add('is-active');
    els.beam.classList.remove('hidden');
    els.prompt.classList.add('hidden');
    els.controls.classList.add('hidden');
    els.verificationZone.classList.remove('hidden');

    activeStream = await startCamera(els.video);
    if (activeStream) {
      // Start periodic frame capture for vision engine
      scanInterval = setInterval(async () => {
        if (appState.get('scanStatus') === 'scanning') {
          const frame = await captureFrame(els.video);
          await processVisionFrame(frame);
        }
      }, 3000); // Process every 3 seconds
    }
  });

  els.btnUploadScan.addEventListener('click', () => {
    els.uploadInput.click();
  });

  els.uploadInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      const base64Image = event.target.result;
      
      // UI Update for manual upload
      els.placeholder.classList.add('hidden');
      els.prompt.classList.add('hidden');
      els.controls.classList.add('hidden');
      els.beam.classList.remove('hidden');
      
      await processVisionFrame(base64Image);
      
      // Reset input so same file can be uploaded again if needed
      els.uploadInput.value = '';
    };
    reader.readAsDataURL(file);
  });

  els.btnCancelAnalysis.addEventListener('click', () => {
    if (analysisController) {
      analysisController.abort();
      analysisController = null;
    }
    resetScannerUI();
  });

  els.dismissScan.addEventListener('click', resetScannerUI);
}

// ─── VISION LOGIC ───
async function processVisionFrame(frame) {
  appState.set('scanStatus', 'verifying');
  
  // UI: Scanning Intelligence (Purple Glow)
  els.beam.classList.add('intelligence-glow');
  els.shimmer.classList.remove('hidden');
  els.intelligenceIcon.classList.add('status-pulse');
  els.cancelAnalysisBox.classList.remove('hidden');

  analysisController = new AbortController();

  try {
    const result = await identifyMedication(frame, analysisController.signal);
    
    if (result.error) {
      appState.set('scanStatus', 'scanning'); // Retry on other errors
      return;
    }

    clearInterval(scanInterval);
    stopCamera();
    
    els.shimmer.classList.add('hidden');
    els.beam.classList.remove('intelligence-glow');
    els.cancelAnalysisBox.classList.add('hidden');
    showResultCard(result);
    
    const history = appState.get('scanHistory');
    history.unshift(result);
    appState.set('scanHistory', history.slice(0, 50));
    renderAuditTrail();
  } catch (err) {
    if (err.name === 'AbortError') {
      console.log('Analysis cancelled by user');
      // No need to set back to scanning, resetScannerUI already handled it
    } else {
      console.error('Analysis error:', err);
      appState.set('scanStatus', 'scanning');
    }
  }
}

function stopCamera() {
  if (activeStream) {
    activeStream.getTracks().forEach(track => track.stop());
    activeStream = null;
  }
}

function showResultCard(result) {
  const isOk = result.authentic;
  const isManual = result.manualReviewRequired;
  
  // Reset classes
  els.resultCard.className = 'result-card slide-up truth-report';
  if (isManual) els.resultCard.classList.add('manual-review');

  els.resultIcon.setAttribute('data-lucide', isOk ? 'shield-check' : (isManual ? 'alert-circle' : 'shield-alert'));
  els.resultTitle.textContent = isOk ? 'Truth Report: Authentic' : (isManual ? 'Manual Review Required' : 'Truth Report: Unverified');
  
  els.resultDataRows.innerHTML = `
    <div class="data-row"><span class="data-label">Identity</span><span class="data-value">${result.drugName}</span></div>
    <div class="data-row"><span class="data-label">Manufacturer</span><span class="data-value">${result.manufacturer}</span></div>
    <div class="data-row"><span class="data-label">Confidence</span><span class="data-value">${result.confidenceScore}%</span></div>
  `;

  els.resultDetailsBox.innerHTML = `
    <div class="detail-block">
      <div class="detail-title">Intelligence extraction</div>
      <div class="detail-text">Indication: ${result.indication}</div>
      <div class="detail-text">Form: ${result.dosageForm}</div>
    </div>
    <div class="detail-block">
      <div class="detail-title">Origin verification</div>
      <div class="detail-text">${result.originVerified ? 'Successfully cross-referenced with openFDA/RxNorm standards.' : 'Origin data inconsistent with global standards.'}</div>
    </div>
    <div class="detail-block">
      <div class="detail-title">Supply chain audit</div>
      <div class="detail-text">Expiry Pattern: ${result.expiryPattern} | Ledger Sync: ${result.cached ? 'Offline (Cached)' : 'Live'}</div>
    </div>
  `;

  els.resultCard.classList.remove('hidden');
  lucide.createIcons();
}

function resetScannerUI() {
  appState.set('scanStatus', 'idle');
  els.resultCard.classList.add('hidden');
  els.prompt.classList.remove('hidden');
  els.controls.classList.remove('hidden');
  els.placeholder.classList.remove('hidden');
  els.video.classList.remove('is-active');
  els.verificationZone.classList.add('hidden');
  els.intelligenceIcon.classList.remove('status-pulse');
  els.cancelAnalysisBox.classList.add('hidden');
  
  // Visual Reset
  els.beam.classList.add('hidden');
  els.beam.classList.remove('intelligence-glow');
  els.shimmer.classList.add('hidden');

  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }
  stopCamera();
}

// ─── RENDERERS ───
function renderAuditTrail() {
  const history = appState.get('scanHistory');
  if (history.length === 0) return;
  
  els.auditList.innerHTML = history.map((scan, i) => {
    const ok = scan.authentic;
    const color = ok ? 'var(--success)' : (scan.manualReviewRequired ? '#EAB308' : 'var(--danger)');
    const bg = ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)';
    const icon = ok ? 'check' : (scan.manualReviewRequired ? 'alert-circle' : 'x');
    const name = scan.drugName || 'Unknown Product';

    return `
      <div class="audit-item" style="animation: slideUp 0.3s ease ${i*0.05}s forwards; opacity:0; transform:translateY(10px); border-color: ${color}">
        <div class="audit-item-icon" style="background: ${bg};">
          <i data-lucide="${icon}" style="width: 14px; height: 14px; color: ${color};"></i>
        </div>
        <div class="audit-item-info">
          <div class="audit-item-header">
            <span class="audit-item-name">${name}</span>
            <span class="audit-item-badge" style="background: ${bg}; color: ${color};">${scan.confidenceScore}% Conf.</span>
          </div>
          <div class="audit-item-meta">${scan.manufacturer} • ${scan.verifyMs}ms</div>
        </div>
      </div>
    `;
  }).join('');
  lucide.createIcons();
}

