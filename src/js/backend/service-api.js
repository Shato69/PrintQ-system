// src/js/backend/service-api.js
import express from "express";
import cors from "cors";
import multer from "multer";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import { PDFDocument } from "pdf-lib";
import { exec } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config({ path: "./.env" });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json({ limit: "25mb" }));
app.use(cors());

// Serve static files — root index.html and assets
const ROOT_DIR = path.resolve(".");
app.use(express.static(ROOT_DIR));

// ✅ Health check
app.get("/health", (req, res) => res.json({ ok: true, time: new Date() }));

// ✅ Email API
app.post("/send-email", async (req, res) => {
  try {
    const { to, subject, message } = req.body;
    if (!to || !subject || !message)
      return res.status(400).json({ error: "Missing email fields" });

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASSWORD },
    });

    const qrPath = path.join(ROOT_DIR, "img", "GCash-MyQR.jpg");
    const info = await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to,
      subject,
      text: message,
      attachments: fs.existsSync(qrPath)
        ? [{ filename: "GCash-MyQR.jpg", path: qrPath }]
        : [],
    });

    console.log("Email sent:", info.response);
    res.json({ ok: true, message: "Email sent successfully" });
  } catch (err) {
    console.error("Email error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ DOCX conversion API
app.post("/convert-docx", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const tmpDir = path.join(os.tmpdir(), "printq-temp");
    fs.mkdirSync(tmpDir, { recursive: true });

    const inputPath = path.join(tmpDir, req.file.originalname);
    fs.writeFileSync(inputPath, req.file.buffer);

    await new Promise((resolve, reject) => {
      const cmd = `soffice --headless --convert-to pdf:writer_pdf_Export --outdir "${tmpDir}" "${inputPath}"`;
      exec(cmd, (err) => (err ? reject(err) : resolve()));
    });

    const pdfPath = inputPath.replace(/\.(docx|doc)$/i, ".pdf");
    const pdfBytes = fs.readFileSync(pdfPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const pages = pdfDoc.getPageCount();

    fs.unlinkSync(inputPath);
    fs.unlinkSync(pdfPath);

    res.json({ ok: true, pages });
  } catch (err) {
    console.error("DOCX error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Fallback for SPA — always serve index.html
app.get("*", (req, res) => {
  res.sendFile(path.join(ROOT_DIR, "index.html"));
});

// ✅ Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
