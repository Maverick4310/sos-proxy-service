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
    console.log("Incoming request:", { companyName, recordId, state });
    console.log("Using COBALT_API_ENDPOINT:", process.env.COBALT_API_ENDPOINT);
    console.log("Using SF_CALLBACK_BASE:", process.env.SF_CALLBACK_BASE);

    // Build Cobalt API request
    const endpoint = `${process.env.COBALT_API_ENDPOINT}?searchQuery=${encodeURIComponent(companyName)}&state=${encodeURIComponent(state)}&liveData=true`;
    console.log("Calling Cobalt API endpoint:", endpoint);

    const cobaltResp = await axios.get(endpoint, {
      headers: {
        "x-api-key": process.env.COBALT_API_KEY,
        "Accept": "application/json"
      },
      timeout: 120000
    });

    console.log("Cobalt API status:", cobaltResp.status);

    // Forward raw JSON to Salesforce callback
    const callbackUrl = `${process.env.SF_CALLBACK_BASE}/services/apexrest/creditapp/sos/callback`;
    console.log("Posting results to Salesforce callback:", callbackUrl);

    await axios.post(
      callbackUrl,
      {
        requestId: recordId,
        ...cobaltResp.data
      },
      {
        headers: { "Content-Type": "application/json" }
      }
    );

    res.status(202).json({ jobId: Date.now(), status: "QUEUED" });

  } catch (err) {
    console.error("Error in /v1/sos/jobs:", err);
    res.status(500).json({ error: "Failed to start SOS job", details: err.message });
  }
});
