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

// ------------------ ENV ------------------
dotenv.config({ path: './.env' });

// ------------------ Multer ------------------
const upload = multer({ storage: multer.memoryStorage() });

// ------------------ Fix __dirname in ESM ------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ------------------ Paths ------------------
const PROJECT_ROOT = path.resolve(__dirname, "../../../..");
const HTML_DIR = path.resolve(".");                       // root directory
const CSS_DIR  = path.join(PROJECT_ROOT, "src/css");     
const JS_DIR   = path.join(PROJECT_ROOT, "src/js");      
const IMG_DIR  = path.join(PROJECT_ROOT, "src/img");     
const INDEX_HTML_PATH = path.join(HTML_DIR, "index.html");

// ------------------ App setup ------------------
const app = express();
app.use(express.json({ limit: "15mb" }));

// Allow all origins for dev; restrict in prod
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));

// ------------------ Email transporter ------------------
let transporter;
try {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_PASSWORD) {
    console.warn("GMAIL_USER or GMAIL_PASSWORD not set, email API will fail.");
  } else {
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_PASSWORD
      }
    });
  }
} catch(e) {
  console.error("Failed to initialize email transporter:", e);
}

// ------------------ API Routes ------------------

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// Send email
app.post("/send-email", async (req, res) => {
  try {
    if (!transporter) return res.status(500).json({ error: "Email transporter not configured" });
    const { to, subject, message } = req.body;
    if (!to || !subject || !message) return res.status(400).json({ error: "Missing required fields" });

    const qrPath = path.join(IMG_DIR, "GCash-MyQR.jpg");
    if (!fs.existsSync(qrPath)) return res.status(404).json({ error: "QR image not found" });

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

    // Convert DOCX to PDF
    await new Promise((resolve, reject) => {
      const cmd = `soffice --headless --convert-to pdf:writer_pdf_Export --outdir "${tempDir}" "${inputPath}"`;
      exec(cmd, (err, stdout, stderr) => {
        if (err) {
          console.error("soffice conversion error:", err, stderr);
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

    // Cleanup
    try { fs.unlinkSync(inputPath); } catch(e) {}
    try { fs.unlinkSync(pdfPath); } catch(e) {}

    return res.json({ originalName: req.file.originalname, pages: pageCount });
  } catch (err) {
    console.error("DOCX analyze error:", err);
    return res.status(500).json({ error: err.message || "conversion error" });
  }
});

// ------------------ Static serving ------------------
if (fs.existsSync(HTML_DIR)) app.use(express.static(HTML_DIR));
if (fs.existsSync(CSS_DIR)) app.use("/css", express.static(CSS_DIR));
if (fs.existsSync(JS_DIR)) app.use("/js", express.static(JS_DIR));
if (fs.existsSync(IMG_DIR)) app.use("/img", express.static(IMG_DIR));

// ------------------ SPA fallback ------------------
// Brute-force compatible with path-to-regexp v6
app.get("/:any*", (req, res) => {
  try {
    if (fs.existsSync(INDEX_HTML_PATH)) {
      res.sendFile(INDEX_HTML_PATH, { root: HTML_DIR });
    } else {
      console.warn("index.html not found at", INDEX_HTML_PATH);
      res.status(404).send("index.html not found");
    }
  } catch(e) {
    console.error("SPA fallback error:", e);
    res.status(500).send("internal server error");
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
