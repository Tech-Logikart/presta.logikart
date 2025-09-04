// --- LOGIKART / script.js ---
// Initialisation de la carte
const map = L.map('map').setView([48.8566, 2.3522], 5);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap contributors'
}).addTo(map);

let markers = [];
let editingIndex = null;

// -- Formulaire prestataire
function addProvider() {
  const modal = document.getElementById("providerFormSection");
  if (!modal) return console.error("#providerFormSection introuvable");
  modal.style.display = "flex";
}

function hideForm() {
  const form = document.getElementById("providerForm");
  const modal = document.getElementById("providerFormSection");
  if (form) form.reset();
  if (modal) modal.style.display = "none";
  editingIndex = null;
}

document.getElementById("providerForm")?.addEventListener("submit", handleFormSubmit);

async function handleFormSubmit(event) {
  event.preventDefault();

  const provider = {
    companyName: document.getElementById("companyName").value,
    contactName: document.getElementById("contactName").value,
    firstName: document.getElementById("firstName").value,
    address: document.getElementById("address").value,
    email: document.getElementById("email").value,
    phone: document.getElementById("phone").value,
    rate: document.getElementById("rate").value,
    travelFees: document.getElementById("travelFees").value,
    totalCost: document.getElementById("totalCost").value
  };

  let providers = JSON.parse(localStorage.getItem("providers")) || [];

  try {
    if (editingIndex !== null) {
      const existing = providers[editingIndex];
      const updated = { ...existing, ...provider };
      providers[editingIndex] = updated;

      if (existing?.id) {
        await db.collection("prestataires").doc(existing.id).update(provider);
      } else {
        const docRef = await db.collection("prestataires").add(provider);
        updated.id = docRef.id;
      }
    } else {
      const docRef = await db.collection("prestataires").add(provider);
      provider.id = docRef.id;
      providers.push(provider);
    }

    localStorage.setItem("providers", JSON.stringify(providers));

    // Ajoute le marqueur immédiatement + met à jour la liste
    geocodeAndAddToMap(provider, { pan: true, open: true });
    updateProviderList();
    const list = document.getElementById("providerList");
    if (list) list.style.display = "block";
    hideForm();
  } catch (e) {
    console.error("Erreur Firestore :", e);
    alert("Impossible d’enregistrer sur le serveur. Réessaie plus tard.");
  }
}

// --- UTILITAIRES de géocodage ---
// Essaie Nominatim via proxy puis en direct (avec UA)
async function fetchNominatim(query) {
  const proxyUrl = `https://proxy-logikart.samir-mouheb.workers.dev/?url=${encodeURIComponent('https://nominatim.openstreetmap.org/search?format=json&q=' + query)}`;
  const directUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}`;

  // 1) Proxy
  try {
    const r = await fetch(proxyUrl);
    if (r.ok) {
      const data = await r.json();
      if (Array.isArray(data) && data.length) return data;
    }
  } catch (_) {}

  // 2) Direct
  try {
    const r2 = await fetch(directUrl, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'LOGIKART/1.0 (contact@logikart.app)'
      }
    });
    if (r2.ok) {
      const data2 = await r2.json();
      if (Array.isArray(data2) && data2.length) return data2;
    }
  } catch (_) {}

  return [];
}

// Génère des variantes raisonnables pour améliorer les matches
function buildQueries(addr) {
  const base = (addr || "").trim();
  const withCountry = /france/i.test(base) ? base : `${base}, France`;
  const simple = withCountry.replace(/[;]/g, ' ').replace(/\s{2,}/g, ' ').trim();
  // Déplace "63000 Clermont-Ferrand" -> "Clermont-Ferrand 63000" si besoin
  const moved = simple.replace(/(\d{5})\s+([A-Za-zÀ-ÿ\-']+)/, '$2 $1');
  return [base, withCountry, simple, moved].filter((v, i, a) => v && a.indexOf(v) === i);
}

// -- Affichage sur carte (robuste, avec fallback) --
async function geocodeAndAddToMap(provider, opts = { pan: false, open: false }) {
  if (!provider?.address) return;

  const queries = buildQueries(provider.address);
  let result = null;

  for (const q of queries) {
    const data = await fetchNominatim(q);
    if (data && data.length) { result = data[0]; break; }
  }

  if (!result) {
    console.warn("Géocodage introuvable pour:", provider.address);
    return;
  }

  const lat = parseFloat(result.lat);
  const lon = parseFloat(result.lon);

  const marker = L.marker([lat, lon])
    .addTo(map)
    .bindPopup(
      `<strong>${provider.companyName || ''}</strong><br>${provider.contactName || ''}<br>${provider.email || ''}<br>${provider.phone || ''}`
    );

  markers.push(marker);

  if (opts.pan) {
    map.setView([lat, lon], Math.max(map.getZoom(), 14));
  }
  if (opts.open) {
    marker.openPopup();
  }
}

function clearMarkers() {
  markers.forEach(marker => map.removeLayer(marker));
  markers = [];
}

async function searchNearest() {
  const city = document.getElementById("cityInput").value.trim();
  if (!city) return;

  // utilise le même fallback que ci-dessus
  const cityData = await fetchNominatim(/france/i.test(city) ? city : `${city}, France`);
  if (!cityData.length) {
    alert("Ville non trouvée.");
    return;
  }

  const userLat = parseFloat(cityData[0].lat);
  const userLon = parseFloat(cityData[0].lon);

  const providers = JSON.parse(localStorage.getItem("providers")) || [];

  let nearest = null;
  let minDistance = Infinity;

  for (const provider of providers) {
    const data = await fetchNominatim(provider.address || "");
    if (!data.length) continue;
    const lat = parseFloat(data[0].lat);
    const lon = parseFloat(data[0].lon);
    const distance = Math.sqrt(Math.pow(lat - userLat, 2) + Math.pow(lon - userLon, 2));

    if (distance < minDistance) {
      minDistance = distance;
      nearest = { ...provider, lat, lon };
    }
  }
  
  if (nearest) {
    map.setView([nearest.lat, nearest.lon], 12);
    L.popup()
      .setLatLng([nearest.lat, nearest.lon])
      .setContent(`<strong>${nearest.companyName}</strong><br>${nearest.contactName}<br>${nearest.email}<br>${nearest.phone}`)
      .openOn(map);
  } else {
    alert("Aucun prestataire trouvé.");
  }
}

function loadProvidersFromLocalStorage() {
  clearMarkers();
  const providers = JSON.parse(localStorage.getItem("providers")) || [];
  providers.forEach(provider => {
    geocodeAndAddToMap(provider);
  });
  updateProviderList();
}

function updateProviderList() {
  const container = document.getElementById("providerList");
  if (!container) return;

  container.innerHTML = "";
  const providers = JSON.parse(localStorage.getItem("providers")) || [];

  providers.forEach((p, i) => {
    const div = document.createElement("div");
    div.className = "provider-entry";
    div.innerHTML = `
      <strong>${p.companyName}</strong><br>
      👤 ${p.contactName} ${p.firstName ? `(${p.firstName})` : ""}<br>
      📧 ${p.email}<br>
      📞 ${p.phone}<br>
      💰 Tarif total HT : ${p.totalCost || "N/A"}<br>
      <button onclick="editProvider(${i})">✏️ Modifier</button>
      <button onclick="deleteProvider(${i})">🗑️ Supprimer</button>
      <hr>
    `;
    container.appendChild(div);
  });
}

function editProvider(index) {
  const providers = JSON.parse(localStorage.getItem("providers")) || [];
  const p = providers[index];

  document.getElementById("companyName").value = p.companyName || "";
  document.getElementById("contactName").value = p.contactName || "";
  document.getElementById("address").value = p.address || "";
  document.getElementById("email").value = p.email || "";
  document.getElementById("phone").value = p.phone || "";
  document.getElementById("firstName").value = p.firstName || "";
  document.getElementById("rate").value = p.rate || "";
  document.getElementById("travelFees").value = p.travelFees || "";
  document.getElementById("totalCost").value = p.totalCost || "";

  if (typeof updateTotal === "function") {
    updateTotal();
  }

  editingIndex = index;
  addProvider();
}

// --- Firestore temps réel
function startRealtimeSync() {
  if (!window.db) return console.error("Firestore non initialisé");
  db.collection("prestataires").onSnapshot((snap) => {
    const providers = [];
    snap.forEach(doc => providers.push({ id: doc.id, ...doc.data() }));
    localStorage.setItem("providers", JSON.stringify(providers));
    clearMarkers();
    providers.forEach(geocodeAndAddToMap);
    updateProviderList();
  }, (err) => {
    console.error("onSnapshot error:", err);
  });
}

// --- Force un rechargement complet depuis Firestore (après import) ---
async function refreshProvidersFromServer() {
  try {
    const snap = await db.collection("prestataires").get();
    const providers = [];
    snap.forEach(doc => providers.push({ id: doc.id, ...doc.data() }));
    localStorage.setItem("providers", JSON.stringify(providers));
    clearMarkers();
    providers.forEach(geocodeAndAddToMap);
    updateProviderList();
  } catch (e) {
    console.error("refreshProvidersFromServer error:", e);
  }
}

// --- EXPORT JSON / CSV ---
function exportProviders(format = "json") {
  const providers = JSON.parse(localStorage.getItem("providers")) || [];
  if (!providers.length) {
    alert("Aucun prestataire à exporter.");
    return;
  }

  const headers = ["id","companyName","contactName","firstName","address","email","phone","rate","travelFees","totalCost"];

  if (format === "json") {
    const blob = new Blob([JSON.stringify(providers, null, 2)], { type: "application/json" });
    triggerDownload(blob, "prestataires.json");
    return;
  }

  if (format === "csv") {
    const escape = (v) => {
      if (v === null || v === undefined) return "";
      v = String(v);
      return /[",\n\r;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    };

    const rows = [headers.join(",")];
    for (const p of providers) {
      const row = headers.map(h => escape(p[h] ?? ""));
      rows.push(row.join(","));
    }
    const csv = rows.join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    triggerDownload(blob, "prestataires.csv");
    return;
  }

  alert("Format non supporté.");
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// --- IMPORT JSON / CSV ---
function openImportModal() {
  const modal = document.getElementById("importModal");
  if (modal) modal.style.display = "flex";
}
function closeImportModal() {
  const modal = document.getElementById("importModal");
  if (modal) modal.style.display = "none";
  const input = document.getElementById("importFile");
  if (input) input.value = "";
}

function normalizeProvider(obj) {
  const norm = (s) => (s ?? "").toString().trim();
  const num = (s) => {
    if (s === null || s === undefined || s === "") return "";
    const n = parseFloat(String(s).replace(",", "."));
    return isNaN(n) ? "" : n.toFixed(2);
  };

  const p = {
    companyName: norm(obj.companyName ?? obj.raisonSociale),
    contactName: norm(obj.contactName ?? obj.nom),
    firstName: norm(obj.firstName ?? obj.prenom),
    address: norm(obj.address ?? obj.adresse),
    email: norm(obj.email),
    phone: norm(obj.phone ?? obj.telephone),
    rate: norm(obj.rate ?? obj.tarifHeureHT),
    travelFees: norm(obj.travelFees ?? obj.fraisDeplacementHT),
    totalCost: norm(obj.totalCost ?? obj.tarifTotalHT),
  };

  if (!p.totalCost) {
    const r = parseFloat(num(p.rate)) || 0;
    const t = parseFloat(num(p.travelFees)) || 0;
    if (r + t > 0) p.totalCost = (r + t).toFixed(2) + " €";
  }

  return p;
}

function detectDelimiter(headerLine) {
  const comma = (headerLine.match(/,/g) || []).length;
  const semi = (headerLine.match(/;/g) || []).length;
  return semi > comma ? ";" : ",";
}

function parseCSVToObjects(text) {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter(l => l.length);
  if (!lines.length) return [];
  const delimiter = detectDelimiter(lines[0]);

  function parseLine(line) {
    const out = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = !inQuotes;
      } else if (ch === delimiter && !inQuotes) {
        out.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out;
  }

  const headersRaw = parseLine(lines[0]).map(h => h.trim());

  const normalizeKey = (k) => k
    .toLowerCase()
    .normalize("NFD").replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9]/g, "");

  const headerMap = {};
  headersRaw.forEach((h, i) => {
    const n = normalizeKey(h);
    if (n.includes("raisonsociale") || n === "companyname") headerMap[i] = "companyName";
    else if (n === "nom" || n === "contactname") headerMap[i] = "contactName";
    else if (n === "prenom" || n === "firstname") headerMap[i] = "firstName";
    else if (n.includes("adresse") || n === "address") headerMap[i] = "address";
    else if (n.includes("email")) headerMap[i] = "email";
    else if (n.includes("telephone") || n === "phone") headerMap[i] = "phone";
    else if (n.includes("tarifheure") || n === "rate") headerMap[i] = "rate";
    else if (n.includes("fraisdeplacement") || n === "travelfees") headerMap[i] = "travelFees";
    else if (n.includes("tariftotal") || n === "totalcost") headerMap[i] = "totalCost";
    else if (n === "id") headerMap[i] = "id";
  });

  const rows = [];
  for (let li = 1; li < lines.length; li++) {
    const cols = parseLine(lines[li]);
    if (cols.length === 1 && cols[0].trim() === "") continue;
    const obj = {};
    cols.forEach((val, i) => {
      const key = headerMap[i];
      if (key) obj[key] = val.trim();
    });
    rows.push(obj);
  }
  return rows;
}

async function handleImport() {
  const input = document.getElementById("importFile");
  if (!input?.files?.length) {
    alert("Choisis un fichier à importer.");
    return;
  }
  const file = input.files[0];
  const text = await file.text();

  let incoming = [];
  if (file.name.toLowerCase().endsWith(".json")) {
    try {
      const data = JSON.parse(text);
      if (Array.isArray(data)) incoming = data;
      else if (data && typeof data === "object") incoming = [data];
    } catch (e) {
      console.error(e);
      alert("JSON invalide.");
      return;
    }
  } else {
    incoming = parseCSVToObjects(text);
  }

  if (!incoming.length) {
    alert("Aucune donnée détectée.");
    return;
  }

  const skipDuplicates = document.getElementById("skipDuplicates")?.checked ?? true;
  const existing = JSON.parse(localStorage.getItem("providers")) || [];
  const keyOf = (p) => (String(p.email || "").toLowerCase() + "|" + String(p.phone || ""));

  const byKey = new Map(existing.map(p => [keyOf(p), p]));
  const results = { added: 0, updated: 0, skipped: 0, errors: 0 };

  for (const raw of incoming) {
    const p = normalizeProvider(raw);

    if (!p.companyName && !p.contactName && !p.email) {
      results.skipped++;
      continue;
    }

    const existingMatch = byKey.get(keyOf(p));
    try {
      if (existingMatch && skipDuplicates) {
        results.skipped++;
      } else if (existingMatch?.id) {
        await db.collection("prestataires").doc(existingMatch.id).update(p);
        results.updated++;
      } else if (raw.id) {
        try {
          await db.collection("prestataires").doc(raw.id).set(p, { merge: true });
          results.added++;
        } catch {
          const docRef = await db.collection("prestataires").add(p);
          void docRef;
          results.added++;
        }
      } else {
        const docRef = await db.collection("prestataires").add(p);
        void docRef;
        results.added++;
      }
    } catch (e) {
      console.error("Import error:", e);
      results.errors++;
    }
  }

  // Force le rafraîchissement pour afficher les marqueurs tout de suite
  await refreshProvidersFromServer();

  alert(`Import terminé :
- ${results.added} ajoutés
- ${results.updated} mis à jour
- ${results.skipped} ignorés
- ${results.errors} erreurs`);

  closeImportModal();
}

// --- Menu / init
document.addEventListener("DOMContentLoaded", () => {
  loadProvidersFromLocalStorage();
  startRealtimeSync();

  const burger = document.getElementById("burgerMenu");
  const dropdown = document.getElementById("menuDropdown");

  burger?.addEventListener("click", (e) => {
    e.stopPropagation();
    dropdown?.classList.toggle("hidden");
  });

  document.addEventListener("click", () => {
    dropdown?.classList.add("hidden");
  });
});

function toggleProviderList() {
  const list = document.getElementById("providerList");
  if (!list) return;
  list.style.display = list.style.display === "none" ? "block" : "none";
}

// --- Rapport d’intervention ---
function openReportForm() {
  const modal = document.getElementById("reportModal");
  if (!modal) return;
  modal.style.display = "flex";

  const form = document.getElementById("reportForm");
  const get = id => form.querySelector(`[name="${id}"]`) || form.querySelector(`#${id}`);

  const values = {
    ticket: get("ticket")?.value || "",
    date: get("interventionDate")?.value || "",
    site: get("siteAddress")?.value || "",
    tech: get("technician")?.value || "",
    todo: get("todo")?.value || "",
    done: get("done")?.value || "",
    start: get("start")?.value || "",
    end: get("end")?.value || "",
    signTech: get("signTech")?.value || "",
    signClient: get("signClient")?.value || ""
  };

  const reportContent = document.getElementById("reportContent");
  if (reportContent) {
    reportContent.innerHTML = `
      <div style="font-family: Arial, sans-serif; padding: 20px; color: #000;">
        <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #004080; padding-bottom: 10px;">
          <img src="logikart-logo.png" alt="LOGIKART" style="height: 50px;">
          <h2 style="text-align: center; flex-grow: 1; color: #004080;">Rapport d’intervention</h2>
          <div style="text-align: right; font-size: 12px;">${values.date}</div>
        </div>

        <div style="margin-top: 20px;">
          <p><strong>Ticket :</strong> ${values.ticket}</p>
          <p><strong>Adresse du site :</strong> ${values.site}</p>
          <p><strong>Nom du technicien :</strong> ${values.tech}</p>
        </div>

        <div style="margin-top: 20px;">
          <h4>Travail à faire</h4>
          <div style="border: 1px solid #ccc; padding: 10px; min-height: 60px;">${values.todo}</div>
        </div>

        <div style="margin-top: 20px;">
          <h4>Travail effectué</h4>
          <div style="border: 1px solid #ccc; padding: 10px; min-height: 80px;">${values.done}</div>
        </div>

        <div style="margin-top: 20px;">
          <p><strong>Heure d’arrivée :</strong> ${values.start}</p>
          <p><strong>Heure de départ :</strong> ${values.end}</p>
        </div>

        <div style="margin-top: 20px;">
          <p><strong>Signature du technicien :</strong> ${values.signTech}</p>
          <p><strong>Signature du client :</strong> ${values.signClient}</p>
        </div>
      </div>
    `;
  }

  populateTechnicianSuggestions();
}

function closeReportForm() {
  const modal = document.getElementById("reportModal");
  if (modal) modal.style.display = "none";
}

function generatePDF() {
  const form = document.getElementById("reportForm");
  const get = id => form.querySelector(`[name="${id}"]`);

  const values = {
    ticket: get("ticket").value,
    date: get("interventionDate").value,
    site: get("siteAddress").value,
    tech: get("technician").value,
    todo: get("todo").value,
    done: get("done").value,
    start: get("start").value,
    end: get("end").value,
    signTech: get("signTech").value,
    signClient: get("signClient").value
  };

  const reportContent = document.getElementById("reportContent");

  reportContent.innerHTML = `
    <div style="font-family: Arial, sans-serif; padding: 20px; color: #000;">
      <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #004080; padding-bottom: 10px;">
        <img src="logikart-logo.png" alt="LOGIKART" style="height: 50px;">
        <h2 style="text-align: center; flex-grow: 1; color: #004080;">Rapport d’intervention</h2>
        <div style="text-align: right; font-size: 12px;">${values.date}</div>
      </div>

      <div style="margin-top: 20px;">
        <p><strong>Ticket :</strong> ${values.ticket}</p>
        <p><strong>Adresse du site :</strong> ${values.site}</p>
        <p><strong>Nom du technicien :</strong> ${values.tech}</p>
      </div>

      <div style="margin-top: 20px;">
        <h4>Travail à faire</h4>
        <div style="border: 1px solid #ccc; padding: 10px; min-height: 60px;">${values.todo}</div>
      </div>

      <div style="margin-top: 20px;">
        <h4>Travail effectué</h4>
        <div style="border: 1px solid #ccc; padding: 10px; min-height: 80px;">${values.done}</div>
      </div>

      <div style="margin-top: 20px;">
        <p><strong>Heure d’arrivée :</strong> ${values.start}</p>
        <p><strong>Heure de départ :</strong> ${values.end}</p>
      </div>
      
      <div style="margin-top: 20px; display: flex; justify-content: space-between;">
        <div style="width: 48%;">
          <p><strong>Signature du technicien :</strong></p>
          <div style="border: 1px solid #ccc; height: 60px;"></div>
          <p style="text-align: center; margin-top: 5px;">${values.signTech}</p>
        </div>

        <div style="width: 48%;">
          <p><strong>Signature du client :</strong></p>
          <div style="border: 1px solid #ccc; height: 60px;"></div>
          <p style="text-align: center; margin-top: 5px;">${values.signClient}</p>
        </div>
      </div>
    </div>
  `;

  reportContent.style.display = "block";

  const opt = {
    margin: 0.5,
    filename: 'rapport_intervention_LOGIKART.pdf',
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2 },
    jsPDF: { unit: 'in', format: 'a4', orientation: 'portrait' }
  };

  html2pdf().set(opt).from(reportContent).save().then(() => {
    reportContent.style.display = "none";
    form.reset();
    closeReportForm();
  });
}

function populateTechnicianSuggestions() {
  const datalist = document.getElementById("technicianList");
  if (!datalist) return;

  datalist.innerHTML = "";
  const providers = JSON.parse(localStorage.getItem("providers")) || [];

  providers.forEach(p => {
    const option = document.createElement("option");
    option.value = `${p.firstName || ""} ${p.contactName || ""}`.trim();
    datalist.appendChild(option);
  });
}

// --- Itinéraire ---
function openItineraryTool() {
  const modal = document.getElementById("itineraryModal");
  if (!modal) return;
  modal.style.display = "flex";
  document.getElementById("routeResult").innerHTML = "";
}

function closeItineraryModal() {
  const modal = document.getElementById("itineraryModal");
  if (!modal) return;
  modal.style.display = "none";
  document.getElementById("itineraryForm").reset();
  document.getElementById("extraDestinations").innerHTML = "";
}

function addDestinationField() {
  const container = document.getElementById("extraDestinations");
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Destination supplémentaire";
  input.classList.add("extra-destination");
  container.appendChild(input);
}

async function calculateRoute() {
  const start = document.getElementById("startAddress").value.trim();
  const end = document.getElementById("endAddress").value.trim();
  const extras = Array.from(document.getElementsByClassName("extra-destination")).map(input => input.value.trim()).filter(Boolean);

  const points = [start, ...extras, end];

  // Convertir adresses → coordonnées via Nominatim
  const coords = [];
  for (const address of points) {
    const data = await fetchNominatim(address);
    if (!data.length) {
      alert(`Adresse non trouvée : ${address}`);
      return;
    }
    coords.push([parseFloat(data[0].lon), parseFloat(data[0].lat)]); // ORS = [lon, lat]
  }

  // Appel à OpenRouteService
  const orsRes = await fetch('https://api.openrouteservice.org/v2/directions/driving-car/geojson', {
    method: 'POST',
    headers: {
      'Authorization': 'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6ImQ4YTg5NTg4NjE0OTQ5NjZhMDY3YzgxZjJjOGE3ODI3IiwiaCI6Im11cm11cjY0In0=',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      coordinates: coords,
      language: "fr",
      instructions: true
    })
  });

  if (!orsRes.ok) {
    alert("Erreur lors du calcul d’itinéraire.");
    return;
  }

  const geojson = await orsRes.json();
  // Instructions
  window.lastRouteInstructions = geojson.features[0].properties.segments[0].steps.map((step, i) => {
    return `${i + 1}. ${step.instruction} (${(step.distance / 1000).toFixed(2)} km)`;
  });

  // Affiche le trajet
  if (window.routeLine) map.removeLayer(window.routeLine);
  window.routeLine = L.geoJSON(geojson, { style: { color: "blue", weight: 4 } }).addTo(map);
  map.fitBounds(window.routeLine.getBounds());

  const summary = geojson.features[0].properties.summary;
  const distanceKm = (summary.distance / 1000).toFixed(2);
  const durationMin = Math.round(summary.duration / 60);

  document.getElementById("routeResult").innerHTML = `
    <p>📏 Distance totale : <strong>${distanceKm} km</strong></p>
    <p>⏱️ Durée estimée : <strong>${durationMin} minutes</strong></p>
  `;
  document.getElementById("exportPdfBtn").style.display = "inline-block";
}

function exportItineraryToPDF() {
  const start = document.getElementById("startAddress").value.trim();
  const end = document.getElementById("endAddress").value.trim();
  const extras = Array.from(document.getElementsByClassName("extra-destination"))
    .map(input => input.value.trim()).filter(Boolean);
  const distanceText = document.querySelector("#routeResult").innerText;

  leafletImage(map, function (err, canvas) {
    if (err) {
      alert("Erreur lors du rendu de la carte.");
      return;
    }

    const mapImage = canvas.toDataURL("image/jpeg");

    const container = document.createElement("div");
    container.style.padding = "20px";
    container.style.fontFamily = "Arial";

    container.innerHTML = `
      <h2 style="color:#004080;">🧭 Itinéraire LOGIKART</h2>
      <p><strong>Départ :</strong> ${start}</p>
      ${extras.map((dest, i) => `<p><strong>Étape ${i + 1} :</strong> ${dest}</p>`).join("")}
      <p><strong>Arrivée :</strong> ${end}</p>
      <p style="margin-top:10px;">${distanceText.replace(/\n/g, "<br>")}</p>
    `;

    if (window.lastRouteInstructions && window.lastRouteInstructions.length) {
      const instructionsHtml = window.lastRouteInstructions.map(i => `<li>${i}</li>`).join("");
      container.innerHTML += `
        <p><strong>🧭 Instructions pas à pas :</strong></p>
        <ol>${instructionsHtml}</ol>
      `;
    }

    container.innerHTML += `
      <hr>
      <p><strong>Carte de l’itinéraire :</strong></p>
      <img src="${mapImage}" style="width:100%; max-height:500px; margin-top:10px;" />
    `;

    html2pdf().set({
      margin: 0.5,
      filename: 'itineraire_LOGIKART.pdf',
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2 },
      jsPDF: { unit: 'in', format: 'a4', orientation: 'portrait' }
    }).from(container).save();
  });
}

// --- Exposer au scope global ---
window.searchNearest = searchNearest;
window.addProvider = addProvider;
window.hideForm = hideForm;
window.toggleProviderList = toggleProviderList;
window.openItineraryTool = openItineraryTool;
window.closeItineraryModal = closeItineraryModal;
window.addDestinationField = addDestinationField;
window.calculateRoute = calculateRoute;
window.exportItineraryToPDF = exportItineraryToPDF;
window.openReportForm = openReportForm;
window.closeReportForm = closeReportForm;
window.generatePDF = generatePDF;
window.editProvider = editProvider;
window.deleteProvider = async function(index) {
  const providers = JSON.parse(localStorage.getItem("providers")) || [];
  if (!confirm("Confirmer la suppression ?")) return;
  const toDelete = providers[index];
  try {
    if (toDelete?.id) {
      await db.collection("prestataires").doc(toDelete.id).delete();
    }
  } catch (e) {
    console.error("Erreur suppression Firestore :", e);
    alert("Suppression côté serveur impossible.");
  }
};
window.exportProviders = exportProviders;
window.openImportModal = openImportModal;
window.closeImportModal = closeImportModal;
window.handleImport = handleImport;
window.refreshProvidersFromServer = refreshProvidersFromServer;
window.geocodeAndAddToMap = geocodeAndAddToMap;
