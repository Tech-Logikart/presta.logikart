// ======================= LOGIKART / script.js =======================
// Carte Leaflet — vue Europe par défaut
const map = L.map('map').setView([54, 15], 4);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap contributors'
}).addTo(map);

// --- utilitaire debounce (retarde l'appel tant que ça "bouge") ---
function debounce(fn, delay = 120) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

// ---------- Marqueurs performants (index + layer + cluster optionnel) ----------
let markerIndex = new Map(); // key -> { marker, data }
let markerLayer;
if (L.markerClusterGroup) {
  markerLayer = L.markerClusterGroup({ chunkedLoading: true });
} else {
  markerLayer = L.layerGroup();
}
map.addLayer(markerLayer);

function markerKey(p) {
  return p.id || (String(p.email || '').toLowerCase() + '|' + String(p.phone || ''));
}

function createMarker(p) {
  const m = L.marker([p.lat, p.lon]).bindPopup(
    `<strong>${p.companyName || ""}</strong><br>${p.contactName || ""}<br>${p.email || ""}<br>${p.phone || ""}<br><em>${p.address || ""}</em>`
  );
  markerLayer.addLayer(m);
  markerIndex.set(markerKey(p), { marker: m, data: p });
  return m;
}
function upsertMarker(p) {
  const key = markerKey(p);
  const existing = markerIndex.get(key);
  if (existing) {
    markerLayer.removeLayer(existing.marker);
    markerIndex.delete(key);
  }
  return createMarker(p);
}
function removeMarkerByKey(key) {
  const entry = markerIndex.get(key);
  if (entry) {
    markerLayer.removeLayer(entry.marker);
    markerIndex.delete(key);
  }
}
function clearMarkers() {
  markerLayer.clearLayers();
  markerIndex.clear();
}

function fitMapToAllMarkers() {
  const allLayers = markerLayer.getLayers();
  if (allLayers.length > 0) {
    const group = L.featureGroup(allLayers);
    map.fitBounds(group.getBounds().pad(0.1));
  } else {
    map.setView([54, 15], 4);
  }
}

let editingKey = null; // id Firestore OU clé email|phone

// Filtre certains rejets (extensions Chrome bavardes)
window.addEventListener('unhandledrejection', (event) => {
  const msg = String(event.reason || '');
  if (msg.includes('A listener indicated an asynchronous response')) {
    event.preventDefault();
    console.debug('[Extension warning filtré]', msg);
  }
});

// ----------------- Auth anonyme (fournie par index.html) -----------------
async function ensureAuth() { try { if (window.authReady) await window.authReady; } catch {} }

// ----------------- Firestore ⇄ localStorage sync -----------------
const LS_KEY = "providers";
const keyOf = (p) => (String(p.email || "").toLowerCase() + "|" + String(p.phone || ""));

const fireSync = {
  online: false,

  async boot() {
    try {
      await ensureAuth();                                // attend l’anonyme si activée
      await db.collection("prestataires").limit(1).get(); // test permission/connexion
      this.online = true;
      updateSyncBadge();
      await this.pullAll();                               // récupère tout dans le local
      this.startRealtime();                               // écoute temps réel (diff)
      console.log("[Sync] Firestore actif");
    } catch (e) {
      this.online = false;
      updateSyncBadge();
      console.warn("[Sync] Mode local uniquement :", e?.message || e);
    }
  },

  async pullAll() {
    const snap = await db.collection("prestataires").get();
    const list = [];
    snap.forEach(doc => list.push({ id: doc.id, ...doc.data() }));
    localStorage.setItem(LS_KEY, JSON.stringify(list));

    // Chargement initial en lots (sans géocoder)
    clearMarkers();
    const providers = list.filter(p => p.lat != null && p.lon != null);
    let i = 0, CHUNK = 200;
    function addChunk() {
      const end = Math.min(i + CHUNK, providers.length);
      for (; i < end; i++) upsertMarker(providers[i]);
      if (i < providers.length) {
        requestAnimationFrame(addChunk);
      } else {
        fitMapToAllMarkers();
        updateProviderList(); // débouncé
      }
    }
    requestAnimationFrame(addChunk);
  },

  async upsert(p) {
    // 1) compléter lat/lon si absents (géocodage unique, rate-limité)
    const hasCoords = p.lat != null && p.lon != null &&
                      !isNaN(parseFloat(p.lat)) && !isNaN(parseFloat(p.lon));
    if (!hasCoords && p.address) {
      const data = await fetchNominatim(p.address);
      if (data && data.length) {
        p.lat = parseFloat(data[0].lat);
        p.lon = parseFloat(data[0].lon);
      }
    }

    // 2) write Firestore + miroir local
    const list = JSON.parse(localStorage.getItem(LS_KEY)) || [];
    if (this.online) {
      if (p.id) {
        await db.collection("prestataires").doc(p.id).set(p, { merge: true });
      } else {
        const docRef = await db.collection("prestataires").add(p);
        p.id = docRef.id;
      }
    } else {
      console.debug("[Sync] upsert local-only (offline).");
    }

    let idx = -1;
    if (p.id) idx = list.findIndex(x => x.id === p.id);
    if (idx === -1) idx = list.findIndex(x => keyOf(x) === keyOf(p));
    if (idx >= 0) list[idx] = { ...list[idx], ...p };
    else list.push(p);

    localStorage.setItem(LS_KEY, JSON.stringify(list));
    return p;
  },

  async remove(p) {
    const list = JSON.parse(localStorage.getItem(LS_KEY)) || [];
    if (this.online && p?.id) {
      await db.collection("prestataires").doc(p.id).delete();
    } else {
      console.debug("[Sync] suppression locale uniquement (offline).");
    }
    const newList = list.filter(x => (p.id ? x.id !== p.id : keyOf(x) !== keyOf(p)));
    localStorage.setItem(LS_KEY, JSON.stringify(newList));
  },

  startRealtime() {
    db.collection("prestataires").onSnapshot((snap) => {
      const pendingFit = { added: 0 };

      // 🔁 Diff incrémental
      snap.docChanges().forEach(change => {
        const p = { id: change.doc.id, ...change.doc.data() };

        // ne pas géocoder ici → on affiche seulement si coords présentes
        if (p.lat == null || p.lon == null) return;

        const key = markerKey(p);
        if (change.type === "added") {
          upsertMarker(p);
          pendingFit.added++;
        } else if (change.type === "modified") {
          upsertMarker(p);
        } else if (change.type === "removed") {
          removeMarkerByKey(key);
        }
      });

      // miroir local
      const list = [];
      snap.forEach(doc => list.push({ id: doc.id, ...doc.data() }));
      localStorage.setItem(LS_KEY, JSON.stringify(list));

      // recentre seulement s'il y a de nouvelles entrées
      if (pendingFit.added > 0) fitMapToAllMarkers();
      updateProviderList(); // débouncé
    }, (err) => {
      this.online = false;
      console.warn("[Sync] onSnapshot error -> mode local:", err?.message || err);
    });
  }
};

// ----------------- Rate-limit / Cache / Normalisation géocodage -----------------
const geoCache = new Map(); // clé: adresse normalisée -> {lat, lon, ts}
function cacheGet(addr) { return geoCache.get(addr); }
function cacheSet(addr, coords) { geoCache.set(addr, { ...coords, ts: Date.now() }); }

// File d’attente 1 req / 1100ms (respect Nominatim)
const geoQueue = [];
let geoBusy = false;
function enqueueGeo(task) {
  return new Promise((resolve, reject) => {
    geoQueue.push({ task, resolve, reject });
    runGeoQueue();
  });
}
async function runGeoQueue() {
  if (geoBusy) return;
  const item = geoQueue.shift();
  if (!item) return;
  geoBusy = true;
  try {
    const res = await item.task();
    item.resolve(res);
  } catch (e) {
    item.reject(e);
  } finally {
    setTimeout(() => {
      geoBusy = false;
      runGeoQueue();
    }, 1100);
  }
}

// Normalisation d’adresse (FR/IT/UK/CZ/ES)
function normalizeIntlAddress(raw) {
  if (!raw) return "";
  let s = String(raw).trim();

  // Italie
  s = s.replace(/\bItalie\b/i, "Italy")
       .replace(/\bItalia\b/i, "Italy")
       .replace(/\bMilano\b/i, "Milan")
       .replace(/\b MI\b/g, ""); // enlève " MI" (province) s'il est séparé

  // Tchéquie
  s = s.replace(/\bTchéquie\b/i, "Czechia")
       .replace(/\bRépublique tchèque\b/i, "Czechia")
       .replace(/\bPraha\b/i, "Prague");

  // Espagne
  s = s.replace(/\bEspagne\b/i, "Spain")
       .replace(/\bValència\b/i, "Valencia");

  // UK
  s = s.replace(/\bRoyaume-Uni\b/i, "United Kingdom")
       .replace(/\bAngleterre\b/i, "England");

  // France (Fontaine-du-Bac)
  s = s.replace(/\bFont\b(\s+du\s+Bac\b)/i, "Fontaine$1")
       .replace(/\bFontaine\s+du\s+Bac\b/i, "Fontaine-du-Bac");

  // Nettoyage espaces
  s = s.replace(/\s{2,}/g, " ").trim();
  return s;
}

async function fetchNominatim(query) {
  const q0 = normalizeIntlAddress(query);
  if (!q0) return [];
  const cached = cacheGet(q0);
  if (cached) return [{ lat: cached.lat, lon: cached.lon }];

  const base = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=1&accept-language=fr,it,en&q=';
  const url = base + encodeURIComponent(q0);
  const proxied = `https://proxy-logikart.samir-mouheb.workers.dev/?url=${encodeURIComponent(url)}`;

  // UNE tentative (proxy OU direct)
  const attempt = (useProxy) => async () => {
    const target = useProxy ? proxied : url;
    const init = useProxy ? {} : { headers: { 'Accept': 'application/json', 'User-Agent': 'LOGIKART/1.0 (contact@logikart.app)' } };
    const res = await fetch(target, init);
    if (res.status === 429) throw Object.assign(new Error("Rate limited"), { code: 429 });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (Array.isArray(data) && data.length) {
      const lat = parseFloat(data[0].lat), lon = parseFloat(data[0].lon);
      if (!isNaN(lat) && !isNaN(lon)) cacheSet(q0, { lat, lon });
      return data;
    }
    return [];
  };

  // Stratégie : proxy -> direct -> proxy, avec backoff
  const tries = [
    () => enqueueGeo(attempt(true)),
    () => enqueueGeo(attempt(false)),
    () => enqueueGeo(attempt(true)),
  ];

  for (let i = 0; i < tries.length; i++) {
    try {
      const data = await tries[i]();
      if (data && data.length) return data;
    } catch (e) {
      if (e.code === 429) {
        await new Promise(r => setTimeout(r, 1500 + i * 500)); // backoff simple
        continue;
      }
    }
  }
  return [];
}

function buildQueries(addr) {
  const src = normalizeIntlAddress(addr || "");
  let norm = src;

  // Ajoute pays par défaut si absent
  const withCountry = /(France|Spain|Italy|Czechia|United Kingdom|England)\b/i.test(norm)
    ? norm
    : `${norm}, France`;

  const parts = withCountry.split(",");
  const streetCity = parts[0].trim();
  const rest = parts.slice(1).join(",").trim();

  const moved = withCountry.replace(/(\d{5})\s+([A-Za-zÀ-ÿ\-']+)/, "$2 $1");
  const streetNoNum = streetCity.replace(/^\s*\d+\s*(bis|ter|quater)?\s*/i, "").trim();

  const ter = /\b(\d+)\b(?!\s*(bis|ter|quater))/i.test(streetCity)
    ? streetCity.replace(/\b(\d+)\b/, "$1 ter")
    : streetCity;

  return [
    withCountry,
    moved,
    `${streetNoNum}, ${rest || 'France'}`,
    `${ter}, ${rest || 'France'}`
  ].map(s => s.replace(/\s{2,}/g, ' ').trim())
   .filter((v, i, a) => v && a.indexOf(v) === i);
}

// ----------------- Géocodage -> Marker (utilise lat/lon si présents) -----------------
async function geocodeAndAddToMap(provider, opts = { pan: false, open: false }) {
  try {
    if (!provider) return;

    let lat = provider.lat != null ? parseFloat(provider.lat) : NaN;
    let lon = provider.lon != null ? parseFloat(provider.lon) : NaN;

    if (isNaN(lat) || isNaN(lon)) {
      if (!provider.address) return;
      const queries = buildQueries(provider.address);
      let result = null;
      for (const q of queries) {
        const data = await fetchNominatim(q);
        if (data && data.length) { result = data[0]; break; }
      }
      if (!result) {
        console.warn("Géocodage introuvable pour:", provider.address);
        const fallbackCity = /([A-Za-zÀ-ÿ'\- ]+),?\s*(France|Spain|Italy|Czechia|United Kingdom|England|Italia|Tchéquie|Espagne)/i.exec(provider.address);
        const cityQ = fallbackCity ? normalizeIntlAddress(`${fallbackCity[1].trim()}, ${fallbackCity[2]}`) : 'France';
        const cityTry = await fetchNominatim(cityQ);
        if (!cityTry.length) return;
        result = cityTry[0];
      }
      lat = parseFloat(result.lat);
      lon = parseFloat(result.lon);
      provider.lat = lat; provider.lon = lon; // enrichit en mémoire
    }

    const m = upsertMarker({ ...provider, lat, lon });
    if (opts.pan) map.setView([lat, lon], Math.max(map.getZoom(), 15));
    if (opts.open) m.openPopup();
  } catch (e) {
    console.error('[geocodeAndAddToMap error]', e);
  }
}

// ----------------- Formulaire prestataire -----------------
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
  if (editingKey) {
  const list = JSON.parse(localStorage.getItem(LS_KEY)) || [];
  const existing = findProviderByKey(list, editingKey);
  if (existing) {
    provider.id = existing.id;
    provider.lat = existing.lat;
    provider.lon = existing.lon;
  }
}
  try {
    const saved = await fireSync.upsert(provider);        // géocode ici si besoin + stocke lat/lon
    geocodeAndAddToMap(saved, { pan: true, open: true }); // animation locale
    updateProviderList(); // débouncé
    const list = document.getElementById("providerList");
    if (list) list.style.display = "block";
    hideForm();
  } catch (e) {
    console.error("Erreur enregistrement:", e);
    alert("Impossible d’enregistrer (vérifie Auth anonyme & règles Firestore).");
  }
  editingKey = null;
}

// ----------------- Recherche de prestataire proche -----------------
async function searchNearest() {
  const city = document.getElementById("cityInput").value.trim();
  if (!city) return;

  const cityData = await fetchNominatim(/(France|Spain|Italy|Czechia|United Kingdom|England)/i.test(city) ? city : `${city}, France`);
  if (!cityData.length) { alert("Ville non trouvée."); return; }

  const userLat = parseFloat(cityData[0].lat);
  const userLon = parseFloat(cityData[0].lon);

  const providers = JSON.parse(localStorage.getItem(LS_KEY)) || [];

  let nearest = null;
  let minDistance = Infinity;

  for (const provider of providers) {
    let plat = provider.lat, plon = provider.lon;
    if (plat == null || plon == null) {
      const data = await fetchNominatim(provider.address || "");
      if (!data.length) continue;
      plat = parseFloat(data[0].lat);
      plon = parseFloat(data[0].lon);
    }
    const distance = Math.sqrt(Math.pow(plat - userLat, 2) + Math.pow(plon - userLon, 2));
    if (distance < minDistance) {
      minDistance = distance;
      nearest = { ...provider, lat: plat, lon: plon };
    }
  }

  if (nearest) {
    map.setView([nearest.lat, nearest.lon], 12);
    L.popup()
      .setLatLng([nearest.lat, nearest.lon])
      .setContent(`<strong>${nearest.companyName || '—'}</strong><br>${nearest.contactName || '—'}<br>${nearest.email || '—'}<br>${nearest.phone || '—'}`)
      .openOn(map);
  } else {
    alert("Aucun prestataire trouvé.");
  }
}

// ----------------- Chargement & liste -----------------
function loadProvidersFromLocalStorage() {
  clearMarkers();
  const providers = (JSON.parse(localStorage.getItem(LS_KEY)) || [])
    .filter(p => p.lat != null && p.lon != null); // pas de géocodage ici

  let i = 0, CHUNK = 200;
  function addChunk() {
    const end = Math.min(i + CHUNK, providers.length);
    for (; i < end; i++) upsertMarker(providers[i]);
    if (i < providers.length) {
      requestAnimationFrame(addChunk);
    } else {
      fitMapToAllMarkers();
      updateProviderList(); // débouncé
    }
  }
  requestAnimationFrame(addChunk);
}

// --- rendu immédiat (non débouncé) de la liste ---
function updateProviderListNow() {
  const container = document.getElementById("providerList");
  if (!container) return;

  container.innerHTML = "";
  const providers = (JSON.parse(localStorage.getItem(LS_KEY)) || [])
  .sort((a, b) =>
    (a.companyName || "").localeCompare(
      (b.companyName || ""),
      "fr",
      { sensitivity: "base" }
    )
  );
  providers.forEach((p, i) => {
    const div = document.createElement("div");
    div.className = "provider-entry";
    div.innerHTML = `
      <strong>${p.companyName || '—'}</strong><br>
      👤 ${p.contactName || '—'} ${p.firstName ? `(${p.firstName})` : ""}<br>
      📧 ${p.email || '—'}<br>
      📞 ${p.phone || '—'}<br>
      💰 Tarif total HT : ${p.totalCost || "N/A"}${(p.lat!=null&&p.lon!=null)?'':' <em style="color:#a00">(géocodage manquant)</em>'}<br>
      <div style="display:flex; gap:8px; margin-top:6px;">
        <button onclick='editProviderByKey(${JSON.stringify(p.id || keyOf(p))})'>✏️ Modifier</button>
        <button onclick='deleteProviderByKey(${JSON.stringify(p.id || keyOf(p))})'>🗑️ Supprimer</button>

      </div>
      <hr>
    `;
    container.appendChild(div);
  });
}
// --- version débouncée utilisée partout ---
const updateProviderList = debounce(updateProviderListNow, 120);
window.updateProviderList = updateProviderList; // si jamais appelé depuis HTML inline

function findProviderByKey(list, k) {
  let p = list.find(x => x.id && x.id === k);
  if (!p) p = list.find(x => keyOf(x) === k);
  return p || null;
}

function editProviderByKey(k) {
  const providers = JSON.parse(localStorage.getItem(LS_KEY)) || [];
  const p = findProviderByKey(providers, k);
  if (!p) return alert("Prestataire introuvable.");

  document.getElementById("companyName").value = p.companyName || "";
  document.getElementById("contactName").value = p.contactName || "";
  document.getElementById("address").value = p.address || "";
  document.getElementById("email").value = p.email || "";
  document.getElementById("phone").value = p.phone || "";
  document.getElementById("firstName").value = p.firstName || "";
  document.getElementById("rate").value = p.rate || "";
  document.getElementById("travelFees").value = p.travelFees || "";
  document.getElementById("totalCost").value = p.totalCost || "";

  if (typeof updateTotal === "function") updateTotal();

  editingKey = p.id || keyOf(p);
  addProvider();
}

async function deleteProviderByKey(k) {
  const providers = JSON.parse(localStorage.getItem(LS_KEY)) || [];
  const toDelete = findProviderByKey(providers, k);
  if (!toDelete) return alert("Prestataire introuvable.");

  if (!confirm("Confirmer la suppression ?")) return;

  try {
    await fireSync.remove(toDelete);
    removeMarkerByKey(markerKey(toDelete));
    updateProviderList();
  } catch (e) {
    console.error("Erreur suppression :", e);
    alert("Suppression impossible.");
  }
}

window.editProviderByKey = editProviderByKey;
window.deleteProviderByKey = deleteProviderByKey;

// ----------------- Export JSON/CSV -----------------
function exportProviders(format = "json") {
  const providers = JSON.parse(localStorage.getItem(LS_KEY)) || [];
  if (!providers.length) { alert("Aucun prestataire à exporter."); return; }

  const headers = ["id","companyName","contactName","firstName","address","email","phone","rate","travelFees","totalCost","lat","lon"];

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
    for (const p of providers) rows.push(headers.map(h => escape(p[h] ?? "")).join(","));
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
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ----------------- Import JSON/CSV -> upsert Firestore -----------------
function openImportModal() { const m = document.getElementById("importModal"); if (m) m.style.display = "flex"; }
function closeImportModal() { const m = document.getElementById("importModal"); if (m) m.style.display = "none"; const i = document.getElementById("importFile"); if (i) i.value = ""; }

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
    firstName:   norm(obj.firstName   ?? obj.prenom),
    address:     norm(obj.address     ?? obj.adresse),
    email:       norm(obj.email),
    phone:       norm(obj.phone       ?? obj.telephone),
    rate:        norm(obj.rate        ?? obj.tarifHeureHT),
    travelFees:  norm(obj.travelFees  ?? obj.fraisDeplacementHT),
    totalCost:   norm(obj.totalCost   ?? obj.tarifTotalHT),
    id:          norm(obj.id),
    lat:         obj.lat !== undefined ? obj.lat : undefined,
    lon:         obj.lon !== undefined ? obj.lon : undefined
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
  const semi  = (headerLine.match(/;/g) || []).length;
  return semi > comma ? ";" : ",";
}

function parseCSVToObjects(text) {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter(l => l.length);
  if (!lines.length) return [];
  const delimiter = detectDelimiter(lines[0]);

  function parseLine(line) {
    const out = []; let cur = ""; let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = !inQuotes;
      } else if (ch === delimiter && !inQuotes) { out.push(cur); cur = ""; }
      else { cur += ch; }
    }
    out.push(cur);
    return out;
  }

  const headersRaw = parseLine(lines[0]).map(h => h.trim());
  const normalizeKey = (k) => k.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, "").replace(/[^a-z0-9]/g, "");

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
    else if (n === "lat" || n === "latitude") headerMap[i] = "lat";
    else if (n === "lon" || n === "lng" || n === "longitude") headerMap[i] = "lon";
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
  if (!input?.files?.length) { alert("Choisis un fichier à importer."); return; }
  const file = input.files[0];
  const text = await file.text();

  let incoming = [];
  if (file.name.toLowerCase().endsWith(".json")) {
    try {
      const data = JSON.parse(text);
      incoming = Array.isArray(data) ? data : [data];
    } catch (e) { console.error(e); alert("JSON invalide."); return; }
  } else {
    incoming = parseCSVToObjects(text);
  }
  if (!incoming.length) { alert("Aucune donnée détectée."); return; }

  const skipDuplicates = document.getElementById("skipDuplicates")?.checked ?? true;
  const existing = JSON.parse(localStorage.getItem(LS_KEY)) || [];
  const byKey = new Map(existing.map(p => [keyOf(p), p]));
  const results = { added: 0, updated: 0, skipped: 0, errors: 0 };

  for (const raw of incoming) {
    const p = normalizeProvider(raw);
    if (!p.companyName && !p.contactName && !p.email) { results.skipped++; continue; }

    const match = byKey.get(keyOf(p));
    try {
      if (match && skipDuplicates) {
        results.skipped++;
      } else {
        const merged = match ? { ...match, ...p, id: match.id } : p;
        const saved = await fireSync.upsert(merged); // géocode ici si coords manquantes
        if (match) results.updated++; else results.added++;
        byKey.set(keyOf(saved), saved);
      }
    } catch (e) {
      console.error("Import error:", e);
      results.errors++;
    }
  }

  if (fireSync.online) await fireSync.pullAll(); else { clearMarkers(); loadProvidersFromLocalStorage(); }

  // Forcer un rendu immédiat final de la liste (micro-gain)
  updateProviderListNow();

  alert(`Import terminé :
- ${results.added} ajoutés
- ${results.updated} mis à jour
- ${results.skipped} ignorés
- ${results.errors} erreurs`);
  closeImportModal();
}

// ----------------- Itinéraire -----------------
function openItineraryTool() { const m = document.getElementById("itineraryModal"); if (m) m.style.display = "flex"; document.getElementById("routeResult").innerHTML = ""; }
function closeItineraryModal() { const m = document.getElementById("itineraryModal"); if (m) m.style.display = "none"; document.getElementById("itineraryForm").reset(); document.getElementById("extraDestinations").innerHTML = ""; }
function addDestinationField() { const c = document.getElementById("extraDestinations"); const i = document.createElement("input"); i.type = "text"; i.placeholder = "Destination supplémentaire"; i.classList.add("extra-destination"); c.appendChild(i); }

async function calculateRoute() {
  try {
    const start = document.getElementById("startAddress").value.trim();
    const end = document.getElementById("endAddress").value.trim();
    const extras = Array.from(document.getElementsByClassName("extra-destination")).map(input => input.value.trim()).filter(Boolean);
    const points = [start, ...extras, end];
    const coords = [];

    for (const address of points) {
      const data = await fetchNominatim(/(France|Spain|Italy|Czechia|United Kingdom|England)/i.test(address) ? address : `${address}, France`);
      if (!data.length) { alert(`Adresse non trouvée : ${address}`); return; }
      coords.push([parseFloat(data[0].lon), parseFloat(data[0].lat)]); // ORS = [lon, lat]
    }

    const orsRes = await fetch('https://api.openrouteservice.org/v2/directions/driving-car/geojson', {
      method: 'POST',
      headers: {
        'Authorization': 'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6ImQ4YTg5NTg4NjE0OTQ5NjZhMDY3YzgxZjJjOGE3ODI3IiwiaCI6Im11cm11cjY0In0=',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ coordinates: coords, language: "fr", instructions: true })
    });

    if (!orsRes.ok) { alert("Erreur lors du calcul d’itinéraire."); return; }

    const geojson = await orsRes.json();
    window.lastRouteInstructions = geojson.features[0].properties.segments[0].steps.map((step, i) =>
      `${i + 1}. ${step.instruction} (${(step.distance / 1000).toFixed(2)} km)`
    );

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
  } catch (e) {
    console.error('[calculateRoute error]', e);
    alert("Une erreur est survenue pendant le calcul d’itinéraire.");
  }
}

function exportItineraryToPDF() {
  const start = document.getElementById("startAddress").value.trim();
  const end = document.getElementById("endAddress").value.trim();
  const extras = Array.from(document.getElementsByClassName("extra-destination")).map(i => i.value.trim()).filter(Boolean);
  const distanceText = document.querySelector("#routeResult").innerText;

  leafletImage(map, function (err, canvas) {
    if (err) { alert("Erreur lors du rendu de la carte."); return; }
    const mapImage = canvas.toDataURL("image/jpeg");

    const container = document.createElement("div");
    container.style.padding = "20px";
    container.style.fontFamily = "Arial";
    container.innerHTML = `
      <h2 style="color:#004080;">🧭 Itinéraire LOGIKART</h2>
      <p><strong>Départ :</strong> ${start}</p>
      ${extras.map((dest, i) => `<p><strong>Étape ${i + 1} :</strong> ${dest}</p>`).join("")}
      <p><strong>Arrivée :</strong> ${end}</p>
      <p style="margin-top:10px;">${distanceText.replace(/\\n/g, "<br>")}</p>
      <hr>
      <p><strong>Carte de l’itinéraire :</strong></p>
      <img src="${mapImage}" style="width:100%; max-height:500px; margin-top:10px;" />
    `;
    if (window.lastRouteInstructions && window.lastRouteInstructions.length) {
      const instructionsHtml = window.lastRouteInstructions.map(i => `<li>${i}</li>`).join("");
      container.innerHTML += `<p><strong>🧭 Instructions pas à pas :</strong></p><ol>${instructionsHtml}</ol>`;
    }

    html2pdf().set({
      margin: 0.5, filename: 'itineraire_LOGIKART.pdf',
      image: { type: 'jpeg', quality: 0.98 }, html2canvas: { scale: 2 },
      jsPDF: { unit: 'in', format: 'a4', orientation: 'portrait' }
    }).from(container).save();
  });
}

// ----------------- Rapport d’intervention (impression & PDF robustes) -----------------
function buildReportHTML(values) {
  return `
    <div style="font-family: Arial, sans-serif; padding: 20px; color: #000;">
      <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #004080; padding-bottom: 10px;">
        <img src="logikart-logo.png" alt="LOGIKART" style="height: 50px;">
        <h2 style="text-align: center; flex-grow: 1; color: #004080;">Rapport d’intervention</h2>
        <div style="text-align: right; font-size: 12px;">${values.date || ""}</div>
      </div>

      <div style="margin-top: 20px;">
        <p><strong>Ticket :</strong> ${values.ticket || ""}</p>
        <p><strong>Adresse du site :</strong> ${values.site || ""}</p>
        <p><strong>Nom du technicien :</strong> ${values.tech || ""}</p>
      </div>

      <div style="margin-top: 20px;">
        <h4>Travail à faire</h4>
        <div style="border: 1px solid #ccc; padding: 10px; min-height: 60px;">${values.todo || ""}</div>
      </div>

      <div style="margin-top: 20px;">
        <h4>Travail effectué</h4>
        <div style="border: 1px solid #ccc; padding: 10px; min-height: 80px;">${values.done || ""}</div>
      </div>

      <div style="margin-top: 20px;">
        <p><strong>Heure d’arrivée :</strong> ${values.start || ""}</p>
        <p><strong>Heure de départ :</strong> ${values.end || ""}</p>
      </div>

      <div style="margin-top: 20px; display: flex; justify-content: space-between;">
        <div style="width: 48%;">
          <p><strong>Signature du technicien :</strong></p>
          <div style="border: 1px solid #ccc; height: 60px;"></div>
          <p style="text-align: center; margin-top: 5px;">${values.signTech || ""}</p>
        </div>
        <div style="width: 48%;">
          <p><strong>Signature du client :</strong></p>
          <div style="border: 1px solid #ccc; height: 60px;"></div>
          <p style="text-align: center; margin-top: 5px;">${values.signClient || ""}</p>
        </div>
      </div>
    </div>
  `;
}

function openReportForm() {
  const modal = document.getElementById("reportModal");
  if (!modal) return;
  modal.style.display = "flex";

  // Ne pas pré-générer l'aperçu pour éviter l'effet "double formulaire"
  const reportContent = document.getElementById("reportContent");
  if (reportContent) {
    reportContent.innerHTML = "";
    reportContent.style.display = "none";
  }

  populateTechnicianSuggestions();
}
function closeReportForm() { const modal = document.getElementById("reportModal"); if (modal) modal.style.display = "none"; }

function printReport() {
  const form = document.getElementById("reportForm");
  const get = id => form.querySelector(`[name="${id}"]`) || form.querySelector(`#${id}`);
  const values = {
    ticket: get("ticket")?.value,
    date: get("interventionDate")?.value,
    site: get("siteAddress")?.value,
    tech: get("technician")?.value,
    todo: get("todo")?.value,
    done: get("done")?.value,
    start: get("start")?.value,
    end: get("end")?.value,
    signTech: get("signTech")?.value,
    signClient: get("signClient")?.value
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
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          h2 { margin: 0; }
        </style>
      </head>
      <body>${html}</body>
    </html>
  `);
  w.document.close();
  w.focus();

  const imgs = Array.from(w.document.images);
  const waitImgs = Promise.all(imgs.map(img => img.complete ? Promise.resolve() :
    new Promise(res => img.onload = img.onerror = res)
  ));
  waitImgs.then(() => {
    w.print();
    // w.close(); // décommente si tu veux fermer l’onglet automatiquement
  });
}

function generatePDF() {
  const form = document.getElementById("reportForm");
  const get = id => form.querySelector(`[name="${id}"]`) || form.querySelector(`#${id}`);
  const values = {
    ticket: get("ticket")?.value,
    date: get("interventionDate")?.value,
    site: get("siteAddress")?.value,
    tech: get("technician")?.value,
    todo: get("todo")?.value,
    done: get("done")?.value,
    start: get("start")?.value,
    end: get("end")?.value,
    signTech: get("signTech")?.value,
    signClient: get("signClient")?.value
  };

  // Si html2pdf n’est pas présent → fallback impression
  if (typeof html2pdf === "undefined") {
    console.warn("[PDF] html2pdf non trouvé, fallback impression");
    printReport();
    return;
  }

  // conteneur visible (offscreen) pour html2canvas/html2pdf
  const temp = document.createElement("div");
  temp.style.position = "fixed";
  temp.style.left = "-10000px"; // hors écran mais rendu
  temp.style.top = "0";
  temp.style.width = "794px";   // ~ A4 @96dpi
  temp.style.background = "#fff";
  temp.innerHTML = buildReportHTML(values);
  document.body.appendChild(temp);

  // attendre les images (logo) avant rendu
  const imgs = Array.from(temp.querySelectorAll("img"));
  const waitImgs = Promise.all(imgs.map(img => img.complete ? Promise.resolve() :
    new Promise(res => img.onload = img.onerror = res)
  ));

  waitImgs.then(() => {
    html2pdf().set({
      margin: 0.5,
      filename: 'rapport_intervention_LOGIKART.pdf',
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true, allowTaint: true },
      jsPDF: { unit: 'in', format: 'a4', orientation: 'portrait' }
    }).from(temp).save()
      .then(() => {
        temp.remove();
        // form.reset(); closeReportForm(); // optionnel
      })
      .catch(err => {
        console.error("[PDF] erreur", err);
        temp.remove();
        printReport(); // fallback impression si canvas/images bloqués
      });
  });
}

function populateTechnicianSuggestions() {
  const datalist = document.getElementById("technicianList");
  if (!datalist) return;
  datalist.innerHTML = "";
  const providers = JSON.parse(localStorage.getItem(LS_KEY)) || [];
  providers.forEach(p => {
    const option = document.createElement("option");
    option.value = `${p.firstName || ""} ${p.contactName || ""}`.trim();
    datalist.appendChild(option);
  });
}

// ----------------- Menu / init + Backfill coords -----------------
document.addEventListener("DOMContentLoaded", async () => {
  // Forçage position burger en haut à droite (au cas où le CSS n'est pas chargé)
  const headerEl = document.querySelector('header');
  const burger = document.getElementById("burgerMenu");
  const dropdown = document.getElementById("menuDropdown");
  // (supprimé) pas d'override du header pour garder le titre centré
  // (supprimé) pas d'override inline du burger; CSS gère déjà la position

  // Affichage immédiat depuis le local (en lots)
  loadProvidersFromLocalStorage();

  // Sync Firestore si possible
  await fireSync.boot();

  // Backfill asynchrone des fiches sans coords (une seule fois)
  backfillMissingCoords(); // best effort, non bloquant

  // Toggle menu
  burger?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!dropdown) return;
    dropdown.style.display = (dropdown.style.display === "none" || !dropdown.style.display) ? "block" : "none";
  });
  document.addEventListener("click", () => { if (dropdown) dropdown.style.display = "none"; });
  updateSyncBadge();
});
function updateSyncBadge() {
  const badge = document.getElementById("syncStatus");
  if (!badge) return;

  if (fireSync.online) {
    badge.textContent = "ONLINE";
    badge.classList.remove("offline");
    badge.classList.add("online");
  } else {
    badge.textContent = "LOCAL";
    badge.classList.remove("online");
    badge.classList.add("offline");
  }
}
function toggleProviderList() {
  const list = document.getElementById("providerList");
  if (!list) return;
  list.style.display = list.style.display === "none" ? "block" : "none";
}

// ----------------- Backfill coords manquantes (asynchrone) -----------------
async function backfillMissingCoords() {
  const list = JSON.parse(localStorage.getItem(LS_KEY)) || [];
  let updated = 0;
  for (const p of list) {
    const has = p.lat != null && p.lon != null && !isNaN(p.lat) && !isNaN(p.lon);
    if (!has && p.address) {
      const data = await fetchNominatim(p.address);
      if (data && data.length) {
        p.lat = parseFloat(data[0].lat);
        p.lon = parseFloat(data[0].lon);
        await fireSync.upsert(p); // merge Firestore + local
        updated++;
      }
    }
  }
  if (updated) console.log(`[Backfill] ${updated} prestataires enrichis en lat/lon`);
}
function updateSyncBadge() {
  const badge = document.getElementById("syncStatus");
  if (!badge) return;

  if (fireSync.online) {
    badge.textContent = "ONLINE";
    badge.classList.remove("offline");
    badge.classList.add("online");
  } else {
    badge.textContent = "LOCAL";
    badge.classList.remove("online");
    badge.classList.add("offline");
  }
}

// ----------------- Expose au scope global -----------------
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
window.printReport = printReport;

window.editProvider = editProvider;
window.deleteProvider = window.deleteProvider; // déjà défini
window.exportProviders = exportProviders;
window.openImportModal = openImportModal;
window.closeImportModal = closeImportModal;
window.handleImport = handleImport;

// --------------------------------------------------------------------
// Production GitHub Pages : ajoute dans Firebase > Auth > Domaines autorisés
//   tech-logikart.github.io   (et localhost si besoin)
// Active "Anonymous" et publie les "Rules" Firestore.
// --------------------------------------------------------------------
