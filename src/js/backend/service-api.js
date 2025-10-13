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

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "30mb" }));
app.use(cors());

const upload = multer({ storage: multer.memoryStorage() });

// ------------------ Constants ------------------
const HTML_DIR = path.join(__dirname, "../../html");
const SRC_DIR  = path.join(__dirname, "../../src");
const IMG_DIR  = path.join(__dirname, "../../img");
const INDEX_HTML = path.join(HTML_DIR, "index.html");

// ------------------ Nodemailer ------------------
const transporter = process.env.GMAIL_USER && process.env.GMAIL_PASSWORD
  ? nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASSWORD }
    })
  : null;

if (!transporter) console.warn("GMAIL_USER or GMAIL_PASSWORD not set. /send-email will fail.");

// ------------------ Routes ------------------

// Health
app.get("/health", (_, res) => res.json({ status: "ok", time: new Date().toISOString() }));

// Send email
app.post("/send-email", async (req, res) => {
  try {
    if (!transporter) return res.status(500).json({ error: "Email transporter not configured" });

    const { to, subject, message } = req.body;
    if (!to || !subject || !message) return res.status(400).json({ error: "Missing fields" });

    const qrPath = path.join(IMG_DIR, "GCash-MyQR.jpg");
    const attachments = fs.existsSync(qrPath) ? [{ filename: "GCash-MyQR.jpg", path: qrPath }] : [];

    const info = await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to, subject, text: message, attachments
    });

    res.json({ ok: true, info: info?.response || info });
  } catch (err) {
    console.error("/send-email error:", err);
    res.status(500).json({ error: err.message || "internal error" });
  }
});

// Convert DOCX
app.post("/convert-docx", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const tempDir = path.join(os.tmpdir(), "printq-temp");
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const safeName = `${Date.now()}_${req.file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_")}`;
    const inputPath = path.join(tempDir, safeName);
    fs.writeFileSync(inputPath, req.file.buffer);

    await new Promise((resolve, reject) => {
      exec(`soffice --headless --convert-to pdf --outdir "${tempDir}" "${inputPath}"`, (err, _, stderr) => {
        if (err) return reject(stderr || err);
        resolve();
      });
    });

    const pdfPath = inputPath.replace(/\.(docx|doc)$/i, ".pdf");
    if (!fs.existsSync(pdfPath)) throw new Error("Converted PDF not found");

    const pdfDoc = await PDFDocument.load(fs.readFileSync(pdfPath));
    const pages = pdfDoc.getPageCount();

    fs.unlinkSync(inputPath);
    fs.unlinkSync(pdfPath);

    res.json({ ok: true, originalName: req.file.originalname, pages });
  } catch (err) {
    console.error("/convert-docx error:", err);
    res.status(500).json({ error: err.message || "conversion failed" });
  }
});

// ------------------ Static serving ------------------
if (fs.existsSync(HTML_DIR)) app.use(express.static(HTML_DIR));
if (fs.existsSync(SRC_DIR)) app.use("/src", express.static(SRC_DIR));
if (fs.existsSync(IMG_DIR)) app.use("/img", express.static(IMG_DIR));

// ------------------ SPA fallback ------------------
app.use((req, res, next) => {
  if (req.method !== "GET") return next();
  const acceptsHtml = req.headers.accept?.includes("text/html") || req.headers.accept?.includes("*/*");
  if (!acceptsHtml) return next();

  if (fs.existsSync(INDEX_HTML)) {
    return res.sendFile(INDEX_HTML, err => {
      if (err) {
        console.error("Failed sendFile index.html, fallback readFile:", err);
        try { res.type("html").send(fs.readFileSync(INDEX_HTML, "utf8")); } catch { next(); }
      }
    });
  } else {
    console.warn("index.html not found at", INDEX_HTML);
    return next();
  }
});

// ------------------ Error handler ------------------
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  if (!res.headersSent) res.status(500).json({ error: "internal server error" });
});

// ------------------ Start server ------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[server] Running on port ${PORT}`));
