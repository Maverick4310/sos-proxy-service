const express = require("express");
const axios = require("axios");
const app = express();

app.use(express.json());

async function fetchWithCookies(fileUrl, baseUrl) {
  // Step 1: Get a session cookie
  const initResp = await axios.get(baseUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml"
    }
  });

  const cookies = initResp.headers["set-cookie"] || [];

  // Step 2: Retry file request with cookies
  const response = await axios.get(fileUrl, {
    responseType: "arraybuffer",
    maxRedirects: 5,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "application/pdf,image/*;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": baseUrl,
      "Cookie": cookies.join("; ")
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
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/pdf,image/*;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });

    // If response looks like HTML, retry with cookie handling
    if (response.headers["content-type"]?.includes("text/html")) {
      console.warn("Got HTML instead of file, retrying with cookie session…");

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
    console.error("Error fetching SOS file:", err.message);
    res.status(500).json({ error: "Failed to fetch SOS file" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
