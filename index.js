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

  // 2026-10 (Render Client Credentials) Salesforce is retiring the OAuth username-password flow.
  // Sign in with client credentials (External Client App "Render Integration", runs as the same
  // integration user) and fall back to the password flow if that is refused, logging why.
  if (process.env.SF_CC_CLIENT_ID && process.env.SF_CC_CLIENT_SECRET) {
    try {
      const cc = await axios.post(
        `${loginUrl}/services/oauth2/token`,
        qs.stringify({
          grant_type: "client_credentials",
          client_id: process.env.SF_CC_CLIENT_ID,
          client_secret: process.env.SF_CC_CLIENT_SECRET
        }),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
      );
      console.log("Salesforce auth: client credentials");
      return cc.data.access_token;
    } catch (err) {
      const detail = err.response ? `HTTP ${err.response.status} ${JSON.stringify(err.response.data).slice(0, 200)}` : err.message;
      console.warn(`Salesforce client credentials refused (${detail}). Using password flow.`);
    }
  }

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
    cobaltUrl = `${process.env.COBALT_API_ENDPOINT}?retryId=${retryId}&screenshot=true`;
  } else {
    cobaltUrl = `${process.env.COBALT_API_ENDPOINT}?searchQuery=${encodeURIComponent(
      companyName
    )}&state=${encodeURIComponent(state)}&liveData=true&screenshot=true`;
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
 * === Phase 1: Start SOS Job ===
 */
app.post("/v1/sos/jobs", async (req, res) => {
  try {
    const { companyName, recordId, state, context } = req.body;
    console.log("Incoming request:", { companyName, recordId, state, context });

    if (!companyName || !recordId || !state) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Default to CreditApp if context not provided
    const ctx = context || "CreditApp";

    // Call Cobalt API with retry logic (includes screenshot=true)
    const data = await fetchWithRetry(companyName, state);

    // Get Salesforce token
    const accessToken = await getSalesforceToken();

    // === Step: Post raw business JSON to Salesforce ===
    const businessCallbackUrl = `${process.env.SF_CALLBACK_BASE}/services/apexrest/sos/callback`;
    console.log("Posting business data to Salesforce callback:", businessCallbackUrl);

    await postToSalesforce(
      businessCallbackUrl,
      { requestId: recordId, context: ctx, ...data },
      accessToken
    );

    console.log("Posted business data to Salesforce");
    res.status(202).json({ jobId: Date.now(), status: "QUEUED" });
  } catch (err) {
    console.error("Error in /v1/sos/jobs:", err.message, err.response?.data || "");
    res.status(500).json({ error: "Failed to start SOS job", details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
