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

// ✅ MIDDLEWARE SETUP (in correct order)
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ limit: "25mb", extended: true }));
app.use(cors());

// Serve static files – root index.html and assets
const ROOT_DIR = path.resolve(".");
app.use(express.static(ROOT_DIR, {
  maxAge: "1d",
  etag: false,
}));

// ✅ HEALTH CHECK ROUTE
app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date(), status: "Server is running" });
});

// ✅ EMAIL API ROUTE
app.post("/send-email", async (req, res) => {
  try {
    const { to, subject, message } = req.body;
    
    // Validate input
    if (!to || !subject || !message) {
      return res.status(400).json({ 
        error: "Missing required fields: to, subject, message" 
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(to)) {
      return res.status(400).json({ error: "Invalid email address" });
    }

    // Check environment variables
    if (!process.env.GMAIL_USER || !process.env.GMAIL_PASSWORD) {
      console.error("Email credentials not configured");
      return res.status(500).json({ 
        error: "Email service not properly configured. Check environment variables." 
      });
    }

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { 
        user: process.env.GMAIL_USER, 
        pass: process.env.GMAIL_PASSWORD 
      },
    });

    // Check QR code attachment
    const qrPath = path.join(ROOT_DIR, "img", "GCash-MyQR.jpg");
    const attachments = fs.existsSync(qrPath)
      ? [{ filename: "GCash-MyQR.jpg", path: qrPath }]
      : [];

    const info = await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to,
      subject,
      text: message,
      html: `<p>${message.replace(/\n/g, "<br>")}</p>`,
      attachments,
    });

    console.log("✅ Email sent successfully:", info.messageId);
    res.json({ 
      ok: true, 
      message: "Email sent successfully",
      messageId: info.messageId 
    });
  } catch (err) {
    console.error("❌ Email error:", err.message);
    res.status(500).json({ 
      error: "Failed to send email",
      details: err.message 
    });
  }
});

// ✅ DOCX CONVERSION API ROUTE
app.post("/convert-docx", upload.single("file"), async (req, res) => {
  try {
    // Validate file upload
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Validate file type
    const allowedMimes = [
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];
    if (!allowedMimes.includes(req.file.mimetype)) {
      return res.status(400).json({ 
        error: "Invalid file type. Only DOCX and DOC files are allowed." 
      });
    }

    // Validate file size (max 25MB)
    const maxSize = 25 * 1024 * 1024;
    if (req.file.size > maxSize) {
      return res.status(400).json({ error: "File size exceeds 25MB limit" });
    }

    const tmpDir = path.join(os.tmpdir(), "printq-temp");
    
    // Ensure temp directory exists
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    const inputPath = path.join(tmpDir, `${Date.now()}-${req.file.originalname}`);
    const pdfPath = inputPath.replace(/\.(docx|doc)$/i, ".pdf");

    // Write file to temp location
    fs.writeFileSync(inputPath, req.file.buffer);

    // Convert DOCX to PDF using LibreOffice
    await new Promise((resolve, reject) => {
      const cmd = `soffice --headless --convert-to pdf:writer_pdf_Export --outdir "${tmpDir}" "${inputPath}"`;
      
      exec(cmd, { timeout: 60000 }, (err, stdout, stderr) => {
        if (err) {
          console.error("❌ Conversion error:", stderr || err.message);
          reject(new Error(`Conversion failed: ${stderr || err.message}`));
        } else {
          resolve();
        }
      });
    });

    // Verify PDF was created
    if (!fs.existsSync(pdfPath)) {
      throw new Error("PDF file was not created during conversion");
    }

    // Read and validate PDF
    const pdfBytes = fs.readFileSync(pdfPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const pages = pdfDoc.getPageCount();

    // Cleanup temp files
    try {
      fs.unlinkSync(inputPath);
      fs.unlinkSync(pdfPath);
    } catch (cleanupErr) {
      console.warn("⚠️ Warning: Could not clean up temp files:", cleanupErr.message);
    }

    console.log(`✅ DOCX conversion successful: ${pages} pages`);
    res.json({ 
      ok: true, 
      pages,
      message: "File converted successfully" 
    });
  } catch (err) {
    console.error("❌ DOCX conversion error:", err.message);
    res.status(500).json({ 
      error: "Failed to convert document",
      details: err.message 
    });
  }
});

// ✅ API ROUTES ERROR HANDLER
app.use("/send-email", (req, res) => {
  res.status(405).json({ error: "Method not allowed. Use POST." });
});

app.use("/convert-docx", (req, res) => {
  res.status(405).json({ error: "Method not allowed. Use POST." });
});

// ✅ SPA FALLBACK - MIDDLEWARE APPROACH (most reliable)
// This must come AFTER all API routes but BEFORE final error handler
app.use((req, res, next) => {
  // Only serve index.html for GET requests
  if (req.method === "GET") {
    // Don't serve index.html for API routes or files with extensions
    if (!req.path.startsWith("/api") && !req.path.includes(".")) {
      const indexPath = path.join(ROOT_DIR, "index.html");
      if (fs.existsSync(indexPath)) {
        return res.sendFile(indexPath);
      }
    }
  }
  next();
});

// ✅ 404 HANDLER - Serve index.html as fallback for SPA routing
app.use((req, res) => {
  const indexPath = path.join(ROOT_DIR, "index.html");
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).json({ error: "Not found" });
  }
});

// ✅ GLOBAL ERROR HANDLER
app.use((err, req, res, next) => {
  console.error("❌ Unhandled error:", err);
  res.status(err.status || 500).json({
    error: "Internal server error",
    details: process.env.NODE_ENV === "development" ? err.message : undefined,
  });
});

// ✅ START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║  ✅ PrintQ Server Running             ║
║  🚀 Port: ${PORT}                         ║
║  📍 Environment: ${process.env.NODE_ENV || "production"}           ║
║  ⏰ Started: ${new Date().toISOString()}  ║
╚══════════════════════════════════════╝
  `);
  console.log("✅ Available endpoints:");
  console.log("   GET  /health");
  console.log("   POST /send-email");
  console.log("   POST /convert-docx");
});

// ✅ GRACEFUL SHUTDOWN
process.on("SIGTERM", () => {
  console.log("📍 SIGTERM received, shutting down gracefully...");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("📍 SIGINT received, shutting down gracefully...");
  process.exit(0);
});
