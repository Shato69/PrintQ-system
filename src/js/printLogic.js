import { supabase } from "./supabase.js";

const pdfjsLib = window['pdfjs-dist/build/pdf'];

// State
let uploadedFiles = []; // { file, name, type, size, pages }
let currentPricePerPage = 2;
let currentTotal = 0;
let currentPrintType = 'bw';
let currentPaperSize = 'Letter';

// ================== Supabase save ==================
async function savePrintJob(jobData) {
  try {
    const { data, error } = await supabase
      .from('orders')
      .insert([{
        color: jobData.color,
        cost: jobData.cost,
        filename: jobData.fileName,
        pagecount: jobData.pageCount,
        papersize: jobData.paperSize,
        status: 'pending',
        created_at: new Date().toISOString(),
        customer_email: jobData.customerEmail
      }])
      .select();

    if (error) {
      console.error("❌ Error inserting order:", error.message || error);
      return null;
    }

    const inserted = Array.isArray(data) ? data[0] : data;
    console.log("✅ Order inserted:", inserted);
    return inserted || null;
  } catch (err) {
    console.error("❌ Exception when inserting order:", err);
    return null;
  }
}

window.savePrintJob = savePrintJob;

// ================== Upload to Supabase Storage ==================
async function uploadFileToSupabase(file) {
  try {
    const { data, error } = await supabase.storage
      .from('ready2print-files')
      .upload(`uploads/${Date.now()}_${file.name}`, file);

    if (error) {
      console.error("❌ Upload failed:", error.message);
      return null;
    }

    console.log("✅ File uploaded:", data);
    return data.path;
  } catch (err) {
    console.error("⚠️ Unexpected upload error:", err);
    return null;
  }
}

const BACKEND_URL = "https://campusprintq.onrender.com/";
// ================== Email API call (robust) ==================
async function sendEmailNotification(to, subject, message) {
  if (!to || !subject || !message) {
    console.error("❌ Missing email fields", { to, subject, message });
    return { ok: false, error: "Missing required fields" };
  }

  try {
    //const res = await fetch("http://localhost:3000/send-email"
    const res = await fetch("${BACKEND_URL}/send-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, subject, message })
    });

    const text = await res.text();

    if (!res.ok) throw new Error(`Email API error: ${res.status} — ${text}`);

    console.log("✅ Email sent successfully:", text);
    return { ok: true };
  } catch (err) {
    console.error("❌ Failed to send email:", err);
    return { ok: false, error: err.message || err };
  }
}


// ================== Page navigation ==================
window.showPrintingPage = function () {
  document.getElementById('mainPage').style.display = 'none';
  document.getElementById('printingPage').style.display = 'block';
};

window.showMainPage = function () {
  document.getElementById('mainPage').style.display = 'flex';
  document.getElementById('printingPage').style.display = 'none';
  resetForm();
};

// ================== File handling ==================
const fileInput = document.getElementById('fileInput');
const uploadArea = document.querySelector('.upload-area');
//const fileListEl = document.getElementById('fileName');

if (uploadArea) {
  uploadArea.addEventListener("dragover", (e) => {
    e.preventDefault();
    uploadArea.classList.add("dragover");
  });
  uploadArea.addEventListener("dragleave", () => {
    uploadArea.classList.remove("dragover");
  });
  uploadArea.addEventListener("drop", (e) => {
    e.preventDefault();
    uploadArea.classList.remove("dragover");
    handleFiles(e.dataTransfer.files);
  });
}

fileInput.addEventListener("change", (e) => handleFiles(e.target.files));

async function handleFiles(fileList) {
  const files = Array.from(fileList);
  const allowedExtensions = [".pdf", ".doc", ".docx", ".png", ".jpg", ".jpeg", ".webp", ".jfif"];
  for (const file of files) {
    const lowerName = file.name.toLowerCase();
    const isAllowed = allowedExtensions.some(ext => lowerName.endsWith(ext));
    if (!isAllowed) continue; 
    await processSingleFile(file);
  }
  renderFileList();
  updateCostCalculation();
}

async function processSingleFile(file) {
  const dup = uploadedFiles.find(f => f.name === file.name && f.size === file.size);
  if (dup) return;

  let pageCount = 1;
  try {
    if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
      const buf = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      pageCount = pdf.numPages || 1;
    } else if (file.type.startsWith("image/")) {
      pageCount = 1;
    } else if (file.name.toLowerCase().endsWith(".txt")) {
      // not allowed anymore; silently ignored earlier
      return;
    } else if (file.name.toLowerCase().endsWith(".doc") || file.name.toLowerCase().endsWith(".docx")) {
      const formData = new FormData();
      formData.append("file", file);
      try {
        //const res = await fetch("http://localhost:3000/convert-docx"
        const res = await fetch (`${BACKEND_URL}/convert-docx`, {
          method: "POST",
          body: formData,
        });
        const text = await res.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          throw new Error("Invalid JSON: " + text.slice(0, 200));
        }
        pageCount = data.pages || 1;
      } catch (err) {
        console.warn("⚠️ DOCX page count failed, using 1:", err);
        pageCount = 1;
      }
    }
  } catch (err) {
    console.warn("Error reading file:", file.name, err);
  }

  uploadedFiles.push({ file, name: file.name, size: file.size, pages: pageCount });
}
// ================== UI render ==================
function renderFileList() {
  const listEl = document.getElementById("fileList");
  if (!listEl) return;

  if (uploadedFiles.length === 0) {
    listEl.innerHTML = `<li style="color:#6b7280;">No file uploaded yet</li>`;
    return;
  }

  listEl.innerHTML = uploadedFiles.map(f => {
    const fileUrl = URL.createObjectURL(f.file);
    return `
      <li style="margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
        <span class="file-name" data-url="${fileUrl}">
          📄 ${f.name}
          <span style="color:#6b7280; font-size:12px;">(${f.pages} page${f.pages > 1 ? 's' : ''})</span>
        </span>
        <button style="background:#ef4444; color:white; border:none; padding:2px 6px; border-radius:4px; cursor:pointer;"
                onclick="removeFile('${f.name}', ${f.size})">✖</button>
      </li>`;
  }).join("");
}

window.removeFile = function(name, size) {
  uploadedFiles = uploadedFiles.filter(f => !(f.name === name && f.size === size));
  renderFileList();
  updateCostCalculation();
};

// ================== Cost ==================
function updateCostCalculation() {
  const totalPages = uploadedFiles.reduce((sum, f) => sum + f.pages, 0);
  document.getElementById('pageCount').textContent = `${totalPages} pages`;
  document.getElementById('pricePerPage').textContent = `₱${currentPricePerPage.toFixed(2)}`;
  currentTotal = totalPages * currentPricePerPage;
  document.getElementById('totalCost').textContent = `₱${currentTotal.toFixed(2)}`;
  /*const payButton = document.getElementById('payButton');
  payButton.disabled = (uploadedFiles.length === 0 || totalPages === 0);*/
  updatePayButtonState();
}

// ================== Button State Control ==================
function updatePayButtonState(state = null) {
  const payButton = document.getElementById("payButton");
  const totalPages = uploadedFiles.reduce((sum, f) => sum + f.pages, 0);

  // Determine base state if none is forced
  if (!state) {
    if (uploadedFiles.length === 0 || totalPages === 0) state = "inactive";
    else state = "active";
  }

  payButton.classList.remove("active", "processing");
  payButton.disabled = false;

  switch (state) {
    case "inactive":
      payButton.disabled = true;
      payButton.textContent = "🚫 Place Order";
      payButton.style.backgroundColor = "#d1d5db";
      payButton.style.color = "#333";
      payButton.style.cursor = "not-allowed";
      break;

    case "active":
      payButton.textContent = "⬇️ Place Order";
      payButton.style.backgroundColor = "#ef4444";
      payButton.style.color = "white";
      payButton.style.cursor = "pointer";
      break;

    case "processing":
      payButton.disabled = true;
      payButton.textContent = "⏳ Processing…";
      payButton.style.backgroundColor = "#fbbf24";
      payButton.style.color = "black";
      payButton.style.cursor = "wait";
      break;

    case "reset":
      uploadedFiles = [];
      currentTotal = 0;
      fileInput.value = "";
      renderFileList();
      updateCostCalculation();
      payButton.textContent = "🚫 Place Order";
      payButton.style.backgroundColor = "#d1d5db";
      payButton.style.color = "#333";
      payButton.disabled = true;
      break;
  }
}

// ================== Payment ==================
window.processPayment = async function () {
  const payButton = document.getElementById("payButton");
  //const originalText = payButton.textContent;
  //const originalBg = payButton.style.backgroundColor;

  payButton.disabled = true;
  payButton.textContent = "⏳ Processing…";
  payButton.style.backgroundColor = "#d1d5db";

  try {
    const customerEmail = document.getElementById("customerEmail").value.trim();
    if (!customerEmail) throw new Error("Please enter a Gmail address.");
    if (uploadedFiles.length === 0) throw new Error("No files uploaded.");

    const ordersSummary = [];

    // Upload all files and save orders
    for (const f of uploadedFiles) {
      const filePath = await uploadFileToSupabase(f.file);
      if (!filePath) {
        console.warn("⚠️ Upload failed:", f.name);
        continue;
      }

      const cost = f.pages * currentPricePerPage;
      const orderData = {
        fileName: f.name,
        filePath,
        pageCount: f.pages,
        paperSize: currentPaperSize,
        color: currentPrintType === "bw" ? "Black & White" : "Colored",
        cost,
        customerEmail
      };

      const order = await savePrintJob(orderData);
      ordersSummary.push({ fileName: f.name, pages: f.pages, cost, orderId: order?.id });
    }

    if (ordersSummary.length === 0) throw new Error("All file uploads failed.");

    // Create a single email body with all files
    const subject = `PrintQ Order Confirmation — ${ordersSummary.length} file(s)`;
    const messageLines = ["Your files have been received and are ready to print:\n"];
    ordersSummary.forEach(o => {
      messageLines.push(`• ${o.fileName} — ${o.pages} page(s) — ₱${o.cost.toFixed(2)} (Order ID: ${o.orderId || "N/A"})`);
    });
    // Calculate total cost
    const totalCost = ordersSummary.reduce((sum, o) => sum + o.cost, 0);
    messageLines.push(`\n📄 Total amount to pay: ₱${totalCost.toFixed(2)}`);
    messageLines.push("\nScan the attached QR to pay.\nThis message is system generated.");
    const message = messageLines.join("\n");

    // Send one single email
    await sendEmailNotification(customerEmail, subject, message);

    alert("✅ Your order has been placed! Check your Gmail for confirmation.");
    updatePayButtonState("reset");

  } catch (err) {
    console.error("❌ processPayment error:", err);
    alert(err.message || "Something went wrong.");
    updatePayButtonState();
  } 
};

// ================== Reset ==================
function resetForm() {
  uploadedFiles = [];
  currentTotal = 0;
  fileInput.value = "";
  renderFileList();
  updateCostCalculation();
}

// ================== Paper & print type ==================
window.selectPaperSize = function (button, size) {
  document.querySelectorAll('.option-button').forEach(btn => btn.classList.remove('selected'));
  button.classList.add('selected');
  currentPaperSize = size;
};

window.selectPrintType = function (button, type, price) {
  document.querySelectorAll('.print-type-button').forEach(btn => btn.classList.remove('selected'));
  button.classList.add('selected');
  currentPrintType = type;
  currentPricePerPage = price;
  updateCostCalculation();
};

document.getElementById("fileList").addEventListener("click", function (e) {
  if (e.target && e.target.matches("span.file-name")) {
    const fileUrl = e.target.getAttribute("data-url");
    if (fileUrl) {
      window.open(fileUrl, "_blank");
    } else {
      alert("Preview unavailable for this file.");
    }
  }
});

// ================== Desktop Enter Key Trigger ==================
document.addEventListener("keydown", (e) => {
  const payButton = document.getElementById("payButton");
  const activeElement = document.activeElement;

  // Only respond to Enter if:
  // - Enter key pressed
  // - Pay button exists and is active
  // - User isn't typing inside an input or textarea
  if (
    e.key === "Enter" &&
    payButton &&
    !payButton.disabled &&
    payButton.textContent.includes("Place Order") &&
    !(activeElement.tagName === "INPUT" || activeElement.tagName === "TEXTAREA")
  ) {
    e.preventDefault();
    payButton.click();
  }
});

// Initialize
renderFileList();
updateCostCalculation();