const express = require("express");
const axios = require("axios");
const qs = require("qs");
const app = express();

app.use(express.json());

/**
 * === Salesforce OAuth Helper ===
 */
async function getSalesforceToken() {
  try {
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
  } catch (err) {
    console.error("Failed to get Salesforce token:", err.response?.data || err.message);
    throw err;
  }
}

/**
 * === Helper: Fetch SOS File with cookie fallback ===
 */
async function fetchWithCookies(fileUrl, baseUrl) {
  console.log("Retrying fetch with cookies. Base URL:", baseUrl);

  const initResp = await axios.get(baseUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "text/html,application/xhtml+xml"
    }
  });

  const cookies = initResp.headers["set-cookie"] || [];
  console.log("Received cookies:", cookies);

  return await axios.get(fileUrl, {
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

    // Call Cobalt API
    const cobaltUrl = `${process.env.COBALT_API_ENDPOINT}?searchQuery=${encodeURIComponent(
      companyName
    )}&state=${encodeURIComponent(state)}&liveData=true`;

    console.log("Calling Cobalt API:", cobaltUrl);

    const cobaltResp = await axios.get(cobaltUrl, {
      headers: {
        "x-api-key": process.env.COBALT_API_KEY,
        Accept: "application/json"
      },
      timeout: 120000
    });

    console.log("Cobalt API status:", cobaltResp.status);

    const cobaltData = cobaltResp.data;
    const accessToken = await getSalesforceToken();

    // === Step 1: Post raw business data JSON to Salesforce ===
    const callbackUrl = `${process.env.SF_CALLBACK_BASE}/services/apexrest/creditapp/sos/callback`;
    console.log("Posting business data to Salesforce callback:", callbackUrl);

    await axios.post(
      callbackUrl,
      {
        requestId: recordId,
        ...cobaltData
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("Successfully posted business data to Salesforce");

    // === Step 2: Process documents + profile URL ===
    if (Array.isArray(cobaltData.results) && cobaltData.results.length > 0) {
      for (const result of cobaltData.results) {
        // Handle SOS business profile URL
        if (result.url) {
          try {
            const htmlContent = `<html><body>
              <p>Business Profile Page: 
              <a href="${result.url}" target="_blank">${result.url}</a></p>
            </body></html>`;

            await axios.post(
              `${process.env.SF_CALLBACK_BASE}/services/apexrest/creditapp/sos/files/callback`,
              {
                requestId: recordId,
                fileName: `SOS - ${companyName} - Business Profile.html`,
                base64: Buffer.from(htmlContent).toString("base64"),
                contentType: "text/html"
              },
              {
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  "Content-Type": "application/json"
                }
              }
            );

            console.log("Posted SOS profile URL as HTML attachment");
          } catch (err) {
            console.error("Error posting SOS profile URL:", err.message);
          }
        }

        // Handle documents
        if (Array.isArray(result.documents)) {
          for (const doc of result.documents) {
            try {
              console.log("Fetching document:", doc.url);

              let response = await axios.get(doc.url, {
                responseType: "arraybuffer",
                maxRedirects: 5,
                headers: {
                  "User-Agent": "Mozilla/5.0",
                  Accept: "application/pdf,image/*;q=0.9,*/*;q=0.8",
                  "Accept-Language": "en-US,en;q=0.9"
                }
              });

              // Retry on 401/403 with cookies
              if (
                response.status === 401 ||
                response.status === 403 ||
                response.headers["content-type"]?.includes("text/html")
              ) {
                console.warn("Retrying document fetch with cookies…");
                const urlObj = new URL(doc.url);
                const baseUrl = `${urlObj.protocol}//${urlObj.host}/`;
                response = await fetchWithCookies(doc.url, baseUrl);
              }

              const fileData = Buffer.from(response.data, "binary").toString("base64");

              await axios.post(
                `${process.env.SF_CALLBACK_BASE}/services/apexrest/creditapp/sos/files/callback`,
                {
                  requestId: recordId,
                  fileName: `SOS - ${companyName} - ${doc.name}`,
                  base64: fileData,
                  contentType: response.headers["content-type"]
                },
                {
                  headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "Content-Type": "application/json"
                  }
                }
              );

              console.log("Successfully posted file:", doc.name);
            } catch (err) {
              console.error("Error fetching/posting file:", doc.url, err.message);
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
