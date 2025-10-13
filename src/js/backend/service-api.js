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

// ✅ MIDDLEWARE SETUP
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ limit: "25mb", extended: true }));

// ✅ CORS - Direct configuration, no wildcards
app.use(cors({
  origin: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  credentials: true,
  maxAge: 3600,
}));

// ✅ Security headers
app.use((req, res, next) => {
  res.header("X-Content-Type-Options", "nosniff");
  res.header("X-Frame-Options", "SAMEORIGIN");
  res.header("X-XSS-Protection", "1; mode=block");
  res.header("Access-Control-Allow-Origin", "*");
  next();
});

const ROOT_DIR = path.resolve(".");
app.use(express.static(ROOT_DIR, {
  maxAge: "1d",
  etag: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".html")) {
      res.set("Cache-Control", "no-cache, no-store, must-revalidate");
    }
  },
}));

// ✅ REQUEST LOGGING
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

// ✅ HEALTH CHECK
app.get("/health", (req, res) => {
  console.log("✅ Health check requested");
  res.status(200).json({ 
    ok: true, 
    time: new Date().toISOString(),
    status: "Server is running",
  });
});

// ✅ EMAIL API
app.post("/send-email", async (req, res) => {
  try {
    console.log("📧 Email request received");
    
    const { to, subject, message } = req.body;
    
    if (!to || !subject || !message) {
      console.warn("⚠️ Missing email fields");
      return res.status(400).json({ 
        ok: false,
        error: "Missing required fields: to, subject, message" 
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(to)) {
      console.warn(`⚠️ Invalid email: ${to}`);
      return res.status(400).json({ 
        ok: false,
        error: "Invalid email address" 
      });
    }

    const gmailUser = process.env.GMAIL_USER;
    const gmailPassword = process.env.GMAIL_PASSWORD;

    if (!gmailUser || !gmailPassword) {
      console.error("❌ Gmail credentials missing");
      return res.status(503).json({ 
        ok: false,
        error: "Email service unavailable",
        details: "Server not configured for email" 
      });
    }

    console.log(`🔧 Configuring transporter for ${gmailUser}`);
    
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { 
        user: gmailUser, 
        pass: gmailPassword 
      },
      connectionTimeout: 10000,
      socketTimeout: 10000,
    });

    // Verify transporter
    await transporter.verify();
    console.log("✅ Email transporter verified");

    // Check QR attachment
    const qrPath = path.join(ROOT_DIR, "img", "GCash-MyQR.jpg");
    const attachments = [];
    
    if (fs.existsSync(qrPath)) {
      console.log("📎 QR code attached");
      attachments.push({ 
        filename: "GCash-MyQR.jpg", 
        path: qrPath 
      });
    }

    const mailOptions = {
      from: gmailUser,
      to,
      subject,
      text: message,
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
          <p>${message.replace(/\n/g, "<br>")}</p>
          ${attachments.length > 0 ? "<hr><p style='font-size: 12px; color: #666;'><em>Payment QR code attached</em></p>" : ""}
        </div>
      `,
      attachments,
    };

    console.log(`📤 Sending email to ${to}`);
    const info = await transporter.sendMail(mailOptions);

    console.log(`✅ Email sent: ${info.messageId}`);
    
    return res.status(200).json({ 
      ok: true, 
      message: "Email sent successfully",
      messageId: info.messageId,
    });

  } catch (err) {
    console.error("❌ Email error:", err.message);
    return res.status(500).json({ 
      ok: false,
      error: "Failed to send email",
      details: err.message 
    });
  }
});

// ✅ DOCX CONVERSION API
app.post("/convert-docx", upload.single("file"), async (req, res) => {
  try {
    console.log("📄 DOCX conversion request received");
    
    if (!req.file) {
      console.warn("⚠️ No file uploaded");
      return res.status(400).json({ 
        ok: false,
        error: "No file uploaded" 
      });
    }

    console.log(`📝 File: ${req.file.originalname} (${(req.file.size / 1024).toFixed(2)} KB)`);

    // Validate file type
    const allowedMimes = [
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/octet-stream",
    ];
    
    if (!allowedMimes.includes(req.file.mimetype)) {
      console.warn(`⚠️ Invalid MIME type: ${req.file.mimetype}`);
      return res.status(400).json({ 
        ok: false,
        error: "Invalid file type. Only DOCX and DOC files are allowed." 
      });
    }

    // Validate file size (max 50MB)
    const maxSize = 50 * 1024 * 1024;
    if (req.file.size > maxSize) {
      console.warn(`⚠️ File too large: ${req.file.size} bytes`);
      return res.status(413).json({ 
        ok: false,
        error: "File size exceeds 50MB limit" 
      });
    }

    const tmpDir = path.join(os.tmpdir(), "printq-temp");
    
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
      console.log(`📁 Created temp directory: ${tmpDir}`);
    }

    const timestamp = Date.now();
    const safeFilename = req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    const inputPath = path.join(tmpDir, `${timestamp}-${safeFilename}`);
    const pdfPath = inputPath.replace(/\.(docx|doc)$/i, ".pdf");

    // Write file
    fs.writeFileSync(inputPath, req.file.buffer);
    console.log(`✅ File written to temp`);

    // Convert DOCX to PDF
    console.log("🔄 Converting to PDF with LibreOffice...");
    
    await new Promise((resolve, reject) => {
      const cmd = `soffice --headless --convert-to pdf:writer_pdf_Export --outdir "${tmpDir}" "${inputPath}"`;
      
      exec(cmd, { 
        timeout: 60000, 
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, HOME: tmpDir }
      }, (err, stdout, stderr) => {
        if (err) {
          console.error(`❌ LibreOffice error: ${stderr || err.message}`);
          reject(new Error(`Conversion failed: ${stderr || err.message}`));
        } else {
          console.log("✅ LibreOffice conversion completed");
          resolve();
        }
      });
    });

    // Verify PDF exists
    if (!fs.existsSync(pdfPath)) {
      console.error(`❌ PDF not created at: ${pdfPath}`);
      try { fs.unlinkSync(inputPath); } catch (e) {}
      
      return res.status(500).json({ 
        ok: false,
        error: "Conversion failed: PDF was not created" 
      });
    }

    console.log(`✅ PDF created`);

    // Read and validate PDF
    const pdfBytes = fs.readFileSync(pdfPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const pages = pdfDoc.getPageCount();

    console.log(`📊 PDF has ${pages} page(s)`);

    // Cleanup
    try {
      fs.unlinkSync(inputPath);
      fs.unlinkSync(pdfPath);
      console.log("🧹 Cleanup complete");
    } catch (e) {
      console.warn("⚠️ Cleanup warning:", e.message);
    }

    console.log(`✅ Conversion successful`);
    return res.status(200).json({ 
      ok: true, 
      pages,
      message: "File converted successfully",
      filename: req.file.originalname,
    });

  } catch (err) {
    console.error("❌ DOCX error:", err.message);
    return res.status(500).json({ 
      ok: false,
      error: "Failed to convert document",
      details: err.message 
    });
  }
});

// ✅ METHOD VALIDATION
app.get("/send-email", (req, res) => {
  return res.status(405).json({ 
    ok: false,
    error: "Method not allowed. Use POST." 
  });
});

app.get("/convert-docx", (req, res) => {
  return res.status(405).json({ 
    ok: false,
    error: "Method not allowed. Use POST." 
  });
});

// ✅ SPA FALLBACK - NO CATCH-ALL ROUTES
app.use((req, res, next) => {
  if (req.method === "GET") {
    if (!req.path.startsWith("/api") && !req.path.includes(".")) {
      const indexPath = path.join(ROOT_DIR, "index.html");
      if (fs.existsSync(indexPath)) {
        console.log(`📄 Serving index.html for: ${req.path}`);
        return res.sendFile(indexPath);
      }
    }
  }
  next();
});

// ✅ 404 HANDLER
app.use((req, res) => {
  console.log(`⚠️ 404 - ${req.method} ${req.path}`);
  
  const indexPath = path.join(ROOT_DIR, "index.html");
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }

  return res.status(404).json({ 
    ok: false,
    error: "Not found" 
  });
});

// ✅ ERROR HANDLER
app.use((err, req, res, next) => {
  console.error("❌ Error:", err.message);
  return res.status(err.status || 500).json({
    ok: false,
    error: "Internal server error",
  });
});

// ✅ START SERVER
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`\n╔════════════════════════════════════════╗`);
  console.log(`║  ✅ PrintQ Server Started Successfully  ║`);
  console.log(`║  🚀 Port: ${PORT}                           ║`);
  console.log(`║  📍 Environment: ${(process.env.NODE_ENV || "production").padEnd(19)}║`);
  console.log(`╚════════════════════════════════════════╝\n`);
  
  console.log("✅ Endpoints:");
  console.log("   GET  /health");
  console.log("   POST /send-email");
  console.log("   POST /convert-docx\n");
});

// ✅ GRACEFUL SHUTDOWN
process.on("SIGTERM", () => {
  console.log("\n📍 SIGTERM - shutting down...");
  server.close(() => {
    console.log("✅ Server closed");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  console.log("\n📍 SIGINT - shutting down...");
  server.close(() => {
    console.log("✅ Server closed");
    process.exit(0);
  });
});
