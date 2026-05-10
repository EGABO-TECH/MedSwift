/**
 * Dexie.js Integration for GS1 Standards & FDA/RxNorm Offline Data
 */
export const db = new Dexie('medswift-vanilla-v2');

db.version(3).stores({
  medicationBatch: '++id, gtin, lot, serial, [gtin+lot+serial]',
  chainOfCustodyNodes: '++id, batchId, timestamp, [batchId+timestamp]',
  referenceData: 'gtin, ndc, rxnormId, brandName',
  visualCache: 'imageHash, drugName'
});

export async function seedDemoData() {
  const refCount = await db.referenceData.count();
  if (refCount === 0) {
    try {
      // Load our compressed RxNorm/openFDA subset for offline use
      const response = await fetch('data/offline_db.json');
      const data = await response.json();
      await db.referenceData.bulkAdd(data);
      console.log('Successfully seeded offline reference data from RxNorm & openFDA.');
    } catch (e) {
      console.warn('Network unavailable for offline_db.json. Bootstrapping August Intelligence fallback matrix...');
      const fallbackMatrix = [
        {
          gtin: "00300450449108", ndc: "0045-0449-10", rxnormId: "8640",
          brandName: "Lipitor", genericName: "Atorvastatin Calcium",
          dosageInstructions: "Take 10-80mg once daily, with or without food.",
          warnings: "Risk of myopathy. Avoid large quantities of grapefruit juice.",
          isEssentialMedicine: true,
          lifestyleNudge: "Taking statins in the evening can align with your body's natural cholesterol production cycle.",
          suggestedBiomarkers: ["Lipid Panel (LDL/HDL)", "Liver Enzymes (AST/ALT)", "Creatine Kinase"],
          proactiveInsight: "Statin class identified. Proactive liver function check recommended within 3 months of starting.",
          therapeuticClass: "HMG-CoA Reductase Inhibitor",
          pathway: "Inhibits HMG-CoA reductase, the rate-limiting enzyme in cholesterol synthesis.",
          regulatoryStatus: "FDA Approved"
        },
        {
          gtin: "00300450449109", ndc: "0045-0449-11", rxnormId: "6809",
          brandName: "Glucophage", genericName: "Metformin Hydrochloride",
          dosageInstructions: "Take 500mg twice daily with meals.",
          warnings: "Risk of lactic acidosis. Avoid excessive alcohol intake.",
          isEssentialMedicine: true,
          lifestyleNudge: "Taking this with meals greatly reduces stomach upset. A balanced, low-glycemic diet enhances its effects.",
          suggestedBiomarkers: ["HbA1c", "Fasting Blood Glucose", "Vitamin B12 Levels", "Renal Function (eGFR)"],
          proactiveInsight: "Metformin identified. Long-term use may lower B12 absorption. Consider monitoring B12 levels.",
          therapeuticClass: "Biguanide Antidiabetic",
          pathway: "Decreases hepatic glucose production and intestinal absorption, improves insulin sensitivity.",
          regulatoryStatus: "FDA Approved / EMA Authorized"
        },
        {
          gtin: "00300450449110", ndc: "0045-0449-12", rxnormId: "1191",
          brandName: "Amoxil", genericName: "Amoxicillin",
          dosageInstructions: "Take 500mg every 8 hours or 875mg every 12 hours.",
          warnings: "High risk of anaphylaxis in penicillin-allergic patients. Complete full course.",
          isEssentialMedicine: true,
          lifestyleNudge: "Taking probiotics 2 hours after your dose can help maintain a healthy gut microbiome.",
          suggestedBiomarkers: [],
          proactiveInsight: "Antibiotic identified. Do not stop early even if symptoms improve to prevent resistance.",
          therapeuticClass: "Aminopenicillin",
          pathway: "Inhibits bacterial cell wall synthesis by binding to penicillin-binding proteins.",
          regulatoryStatus: "FDA Approved"
        }
      ];
      await db.referenceData.bulkAdd(fallbackMatrix);
      console.log('Successfully seeded August Offline Medical Logic.');
    }
  }

  const batchCount = await db.medicationBatch.count();
  if (batchCount === 0) {
    await db.medicationBatch.bulkAdd([
      {
        gtin: '00380777055124', lot: 'MX-2024-8A7F', serial: 'SN-00012845',
        expiry: '20270315', status: 'active'
      },
      {
        gtin: '00369715002715', lot: 'TX-2024-3B2C', serial: 'SN-00089341',
        expiry: '20261201', status: 'active'
      }
    ]);
  }
}

export async function findBatchByGTIN(gtin, lot) {
  return db.medicationBatch.where({ gtin, lot }).first();
}

export async function getReferenceData(gtin) {
  return db.referenceData.where('gtin').equals(gtin).first();
}
