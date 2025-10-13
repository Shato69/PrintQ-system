// src/js/backend/service-api.js
// Brute-force, safe, Render-ready. Avoids path-to-regexp wildcard issues by using a final app.use() fallback.

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

// Basic app
const app = express();
app.use(express.json({ limit: "30mb" }));
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
app.use(cors({ origin: CORS_ORIGIN }));

// Multer
const upload = multer({ storage: multer.memoryStorage() });

// Utility
const exists = p => { try { return fs.existsSync(p); } catch { return false; } };
const safeLog = (...a) => { try { console.log(...a); } catch(_) {} };
const safeWarn = (...a) => { try { console.warn(...a); } catch(_) {} };
const safeError = (...a) => { try { console.error(...a); } catch(_) {} };

// Resolve roots & index
const CWD_ROOT = path.resolve("."); // Render runs in repo root
const PROJECT_ROOT = path.resolve(__dirname, "../../../..");
const ROOT_INDEX = path.join(CWD_ROOT, "index.html");

// Candidate static directories to mount (if present)
const STATIC_CANDIDATES = [
  CWD_ROOT,
  path.join(CWD_ROOT, "public"),
  path.join(CWD_ROOT, "dist"),
  path.join(CWD_ROOT, "build"),
  path.join(CWD_ROOT, "html"),
  path.join(PROJECT_ROOT, "src"),
  path.join(PROJECT_ROOT, "src", "css"),
  path.join(PROJECT_ROOT, "src", "js"),
  path.join(PROJECT_ROOT, "src", "img"),
].filter(p => exists(p) && fs.statSync(p).isDirectory());

// Mount static directories.
// We mount repo root first (so root/index.html and root assets are prioritized).
if (exists(CWD_ROOT) && fs.statSync(CWD_ROOT).isDirectory()) {
  app.use(express.static(CWD_ROOT, { extensions: ["html", "htm"] }));
  safeLog("[startup] Mounted repo root as static:", CWD_ROOT);
}
for (const dir of STATIC_CANDIDATES) {
  // If we already mounted root which equals dir, skip re-mount.
  if (path.resolve(dir) === path.resolve(CWD_ROOT)) continue;
  // Mount under /<basename> to avoid collision
  const mountPoint = "/" + path.basename(dir);
  app.use(mountPoint, express.static(dir));
  safeLog("[startup] Mounted static:", mountPoint, "->", dir);
}

// Diagnostics
safeLog("[startup] process.cwd():", process.cwd());
safeLog("[startup] __dirname:", __dirname);
safeLog("[startup] ROOT_INDEX (expected):", ROOT_INDEX);
safeLog("[startup] NODE_ENV:", process.env.NODE_ENV);
safeLog("[startup] CORS_ORIGIN:", CORS_ORIGIN);

// ------------------ Email transporter (defensive) ------------------
let transporter = null;
if (process.env.GMAIL_USER && process.env.GMAIL_PASSWORD) {
  try {
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASSWORD }
    });
    // verify non-blocking
    transporter.verify().then(() => safeLog("[startup] Email transporter OK")).catch(err => safeWarn("[startup] Email verify:", err?.message || err));
  } catch (e) {
    safeWarn("[startup] transporter init failed:", e?.message || e);
    transporter = null;
  }
} else {
  safeWarn("[startup] GMAIL_USER/GMAIL_PASSWORD not set. /send-email will return 500.");
}

// ------------------ soffice check (non-blocking) ------------------
let sofficeAvailable = false;
try {
  exec("soffice --version", (err, stdout, stderr) => {
    if (!err) {
      sofficeAvailable = true;
      safeLog("[startup] soffice detected");
    } else {
      safeWarn("[startup] soffice unavailable:", (stderr||"").toString().slice(0,200));
    }
  });
} catch (e) {
  safeWarn("[startup] soffice check failed:", e?.message || e);
}

// ------------------ API routes ------------------

// Health
app.get("/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString(), rootIndexExists: exists(ROOT_INDEX) });
});

// Send-email
app.post("/send-email", async (req, res) => {
  try {
    if (!transporter) return res.status(500).json({ ok: false, error: "Email transporter not configured on server." });
    const { to, subject, message } = req.body || {};
    if (!to || !subject || !message) return res.status(400).json({ ok: false, error: "Missing fields: to, subject, message." });
    if (typeof to !== "string" || !/@/.test(to)) return res.status(400).json({ ok: false, error: "Invalid recipient." });

    const qrCandidates = [
      path.join(CWD_ROOT, "img", "GCash-MyQR.jpg"),
      path.join(PROJECT_ROOT, "src", "img", "GCash-MyQR.jpg"),
      path.join(CWD_ROOT, "GCash-MyQR.jpg")
    ];
    const qrPath = qrCandidates.find(exists);
    const attachments = qrPath ? [{ filename: path.basename(qrPath), path: qrPath }] : [];

    const info = await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to, subject, text: message, attachments
    });
    res.json({ ok: true, info: info?.response || info });
  } catch (err) {
    safeError("[/send-email] error:", err?.message || err);
    res.status(500).json({ ok: false, error: (err && err.message) || "internal error" });
  }
});

// Convert DOCX (defensive)
app.post("/convert-docx", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded (field 'file')." });
    if (!sofficeAvailable) return res.status(503).json({ ok: false, error: "LibreOffice not installed on server (soffice missing)." });

    const tempDir = path.join(os.tmpdir(), "printq-temp");
    if (!exists(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const safeName = `${Date.now()}_${req.file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_")}`;
    const inputPath = path.join(tempDir, safeName);
    fs.writeFileSync(inputPath, req.file.buffer);

    await new Promise((resolve, reject) => {
      const cmd = `soffice --headless --convert-to pdf:writer_pdf_Export --outdir "${tempDir}" "${inputPath}"`;
      exec(cmd, { timeout: 60000 }, (err, stdout, stderr) => {
        if (err) {
          safeError("[convert-docx] soffice failed:", err?.message || err, (stderr||"").toString().slice(0,400));
          return reject(err);
        }
        resolve();
      });
    });

    const pdfPath = inputPath.replace(/\.(docx|doc)$/i, ".pdf");
    if (!exists(pdfPath)) throw new Error("Converted PDF not found");

    const pdfBytes = fs.readFileSync(pdfPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const pageCount = pdfDoc.getPageCount();

    // cleanup
    try { fs.unlinkSync(inputPath); } catch(_) {}
    try { fs.unlinkSync(pdfPath); } catch(_) {}

    res.json({ ok: true, originalName: req.file.originalname, pages: pageCount });
  } catch (err) {
    safeError("[/convert-docx] error:", err?.message || err);
    res.status(500).json({ ok: false, error: err?.message || "conversion failed" });
  }
});

// ------------------ SPA fallback middleware (no path-to-regexp) ------------------
// This middleware runs after static mounts and APIs.
// It only handles GET requests that accept HTML (browser navigation).
app.use((req, res, next) => {
  try {
    // Only handle GET requests
    if (req.method !== "GET") return next();

    // If a static file was matched earlier, express.static would have ended the request.
    // Check Accept header to see if client expects HTML.
    const accept = req.headers.accept || "";
    const wantHtml = accept.includes("text/html") || accept.includes("*/*");
    if (!wantHtml) return next();

    // Serve root index if present
    if (exists(ROOT_INDEX)) {
      return res.sendFile(ROOT_INDEX);
    }

    // Try common build locations
    const fallbackCandidates = [
      path.join(CWD_ROOT, "dist", "index.html"),
      path.join(CWD_ROOT, "build", "index.html"),
      path.join(CWD_ROOT, "public", "index.html"),
      path.join(CWD_ROOT, "html", "index.html"),
    ];
    for (const c of fallbackCandidates) {
      if (exists(c)) return res.sendFile(c);
    }

    // Final small embedded fallback page so browser doesn't show "Cannot GET /"
    const fallbackHtml = `<!doctype html><html><head><meta charset="utf-8"><title>PrintQ — fallback</title></head><body>
      <h2>PrintQ — fallback page</h2>
      <p>index.html not found on server in expected locations.</p>
      <pre>Looked at: ${ROOT_INDEX}\n${fallbackCandidates.join("\n")}</pre>
      <p>Ensure index.html is at repo root or in /dist or /public, then redeploy.</p>
    </body></html>`;
    return res.status(200).type("html").send(fallbackHtml);
  } catch (e) {
    safeError("[SPA fallback] error:", e?.message || e);
    return next();
  }
});

// ------------------ Error handling & process safety ------------------
app.use((err, req, res, next) => {
  safeError("[express err]", err?.stack || err);
  if (!res.headersSent) res.status(500).json({ ok: false, error: "internal server error" });
});

process.on("uncaughtException", (err) => {
  safeError("[uncaughtException]", err?.stack || err);
  // keep alive; Render will expose logs
});
process.on("unhandledRejection", (reason, p) => {
  safeError("[unhandledRejection]", reason, p);
});

// ------------------ Start ------------------
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  safeLog(`[startup] server listening on ${PORT}. ROOT_INDEX exists?`, exists(ROOT_INDEX));
});
