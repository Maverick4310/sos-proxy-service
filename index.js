const express = require("express");
const axios = require("axios");
const app = express();

app.use(express.json());

/**
 * === PHASE 1: START SOS JOB ===
 * Salesforce will call this with { companyName, recordId, state }.
 * Render will call Cobalt API, then forward raw JSON to Salesforce callback.
 */
app.post("/v1/sos/jobs", async (req, res) => {
  try {
    const { companyName, recordId, state } = req.body;
    if (!companyName || !recordId || !state) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Build Cobalt API request
    const endpoint = `${process.env.COBALT_API_ENDPOINT}?searchQuery=${encodeURIComponent(
      companyName
    )}&state=${encodeURIComponent(state)}&liveData=true`;

    const cobaltResp = await axios.get(endpoint, {
      headers: {
        "x-api-key": process.env.COBALT_API_KEY,
        "Accept": "application/json"
      },
      timeout: 120000
    });

    // Forward raw JSON to Salesforce callback
    const callbackUrl = `${process.env.SF_CALLBACK_BASE}/services/apexrest/creditapp/sos/callback`;

    await axios.post(
      callbackUrl,
      {
        requestId: recordId, // tells SF which CreditApp this belongs to
        ...cobaltResp.data
      },
      {
        headers: { "Content-Type": "application/json" }
      }
    );

    // Respond immediately to Salesforce (don’t block on mapping)
    res.status(202).json({ jobId: Date.now(), status: "QUEUED" });
  } catch (err) {
    res.status(500).json({ error: "Failed to start SOS job" });
  }
});

/**
 * === PHASE 2: FETCH SOS FILE ===
 * Given a fileUrl, tries to download the file (PDF/image),
 * retrying with cookies if necessary, then returns Base64.
 */
async function fetchWithCookies(fileUrl, baseUrl) {
  // Step 1: Get a session cookie
  const initResp = await axios.get(baseUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml"
    }
  });

  const cookies = initResp.headers["set-cookie"] || [];

  // Step 2: Retry file request with cookies
  const response = await axios.get(fileUrl, {
    responseType: "arraybuffer",
    maxRedirects: 5,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "application/pdf,image/*;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: baseUrl,
      Cookie: cookies.join("; ")
    }
  });

  return response;
}

app.post("/fetch-sos-file", async (req, res) => {
  try {
    const { fileUrl } = req.body;
    if (!fileUrl) {
      return res.status(400).json({ error: "Missing fileUrl" });
    }

    // Default request
    let response = await axios.get(fileUrl, {
      responseType: "arraybuffer",
      maxRedirects: 5,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "application/pdf,image/*;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });

    // If response looks like HTML, retry with cookie handling
    if (response.headers["content-type"]?.includes("text/html")) {
      // derive base URL from fileUrl (scheme + host)
      const urlObj = new URL(fileUrl);
      const baseUrl = `${urlObj.protocol}//${urlObj.host}/`;

      response = await fetchWithCookies(fileUrl, baseUrl);
    }

    // Convert file into Base64
    const fileData = Buffer.from(response.data, "binary").toString("base64");

    res.json({
      fileName: fileUrl.split("/").pop(),
      contentType: response.headers["content-type"],
      base64: fileData
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch SOS file" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
