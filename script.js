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
// ---------- Marqueurs SANS clustering ----------
let markerLayer = L.layerGroup();
map.addLayer(markerLayer);

function markerKey(p) {
  return p.id || (String(p.email || '').toLowerCase() + '|' + String(p.phone || ''));
}

function normalizeAreaLabel(area) {
  return String(area || "").replace(/\s+/g, " ").trim();
}

function areaKey(area) {
  return normalizeAreaLabel(area)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function zoneMarkerKey(p, area) {
  return `${markerKey(p)}|zone|${areaKey(area)}`;
}

function normalizeCoords(p) {
  return { ...p, lat: parseFloat(p.lat), lon: parseFloat(p.lon) };
}

function hasValidCoords(p) {
  const lat = parseFloat(p?.lat);
  const lon = parseFloat(p?.lon);
  return !isNaN(lat) && !isNaN(lon);
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
function removeProviderMarkers(p) {
  const baseKey = markerKey(p);
  const zonePrefix = `${baseKey}|zone|`;
  Array.from(markerIndex.keys()).forEach(key => {
    if (key === baseKey || key.startsWith(zonePrefix)) removeMarkerByKey(key);
  });
}
function hasProviderMarkers(p) {
  const baseKey = markerKey(p);
  const zonePrefix = `${baseKey}|zone|`;
  return Array.from(markerIndex.keys()).some(key => key === baseKey || key.startsWith(zonePrefix));
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

// ----------------- Firestore comme source commune -----------------
const keyOf = (p) => (String(p.email || "").toLowerCase() + "|" + String(p.phone || ""));
let providersState = [];

function setProvidersState(list) {
  providersState = Array.isArray(list) ? list : [];
  updateTechnicianCounter();
}

function getProviders() {
  return providersState;
}

function upsertProviderState(p) {
  const list = [...providersState];
  let idx = -1;
  if (p.id) idx = list.findIndex(x => x.id === p.id);
  if (idx === -1) idx = list.findIndex(x => keyOf(x) === keyOf(p));
  if (idx >= 0) list[idx] = { ...list[idx], ...p };
  else list.push(p);
  setProvidersState(list);
  return p;
}

function removeProviderState(p) {
  setProvidersState(providersState.filter(x => (p.id ? x.id !== p.id : keyOf(x) !== keyOf(p))));
}

const fireSync = {
  online: false,

  async boot() {
    try {
      await ensureAuth();                                // attend l’anonyme si activée
      await db.collection("prestataires").limit(1).get(); // test permission/connexion
      this.online = true;
      updateSyncBadge();
      await this.pullAll();                               // récupère tout depuis Firestore
      this.startRealtime();                               // écoute temps réel (diff)
      console.log("[Sync] Firestore actif");
    } catch (e) {
      this.online = false;
      updateSyncBadge();
      console.warn("[Sync] Firestore indisponible, aucune sauvegarde navigateur :", e?.message || e);
    }
  },

  async pullAll() {
    const snap = await db.collection("prestataires").get();
    const list = [];
    snap.forEach(doc => list.push({ id: doc.id, ...doc.data() }));
    setProvidersState(list);

    // Chargement initial en lots rapides (sans géocoder)
    clearMarkers();
    const providers = list.filter(p => hasValidCoords(p) || getProviderAreas(p).length);
    let i = 0, CHUNK = 1000;
    function addChunk() {
      const end = Math.min(i + CHUNK, providers.length);
      for (; i < end; i++) {
        renderProviderMarkers(providers[i], { skipRemove: true });
      }
      if (i < providers.length) {
        requestAnimationFrame(addChunk);
      } else {
        fitMapToAllMarkers();
        updateProviderListNow();
      }
    }
    addChunk();
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
    await ensureServiceAreaCoords(p);

    // 2) write Firestore puis état mémoire
    if (this.online) {
      if (p.id) {
        await db.collection("prestataires").doc(p.id).set(p, { merge: true });
      } else {
        const docRef = await db.collection("prestataires").add(p);
        p.id = docRef.id;
      }
    } else {
      throw new Error("Connexion Firestore indisponible : enregistrement annulé pour éviter une sauvegarde locale navigateur.");
    }

    return upsertProviderState(p);
  },

  async remove(p) {
    if (this.online && p?.id) {
      await db.collection("prestataires").doc(p.id).delete();
    } else {
      throw new Error("Connexion Firestore indisponible : suppression annulée pour éviter une sauvegarde locale navigateur.");
    }
    removeProviderState(p);
  },

  startRealtime() {
    let firstSnapshot = true;
    db.collection("prestataires").onSnapshot((snap) => {
      const pendingFit = { added: 0 };
      const list = [];
      snap.forEach(doc => list.push({ id: doc.id, ...doc.data() }));
      setProvidersState(list);

      if (firstSnapshot) {
        firstSnapshot = false;
        updateProviderListNow();
        return;
      }

      // 🔁 Diff incrémental
      snap.docChanges().forEach(change => {
        const p = { id: change.doc.id, ...change.doc.data() };

        const alreadyOnMap = hasProviderMarkers(p);
        if (change.type === "added") {
          if (!alreadyOnMap) {
            const rendered = renderProviderMarkers(p);
            if (rendered) pendingFit.added++;
            else if (getProviderAreas(p).length) geocodeAndAddToMap(p).then(() => fitMapToAllMarkers());
          }
        } else if (change.type === "modified") {
          if (hasValidCoords(p) || getProviderAreas(p).length) {
            const rendered = renderProviderMarkers(p);
            if (!rendered) geocodeAndAddToMap(p).then(() => fitMapToAllMarkers());
          } else {
            removeProviderMarkers(p);
          }
        } else if (change.type === "removed") {
          removeProviderMarkers(p);
        }
      });

      // recentre seulement s'il y a de nouvelles entrées
      if (pendingFit.added > 0) fitMapToAllMarkers();
      updateProviderListNow();
    }, (err) => {
      this.online = false;
      console.warn("[Sync] onSnapshot error, aucune sauvegarde navigateur :", err?.message || err);
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

function getProviderAreas(provider) {
  const areas = Array.isArray(provider.serviceAreas) && provider.serviceAreas.length
    ? provider.serviceAreas
    : [provider.address];

  const seen = new Set();
  return areas
    .map(normalizeAreaLabel)
    .filter(area => {
      const key = areaKey(area);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function getStoredAreaCoord(provider, area) {
  const coords = Array.isArray(provider.serviceAreaCoords) ? provider.serviceAreaCoords : [];
  const found = coords.find(item => areaKey(item.area) === areaKey(area));
  if (!found || !hasValidCoords(found)) return null;
  return { area: normalizeAreaLabel(found.area || area), lat: parseFloat(found.lat), lon: parseFloat(found.lon) };
}

async function resolveAreaCoord(area) {
  const queries = buildQueries(area);
  for (const q of queries) {
    const data = await fetchNominatim(q);
    if (data && data.length) {
      const lat = parseFloat(data[0].lat);
      const lon = parseFloat(data[0].lon);
      if (!isNaN(lat) && !isNaN(lon)) return { area: normalizeAreaLabel(area), lat, lon };
    }
  }
  return null;
}

async function ensureServiceAreaCoords(provider) {
  const areas = getProviderAreas(provider);
  const coords = [];
  let changed = false;

  for (const area of areas) {
    const stored = getStoredAreaCoord(provider, area);
    if (stored) {
      coords.push({ ...stored, area });
      continue;
    }

    const resolved = await resolveAreaCoord(area);
    if (resolved) {
      coords.push(resolved);
      changed = true;
    } else {
      console.warn("Géocodage introuvable pour zone :", area);
    }
  }

  if (coords.length) {
    provider.serviceAreaCoords = coords;
    if (!hasValidCoords(provider)) {
      provider.lat = coords[0].lat;
      provider.lon = coords[0].lon;
    }
  }

  return { provider, changed };
}

function renderProviderMarkers(provider, opts = {}) {
  if (!opts.skipRemove) removeProviderMarkers(provider);

  const areas = getProviderAreas(provider);
  if (areas.length) {
    let firstMarker = null;
    areas.forEach(area => {
      const coord = getStoredAreaCoord(provider, area);
      if (!coord) return;
      const markerProvider = { ...provider, lat: coord.lat, lon: coord.lon, address: area };
      const marker = createMarkerForZone(markerProvider, area);
      if (!firstMarker) firstMarker = marker;
    });

    if (opts.pan && firstMarker) map.setView(firstMarker.getLatLng(), Math.max(map.getZoom(), 11));
    if (opts.open && firstMarker) firstMarker.openPopup();
    return firstMarker;
  }

  if (hasValidCoords(provider)) {
    const marker = upsertMarker(normalizeCoords(provider));
    if (opts.pan) map.setView(marker.getLatLng(), Math.max(map.getZoom(), 11));
    if (opts.open) marker.openPopup();
    return marker;
  }

  return null;
}

function createMarkerForZone(p, area) {
  const key = zoneMarkerKey(p, area);

  const existing = markerIndex.get(key);
  if (existing) {
    markerLayer.removeLayer(existing.marker);
    markerIndex.delete(key);
  }

  const m = L.marker([p.lat, p.lon]).bindPopup(
    `<strong>${p.companyName || ""}</strong><br>
    ${p.firstName || ""} ${p.contactName || ""}<br>
    ${p.email || ""}<br>
    ${p.phone || ""}<br>
    <em>Zone : ${area || ""}</em>`
  );

  markerLayer.addLayer(m);
  markerIndex.set(key, { marker: m, data: p });
  return m;
}

// ----------------- Géocodage -> Marker (utilise lat/lon si présents) -----------------
async function geocodeAndAddToMap(provider, opts = { pan: false, open: false }) {
  try {
    if (!provider) return;

    const { provider: enriched, changed } = await ensureServiceAreaCoords(provider);
    upsertProviderState(enriched);

    if (changed && fireSync.online && enriched.id) {
      await db.collection("prestataires").doc(enriched.id).set({
        serviceAreaCoords: enriched.serviceAreaCoords || [],
        lat: enriched.lat ?? null,
        lon: enriched.lon ?? null
      }, { merge: true });
    }

    const marker = renderProviderMarkers(enriched, opts);
    if (marker) fitMapToAllMarkers();
  } catch (e) {
    console.error("[geocodeAndAddToMap error]", e);
  }
}
// ----------------- Zones d’intervention -----------------
function addServiceArea(value = "") {
  const container = document.getElementById("serviceAreas");
  if (!container) return;

  const row = document.createElement("div");
  row.className = "service-area-row";

  row.innerHTML = `
    <input type="text" class="service-area-input" placeholder="Ville ou département" value="${String(value).replace(/"/g, "&quot;")}">
    <button type="button" onclick="removeServiceArea(this)">❌</button>
  `;

  container.appendChild(row);
}

function removeServiceArea(button) {
  const row = button.closest(".service-area-row");
  if (row) row.remove();
}

function getServiceAreas() {
  return Array.from(document.querySelectorAll(".service-area-input"))
    .map(input => input.value.trim())
    .filter(Boolean);
}

function setServiceAreas(areas = []) {
  const container = document.getElementById("serviceAreas");
  if (!container) return;

  container.innerHTML = "";

  if (!areas.length) {
    addServiceArea();
    return;
  }

  areas.forEach(area => addServiceArea(area));
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
  setServiceAreas([]);
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
    serviceAreas: getServiceAreas(),
    email: document.getElementById("email").value,
    phone: document.getElementById("phone").value,
    rate: document.getElementById("rate").value,
    travelFees: document.getElementById("travelFees").value,
    totalCost: document.getElementById("totalCost").value
  };
  if (editingKey) {
  const list = getProviders();
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
function calculateDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const distanceKm = calculateDistanceKm;

function countryForGeocode(country) {
  const countries = {
    "France": "France",
    "Belgique": "Belgium",
    "Suisse": "Switzerland",
    "Luxembourg": "Luxembourg",
    "Espagne": "Spain",
    "Italie": "Italy",
    "Allemagne": "Germany",
    "Royaume-Uni": "United Kingdom"
  };
  return countries[country] || country;
}

async function geocodeAddress(address, country) {
  const cleanAddress = normalizeAreaLabel(address);
  const cleanCountry = normalizeAreaLabel(country);
  if (!cleanCountry) throw new Error("country_missing");
  if (!cleanAddress) throw new Error("address_missing");

  const query = `${cleanAddress}, ${countryForGeocode(cleanCountry)}`;
  const data = await fetchNominatim(query);
  if (!data || !data.length) return null;

  const lat = parseFloat(data[0].lat);
  const lon = parseFloat(data[0].lon);
  if (isNaN(lat) || isNaN(lon)) return null;
  return { lat, lon, label: query };
}

async function getProviderSearchCandidates(provider, searchedCity) {
  const searchedKey = areaKey(searchedCity);
  const candidates = [];
  const coords = Array.isArray(provider.serviceAreaCoords) ? provider.serviceAreaCoords : [];

  coords.forEach(coord => {
    if (!hasValidCoords(coord)) return;
    candidates.push({
      provider,
      area: normalizeAreaLabel(coord.area || provider.address || ""),
      lat: parseFloat(coord.lat),
      lon: parseFloat(coord.lon),
      exactAreaMatch: areaKey(coord.area) === searchedKey
    });
  });

  const areas = getProviderAreas(provider);
  for (const area of areas) {
    const alreadyKnown = candidates.some(c => areaKey(c.area) === areaKey(area));
    if (alreadyKnown || areaKey(area) !== searchedKey) continue;

    const resolved = await resolveAreaCoord(area);
    if (resolved) {
      candidates.push({
        provider,
        area,
        lat: resolved.lat,
        lon: resolved.lon,
        exactAreaMatch: true
      });
    }
  }

  if (!candidates.length && hasValidCoords(provider)) {
    candidates.push({
      provider,
      area: normalizeAreaLabel(provider.address || ""),
      lat: parseFloat(provider.lat),
      lon: parseFloat(provider.lon),
      exactAreaMatch: areaKey(provider.address) === searchedKey
    });
  }

  return candidates;
}

async function findNearestProvider(searchLat, searchLng, providers, searchedAddress = "") {
  let nearest = null;
  let minDistance = Infinity;

  for (const provider of providers) {
    const candidates = await getProviderSearchCandidates(provider, searchedAddress);
    for (const candidate of candidates) {
      const distance = calculateDistanceKm(searchLat, searchLng, candidate.lat, candidate.lon);
      if (distance < minDistance) {
        minDistance = distance;
        nearest = {
          ...candidate.provider,
          lat: candidate.lat,
          lon: candidate.lon,
          matchedArea: candidate.area,
          exactAreaMatch: candidate.exactAreaMatch,
          distanceKm: distance
        };
      }
    }
  }

  return nearest;
}

function showSearchResult(searchPoint, nearest) {
  if (window.searchHighlightLayer) {
    map.removeLayer(window.searchHighlightLayer);
  }

  window.searchHighlightLayer = L.layerGroup().addTo(map);
  const searchMarker = L.circleMarker([searchPoint.lat, searchPoint.lon], {
    radius: 8,
    color: "#d32f2f",
    weight: 3,
    fillColor: "#ffffff",
    fillOpacity: 1
  }).bindPopup(`<strong>Recherche</strong><br>${searchPoint.label || ""}`);

  const providerHighlight = L.circle([nearest.lat, nearest.lon], {
    radius: 2500,
    color: "#1b8a5a",
    weight: 3,
    fillColor: "#2ecc71",
    fillOpacity: 0.18
  });

  const linkLine = L.polyline(
    [[searchPoint.lat, searchPoint.lon], [nearest.lat, nearest.lon]],
    { color: "#1b8a5a", weight: 3, opacity: 0.75, dashArray: "8 8" }
  );

  window.searchHighlightLayer.addLayer(searchMarker);
  window.searchHighlightLayer.addLayer(providerHighlight);
  window.searchHighlightLayer.addLayer(linkLine);

  const bounds = L.latLngBounds([
    [searchPoint.lat, searchPoint.lon],
    [nearest.lat, nearest.lon]
  ]);
  map.fitBounds(bounds.pad(0.25), { maxZoom: 12 });

  const areaLine = nearest.matchedArea ? `<br><em>Zone : ${nearest.matchedArea}</em>` : "";
  L.popup()
    .setLatLng([nearest.lat, nearest.lon])
    .setContent(`<strong>${nearest.companyName || '—'}</strong><br>${nearest.contactName || '—'}<br>${nearest.email || '—'}<br>${nearest.phone || '—'}${areaLine}`)
    .openOn(map);
}

async function handleSearch() {
  const city = document.getElementById("cityInput").value.trim();
  const country = document.getElementById("countrySelect")?.value || "";
  const resultEl = document.getElementById("searchResult");
  if (resultEl) resultEl.textContent = "";

  if (!country) {
    alert("Sélectionne un pays.");
    return;
  }
  if (!city) {
    alert("Saisis une ville ou une adresse.");
    return;
  }

  const searchPoint = await geocodeAddress(city, country);
  if (!searchPoint) {
    alert("Adresse introuvable.");
    return;
  }

  const providers = getProviders();
  if (!providers.length) {
    alert("Aucun prestataire disponible.");
    return;
  }

  const nearest = await findNearestProvider(searchPoint.lat, searchPoint.lon, providers, city);

  if (nearest) {
    showSearchResult(searchPoint, nearest);
    const distanceText = nearest.distanceKm != null ? nearest.distanceKm.toFixed(1) : "N/A";
    const areaText = nearest.matchedArea || nearest.address || "zone non précisée";
    if (resultEl) {
      resultEl.textContent = `Prestataire le plus proche : ${nearest.companyName || "—"} — ${areaText} — ${distanceText} km`;
    }
  } else {
    alert("Aucun prestataire avec coordonnées GPS disponible.");
  }
}

async function searchNearest() {
  return handleSearch();
}

// ----------------- Chargement & liste -----------------
function loadProvidersFromState() {
  clearMarkers();

  const providers = getProviders();

  if (!providers.length) {
    updateProviderListNow();
    return;
  }

  // 1) Affichage immédiat des prestataires déjà géocodés
  providers.forEach(p => {
    renderProviderMarkers(p, { skipRemove: true });
  });

  fitMapToAllMarkers();
  updateProviderListNow();
}

// --- rendu immédiat (non débouncé) de la liste ---
function updateProviderListNow() {
  const container = document.getElementById("providerList");
  if (!container) return;

  container.innerHTML = "";
  const providers = getProviders()
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
 const zonesText =
  Array.isArray(p.serviceAreas) && p.serviceAreas.length
    ? p.serviceAreas.join(", ")
    : (p.address || "—");

div.innerHTML = `
  <strong>${p.companyName || '—'}</strong><br>
  👤 ${p.contactName || '—'} ${p.firstName ? `(${p.firstName})` : ""}<br>
  📍 Zones : ${zonesText}<br>
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
  
  updateTechnicianCounter();
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
  const providers = getProviders();
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
  
  setServiceAreas(p.serviceAreas || []);
  if (typeof updateTotal === "function") updateTotal();

  editingKey = p.id || keyOf(p);
  addProvider();
}

async function deleteProviderByKey(k) {
  const providers = getProviders();
  const toDelete = findProviderByKey(providers, k);
  if (!toDelete) return alert("Prestataire introuvable.");

  if (!confirm("Confirmer la suppression ?")) return;

  try {
    await fireSync.remove(toDelete);
    removeProviderMarkers(toDelete);
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
  const providers = getProviders();
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
  const existing = getProviders();
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

  if (fireSync.online) await fireSync.pullAll(); else { clearMarkers(); loadProvidersFromState(); }

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
    <div style="width:100%; display:flex; justify-content:center; background:#fff;">
     <div style="
  width: 794px;                /* Largeur A4 */
  margin: 40px auto;           /* Centre + marge verticale */
  padding: 40px;               /* Marges internes */
  box-sizing: border-box;
  background: #ffffff;
  font-family: Arial, sans-serif;
  color: #000;
  border-radius: 10px;
">
        <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:2px solid #004080; padding-bottom:10px;">
          <img src="logikart-logo.png" alt="LOGIKART" style="height:50px;">
          <h2 style="text-align:center; flex-grow:1; color:#004080; margin:0;">Rapport d’intervention</h2>
          <div style="text-align:right; font-size:12px;">${values.date || ""}</div>
        </div>

<div style="margin-top:20px; display:grid; gap:12px;">

  <!-- Ticket -->
  <div style="border:1px solid #cfcfcf; border-radius:8px; padding:12px;">
    <div style="font-weight:700; margin-bottom:6px;">Ticket :</div>
    <div style="min-height:20px;">${values.ticket || ""}</div>
  </div>

  <!-- Adresse -->
  <div style="border:1px solid #cfcfcf; border-radius:8px; padding:12px;">
    <div style="font-weight:700; margin-bottom:6px;">Adresse du site :</div>
    <div style="min-height:20px;">${values.site || ""}</div>
  </div>

  <!-- Technicien -->
  <div style="border:1px solid #cfcfcf; border-radius:8px; padding:12px;">
    <div style="font-weight:700; margin-bottom:6px;">Nom du technicien :</div>
    <div style="min-height:20px;">${values.tech || ""}</div>
  </div>

<div style="border:1px solid #cfcfcf; border-radius:8px; padding:12px;">
  <div style="font-weight:700; margin-bottom:8px;">Travail à faire</div>
  ${values.tasks.map(task => `
    <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
      <div>${task.text || ""}</div>
      <div style="border:1px solid #000; width:14px; height:14px; text-align:center;">
        ${task.done ? "✓" : ""}
      </div>
    </div>
  `).join("")}
</div>

  <!-- Commentaires -->
  <div style="border:1px solid #cfcfcf; border-radius:8px; padding:12px;">
    <div style="font-weight:700; margin-bottom:8px;">Commentaires</div>
    <div style="border:1px solid #e1e1e1; border-radius:6px; padding:10px; min-height:110px; white-space:pre-wrap;">
      ${values.done || ""}
    </div>
  </div>

  <!-- Heures -->
  <div style="border:1px solid #cfcfcf; border-radius:8px; padding:12px; display:flex; gap:16px; justify-content:space-between;">
    <div style="width:48%;">
      <div style="font-weight:700; margin-bottom:6px;">Heure d’arrivée :</div>
      <div style="min-height:20px;">${values.start || ""}</div>
    </div>
    <div style="width:48%;">
      <div style="font-weight:700; margin-bottom:6px;">Heure de départ :</div>
      <div style="min-height:20px;">${values.end || ""}</div>
    </div>
  </div>

  <!-- Signatures -->
  <div style="border:1px solid #cfcfcf; border-radius:8px; padding:12px; display:flex; gap:16px; justify-content:space-between;">
    <div style="width:48%;">
      <div style="font-weight:700; margin-bottom:6px;">Signature du technicien :</div>
      <div style="border:1px solid #e1e1e1; border-radius:6px; height:70px;"></div>
      <div style="text-align:center; margin-top:6px; font-size:12px;">${values.signTech || ""}</div>
    </div>
    <div style="width:48%;">
      <div style="font-weight:700; margin-bottom:6px;">Signature du client :</div>
      <div style="border:1px solid #e1e1e1; border-radius:6px; height:70px;"></div>
      <div style="text-align:center; margin-top:6px; font-size:12px;">${values.signClient || ""}</div>
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

async function generatePDF() {
  const form = document.getElementById("reportForm");
  const get = (id) => form.querySelector(`[name="${id}"]`) || form.querySelector(`#${id}`);
  
  const tasks = Array.from(document.querySelectorAll(".taskInput")).map((input, i) => {
  const checked = document.querySelectorAll(".taskCheck")[i].checked;
  return {
    text: input.value,
    done: checked
  };
});
  
  const values = {
    ticket: get("ticket")?.value,
    date: get("interventionDate")?.value,
    site: get("siteAddress")?.value,
    tech: get("technician")?.value,
    tasks: tasks,
    done: get("done")?.value,
    start: get("start")?.value,
    end: get("end")?.value,
    signTech: get("signTech")?.value,
    signClient: get("signClient")?.value
  };

  if (typeof html2pdf === "undefined") {
    console.warn("[PDF] html2pdf non trouvé, fallback impression");
    printReport();
    return;
  }

  // ✅ Overlay “capturable” (dans le viewport), quasi invisible pour l’utilisateur
  const overlay = document.createElement("div");
  overlay.style.position = "fixed";
  overlay.style.inset = "0";
  overlay.style.zIndex = "999999";      // AU-DESSUS de tout
  overlay.style.background = "transparent";
  overlay.style.opacity = "0.01";       // 0.01 => rendu OK, invisible à l’œil
  overlay.style.pointerEvents = "none"; // ne bloque pas les clics

  const temp = document.createElement("div");
  temp.style.width = "794px";       // ~A4 @96dpi
  temp.style.margin = "0 auto";
  temp.style.background = "#fff";
  temp.innerHTML = buildReportHTML(values);

  // ✅ évite les soucis CORS sur l’image (même si locale)
  temp.querySelectorAll("img").forEach(img => img.setAttribute("crossorigin", "anonymous"));

  overlay.appendChild(temp);
  document.body.appendChild(overlay);

  // ✅ attendre images
  const imgs = Array.from(temp.querySelectorAll("img"));
  await Promise.all(imgs.map(img => img.complete ? Promise.resolve() : new Promise(res => img.onload = img.onerror = res)));

  // ✅ attendre 2 frames (sinon capture blanche sur certains navigateurs)
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  const prevX = window.scrollX, prevY = window.scrollY;
  window.scrollTo(0, 0);

  try {
    await html2pdf().set({
      margin: 0,
      filename: "rapport_intervention_LOGIKART.pdf",
      image: { type: "jpeg", quality: 0.98 },
      html2canvas: {
        scale: 2,
        useCORS: true,
        allowTaint: false,            // IMPORTANT : évite canvas “tainted” => pdf blanc
        backgroundColor: "#ffffff",
        scrollX: 0,
        scrollY: 0
      },
      jsPDF: { unit: "in", format: "a4", orientation: "portrait" }
    }).from(temp).save();
  } catch (err) {
    console.error("[PDF] Toujours blanc / erreur capture", err);
    // fallback: impression (au moins tu peux "Enregistrer en PDF")
    printReport();
  } finally {
    overlay.remove();
    window.scrollTo(prevX, prevY);
  }
}

function populateTechnicianSuggestions() {
  const datalist = document.getElementById("technicianList");
  if (!datalist) return;
  datalist.innerHTML = "";
  const providers = getProviders();
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

  // Sync Firestore si possible
  await fireSync.boot();
  updateTechnicianCounter();
  
  // Backfill asynchrone des fiches sans coords (une seule fois)
  setTimeout(backfillMissingCoords, 3000);

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
    badge.textContent = "HORS LIGNE";
    badge.classList.remove("online");
    badge.classList.add("offline");
  }
}
function toggleProviderList() {
  const list = document.getElementById("providerList");
  if (!list) return;

  const isHidden = list.style.display === "none" || !list.style.display;

  if (isHidden) {
    list.style.display = "block";
    updateProviderListNow(); // 🔥 FORCER affichage immédiat
  } else {
    list.style.display = "none";
  }
}

// ----------------- Backfill coords manquantes (asynchrone) -----------------
async function backfillMissingCoords() {
  if (!fireSync.online) return;
  const list = getProviders();
  let updated = 0;
  for (const p of list) {
    const before = JSON.stringify(p.serviceAreaCoords || []);
    const { provider: enriched } = await ensureServiceAreaCoords(p);
    const after = JSON.stringify(enriched.serviceAreaCoords || []);
    if (before !== after || !hasValidCoords(p)) {
      await fireSync.upsert(enriched); // merge Firestore + état mémoire
      renderProviderMarkers(enriched);
      updated++;
    }
  }
  if (updated) {
    fitMapToAllMarkers();
    console.log(`[Backfill] ${updated} prestataires enrichis en coordonnées de zones`);
  }
}
function updateSyncBadge() {
  const badge = document.getElementById("syncStatus");
  if (!badge) return;

  if (fireSync.online) {
    badge.textContent = "ONLINE";
    badge.classList.remove("offline");
    badge.classList.add("online");
  } else {
    badge.textContent = "HORS LIGNE";
    badge.classList.remove("online");
    badge.classList.add("offline");
  }
}
// ----------------- Compteur techniciens -----------------
function updateTechnicianCounter() {
  const counterEl = document.getElementById("techCount");
  if (!counterEl) return;

  const list = getProviders();
  const countFromMarkers = (typeof markerIndex !== "undefined" && markerIndex?.size) ? markerIndex.size : 0;
  const count = (list.length > 0) ? list.length : countFromMarkers;

  counterEl.textContent = String(count);
}
// ----------------- Tâches "Travail à faire" -----------------
function addTask(value = "", checked = false) {
  const container = document.getElementById("taskList");
  if (!container) return;

  const row = document.createElement("div");
  row.className = "task-row";

  row.innerHTML = `
    <input type="text" class="taskInput" placeholder="Tâche à effectuer" value="${String(value).replace(/"/g, '&quot;')}">
    <input type="checkbox" class="taskCheck" ${checked ? "checked" : ""}>
    <button type="button" class="taskDelete" title="Supprimer la tâche">🗑️</button>
  `;

  // suppression ligne
  row.querySelector(".taskDelete").addEventListener("click", () => {
  const rows = container.querySelectorAll(".task-row");
  if (rows.length <= 1) {
    // vide la seule ligne restante
    row.querySelector(".taskInput").value = "";
    row.querySelector(".taskCheck").checked = false;
    return;
  }
  row.remove();
});

  container.appendChild(row);
}

// Ajoute 1 ligne par défaut quand on ouvre le formulaire Rapport
const _openReportForm = window.openReportForm;
window.openReportForm = function () {
  if (typeof _openReportForm === "function") _openReportForm();

  const container = document.getElementById("taskList");
  if (container) {
    container.innerHTML = ""; // reset
    addTask();                // 1ère tâche vide
  }
};
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

window.editProvider = editProviderByKey;
window.deleteProvider = window.deleteProvider; // déjà défini
window.exportProviders = exportProviders;
window.openImportModal = openImportModal;
window.closeImportModal = closeImportModal;
window.handleImport = handleImport;

window.addTask = addTask;

window.addServiceArea = addServiceArea;
window.removeServiceArea = removeServiceArea;

// --------------------------------------------------------------------
// Production GitHub Pages : ajoute dans Firebase > Auth > Domaines autorisés
//   tech-logikart.github.io   (et localhost si besoin)
// Active "Anonymous" et publie les "Rules" Firestore.
// --------------------------------------------------------------------
