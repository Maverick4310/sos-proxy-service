const express = require("express");
const axios = require("axios");
const app = express();

app.use(express.json());

// Proxy endpoint Salesforce will call
app.post("/fetch-sos-file", async (req, res) => {
  try {
    const { fileUrl } = req.body;
    if (!fileUrl) {
      return res.status(400).json({ error: "Missing fileUrl" });
    }

    // Fetch from SOS system with browser-like headers
    const response = await axios.get(fileUrl, {
      responseType: "arraybuffer",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept":
          "application/pdf,application/octet-stream;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://ecorp.sos.ga.gov/"
      }
    });

    // Convert file into Base64
    const fileData = Buffer.from(response.data, "binary").toString("base64");

    res.json({
      fileName: fileUrl.split("/").pop(),
      contentType: response.headers["content-type"],
      base64: fileData
    });
  } catch (err) {
    console.error("Error fetching SOS file:", err.message);
    res.status(500).json({ error: "Failed to fetch SOS file" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
