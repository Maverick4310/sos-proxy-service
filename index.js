const express = require("express");
const axios = require("axios");
const app = express();

app.use(express.json());

app.post("/fetch-sos-file", async (req, res) => {
  try {
    const { fileUrl } = req.body;
    if (!fileUrl) {
      return res.status(400).json({ error: "Missing fileUrl" });
    }

    const response = await axios.get(fileUrl, { responseType: "arraybuffer" });

    const fileData = Buffer.from(response.data, "binary").toString("base64");

    res.json({
      fileName: fileUrl.split("/").pop(),
      contentType: response.headers["content-type"],
      base64: fileData
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Failed to fetch SOS file" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
