const express = require("express");
const axios = require("axios");
const qs = require("qs");
const app = express();

app.use(express.json());

/**
 * === Salesforce OAuth Helper ===
 */
async function getSalesforceToken() {
  const loginUrl = process.env.SF_LOGIN_URL || "https://test.salesforce.com";
  const params = {
    grant_type: "password",
    client_id: process.env.SF_CLIENT_ID,
    client_secret: process.env.SF_CLIENT_SECRET,
    username: process.env.SF_USERNAME,
    password: process.env.SF_PASSWORD // password + security token
  };
  const resp = await axios.post(
    `${loginUrl}/services/oauth2/token`,
    qs.stringify(params),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  return resp.data.access_token;
}

/**
 * === Helper: Post to Salesforce ===
 */
async function postToSalesforce(endpoint, payload, accessToken) {
  await axios.post(endpoint, payload, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    }
  });
}

/**
 * === Helper: Retry Cobalt API if results missing ===
 */
async function fetchWithRetry(companyName, state, attempt = 1, maxAttempts = 3, retryId = null) {
  let cobaltUrl;
  if (retryId) {
    cobaltUrl = `${process.env.COBALT_API_ENDPOINT}?retryId=${retryId}`;
  } else {
    cobaltUrl = `${process.env.COBALT_API_ENDPOINT}?searchQuery=${encodeURIComponent(
      companyName
    )}&state=${encodeURIComponent(state)}&liveData=true`;
  }

  console.log(`[Attempt ${attempt}] Calling Cobalt API: ${cobaltUrl}`);

  const cobaltResp = await axios.get(cobaltUrl, {
    headers: {
      "x-api-key": process.env.COBALT_API_KEY,
      Accept: "application/json"
    },
    timeout: 120000
  });

  const data = cobaltResp.data;

  if (data?.results && data.results.length > 0) {
    console.log(`Cobalt returned results after ${attempt} attempt(s).`);
    return data;
  }

  if (data?.retryId && attempt < maxAttempts) {
    console.log(`Cobalt returned retryId: ${data.retryId}. Retrying in 15s...`);
    await new Promise((r) => setTimeout(r, 15000));
    return fetchWithRetry(companyName, state, attempt + 1, maxAttempts, data.retryId);
  }

  console.warn(`No results after ${attempt} attempts. Returning what we have.`);
  return data;
}

/**
 * === Helper: Fetch with cookies if blocked ===
 */
async function fetchWithCookies(fileUrl) {
  const urlObj = new URL(fileUrl);
  const baseUrl = `${urlObj.protocol}//${urlObj.host}/`;

  console.log("Priming session at:", baseUrl);

  const initResp = await axios.get(baseUrl, {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" }
  });

  const cookies = initResp.headers["set-cookie"] || [];

  return axios.get(fileUrl, {
    responseType: "arraybuffer",
    maxRedirects: 5,
    timeout: 60000,
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "application/pdf,image/*;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: baseUrl,
      Cookie: cookies.join("; ")
    }
  });
}

/**
 * === Phase 1: Start SOS Job ===
 */
app.post("/v1/sos/jobs", async (req, res) => {
  try {
    const { companyName, recordId, state } = req.body;
    console.log("Incoming request:", { companyName, recordId, state });

    if (!companyName || !recordId || !state) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Call Cobalt API with retry logic
    const data = await fetchWithRetry(companyName, state);

    // Get Salesforce token
    const accessToken = await getSalesforceToken();

    // === Step 1: Post raw business JSON to Salesforce ===
    const businessCallbackUrl = `${process.env.SF_CALLBACK_BASE}/services/apexrest/creditapp/sos/callback`;
    console.log("Posting business data to Salesforce callback:", businessCallbackUrl);

    await postToSalesforce(
      businessCallbackUrl,
      { requestId: recordId, ...data },
      accessToken
    );

    console.log("Posted business data to Salesforce");

    // === Step 2: Process each result ===
    if (Array.isArray(data.results) && data.results.length > 0) {
      for (const result of data.results) {
        // --- 2a: Business profile URL (send as Note) ---
        if (result.url) {
          try {
            const fileCallbackUrl = `${process.env.SF_CALLBACK_BASE}/services/apexrest/creditapp/sos/files/callback`;
            await postToSalesforce(
              fileCallbackUrl,
              {
                requestId: recordId,
                fileName: `SOS - ${companyName} - Business Profile Link`,
                url: result.url // Apex will insert as Note
              },
              accessToken
            );

            console.log("Posted business profile URL as Note");
          } catch (err) {
            console.error("Error posting business profile URL:", err.message);
          }
        }

        // --- 2b: Documents loop ---
        if (Array.isArray(result.documents)) {
          for (const doc of result.documents) {
            let fileName = doc.name || "SOS_Document";
            if (!fileName.includes(".")) fileName += ".pdf"; // enforce extension
            fileName = `SOS - ${companyName} - ${fileName}`;

            try {
              console.log("Fetching document:", doc.url);

              let response;
              try {
                response = await axios.get(doc.url, {
                  responseType: "arraybuffer",
                  timeout: 60000,
                  headers: {
                    "User-Agent": "Mozilla/5.0",
                    Accept: "application/pdf,image/*;q=0.9,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.9"
                  }
                });
              } catch (err) {
                if (err.response?.status === 403 || err.response?.status === 401) {
                  console.warn("403/401 blocked. Retrying with cookies...");
                  response = await fetchWithCookies(doc.url);
                } else {
                  throw err;
                }
              }

              if (response.headers["content-type"]?.includes("text/html")) {
                console.warn("Got HTML after retry, skipping file fetch.");
                throw new Error("Unfetchable file, HTML returned");
              }

              const fileData = Buffer.from(response.data, "binary").toString("base64");
              const fileCallbackUrl = `${process.env.SF_CALLBACK_BASE}/services/apexrest/creditapp/sos/files/callback`;

              await postToSalesforce(
                fileCallbackUrl,
                {
                  requestId: recordId,
                  fileName,
                  base64: fileData,
                  contentType: response.headers["content-type"] || "application/pdf"
                },
                accessToken
              );

              console.log("Posted file:", fileName);
            } catch (fileErr) {
              console.error("File fetch failed:", doc.url, fileErr.message);

              // fallback: post only URL
              const fileCallbackUrl = `${process.env.SF_CALLBACK_BASE}/services/apexrest/creditapp/sos/files/callback`;
              await postToSalesforce(
                fileCallbackUrl,
                { requestId: recordId, fileName, url: doc.url },
                accessToken
              );
            }
          }
        }
      }
    } else {
      console.log("No results array in Cobalt response.");
    }

    res.status(202).json({ jobId: Date.now(), status: "QUEUED" });
  } catch (err) {
    console.error("Error in /v1/sos/jobs:", err.message, err.response?.data || "");
    res.status(500).json({ error: "Failed to start SOS job", details: err.message });
  }
});

/**
 * === Phase 3: Debug endpoint to fetch one file manually ===
 */
app.post("/fetch-sos-file", async (req, res) => {
  try {
    const { fileUrl } = req.body;
    console.log("Incoming debug fetch:", fileUrl);

    if (!fileUrl) return res.status(400).json({ error: "Missing fileUrl" });

    let response = await axios.get(fileUrl, {
      responseType: "arraybuffer",
      timeout: 60000,
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "application/pdf,image/*;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });

    if (response.headers["content-type"]?.includes("text/html")) {
      console.warn("Got HTML in debug fetch, retrying with cookies...");
      response = await fetchWithCookies(fileUrl);
    }

    const fileData = Buffer.from(response.data, "binary").toString("base64");

    res.json({
      fileName: fileUrl.split("/").pop(),
      contentType: response.headers["content-type"],
      base64: fileData
    });
  } catch (err) {
    console.error("Debug fetch failed:", err.message);
    res.status(500).json({ error: "Debug fetch failed", details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
