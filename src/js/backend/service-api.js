// src/js/backend/service-api.js
/**
 * Aggressive, root-first server:
 * - Assumes index.html is at repo root (process.cwd()) and forces serving it.
 * - Mounts repo root as static so all assets in root are served.
 * - Uses named catch-all (/:any*) to avoid PathError.
 * - Defensive checks + clear startup logs for Render.
 */

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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "30mb" }));
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));

// Multer (memory)
const upload = multer({ storage: multer.memoryStorage() });

// --- Root-first, explicit paths ---
const CWD_ROOT = path.resolve("."); // should be repo root on Render
const ROOT_INDEX = path.join(CWD_ROOT, "index.html"); // <-- ROOT PRIORITY: index.html must be here
const STATIC_ROOT = CWD_ROOT; // serve the whole repo root as static

// Additional likely static dirs (optional mounts)
const STATIC_DIRS = [
  path.join(CWD_ROOT, "public"),
  path.join(CWD_ROOT, "dist"),
  path.join(CWD_ROOT, "build"),
  path.join(CWD_ROOT, "src"),
].filter(p => fs.existsSync(p) && fs.statSync(p).isDirectory());

// --- Mount static (root first) ---
if (fs.existsSync(STATIC_ROOT) && fs.statSync(STATIC_ROOT).isDirectory()) {
  app.use(express.static(STATIC_ROOT, { extensions: ["html", "htm"] }));
  console.log("[startup] Mounted repo root as static ->", STATIC_ROOT);
} else {
  console.warn("[startup] Repo root does not exist or not a dir:", STATIC_ROOT);
}

for (const d of STATIC_DIRS) {
  // mount under /<basename> to avoid collisions
  const mount = "/" + path.basename(d);
  app.use(mount, express.static(d));
  console.log(`[startup] Mounted ${d} at ${mount}`);
}

// --- Diagnostics ---
console.log("[startup] process.cwd():", process.cwd());
console.log("[startup] __dirname:", __dirname);
console.log("[startup] ROOT_INDEX:", ROOT_INDEX);
console.log("[startup] NODE_ENV:", process.env.NODE_ENV);

// --- Email transporter (defensive) ---
let transporter = null;
if (process.env.GMAIL_USER && process.env.GMAIL_PASSWORD) {
  try {
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASSWORD }
    });
    transporter.verify().then(() => console.log("[startup] Email transporter verified")).catch(e => console.warn("[startup] Email verify failed:", e?.message || e));
  } catch (e) {
    console.warn("[startup] transporter init error:", e?.message || e);
    transporter = null;
  }
} else {
  console.warn("[startup] GMAIL_USER / GMAIL_PASSWORD not set — /send-email will return 500.");
}

// --- Utility ---
const exists = p => { try { return fs.existsSync(p); } catch { return false; } };

// --- Routes: APIs (unchanged semantics) ---

app.get("/health", (req, res) => {
  return res.json({ ok: true, time: new Date().toISOString(), indexPresent: exists(ROOT_INDEX) });
});

app.post("/send-email", async (req, res) => {
  try {
    if (!transporter) return res.status(500).json({ ok: false, error: "Email transporter not configured." });
    const { to, subject, message } = req.body || {};
    if (!to || !subject || !message) return res.status(400).json({ ok: false, error: "Missing fields" });
    if (typeof to !== "string" || !/@/.test(to)) return res.status(400).json({ ok: false, error: "Invalid recipient" });

    // find QR in root/src/img/img locations
    const qrCandidates = [
      path.join(CWD_ROOT, "img", "GCash-MyQR.jpg"),
      path.join(CWD_ROOT, "src", "img", "GCash-MyQR.jpg"),
      path.join(CWD_ROOT, "GCash-MyQR.jpg")
    ];
    const qrPath = qrCandidates.find(exists);
    const attachments = qrPath ? [{ filename: path.basename(qrPath), path: qrPath }] : [];

    const info = await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to, subject, text: message, attachments
    });
    return res.json({ ok: true, info: info?.response || info });
  } catch (err) {
    console.error("[send-email] error:", err);
    return res.status(500).json({ ok: false, error: err?.message || "internal error" });
  }
});

// DOCX convert (best-effort; checks soffice)
app.post("/convert-docx", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded (field 'file')" });

    // quick soffice check
    let sofficeAvailable = true;
    try {
      exec("soffice --version", (err) => { if (err) sofficeAvailable = false; });
    } catch { sofficeAvailable = false; }

    if (!sofficeAvailable) return res.status(503).json({ ok: false, error: "Server conversion unavailable: soffice not installed." });

    const tempDir = path.join(os.tmpdir(), "printq-temp");
    if (!exists(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const safeName = `${Date.now()}_${req.file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_")}`;
    const inputPath = path.join(tempDir, safeName);
    fs.writeFileSync(inputPath, req.file.buffer);

    await new Promise((resolve, reject) => {
      const cmd = `soffice --headless --convert-to pdf:writer_pdf_Export --outdir "${tempDir}" "${inputPath}"`;
      exec(cmd, { timeout: 60_000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message || "").toString().slice(0, 1000)));
        resolve();
      });
    });

    const pdfPath = inputPath.replace(/\.(docx|doc)$/i, ".pdf");
    if (!exists(pdfPath)) throw new Error("Converted PDF missing");

    const pdfBytes = fs.readFileSync(pdfPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const pages = pdfDoc.getPageCount();

    // cleanup
    try { fs.unlinkSync(inputPath); } catch (_) {}
    try { fs.unlinkSync(pdfPath); } catch (_) {}

    return res.json({ ok: true, pages, originalName: req.file.originalname });
  } catch (err) {
    console.error("[convert-docx] error:", err);
    return res.status(500).json({ ok: false, error: err?.message || "conversion failed" });
  }
});

// --- Root route: FORCE serve root/index.html if exists ---
async function forceServeIndex(req, res) {
  try {
    if (exists(ROOT_INDEX)) {
      // sendFile requires absolute path; use ROOT_INDEX
      return res.sendFile(ROOT_INDEX);
    }
    // If no index at root, try fallback candidates (common build dirs)
    const fallbackCandidates = [
      path.join(CWD_ROOT, "dist", "index.html"),
      path.join(CWD_ROOT, "build", "index.html"),
      path.join(CWD_ROOT, "public", "index.html"),
      path.join(CWD_ROOT, "html", "index.html")
    ];
    for (const c of fallbackCandidates) {
      if (exists(c)) return res.sendFile(c);
    }
    // final embedded fallback HTML so browser doesn't show "Cannot GET /"
    const embedded = `<!doctype html><html><head><meta charset="utf-8"><title>Fallback</title></head><body>
      <h1>PrintQ (fallback)</h1>
      <p>index.html not found at root. Expected at: ${ROOT_INDEX}</p>
      <p>Check repo and redeploy. Server mounted repo root as static.</p>
    </body></html>`;
    return res.status(200).type("html").send(embedded);
  } catch (e) {
    console.error("[forceServeIndex] error:", e);
    return res.status(500).send("internal server error");
  }
}

// exact root
app.get("/", forceServeIndex);
// named catch-all compatible with path-to-regexp v6
app.get("/:any*", forceServeIndex);

// generic error middleware
app.use((err, req, res, next) => {
  console.error("[express error]", err);
  if (!res.headersSent) res.status(500).json({ ok: false, error: "internal server error" });
});

// keep process alive and log unhandled issues
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));
process.on("unhandledRejection", (r) => console.error("[unhandledRejection]", r));

// Start
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log(`[startup] server listening on ${PORT} — ROOT_INDEX exists? ${exists(ROOT_INDEX)}`));
