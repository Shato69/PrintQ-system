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

const app = express();
app.use(express.json({ limit: "15mb" })); // increase if needed
app.use(cors());

// ------------ Helper constants ------------
const HTML_DIR = path.join(__dirname, "../../html"); // where index.html lives
const SRC_DIR  = path.join(__dirname, "../../src");  // where css/js live
const IMG_DIR  = path.join(__dirname, "../../img");  // images folder (GCash-MyQR.jpg)
const INDEX_HTML_PATH = path.join(HTML_DIR, "index.html");

// -------------- API ROUTES (define FIRST) --------------

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

// DOCX -> count pages (LibreOffice must be available on the host)
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
    let pageCount = pdfDoc.getPageCount();

    // Cleanup temp files
    try { fs.unlinkSync(inputPath); } catch(e) {}
    try { fs.unlinkSync(pdfPath); } catch(e) {}

    return res.json({ originalName: req.file.originalname, pages: pageCount });
  } catch (err) {
    console.error("DOCX analyze error:", err);
    return res.status(500).json({ error: err.message || "conversion error" });
  }
});

// -------------- STATIC SERVING --------------
// Serve html folder (index.html) and any assets inside html/
if (fs.existsSync(HTML_DIR)) {
  app.use(express.static(HTML_DIR));
} else {
  console.warn("WARNING: html folder not found at", HTML_DIR);
}

// Serve /src (css/js) if it's sibling to html (your described layout)
if (fs.existsSync(SRC_DIR)) {
  app.use("/src", express.static(SRC_DIR));
} else {
  console.warn("WARNING: src folder not found at", SRC_DIR);
}

// Serve /img for images (like GCash-MyQR.jpg)
if (fs.existsSync(IMG_DIR)) {
  app.use("/img", express.static(IMG_DIR));
}

// -------------- BRUTE-FORCE SPA FALLBACK (NO path-to-regexp) --------------
// This middleware does not use app.get("pattern", ...) so we avoid any path-to-regexp parsing.
// It only handles GET requests that accept HTML and that haven't already been matched by static files or APIs.
app.use((req, res, next) => {
  // Only try to return index.html for GET requests that accept HTML
  if (req.method !== "GET") return next();
  const acceptsHtml = req.headers.accept && req.headers.accept.indexOf("text/html") !== -1;
  if (!acceptsHtml) return next();

  // If index exists, try sendFile. If sendFile fails, fallback to streaming file contents.
  if (fs.existsSync(INDEX_HTML_PATH)) {
    res.sendFile(INDEX_HTML_PATH, (err) => {
      if (err) {
        console.error("sendFile failed, falling back to readFile:", err);
        try {
          const html = fs.readFileSync(INDEX_HTML_PATH, "utf8");
          res.type("html").send(html);
        } catch (readErr) {
          console.error("Failed reading index.html for fallback:", readErr);
          next();
        }
      }
    });
    return; // we responded (or attempted to)
  } else {
    console.warn("index.html not found at", INDEX_HTML_PATH);
    return next();
  }
});

// -------------- Generic error handler --------------
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "internal server error" });
});

// -------------- Server start --------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
