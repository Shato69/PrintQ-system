import { supabase } from "./supabase.js";

const pdfjsLib = window['pdfjs-dist/build/pdf'];

// ✅ BACKEND URL CONFIGURATION
const BACKEND_URL = (() => {
  const hostname = window.location.hostname;
  const isDev = hostname.includes("localhost") || hostname.includes("127.0.0.1");
  
  // Uncomment for localhost debugging:
  // return "http://localhost:3000";
  
  return isDev ? "http://localhost:3000" : "https://campusprintq.onrender.com";
})();

console.log(`🌐 Backend URL: ${BACKEND_URL}`);
console.log(`📍 Current hostname: ${window.location.hostname}`);

// ================== STATE ==================
let uploadedFiles = []; // { file, name, type, size, pages }
let currentPricePerPage = 2;
let currentTotal = 0;
let currentPrintType = 'bw';
let currentPaperSize = 'Letter';

// ================== SUPABASE SAVE ==================
async function savePrintJob(jobData) {
  try {
    console.log("💾 Saving print job to Supabase:", jobData);
    
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
      console.error("❌ Supabase insert error:", error.message || error);
      throw error;
    }

    const inserted = Array.isArray(data) ? data[0] : data;
    console.log("✅ Order inserted successfully:", inserted);
    return inserted || null;
  } catch (err) {
    console.error("❌ Exception when saving order:", err);
    return null;
  }
}

window.savePrintJob = savePrintJob;

// ================== UPLOAD TO SUPABASE STORAGE ==================
async function uploadFileToSupabase(file) {
  try {
    console.log(`📤 Uploading file to Supabase: ${file.name}`);
    
    const timestamp = Date.now();
    const fileName = `uploads/${timestamp}_${file.name}`;
    
    const { data, error } = await supabase.storage
      .from('ready2print-files')
      .upload(fileName, file);

    if (error) {
      console.error("❌ Supabase upload error:", error.message);
      throw error;
    }

    console.log("✅ File uploaded successfully:", data);
    return data.path;
  } catch (err) {
    console.error("❌ Upload exception:", err);
    return null;
  }
}

// ================== EMAIL NOTIFICATION ==================
async function sendEmailNotification(to, subject, message) {
  if (!to || !subject || !message) {
    console.error("❌ Missing email fields", { to, subject, message });
    return { ok: false, error: "Missing required fields" };
  }

  try {
    console.log("📧 Sending email via backend...");
    console.log(`   To: ${to}`);
    console.log(`   Subject: ${subject}`);
    console.log(`   Backend URL: ${BACKEND_URL}/send-email`);

    const response = await fetch(`${BACKEND_URL}/send-email`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({ to, subject, message })
    });

    console.log(`📊 Email API response status: ${response.status}`);

    const data = await response.json();

    if (!response.ok) {
      console.error("❌ Email API error:", data);
      throw new Error(data.error || `Email failed with status ${response.status}`);
    }

    console.log("✅ Email sent successfully:", data);
    return { ok: true, data };
  } catch (err) {
    console.error("❌ Failed to send email:", err.message || err);
    return { ok: false, error: err.message || err };
  }
}

// ================== PAGE NAVIGATION ==================
window.showPrintingPage = function () {
  console.log("📄 Switching to printing page");
  document.getElementById('mainPage').style.display = 'none';
  document.getElementById('printingPage').style.display = 'block';
};

window.showMainPage = function () {
  console.log("📄 Switching to main page");
  document.getElementById('mainPage').style.display = 'flex';
  document.getElementById('printingPage').style.display = 'none';
  resetForm();
};

// ================== FILE HANDLING ==================
const fileInput = document.getElementById('fileInput');
const uploadArea = document.querySelector('.upload-area');

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
    console.log("📂 Files dropped:", e.dataTransfer.files.length);
    handleFiles(e.dataTransfer.files);
  });
}

fileInput.addEventListener("change", (e) => {
  console.log("📂 Files selected:", e.target.files.length);
  handleFiles(e.target.files);
});

async function handleFiles(fileList) {
  const files = Array.from(fileList);
  const allowedExtensions = [".pdf", ".doc", ".docx", ".png", ".jpg", ".jpeg", ".webp", ".jfif"];
  
  console.log(`📋 Processing ${files.length} files`);

  for (const file of files) {
    const lowerName = file.name.toLowerCase();
    const isAllowed = allowedExtensions.some(ext => lowerName.endsWith(ext));
    
    if (!isAllowed) {
      console.warn(`⚠️ File rejected (unsupported type): ${file.name}`);
      continue;
    }

    await processSingleFile(file);
  }

  renderFileList();
  updateCostCalculation();
}

async function processSingleFile(file) {
  console.log(`🔄 Processing file: ${file.name} (${(file.size / 1024).toFixed(2)} KB)`);

  // Check for duplicates
  const dup = uploadedFiles.find(f => f.name === file.name && f.size === file.size);
  if (dup) {
    console.warn("⚠️ Duplicate file ignored:", file.name);
    return;
  }

  let pageCount = 1;

  try {
    if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
      console.log("📑 Reading PDF pages...");
      const buf = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      pageCount = pdf.numPages || 1;
      console.log(`✅ PDF has ${pageCount} page(s)`);
    } 
    else if (file.type.startsWith("image/")) {
      console.log("🖼️ Image file detected - 1 page");
      pageCount = 1;
    } 
    else if (file.name.toLowerCase().endsWith(".doc") || file.name.toLowerCase().endsWith(".docx")) {
      console.log("📝 DOCX file detected - converting to PDF...");
      const formData = new FormData();
      formData.append("file", file);

      try {
        // Uncomment for localhost debugging:
        // const url = "http://localhost:3000/convert-docx";
        const url = `${BACKEND_URL}/convert-docx`;
        
        console.log(`   Converting via: ${url}`);
        
        const response = await fetch(url, {
          method: "POST",
          body: formData
        });

        console.log(`   Conversion response status: ${response.status}`);

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Conversion failed: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        pageCount = data.pages || 1;
        console.log(`✅ DOCX converted - ${pageCount} page(s)`);
      } catch (err) {
        console.error("❌ DOCX conversion error:", err.message);
        console.warn("⚠️ Using default 1 page for:", file.name);
        pageCount = 1;
      }
    }
  } catch (err) {
    console.error("❌ Error processing file:", file.name, err);
    pageCount = 1;
  }

  uploadedFiles.push({ file, name: file.name, size: file.size, pages: pageCount });
  console.log(`✅ File added to queue: ${file.name} (${pageCount} pages)`);
}

// ================== UI RENDER ==================
function renderFileList() {
  const listEl = document.getElementById("fileList");
  if (!listEl) {
    console.warn("⚠️ fileList element not found");
    return;
  }

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
                onclick="removeFile('${f.name}', ${f.size})">✕</button>
      </li>`;
  }).join("");

  console.log(`📋 Rendered ${uploadedFiles.length} file(s)`);
}

window.removeFile = function(name, size) {
  console.log(`🗑️ Removing file: ${name}`);
  uploadedFiles = uploadedFiles.filter(f => !(f.name === name && f.size === size));
  renderFileList();
  updateCostCalculation();
};

// ================== COST CALCULATION ==================
function updateCostCalculation() {
  const totalPages = uploadedFiles.reduce((sum, f) => sum + f.pages, 0);
  const pageCountEl = document.getElementById('pageCount');
  const pricePerPageEl = document.getElementById('pricePerPage');
  const totalCostEl = document.getElementById('totalCost');

  if (pageCountEl) pageCountEl.textContent = `${totalPages} pages`;
  if (pricePerPageEl) pricePerPageEl.textContent = `₱${currentPricePerPage.toFixed(2)}`;
  
  currentTotal = totalPages * currentPricePerPage;
  if (totalCostEl) totalCostEl.textContent = `₱${currentTotal.toFixed(2)}`;

  updatePayButtonState();
  
  console.log(`💰 Cost calculated: ${totalPages} pages × ₱${currentPricePerPage} = ₱${currentTotal.toFixed(2)}`);
}

// ================== BUTTON STATE CONTROL ==================
function updatePayButtonState(state = null) {
  const payButton = document.getElementById("payButton");
  if (!payButton) {
    console.warn("⚠️ payButton element not found");
    return;
  }

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
      console.log("🔘 Button state: INACTIVE");
      payButton.disabled = true;
      payButton.textContent = "🚫 Place Order";
      payButton.style.backgroundColor = "#d1d5db";
      payButton.style.color = "#333";
      payButton.style.cursor = "not-allowed";
      break;

    case "active":
      console.log("🔘 Button state: ACTIVE");
      payButton.textContent = "⬇️ Place Order";
      payButton.style.backgroundColor = "#ef4444";
      payButton.style.color = "white";
      payButton.style.cursor = "pointer";
      break;

    case "processing":
      console.log("🔘 Button state: PROCESSING");
      payButton.disabled = true;
      payButton.textContent = "⏳ Processing…";
      payButton.style.backgroundColor = "#fbbf24";
      payButton.style.color = "black";
      payButton.style.cursor = "wait";
      break;

    case "reset":
      console.log("🔘 Button state: RESET");
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

// ================== PAYMENT PROCESSING ==================
window.processPayment = async function () {
  console.log("💳 Starting payment process...");
  
  const payButton = document.getElementById("payButton");
  payButton.disabled = true;
  payButton.textContent = "⏳ Processing…";
  payButton.style.backgroundColor = "#d1d5db";

  try {
    const customerEmail = document.getElementById("customerEmail").value.trim();
    
    if (!customerEmail) {
      throw new Error("❌ Please enter a Gmail address.");
    }

    console.log(`👤 Customer email: ${customerEmail}`);

    if (uploadedFiles.length === 0) {
      throw new Error("❌ No files uploaded.");
    }

    console.log(`📂 Processing ${uploadedFiles.length} file(s)...`);

    const ordersSummary = [];

    // Upload all files and save orders
    for (const f of uploadedFiles) {
      console.log(`📤 Uploading: ${f.name}`);
      
      const filePath = await uploadFileToSupabase(f.file);
      if (!filePath) {
        console.warn(`⚠️ Upload failed: ${f.name}`);
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

      console.log(`💾 Saving order for: ${f.name}`);
      const order = await savePrintJob(orderData);
      ordersSummary.push({ 
        fileName: f.name, 
        pages: f.pages, 
        cost, 
        orderId: order?.id 
      });
    }

    if (ordersSummary.length === 0) {
      throw new Error("❌ All file uploads failed.");
    }

    console.log(`✅ ${ordersSummary.length} order(s) created`);

    // Create email body
    const subject = `PrintQ Order Confirmation – ${ordersSummary.length} file(s)`;
    const messageLines = ["Your files have been received and are ready to print:\n"];
    
    ordersSummary.forEach(o => {
      messageLines.push(
        `• ${o.fileName} – ${o.pages} page(s) – ₱${o.cost.toFixed(2)} (Order ID: ${o.orderId || "N/A"})`
      );
    });

    const totalCost = ordersSummary.reduce((sum, o) => sum + o.cost, 0);
    messageLines.push(`\n📄 Total amount to pay: ₱${totalCost.toFixed(2)}`);
    messageLines.push("\nScan the attached QR to pay.\nThis message is system generated.");
    
    const message = messageLines.join("\n");

    console.log("📧 Sending confirmation email...");
    const emailResult = await sendEmailNotification(customerEmail, subject, message);

    if (!emailResult.ok) {
      throw new Error(`Email failed: ${emailResult.error}`);
    }

    alert("✅ Your order has been placed! Check your Gmail for confirmation.");
    updatePayButtonState("reset");

  } catch (err) {
    console.error("❌ Payment process error:", err);
    alert(`❌ ${err.message || "Something went wrong."}`);
    updatePayButtonState("active");
  }
};

// ================== RESET FORM ==================
function resetForm() {
  console.log("🔄 Resetting form...");
  uploadedFiles = [];
  currentTotal = 0;
  fileInput.value = "";
  renderFileList();
  updateCostCalculation();
}

// ================== PAPER & PRINT TYPE ==================
window.selectPaperSize = function (button, size) {
  console.log(`📄 Paper size selected: ${size}`);
  document.querySelectorAll('.option-button').forEach(btn => btn.classList.remove('selected'));
  button.classList.add('selected');
  currentPaperSize = size;
};

window.selectPrintType = function (button, type, price) {
  console.log(`🎨 Print type selected: ${type} (₱${price})`);
  document.querySelectorAll('.print-type-button').forEach(btn => btn.classList.remove('selected'));
  button.classList.add('selected');
  currentPrintType = type;
  currentPricePerPage = price;
  updateCostCalculation();
};

// ================== FILE PREVIEW ==================
document.getElementById("fileList").addEventListener("click", function (e) {
  if (e.target && e.target.matches("span.file-name")) {
    const fileUrl = e.target.getAttribute("data-url");
    if (fileUrl) {
      console.log("👁️ Opening file preview...");
      window.open(fileUrl, "_blank");
    } else {
      alert("⚠️ Preview unavailable for this file.");
    }
  }
});

// ================== ENTER KEY TRIGGER ==================
document.addEventListener("keydown", (e) => {
  const payButton = document.getElementById("payButton");
  const activeElement = document.activeElement;

  if (
    e.key === "Enter" &&
    payButton &&
    !payButton.disabled &&
    payButton.textContent.includes("Place Order") &&
    !(activeElement.tagName === "INPUT" || activeElement.tagName === "TEXTAREA")
  ) {
    e.preventDefault();
    console.log("⌨️ Enter key triggered payment");
    payButton.click();
  }
});

// ================== INITIALIZATION ==================
console.log("🚀 PrintQ initialized");
console.log(`   Backend: ${BACKEND_URL}`);
console.log(`   Environment: ${window.location.hostname}`);

renderFileList();
updateCostCalculation();
