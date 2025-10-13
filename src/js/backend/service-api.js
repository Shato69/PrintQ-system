// src/js/backend/service-api.js
import express from "express";
import cors from "cors";
import { PDFDocument } from "pdf-lib";
import multer from "multer";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import path from "path";
import { exec } from "child_process";
import fs from "fs";
import { fileURLToPath } from "url";
import os from "os";

dotenv.config({ path: './.env' });
const upload = multer({ storage: multer.memoryStorage() });

// Fix __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ------------------ Paths ------------------
const PROJECT_ROOT = path.resolve(__dirname, "../../../..");
const HTML_DIR = path.resolve(".");                       // root directory
const CSS_DIR  = path.join(PROJECT_ROOT, "src/css");     // css folder
const JS_DIR   = path.join(PROJECT_ROOT, "src/js");      // js folder
const IMG_DIR  = path.join(PROJECT_ROOT, "src/img");     // images folder
const INDEX_HTML_PATH = path.join(HTML_DIR, "index.html");

// ------------------ App setup ------------------
const app = express();
app.use(express.json({ limit: "15mb" }));
app.use(cors({ origin: "https://shato69.github.io/PrintQ-system" }));

// ------------------ API Routes ------------------

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// Email transporter
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASSWORD
  }
});

// Send email API
app.post("/send-email", async (req, res) => {
  try {
    const { to, subject, message } = req.body;
    if (!to || !subject || !message) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const qrPath = path.join(IMG_DIR, "GCash-MyQR.jpg");
    const mailOptions = {
      from: process.env.GMAIL_USER,
      to,
      subject,
      text: message,
      attachments: [{ filename: "GCash-MyQR.jpg", path: qrPath }]
    };

    const info = await transporter.sendMail(mailOptions);
    console.log("Email sent:", info.response);
    return res.status(200).json({ message: "Email sent successfully" });
  } catch (err) {
    console.error("Error sending email:", err);
    return res.status(500).json({ error: err.message || "internal error" });
  }
});

// DOCX -> PDF -> page count
app.post("/convert-docx", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const tempDir = path.join(os.tmpdir(), "printq-temp");
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const inputPath = path.join(tempDir, `${Date.now()}_${req.file.originalname}`);
    fs.writeFileSync(inputPath, req.file.buffer);

    // Convert via LibreOffice CLI
    await new Promise((resolve, reject) => {
      const cmd = `soffice --headless --convert-to pdf:writer_pdf_Export --outdir "${tempDir}" "${inputPath}"`;
      exec(cmd, (err, stdout, stderr) => {
        if (err) {
          console.error("soffice error:", err, stderr);
          return reject(err);
        }
        resolve();
      });
    });

    const pdfPath = inputPath.replace(/\.(docx|doc)$/i, ".pdf");
    if (!fs.existsSync(pdfPath)) throw new Error("Converted PDF not found");

    const pdfBytes = fs.readFileSync(pdfPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const pageCount = pdfDoc.getPageCount();

    // Cleanup temp files
    try { fs.unlinkSync(inputPath); } catch(e) {}
    try { fs.unlinkSync(pdfPath); } catch(e) {}

    return res.json({ originalName: req.file.originalname, pages: pageCount });
  } catch (err) {
    console.error("DOCX analyze error:", err);
    return res.status(500).json({ error: err.message || "conversion error" });
  }
});

// ------------------ Static serving ------------------

// Serve root (index.html + any other files in root)
if (fs.existsSync(HTML_DIR)) {
  app.use(express.static(HTML_DIR));
}

// Serve CSS
if (fs.existsSync(CSS_DIR)) {
  app.use("/css", express.static(CSS_DIR));
}

// Serve JS
if (fs.existsSync(JS_DIR)) {
  app.use("/js", express.static(JS_DIR));
}

// Serve images
if (fs.existsSync(IMG_DIR)) {
  app.use("/img", express.static(IMG_DIR));
}

// ------------------ SPA fallback ------------------
app.get("/*", (req, res) => {
  if (fs.existsSync(INDEX_HTML_PATH)) {
    res.sendFile(INDEX_HTML_PATH);
  } else {
    console.warn("index.html not found at", INDEX_HTML_PATH);
    res.status(404).send("index.html not found");
  }
});

// ------------------ Error handler ------------------
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "internal server error" });
});

// ------------------ Server start ------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

