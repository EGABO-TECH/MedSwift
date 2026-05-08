export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { image } = req.body;
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'Gemini API Key not configured in Vercel' });
  }

  const prompt = "Identify this medication. Extract: [Drug Name], [Manufacturer/Origin], [Indication/Disease], [Dosage Form], and [Expiry Pattern]. Cross-reference with openFDA standards. Return as JSON with fields: drugName, manufacturer, indication, dosageForm, expiryPattern, confidenceScore (0-100), and originVerified (boolean).";

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
        }]
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
