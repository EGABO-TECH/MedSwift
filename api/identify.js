export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { image } = req.body;
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'Gemini API Key not configured in Vercel' });
  }

  const prompt = `You are an advanced pharmaceutical verification AI. Identify the medication in the provided image by heavily leveraging your knowledge of global medical databases (openFDA, DailyMed, RxNorm, DrugBank, ChEMBL) and Google's database.

Extract and provide highly accurate information for:
1. Drug Name: Brand and generic.
2. Manufacturer/Origin: Verified manufacturer.
3. Indication/Disease: Specific diseases/disorders it cures or treats.
4. Dosage Prescriptions: Standard dosage forms and guidelines.
5. Expiry Pattern: Standard shelf-life.

Return ONLY a strictly formatted JSON object (without markdown blocks) with the following exact keys:
"drugName", "manufacturer", "indication", "dosageForm", "expiryPattern", "confidenceScore" (number 0-100), and "originVerified" (boolean, true if it matches known global databases).`;
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: "image/jpeg", data: image } }
          ]
        }],
        tools: [
          {
            googleSearchRetrieval: {
              dynamicRetrievalConfig: {
                mode: "MODE_DYNAMIC",
                dynamicThreshold: 0.3
              }
            }
          }
        ]
      })

    });

    const data = await response.json();
    if (!data.candidates || data.candidates.length === 0) {
      return res.status(500).json({ error: 'Gemini returned no results' });
    }

    const resultText = data.candidates[0].content.parts[0].text;
    const visionResult = JSON.parse(resultText.replace(/```json|```/g, ''));
    
    return res.status(200).json(visionResult);
  } catch (err) {
    console.error("API Proxy Error:", err);
    return res.status(500).json({ error: 'Vision analysis failed' });
  }
}
