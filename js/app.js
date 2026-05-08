import { appState } from './state.js';
import { seedDemoData } from './db.js';
import { verifyScannedCode, startCamera } from './scanner.js';

let scannerReader = null;

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
  btnDemoScan: document.getElementById('btn-demo-scan'),
  dismissScan: document.getElementById('dismiss-scan'),
  
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


  // Scanner controls
  els.btnStartScan.addEventListener('click', async () => {
    appState.set('scanStatus', 'scanning');
    els.placeholder.classList.add('hidden');
    els.video.classList.add('is-active');
    els.beam.classList.remove('hidden');
    els.prompt.classList.add('hidden');
    els.controls.classList.add('hidden');

    scannerReader = await startCamera(els.video, handleScanResult);
  });

  els.btnDemoScan.addEventListener('click', () => {
    handleScanResult('(01)00380777055124(10)MX-2024-8A7F(17)270315(21)SN-00012845');
  });

  els.dismissScan.addEventListener('click', resetScannerUI);
}



// ─── SCANNER LOGIC ───
async function handleScanResult(rawData) {
  if (appState.get('scanStatus') === 'verifying') return;
  
  if (scannerReader) {
    scannerReader.reset();
    scannerReader = null;
  }

  appState.set('scanStatus', 'verifying');
  els.beam.classList.add('hidden');
  els.shimmer.classList.remove('hidden');
  els.video.classList.remove('is-active');
  els.placeholder.classList.remove('hidden');

  // Verify
  const result = await verifyScannedCode(rawData);
  
  els.shimmer.classList.add('hidden');
  showResultCard(result);
  
  const history = appState.get('scanHistory');
  history.unshift(result);
  appState.set('scanHistory', history.slice(0, 50));
  renderAuditTrail();
}

function truncate(str, n) {
  return (str.length > n) ? str.slice(0, n - 1) + '...' : str;
}

function showResultCard(result) {
  const ok = result.authentic;
  
  els.resultCard.className = `result-card slide-up ${ok ? 'result-authentic' : 'result-counterfeit'}`;
  
  els.resultIconBg.style.background = ok ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)';
  els.resultIcon.setAttribute('data-lucide', ok ? 'check' : 'x');
  els.resultIcon.style.color = ok ? 'var(--success)' : 'var(--danger)';
  
  els.resultTitle.textContent = ok ? 'Verified Authentic' : 'Counterfeit Detected';
  els.resultTitle.style.color = ok ? 'var(--success)' : 'var(--danger)';
  
  els.resultDataRows.innerHTML = `
    <div class="data-row"><span class="data-label">GTIN</span><span class="data-value">${result.gs1?.gtin || '—'}</span></div>
    <div class="data-row"><span class="data-label">Batch/Lot</span><span class="data-value">${result.gs1?.lot || '—'}</span></div>
    <div class="data-row"><span class="data-label">Origin</span><span class="data-value">${result.fdaEnrichment?.origin || (ok ? 'Verified' : 'Unknown')}</span></div>
  `;

  // Offline DB Enriched Data
  let detailsHtml = '';
  if (ok && result.fdaEnrichment) {
    detailsHtml = `
      <div class="detail-block">
        <div class="detail-title">Drug Information</div>
        <div class="detail-text">${result.fdaEnrichment.genericName} (${result.fdaEnrichment.brandName})</div>
      </div>
      <div class="detail-block">
        <div class="detail-title">Dosage & Administration</div>
        <div class="detail-text">${truncate(result.fdaEnrichment.dosageInstructions || 'No data', 120)}</div>
      </div>
      <div class="detail-block">
        <div class="detail-title" style="color: var(--danger);">Warnings</div>
        <div class="detail-text">${truncate(result.fdaEnrichment.warnings || 'No data', 80)}</div>
      </div>
      <div class="detail-block">
        <div class="detail-title" style="color: var(--success);">Standards Registry</div>
        <div class="detail-text">RxNorm: ${result.fdaEnrichment.rxnormId} | NDC: ${result.fdaEnrichment.ndc}</div>
      </div>
    `;
  } else {
    detailsHtml = `
      <div class="detail-block">
        <div class="detail-title" style="color: var(--danger);">Danger</div>
        <div class="detail-text">This product is not recognized by the GS1 ledger. Do not consume.</div>
      </div>
    `;
  }

  els.resultDetailsBox.innerHTML = detailsHtml;

  els.resultCard.classList.remove('hidden');
  lucide.createIcons();
}

function resetScannerUI() {
  appState.set('scanStatus', 'idle');
  els.resultCard.classList.add('hidden');
  els.prompt.classList.remove('hidden');
  els.controls.classList.remove('hidden');
}

// ─── RENDERERS ───
function renderAuditTrail() {
  const history = appState.get('scanHistory');
  if (history.length === 0) return;
  
  els.auditList.innerHTML = history.map((scan, i) => {
    const ok = scan.authentic;
    const color = ok ? 'var(--success)' : 'var(--danger)';
    const bg = ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)';
    const icon = ok ? 'check' : 'x';
    const label = ok ? 'Auth' : 'Flag';
    const name = scan.batch?.brandName || scan.fdaEnrichment?.brandName || scan.gs1?.gtin || 'Unknown Product';

    return `
      <div class="audit-item" style="animation: slideUp 0.3s ease ${i*0.05}s forwards; opacity:0; transform:translateY(10px); border-color: ${ok ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}">
        <div class="audit-item-icon" style="background: ${bg};">
          <i data-lucide="${icon}" style="width: 14px; height: 14px; color: ${color};"></i>
        </div>
        <div class="audit-item-info">
          <div class="audit-item-header">
            <span class="audit-item-name">${name}</span>
            <span class="audit-item-badge" style="background: ${bg}; color: ${color};">${label}</span>
          </div>
          <div class="audit-item-meta">${scan.fdaEnrichment?.origin || 'Origin verified via ledger'} • ${scan.verifyMs}ms</div>
        </div>
      </div>
    `;
  }).join('');
  lucide.createIcons();
}
