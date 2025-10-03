// --- Utils ---
function debounce(fn, delay = 120) {
  let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delay); };
}

// --- Map (Leaflet) ---
let map, markerLayer, markerIndex = new Map();
function initMap(){
  map = L.map('map').setView([54, 15], 4);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors'
  }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
}
function markerKey(p){ return p.id || (String(p.email||'').toLowerCase()+'|'+String(p.phone||'')); }
function createMarker(p){
  const m = L.marker([p.lat, p.lon]).bindPopup(
    `<strong>${p.companyName||""}</strong><br>${p.contactName||""}<br>${p.email||""}<br>${p.phone||""}<br><em>${p.address||""}</em>`
  );
  markerLayer.addLayer(m);
  markerIndex.set(markerKey(p), { marker:m, data:p });
  return m;
}
function upsertMarker(p){
  const key = markerKey(p); const ex = markerIndex.get(key);
  if (ex){ markerLayer.removeLayer(ex.marker); markerIndex.delete(key); }
  return createMarker(p);
}
function removeMarkerByKey(key){
  const entry = markerIndex.get(key); if (entry){ markerLayer.removeLayer(entry.marker); markerIndex.delete(key); }
}
function clearMarkers(){ markerLayer.clearLayers(); markerIndex.clear(); }
function fitMapToAllMarkers(){
  const layers = markerLayer.getLayers();
  if (layers.length){
    const group = L.featureGroup(layers); map.fitBounds(group.getBounds().pad(0.1));
  } else { map.setView([54, 15], 4); }
}

// --- Local storage data model ---
const LS_KEY = "providers";
const keyOf = (p) => (String(p.email || "").toLowerCase() + "|" + String(p.phone || ""));

// --- Simple sync layer (offline-first) ---
const fireSync = {
  online:false,
  async boot(){ /* offline simple */ },

  async pullAll(){
    const list = JSON.parse(localStorage.getItem(LS_KEY)||"[]");
    clearMarkers();
    list.filter(p=>p.lat!=null && p.lon!=null).forEach(p=> upsertMarker(p));
    fitMapToAllMarkers();
    updateProviderList();
  },

  async upsert(p){
    const list = JSON.parse(localStorage.getItem(LS_KEY)||"[]");
    // upsert by id or keyOf
    let idx = p.id ? list.findIndex(x=>x.id===p.id) : -1;
    if (idx===-1){ idx = list.findIndex(x=> keyOf(x)===keyOf(p)); }
    if (idx>=0){ list[idx] = {...list[idx], ...p}; } else { p.id = p.id || cryptoRandomId(); list.push(p); }
    localStorage.setItem(LS_KEY, JSON.stringify(list));
    return list[idx>=0?idx:list.length-1];
  },

  async remove(p){
    const list = JSON.parse(localStorage.getItem(LS_KEY)||"[]");
    const newList = list.filter(x => (p.id ? x.id !== p.id : keyOf(x) !== keyOf(p)));
    localStorage.setItem(LS_KEY, JSON.stringify(newList));
  }
};
function cryptoRandomId(){ return 'id_'+Math.random().toString(36).slice(2)+Date.now().toString(36); }

// --- Geocoding (Nominatim) with light normalization ---
function normalizeIntlAddress(raw){
  if (!raw) return "";
  let s = String(raw).trim();
  s = s.replace(/\bItalie\b/i, "Italy").replace(/\bItalia\b/i, "Italy").replace(/\bMilano\b/i, "Milan");
  s = s.replace(/\bTchéquie\b/i, "Czechia").replace(/\bRépublique tchèque\b/i, "Czechia").replace(/\bPraha\b/i, "Prague");
  s = s.replace(/\bEspagne\b/i, "Spain").replace(/\bValència\b/i, "Valencia");
  s = s.replace(/\bRoyaume-Uni\b/i, "United Kingdom").replace(/\bAngleterre\b/i, "England");
  s = s.replace(/\s{2,}/g, " ").trim();
  return s;
}
async function fetchNominatim(query){
  const q = normalizeIntlAddress(query||"");
  if (!q) return [];
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=1&accept-language=fr,it,en&q=' + encodeURIComponent(q);
  const res = await fetch(url, {headers:{'Accept':'application/json','User-Agent':'LOGIKART/1.0'}});
  if (!res.ok) return [];
  return await res.json();
}

// --- Provider form / list ---
let editingIndex = null;

function openProviderForm(){
  const modal = document.getElementById("providerFormSection");
  if (modal) modal.style.display = "flex";
}
function addProvider(){ openProviderForm(); } // alias pour compat

function hideForm(){
  const form = document.getElementById("providerForm");
  const modal = document.getElementById("providerFormSection");
  if (form) form.reset();
  if (modal) modal.style.display = "none";
  editingIndex = null;
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("providerForm")?.addEventListener("submit", handleFormSubmit);
});

async function handleFormSubmit(e){
  e.preventDefault();
  const provider = {
    companyName: document.getElementById("companyName").value,
    contactName: document.getElementById("contactName").value,
    firstName:   document.getElementById("firstName").value,
    address:     document.getElementById("address").value,
    email:       document.getElementById("email").value,
    phone:       document.getElementById("phone").value,
    rate:        document.getElementById("rate").value,
    travelFees:  document.getElementById("travelFees").value,
    totalCost:   document.getElementById("totalCost").value
  };

  // Geocode if missing coords
  if (provider.address){
    const data = await fetchNominatim(provider.address + (/(France|Spain|Italy|Czechia|United Kingdom|England)/i.test(provider.address)?'':', France'));
    if (data && data.length){
      provider.lat = parseFloat(data[0].lat);
      provider.lon = parseFloat(data[0].lon);
    }
  }

  const saved = await fireSync.upsert(provider);
  if (saved.lat!=null && saved.lon!=null) upsertMarker(saved);
  updateProviderList();
  fitMapToAllMarkers();
  hideForm();
}

function updateProviderListNow(){
  const container = document.getElementById("providerList");
  if (!container) return;
  const providers = JSON.parse(localStorage.getItem(LS_KEY)||"[]");
  container.innerHTML = "";
  providers.forEach((p,i)=>{
    const div = document.createElement("div");
    div.className = "provider-entry";
    div.innerHTML = `
      <strong>${p.companyName || '—'}</strong><br>
      👤 ${p.contactName || '—'} ${p.firstName?`(${p.firstName})`:""}<br>
      📧 ${p.email || '—'}<br>
      📞 ${p.phone || '—'}<br>
      <em>${p.address || ''}</em><br>
      <div style="display:flex; gap:8px; margin-top:6px;">
        <button onclick="editProvider(${i})">✏️ Modifier</button>
        <button onclick="deleteProvider(${i})">🗑️ Supprimer</button>
      </div>
    `;
    container.appendChild(div);
  });
}
const updateProviderList = debounce(updateProviderListNow, 120);

function editProvider(index){
  const providers = JSON.parse(localStorage.getItem(LS_KEY)||"[]");
  const p = providers[index];
  if (!p) return;

  document.getElementById("companyName").value = p.companyName || "";
  document.getElementById("contactName").value = p.contactName || "";
  document.getElementById("firstName").value  = p.firstName || "";
  document.getElementById("address").value    = p.address  || "";
  document.getElementById("email").value      = p.email    || "";
  document.getElementById("phone").value      = p.phone    || "";
  document.getElementById("rate").value       = p.rate     || "";
  document.getElementById("travelFees").value = p.travelFees || "";
  document.getElementById("totalCost").value  = p.totalCost || "";

  editingIndex = index;
  openProviderForm();
}

async function deleteProvider(index){
  const providers = JSON.parse(localStorage.getItem(LS_KEY)||"[]");
  const p = providers[index]; if (!p) return;
  if (!confirm("Confirmer la suppression ?")) return;
  await fireSync.remove(p);
  removeMarkerByKey(markerKey(p));
  updateProviderList();
}

// --- Import / Export ---
function exportProviders(format="json"){
  const providers = JSON.parse(localStorage.getItem(LS_KEY)||"[]");
  if (!providers.length){ alert("Aucun prestataire à exporter."); return; }
  const headers = ["id","companyName","contactName","firstName","address","email","phone","rate","travelFees","totalCost","lat","lon"];

  if (format==="json"){
    const blob = new Blob([JSON.stringify(providers,null,2)], {type:"application/json"});
    triggerDownload(blob, "prestataires.json"); return;
  }
  if (format==="csv"){
    const escape = (v) => {
      if (v===null || v===undefined) return "";
      v = String(v);
      return /[",\n\r;]/.test(v) ? `"${v.replace(/"/g,'""')}"` : v;
    };
    const rows = [headers.join(",")];
    for (const p of providers) rows.push(headers.map(h=>escape(p[h]??"")).join(","));
    const csv = rows.join("\r\n");
    triggerDownload(new Blob([csv],{type:"text/csv;charset=utf-8"}), "prestataires.csv"); return;
  }
  alert("Format non supporté.");
}
function triggerDownload(blob, filename){
  const url = URL.createObjectURL(blob); const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 5000);
}

function openImportModal(){ const m=document.getElementById("importModal"); if (m) m.style.display="flex"; }
function closeImportModal(){ const m=document.getElementById("importModal"); if (m) m.style.display="none"; const i=document.getElementById("importFile"); if (i) i.value=""; }

function detectDelimiter(headerLine){
  const comma = (headerLine.match(/,/g)||[]).length;
  const semi  = (headerLine.match(/;/g)||[]).length;
  return semi > comma ? ";" : ",";
}
function parseCSVToObjects(text){
  const lines = text.replace(/\r\n/g,"\n").replace(/\r/g,"\n").split("\n").filter(l=>l.length);
  if (!lines.length) return [];
  const delimiter = detectDelimiter(lines[0]);

  function parseLine(line){
    const out=[]; let cur=""; let inQuotes=false;
    for (let i=0;i<line.length;i++){
      const ch=line[i];
      if (ch === '"'){
        if (inQuotes && line[i+1] === '"'){ cur+='"'; i++; }
        else inQuotes = !inQuotes;
      } else if (ch === delimiter && !inQuotes){ out.push(cur); cur=""; }
      else { cur += ch; }
    }
    out.push(cur); return out;
  }

  const headersRaw = parseLine(lines[0]).map(h=>h.trim());
  const normalizeKey = (k) => k.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/\s+/g,"").replace(/[^a-z0-9]/g,"");

  const headerMap = {};
  headersRaw.forEach((h,i)=>{
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
    else if (n === "lat" || n === "latitude") headerMap[i] = "lat";
    else if (n === "lon" || n === "lng" || n === "longitude") headerMap[i] = "lon";
  });

  const rows=[];
  for (let li=1; li<lines.length; li++){
    const cols = parseLine(lines[li]); if (cols.length===1 && cols[0].trim()==="") continue;
    const obj = {};
    cols.forEach((val,i)=>{ const key = headerMap[i]; if (key) obj[key] = val.trim(); });
    rows.push(obj);
  }
  return rows;
}

async function handleImport(){
  const input = document.getElementById("importFile");
  if (!input?.files?.length){ alert("Choisis un fichier à importer."); return; }
  const file = input.files[0]; const text = await file.text();

  let incoming=[];
  if (file.name.toLowerCase().endsWith(".json")){
    try { const data = JSON.parse(text); incoming = Array.isArray(data) ? data : [data]; }
    catch(e){ console.error(e); alert("JSON invalide."); return; }
  } else { incoming = parseCSVToObjects(text); }

  if (!incoming.length){ alert("Aucune donnée détectée."); return; }

  const skipDuplicates = document.getElementById("skipDuplicates")?.checked ?? true;
  const existing = JSON.parse(localStorage.getItem(LS_KEY)||"[]");
  const byKey = new Map(existing.map(p=>[keyOf(p), p]));
  const results = { added:0, updated:0, skipped:0, errors:0 };

  for (const raw of incoming){
    const p = {
      companyName: raw.companyName ?? raw.raisonSociale ?? "",
      contactName: raw.contactName ?? raw.nom ?? "",
      firstName:   raw.firstName   ?? raw.prenom ?? "",
      address:     raw.address     ?? raw.adresse ?? "",
      email:       raw.email ?? "",
      phone:       raw.phone ?? raw.telephone ?? "",
      rate:        raw.rate ?? raw.tarifHeureHT ?? "",
      travelFees:  raw.travelFees ?? raw.fraisDeplacementHT ?? "",
      totalCost:   raw.totalCost ?? raw.tarifTotalHT ?? "",
      id:          raw.id,
      lat:         raw.lat !== undefined ? parseFloat(raw.lat) : undefined,
      lon:         raw.lon !== undefined ? parseFloat(raw.lon) : undefined
    };
    if (!p.totalCost){
      const r = parseFloat(String(p.rate).replace(",", ".")) || 0;
      const t = parseFloat(String(p.travelFees).replace(",", ".")) || 0;
      if (r+t>0) p.totalCost = (r+t).toFixed(2) + " €";
    }

    const match = byKey.get(keyOf(p));
    try{
      if (match && skipDuplicates){ results.skipped++; }
      else {
        const merged = match ? {...match, ...p, id:match.id} : p;
        const saved = await fireSync.upsert(merged);
        if (match) results.updated++; else results.added++;
        byKey.set(keyOf(saved), saved);
      }
    } catch(e){ console.error("Import error:", e); results.errors++; }
  }

  await fireSync.pullAll();
  updateProviderListNow();

  alert(`Import terminé :
- ${results.added} ajoutés
- ${results.updated} mis à jour
- ${results.skipped} ignorés
- ${results.errors} erreurs`);
  closeImportModal();
}

// --- Recherche du prestataire le plus proche ---
async function searchNearest(){
  const city = document.getElementById("cityInput").value.trim();
  if (!city) return;
  const cityData = await fetchNominatim(/(France|Spain|Italy|Czechia|United Kingdom|England)/i.test(city) ? city : `${city}, France`);
  if (!cityData.length){ alert("Ville non trouvée."); return; }
  const userLat = parseFloat(cityData[0].lat), userLon = parseFloat(cityData[0].lon);

  const providers = JSON.parse(localStorage.getItem(LS_KEY)||"[]");
  let nearest=null; let minDist=Infinity;

  for (const p of providers){
    let lat=p.lat, lon=p.lon;
    if (lat==null || lon==null){
      const data = await fetchNominatim(p.address || "");
      if (!data.length) continue;
      lat = parseFloat(data[0].lat); lon = parseFloat(data[0].lon);
    }
    const d = Math.hypot(lat - userLat, lon - userLon);
    if (d < minDist){ minDist=d; nearest={...p, lat, lon}; }
  }

  if (nearest){
    map.setView([nearest.lat, nearest.lon], 12);
    L.popup().setLatLng([nearest.lat, nearest.lon]).setContent(
      `<strong>${nearest.companyName||'—'}</strong><br>${nearest.contactName||'—'}<br>${nearest.email||'—'}<br>${nearest.phone||'—'}`
    ).openOn(map);
  } else { alert("Aucun prestataire trouvé."); }
}

// --- Itinéraire (version simple) ---
function openItineraryTool(){ const m=document.getElementById("itineraryModal"); if (m) m.style.display="flex"; }
function closeItineraryModal(){ const m=document.getElementById("itineraryModal"); if (m) m.style.display="none"; document.getElementById("itineraryForm").reset(); document.getElementById("extraDestinations").innerHTML=""; }
function addDestinationField(){
  const i=document.createElement("input"); i.type="text"; i.placeholder="Étape intermédiaire"; i.classList.add("extra-destination");
  document.getElementById("extraDestinations").appendChild(i);
}
async function calculateRoute(){
  // Démo simple pour l’instant
  document.getElementById("routeResult").innerText = "Itinéraire calculé (simulation).";
  document.getElementById("exportPdfBtn").style.display = "inline-block";
}
function exportItineraryToPDF(){
  const start = document.getElementById("startAddress").value.trim();
  const end = document.getElementById("endAddress").value.trim();
  const extras = Array.from(document.getElementsByClassName("extra-destination")).map(i => i.value.trim()).filter(Boolean);
  const distanceText = document.querySelector("#routeResult").innerText;

  const container = document.createElement("div");
  container.style.padding = "20px";
  container.style.fontFamily = "Arial";
  container.innerHTML = `
    <h2 style="color:#004080;">🧭 Itinéraire LOGIKART</h2>
    <p><strong>Départ :</strong> ${start}</p>
    ${extras.map((dest, i) => `<p><strong>Étape ${i + 1} :</strong> ${dest}</p>`).join("")}
    <p><strong>Arrivée :</strong> ${end}</p>
    <p style="margin-top:10px;">${distanceText}</p>
  `;
  const w = window.open("", "_blank");
  w.document.open();
  w.document.write(`<html><head><meta charset="utf-8"><title>Itinéraire</title></head><body>${container.outerHTML}</body></html>`);
  w.document.close();
  w.focus();
  w.print();
}

// --- Rapport d’intervention ---
function buildReportHTML(values){
  return `
  <div style="font-family:Arial,sans-serif; padding:20px; color:#000;">
    <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:2px solid #004080; padding-bottom:10px;">
      <img src="logikart-logo.png" alt="LOGIKART" style="height:50px;">
      <h2 style="text-align:center; flex-grow:1; color:#004080;">Rapport d’intervention</h2>
      <div style="text-align:right; font-size:12px;">${values.date || ""}</div>
    </div>

    <div style="margin-top:20px;">
      <p><strong>Ticket :</strong> ${values.ticket || ""}</p>
      <p><strong>Adresse du site :</strong> ${values.site || ""}</p>
      <p><strong>Nom du technicien :</strong> ${values.tech || ""}</p>
    </div>

    <div style="margin-top:20px;">
      <h4>Travail à faire</h4>
      <div style="border:1px solid #ccc; padding:10px; min-height:60px;">${values.todo || ""}</div>
    </div>

    <div style="margin-top:20px;">
      <h4>Travail effectué</h4>
      <div style="border:1px solid #ccc; padding:10px; min-height:80px;">${values.done || ""}</div>
    </div>

    <div style="margin-top:20px;">
      <p><strong>Heure d’arrivée :</strong> ${values.start || ""}</p>
      <p><strong>Heure de départ :</strong> ${values.end || ""}</p>
    </div>

    <div style="margin-top:20px; display:flex; justify-content:space-between; gap:16px;">
      <div style="flex:1;">
        <p><strong>Signature du technicien :</strong></p>
        <div style="border:1px solid #ccc; height:60px;"></div>
        <p style="text-align:center; margin-top:5px;">${values.signTech || ""}</p>
      </div>
      <div style="flex:1;">
        <p><strong>Signature du client :</strong></p>
        <div style="border:1px solid #ccc; height:60px;"></div>
        <p style="text-align:center; margin-top:5px;">${values.signClient || ""}</p>
      </div>
    </div>
  </div>`;
}

function openReportForm(){
  // Fermer autres modales par sécurité
  const modals = ["providerFormSection","itineraryModal","importModal"];
  modals.forEach(id => { const m=document.getElementById(id); if (m) m.style.display="none"; });

  const modal = document.getElementById("reportModal");
  if (!modal) return;
  modal.style.display = "flex";

  // Ne pas pré-générer l’aperçu
  const reportContent = document.getElementById("reportContent");
  if (reportContent){ reportContent.innerHTML=""; reportContent.style.display="none"; }

  populateTechnicianSuggestions();
}
function closeReportForm(){ const m=document.getElementById("reportModal"); if (m) m.style.display="none"; }

// Impression fiable (évite PDF blanc)
function printReport(){
  const form = document.getElementById("reportForm");
  const get = id => form.querySelector(`[name="${id}"]`) || form.querySelector(`#${id}`);
  const values = {
    ticket:get("ticket")?.value, date:get("interventionDate")?.value, site:get("siteAddress")?.value,
    tech:get("technician")?.value, todo:get("todo")?.value, done:get("done")?.value,
    start:get("start")?.value, end:get("end")?.value, signTech:get("signTech")?.value, signClient:get("signClient")?.value
  };
  const html = buildReportHTML(values);
  const w = window.open('', '_blank');
  w.document.open();
  w.document.write(`
    <html>
      <head>
        <meta charset="utf-8">
        <title>Rapport d’intervention</title>
        <style>
          @page { size: A4; margin: 12mm; }
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; font-family: Arial, sans-serif; }
          h2 { margin: 0; color: #004080; }
        </style>
      </head>
      <body>${html}</body>
    </html>
  `);
  w.document.close();
  const waitImgs = () => {
    const imgs = Array.from(w.document.images);
    return Promise.all(imgs.map(img => img.complete ? Promise.resolve() : new Promise(res => { img.onload = img.onerror = res; })));
  };
  w.addEventListener("load", async () => { await waitImgs(); w.focus(); w.print(); }, {once:true});
}

// Génération PDF = impression (fiable partout)
function generatePDF(){ printReport(); }

// Remplissage liste des techniciens (datalist) depuis local
function populateTechnicianSuggestions(){
  const datalist = document.getElementById("technicianList"); if (!datalist) return;
  datalist.innerHTML = "";
  const providers = JSON.parse(localStorage.getItem(LS_KEY)||"[]");
  providers.forEach(p=>{
    const opt = document.createElement("option");
    opt.value = `${p.firstName||""} ${p.contactName||""}`.trim();
    if (opt.value) datalist.appendChild(opt);
  });
}

// --- Init ---
document.addEventListener("DOMContentLoaded", async () => {
  initMap();
  await fireSync.boot();
  await fireSync.pullAll();
  updateProviderList();
});
