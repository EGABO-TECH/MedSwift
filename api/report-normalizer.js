/**
 * MedSwift Clinical Report Normalizer
 * Ensures all report outputs are clinically meaningful and properly structured
 */

export function isClinicallyMeaningful(text) {
  const meaningful = String(text || '')
    .toLowerCase()
    .replace(/^[-•*\d.()[\]{}]+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Filter out non-clinical noise
  const noisePatterns = [
    /^(?:form|field|name|branch|trade|date|wait|rank|unit|colos|disposal|pad|base|paf|ref|no\.?|id)\b/i,
    /^[a-z]{1,2}\s*:?\s*$/,
    /^\d+\.?\d*\s*$/
  ];

  if (noisePatterns.some(p => p.test(meaningful))) return false;
  return meaningful.length > 15;
}

export function extractClinicalStructure(text) {
  // Parse clinical text to extract: complaints, findings, diagnosis, medications, plan
  const lines = (text || '')
    .split(/\n|;(?!.*http)/)
    .map(l => l.trim())
    .filter(Boolean);

  const clinical = {
    complaints: [],
    findings: [],
    diagnoses: [],
    medications: [],
    vitals: [],
    plan: []
  };

  const patterns = {
    complaint: /(?:chief complaint|cc:|patient presents|complains of|c\/c|hpc|hpi|history|states)/i,
    finding: /(?:exam|physical exam|pe|vital|bmi|bp|hr|o2|sat|rr|temp|finding|observed|noted|shows|assessment)/i,
    diagnosis: /(?:diagnosis|dx:|assessment|impression|rule out|ddx|assessment:|icd)/i,
    medication: /(?:medication|drug|rx|prescribed|taking|given|mg|tablet|capsule|dose|therapy)/i,
    vital: /(?:bp|blood pressure|heart rate|hr|o2|oxygen|temp|temperature|respiratory rate|rr|weight|bmi)/i,
    plan: /(?:plan|recommendation|advise|follow.?up|return|recheck|monitor|continue|stop|refer|prescribe)/i
  };

  for (const line of lines) {
    if (!line || line.length < 5) continue;

    if (patterns.complaint.test(line)) {
      const cleaned = line.replace(patterns.complaint, '').trim();
      if (isClinicallyMeaningful(cleaned)) clinical.complaints.push(cleaned);
    } else if (patterns.diagnosis.test(line)) {
      const cleaned = line.replace(patterns.diagnosis, '').trim();
      if (isClinicallyMeaningful(cleaned)) clinical.diagnoses.push(cleaned);
    } else if (patterns.vital.test(line)) {
      clinical.vitals.push(line);
    } else if (patterns.medication.test(line)) {
      clinical.medications.push(line);
    } else if (patterns.plan.test(line)) {
      const cleaned = line.replace(patterns.plan, '').trim();
      if (isClinicallyMeaningful(cleaned)) clinical.plan.push(cleaned);
    } else if (patterns.finding.test(line)) {
      const cleaned = line.replace(patterns.finding, '').trim();
      if (isClinicallyMeaningful(cleaned)) clinical.findings.push(cleaned);
    } else if (isClinicallyMeaningful(line)) {
      clinical.findings.push(line);
    }
  }

  return clinical;
}

export function validateAndCleanSummary(summary, fallback = 'Clinical evaluation performed. Provider assessment recommended.') {
  const clinicalKeywords = /patient|diagnosis|assessment|finding|evaluation|examination|symptom|complaint|condition|therapy|medication|treatment|disease|abnormal|normal|elevated|present|absent|clear|noted|observed|reported/i;

  const text = String(summary || '').replace(/\s+/g, ' ').trim();

  if (!isClinicallyMeaningful(text)) return fallback;
  if (!clinicalKeywords.test(text)) return fallback;
  if (text.length < 30) return fallback;

  return text;
}

export function normalizeReportResult(result, sourceText = '') {
  const def = {
    title: 'Clinical Assessment',
    summary: 'Clinical evaluation completed. Provider review recommended.',
    keyFindings: ['Clinical assessment performed'],
    recommendations: ['Follow-up with provider'],
    followUp: 'Schedule follow-up as clinically indicated.',
    sourceContext: 'Clinical document scan'
  };

  const normalizeItem = (item, maxWords = 28) => {
    const text = String(item || '').replace(/\s+/g, ' ').trim();
    if (!isClinicallyMeaningful(text)) return null;
    const words = text.split(/\s+/);
    return words.length <= maxWords ? text : words.slice(0, maxWords).join(' ') + '…';
  };

  const normalizeList = (items, fallback, maxItems = 3) => {
    const cleaned = (Array.isArray(items) ? items : [])
      .map(item => normalizeItem(item, 20))
      .filter(Boolean)
      .slice(0, maxItems);
    return cleaned.length > 0 ? cleaned : [fallback];
  };

  // Build final summary
  let finalSummary = normalizeItem(result?.summary, 30);

  if (!finalSummary && sourceText) {
    const clinical = extractClinicalStructure(sourceText);

    const summaryParts = [];
    if (clinical.complaints.length > 0) {
      summaryParts.push(`Patient with ${clinical.complaints[0]}`);
    }
    if (clinical.findings.length > 0) {
      summaryParts.push(`Findings: ${clinical.findings.slice(0, 2).join('; ')}`);
    }
    if (clinical.diagnoses.length > 0) {
      summaryParts.push(`Assessment: ${clinical.diagnoses[0]}`);
    }

    finalSummary = summaryParts.join('. ');
    if (!finalSummary || !isClinicallyMeaningful(finalSummary)) {
      finalSummary = def.summary;
    }
  }

  return {
    ...result,
    title: normalizeItem(result?.title, 20) || def.title,
    summary: finalSummary || def.summary,
    keyFindings: normalizeList(result?.keyFindings, 'Clinical assessment completed', 3),
    recommendations: normalizeList(result?.recommendations, 'Follow-up with provider as indicated', 2),
    followUp: normalizeItem(result?.followUp, 14) || def.followUp,
    sourceContext: normalizeItem(result?.sourceContext, 10) || def.sourceContext
  };
}
