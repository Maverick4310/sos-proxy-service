const express = require("express");
const axios = require("axios");
const qs = require("qs"); // for form-encoded auth requests
const app = express();

app.use(express.json());

/**
 * === Helper: Get Salesforce OAuth Token ===
 * Uses username-password OAuth flow with Connected App credentials.
 */
async function getSalesforceToken() {
  try {
    const loginUrl = process.env.SF_LOGIN_URL || "https://test.salesforce.com"; // default sandbox

    const params = {
      grant_type: "password",
      client_id: process.env.SF_CLIENT_ID,
      client_secret: process.env.SF_CLIENT_SECRET,
      username: process.env.SF_USERNAME,
      password: process.env.SF_PASSWORD // must be password + security token
    };

    const resp = await axios.post(
      `${loginUrl}/services/oauth2/token`,
      qs.stringify(params),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    console.log("Salesforce OAuth success");
    return resp.data.access_token;
  } catch (err) {
    console.error("Failed to get Salesforce token:", err.response?.data || err.message);
    throw err;
  }
}

/**
 * === PHASE 1: START SOS JOB ===
 * Salesforce calls this with { companyName, recordId, state }.
 * Render calls Cobalt API, then posts raw JSON into Salesforce using OAuth.
 */
app.post("/v1/sos/jobs", async (req, res) => {
  try {
    const { companyName, recordId, state } = req.body;
    console.log("Incoming request:", { companyName, recordId, state });

    if (!companyName || !recordId || !state) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Call Cobalt API
    const cobaltUrl = `${process.env.COBALT_API_ENDPOINT}?searchQuery=${encodeURIComponent(
      companyName
    )}&state=${encodeURIComponent(state)}&liveData=true`;

    console.log("Calling Cobalt API:", cobaltUrl);

    const cobaltResp = await axios.get(cobaltUrl, {
      headers: {
        "x-api-key": process.env.COBALT_API_KEY,
        "Accept": "application/json"
      },
      timeout: 120000
    });

    console.log("Cobalt API status:", cobaltResp.status);

    // Get Salesforce OAuth token
    const accessToken = await getSalesforceToken();

    // Post results to Salesforce
    const callbackUrl = `${process.env.SF_CALLBACK_BASE}/services/apexrest/creditapp/sos/callback`;
    console.log("Posting results to Salesforce callback:", callbackUrl);

    await axios.post(
      callbackUrl,
      {
        requestId: recordId,
        ...cobaltResp.data
      },
      {
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("Successfully posted results to Salesforce");
    res.status(202).json({ jobId: Date.now(), status: "QUEUED" });

  } catch (err) {
    console.error("Error in /v1/sos/jobs:", err.message, err.response?.data || "");
    res.status(500).json({ error: "Failed to start SOS job", details: err.message });
  }
});

/**
 * === PHASE 2: FETCH SOS FILE ===
 * Given a fileUrl, tries to download the file (PDF/image),
 * retrying with cookies if necessary, then returns Base64.
 */
async function fetchWithCookies(fileUrl, baseUrl) {
  console.log("Fetching with cookies. Base URL:", baseUrl);

  const initResp = await axios.get(baseUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "text/html,application/xhtml+xml"
    }
  });

  const cookies = initResp.headers["set-cookie"] || [];
  console.log("Received cookies:", cookies);

  const response = await axios.get(fileUrl, {
    responseType: "arraybuffer",
    maxRedirects: 5,
    headers: {
      "User-Agent": "Mozilla/5.0",
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
    console.log("Incoming file fetch request:", fileUrl);

    if (!fileUrl) {
      return res.status(400).json({ error: "Missing fileUrl" });
    }

    let response = await axios.get(fileUrl, {
      responseType: "arraybuffer",
      maxRedirects: 5,
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "application/pdf,image/*;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });

    if (response.headers["content-type"]?.includes("text/html")) {
      console.warn("Got HTML instead of file, retrying with cookies…");
      const urlObj = new URL(fileUrl);
      const baseUrl = `${urlObj.protocol}//${urlObj.host}/`;
      response = await fetchWithCookies(fileUrl, baseUrl);
    }

    const fileData = Buffer.from(response.data, "binary").toString("base64");

    res.json({
      fileName: fileUrl.split("/").pop(),
      contentType: response.headers["content-type"],
      base64: fileData
    });
  } catch (err) {
    console.error("Error fetching SOS file:", err.message);
    res.status(500).json({ error: "Failed to fetch SOS file", details: err.message });
  }
});

/**
 * === PHASE 3: BULK SOS FILES ===
 * Salesforce requests documents, Render fetches them, then posts back to Salesforce as Base64.
 */
app.post("/v1/sos/files", async (req, res) => {
  try {
    const { recordId, documents } = req.body;
    console.log("Incoming file batch request:", { recordId, documents });

    if (!recordId || !Array.isArray(documents)) {
      return res.status(400).json({ error: "Missing recordId or documents array" });
    }

    // Get Salesforce OAuth token
    const accessToken = await getSalesforceToken();

    for (const fileUrl of documents) {
      try {
        console.log("Fetching document:", fileUrl);

        let response = await axios.get(fileUrl, {
          responseType: "arraybuffer",
          maxRedirects: 5,
          headers: {
            "User-Agent": "Mozilla/5.0",
            Accept: "application/pdf,image/*;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9"
          }
        });

        if (response.headers["content-type"]?.includes("text/html")) {
          console.warn("Got HTML instead of file, retrying with cookies…");
          const urlObj = new URL(fileUrl);
          const baseUrl = `${urlObj.protocol}//${urlObj.host}/`;
          response = await fetchWithCookies(fileUrl, baseUrl);
        }

        const fileData = Buffer.from(response.data, "binary").toString("base64");
        const fileName = fileUrl.split("/").pop() || "sos_document.pdf";

        // Post file to Salesforce
        const callbackUrl = `${process.env.SF_CALLBACK_BASE}/services/apexrest/creditapp/sos/files/callback`;
        console.log("Posting file to Salesforce callback:", fileName);

        await axios.post(
          callbackUrl,
          {
            requestId: recordId,
            fileName,
            contentType: response.headers["content-type"],
            base64: fileData
          },
          {
            headers: {
              "Authorization": `Bearer ${accessToken}`,
              "Content-Type": "application/json"
            }
          }
        );

        console.log(`Successfully posted file: ${fileName}`);
      } catch (fileErr) {
        console.error("Error fetching/posting file:", fileUrl, fileErr.message);
        // Fallback: send URL only
        const callbackUrl = `${process.env.SF_CALLBACK_BASE}/services/apexrest/creditapp/sos/files/callback`;
        await axios.post(
          callbackUrl,
          { requestId: recordId, fileName: fileUrl.split("/").pop(), url: fileUrl },
          {
            headers: {
              "Authorization": `Bearer ${accessToken}`,
              "Content-Type": "application/json"
            }
          }
        );
      }
    }

    res.status(202).json({ status: "FILES_PROCESSED", count: documents.length });

  } catch (err) {
    console.error("Error in /v1/sos/files:", err.message);
    res.status(500).json({ error: "Failed to process files", details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
