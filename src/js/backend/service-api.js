import express from "express";
import cors from "cors";
import { PDFDocument } from "pdf-lib";
import multer from "multer";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import path, { dirname, join } from "path";
import { exec } from "child_process";
import fs from "fs";
import os from "os";
import { fileURLToPath } from "url";

dotenv.config();
const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ================== MIDDLEWARE ==================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ================== FRONTEND SERVING ==================
const frontendPath = join(__dirname, "../../../");
app.use(express.static(frontendPath));

// ================== EMAIL API ==================
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASSWORD,
  },
});

app.post("/send-email", async (req, res) => {
  try {
    const { to, subject, message } = req.body;
    if (!to || !subject || !message)
      return res.status(400).json({ error: "Missing required fields" });

    const qrPath = path.join(__dirname, "../../img/GCash-MyQR.jpg");
    const mailOptions = {
      from: process.env.GMAIL_USER,
      to,
      subject,
      text: message,
      attachments: [{ filename: "GCash-MyQR.jpg", path: qrPath }],
    };

    const info = await transporter.sendMail(mailOptions);
    console.log("📨 Email sent:", info.response);
    res.status(200).json({ messageId: info.messageId || info.response });
  } catch (err) {
    console.error("❌ Email error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ================== DOCX → PDF PAGE COUNT API ==================
app.post("/convert-docx", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const tempDir = path.join("/tmp", "printq-temp");
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const inputPath = path.join(tempDir, `${Date.now()}_${req.file.originalname}`);
    fs.writeFileSync(inputPath, req.file.buffer);

    await new Promise((resolve, reject) => {
      exec(`soffice --headless --convert-to pdf --outdir "${tempDir}" "${inputPath}"`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    const pdfPath = inputPath.replace(/\.(docx|doc)$/i, ".pdf");
    const pdfBytes = fs.readFileSync(pdfPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const pageCount = pdfDoc.getPageCount();

    fs.unlinkSync(inputPath);
    fs.unlinkSync(pdfPath);

    res.json({ originalName: req.file.originalname, pages: pageCount });
  } catch (err) {
    console.error("❌ DOCX analyze error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ================== FALLBACK ROUTE ==================
// Serve index.html only for non-API routes
app.use((req, res, next) => {
  if (req.path.startsWith("/convert-docx") || req.path.startsWith("/send-email")) return next();
  res.sendFile(path.join(frontendPath, "index.html"));
});

// ================== START SERVER ==================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Service API running on port ${PORT}`);
});
