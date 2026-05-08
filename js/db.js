/**
 * Dexie.js Integration for GS1 Standards & FDA/RxNorm Offline Data
 */
export const db = new Dexie('medswift-vanilla-v2');

db.version(2).stores({
  medicationBatch: '++id, gtin, lot, serial, [gtin+lot+serial]',
  chainOfCustodyNodes: '++id, batchId, timestamp, [batchId+timestamp]',
  referenceData: 'gtin, ndc, rxnormId, brandName'
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
      console.error('Failed to load offline_db.json', e);
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
