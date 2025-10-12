import express from "express";
import cors from "cors";
//import mammoth from "mammoth";
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

const app = express();
app.use(express.json());
app.use(cors());

// ================== Email Transporter ==================
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASSWORD
  }
});

// ================== POST /send-email ==================
app.post("/send-email", async (req, res) => {
  const { to, subject, message } = req.body;
  if (!to || !subject || !message)
    return res.status(400).json({ error: "Missing required fields" });

  const qrPath = path.join(__dirname, "../../img/GCash-MyQR.jpg");

  const mailOptions = {
    from: process.env.GMAIL_USER,
    to,
    subject,
    text: message,
    attachments: [{ filename: "GCash-MyQR.jpg", path: qrPath }]
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log("📨 Email sent:", info.response);
    res.status(200).json({ message: "Email sent successfully" });
  } catch (err) {
    console.error("❌ Error sending email:", err);
    res.status(500).json({ error: err.message });
  }
});

// ================== POST /convert-docx ==================
app.post("/convert-docx", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const tempDir = path.join(os.tmpdir(), "printq-temp");
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const inputPath = path.join(tempDir, `${Date.now()}_${req.file.originalname}`);
    fs.writeFileSync(inputPath, req.file.buffer);

    // 1️⃣ Convert DOCX to PDF via LibreOffice
    await new Promise((resolve, reject) => {
      exec(`soffice --headless --convert-to pdf:writer_pdf_Export --outdir "${tempDir}" "${inputPath}"`, (err) => {
        if (err) reject(err);
        else resolve();});

    });

    const pdfPath = inputPath.replace(/\.(docx|doc)$/i, ".pdf");

    // 2️⃣ Count pages in converted PDF
    const pdfBytes = fs.readFileSync(pdfPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const pageCount = pdfDoc.getPageCount();
    // if doc has more than 2 pages and last page is empty, ignore it
    const lastPage = pdfDoc.getPages().at(-1);
    const text = lastPage.getTextContent ? await lastPage.getTextContent() : null;
    if (pageCount > 1 && !text) pageCount--;

    // 3️⃣ Clean up
    fs.unlinkSync(inputPath);
    fs.unlinkSync(pdfPath);

    // 4️⃣ Return results
    res.json({
      originalName: req.file.originalname,
      pages: pageCount,
    });
  } catch (err) {
    console.error("❌ DOCX analyze error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ================== Server start ==================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
