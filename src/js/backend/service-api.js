// src/js/backend/service-api.js
// Render-ready backend for email and DOCX page count

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

dotenv.config({ path: "./.env" });

// ESM __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// App setup
const app = express();
app.use(express.json({ limit: "30mb" }));
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
app.use(cors({ origin: CORS_ORIGIN }));

// Multer memory storage
const upload = multer({ storage: multer.memoryStorage() });

// Utility
const exists = p => { try { return fs.existsSync(p); } catch { return false; } };
const safeLog = (...a) => { try { console.log(...a); } catch(_) {} };
const safeWarn = (...a) => { try { console.warn(...a); } catch(_) {} };
const safeError = (...a) => { try { console.error(...a); } catch(_) {} };

// Root index
const CWD_ROOT = path.resolve(".");
const ROOT_INDEX = path.join(CWD_ROOT, "index.html");

// ------------------ Email transporter ------------------
let transporter = null;
if (process.env.GMAIL_USER && process.env.GMAIL_PASSWORD) {
  try {
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASSWORD }
    });
    transporter.verify().then(() => safeLog("[startup] Email transporter OK"))
      .catch(err => safeWarn("[startup] Email verify:", err?.message || err));
  } catch (e) {
    safeWarn("[startup] transporter init failed:", e?.message || e);
  }
} else {
  safeWarn("[startup] GMAIL_USER/GMAIL_PASSWORD not set. /send-email will fail.");
}

// ------------------ LibreOffice check ------------------
let sofficeAvailable = false;
try {
  exec("soffice --version", (err) => {
    if (!err) { sofficeAvailable = true; safeLog("[startup] soffice detected"); }
    else safeWarn("[startup] soffice unavailable");
  });
} catch (e) {
  safeWarn("[startup] soffice check failed:", e?.message || e);
}

// ------------------ Health ------------------
app.get("/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString(), rootIndexExists: exists(ROOT_INDEX) });
});

// ------------------ Send email ------------------
app.post("/send-email", async (req, res) => {
  try {
    if (!transporter) return res.status(500).json({ ok: false, error: "Email transporter not configured." });
    const { to, subject, message } = req.body || {};
    if (!to || !subject || !message) return res.status(400).json({ ok: false, error: "Missing fields" });

    const qrPath = path.join(CWD_ROOT, "img", "GCash-MyQR.jpg");
    const attachments = exists(qrPath) ? [{ filename: "GCash-MyQR.jpg", path: qrPath }] : [];

    const info = await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to,
      subject,
      text: message,
      attachments,
    });

    res.json({ ok: true, info: info?.response || info });
  } catch (err) {
    safeError("[/send-email] error:", err?.message || err);
    res.status(500).json({ ok: false, error: err?.message || "internal error" });
  }
});

// ------------------ DOCX page count ------------------
app.post("/convert-docx", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded" });
    if (!sofficeAvailable) return res.status(503).json({ ok: false, error: "LibreOffice not installed" });

    const tempDir = path.join(os.tmpdir(), "printq-temp");
    if (!exists(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const safeName = `${Date.now()}_${req.file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_")}`;
    const inputPath = path.join(tempDir, safeName);
    fs.writeFileSync(inputPath, req.file.buffer);

    await new Promise((resolve, reject) => {
      const cmd = `soffice --headless --convert-to pdf:writer_pdf_Export --outdir "${tempDir}" "${inputPath}"`;
      exec(cmd, { timeout: 60000 }, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    const pdfPath = inputPath.replace(/\.(docx|doc)$/i, ".pdf");
    if (!exists(pdfPath)) throw new Error("Converted PDF not found");

    const pdfBytes = fs.readFileSync(pdfPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const pageCount = pdfDoc.getPageCount();

    try { fs.unlinkSync(inputPath); } catch(_) {}
    try { fs.unlinkSync(pdfPath); } catch(_) {}

    res.json({ ok: true, originalName: req.file.originalname, pages: pageCount });
  } catch (err) {
    safeError("[/convert-docx] error:", err?.message || err);
    res.status(500).json({ ok: false, error: err?.message || "conversion failed" });
  }
});

// ------------------ SPA fallback ------------------
app.use((req, res, next) => {
  if (req.method !== "GET") return next();
  const accept = req.headers.accept || "";
  if (!accept.includes("text/html") && !accept.includes("*/*")) return next();

  if (exists(ROOT_INDEX)) return res.sendFile(ROOT_INDEX);
  return res.status(200).type("html").send(`
    <!doctype html><html><head><meta charset="utf-8"><title>PrintQ fallback</title></head><body>
    <h2>PrintQ — fallback page</h2>
    <p>index.html not found on server.</p></body></html>
  `);
});

// ------------------ Error handling ------------------
app.use((err, req, res, next) => {
  safeError("[express err]", err?.stack || err);
  if (!res.headersSent) res.status(500).json({ ok: false, error: "internal server error" });
});

process.on("uncaughtException", (err) => safeError("[uncaughtException]", err?.stack || err));
process.on("unhandledRejection", (reason, p) => safeError("[unhandledRejection]", reason, p));

// ------------------ Start server ------------------
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => safeLog(`[startup] server listening on ${PORT}. ROOT_INDEX exists?`, exists(ROOT_INDEX)));
