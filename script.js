/* LOGIKART – Script principal
   Objectifs de cette version :
   - Affichage rapide des pointeurs (géocodage mis en cache + parallélisation limitée)
   - Aucun zoom “prestataire par prestataire” au chargement (fitBounds en 1 fois)
   - Rapport d’intervention : un seul formulaire, techniciens proposés, PDF non-vierge
   - Menus / modales robustes (z-index + fermeture au clic extérieur)
*/

// -----------------------------
// 1) Carte Leaflet
// -----------------------------

const DEFAULT_VIEW = { center: [48.8566, 2.3522], zoom: 5 }; // Europe
const map = L.map('map', { zoomControl: true }).setView(DEFAULT_VIEW.center, DEFAULT_VIEW.zoom);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap contributors'
}).addTo(map);

let markers = []; // marqueurs individuels (pas de clustering)
let editingIndex = null;

// -----------------------------
// 2) Stockage prestataires
// -----------------------------

function getProviders() {
  return JSON.parse(localStorage.getItem('providers')) || [];
}

function setProviders(providers) {
  localStorage.setItem('providers', JSON.stringify(providers));
}

// -----------------------------
// 3) Géocodage – cache + limite de concurrence
// -----------------------------

const GEOCODE_PROXY = 'https://proxy-logikart.samir-mouheb.workers.dev/?url=';

function getGeocodeCache() {
  try {
    return JSON.parse(localStorage.getItem('geocodeCache') || '{}');
  } catch {
    return {};
  }
}

function setGeocodeCache(cache) {
  localStorage.setItem('geocodeCache', JSON.stringify(cache));
}

async function geocodeAddress(address) {
  const key = String(address || '').trim().toLowerCase();
  if (!key) return null;

  const cache = getGeocodeCache();
  if (cache[key] && typeof cache[key].lat === 'number' && typeof cache[key].lon === 'number') {
    return cache[key];
  }

  const nominatimUrl = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=1&accept-language=fr,en&q=' + encodeURIComponent(address);
  const url = GEOCODE_PROXY + encodeURIComponent(nominatimUrl);

  const res = await fetch(url);
  if (!res.ok) {
    // 429 = rate limit : on ne “spam” pas, on renvoie null et on laisse l’appelant gérer.
    return null;
  }
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) return null;

  const lat = parseFloat(data[0].lat);
  const lon = parseFloat(data[0].lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  cache[key] = { lat, lon, ts: Date.now() };
  setGeocodeCache(cache);

  return cache[key];
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let i = 0;

  const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = await mapper(items[idx], idx);
      } catch (e) {
        results[idx] = null;
        console.warn('mapLimit error:', e);
      }
    }
  });

  await Promise.all(workers);
  return results;
}

// -----------------------------
// 4) Marqueurs
// -----------------------------

function clearMarkers() {
  markers.forEach(m => map.removeLayer(m));
  markers = [];
}

function createPopupHtml(p) {
  const name = p.companyName || '';
  const contact = [p.firstName, p.contactName].filter(Boolean).join(' ').trim();
  const email = p.email || '';
  const phone = p.phone || '';
  const addr = p.address || '';
  return `
    <div style="min-width:220px">
      <div style="font-weight:700">${escapeHtml(name)}</div>
      ${contact ? `<div>👤 ${escapeHtml(contact)}</div>` : ''}
      ${addr ? `<div>📍 ${escapeHtml(addr)}</div>` : ''}
      ${email ? `<div>📧 ${escapeHtml(email)}</div>` : ''}
      ${phone ? `<div>📞 ${escapeHtml(phone)}</div>` : ''}
    </div>
  `;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function renderProvidersOnMap({ fit = true } = {}) {
  clearMarkers();
  const providers = getProviders();

  // Géocodage en parallèle limité (évite l’affichage “très lent”)
  const coords = await mapLimit(providers, 4, async (p) => {
    // Si on a déjà des coords stockées sur le prestataire, on les utilise.
    if (Number.isFinite(p.lat) && Number.isFinite(p.lon)) return { lat: p.lat, lon: p.lon };
    const c = await geocodeAddress(p.address);
    return c;
  });

  const bounds = [];

  providers.forEach((p, idx) => {
    const c = coords[idx];
    if (!c) return;
    const marker = L.marker([c.lat, c.lon]).addTo(map).bindPopup(createPopupHtml(p));
    markers.push(marker);
    bounds.push([c.lat, c.lon]);

    // On “mémorise” les coords sur le prestataire pour la prochaine fois (accélère énormément)
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) {
      p.lat = c.lat;
      p.lon = c.lon;
    }
  });

  // Sauvegarde des coords enrichies (si ajoutées)
  setProviders(providers);

  // 1 seul ajustement de vue (pas de zoom prestataire par prestataire)
  if (fit && bounds.length) {
    map.fitBounds(bounds, { padding: [30, 30] });
  }
}

// -----------------------------
// 5) Formulaire Prestataire (CRUD)
// -----------------------------

function addProvider() {
  document.getElementById('providerFormSection').style.display = 'flex';
}

function hideForm() {
  document.getElementById('providerForm').reset();
  document.getElementById('providerFormSection').style.display = 'none';
  editingIndex = null;
}

document.getElementById('providerForm').addEventListener('submit', handleFormSubmit);

async function handleFormSubmit(event) {
  event.preventDefault();

  const provider = {
    companyName: document.getElementById('companyName').value,
    contactName: document.getElementById('contactName').value,
    firstName: document.getElementById('firstName').value,
    address: document.getElementById('address').value,
    email: document.getElementById('email').value,
    phone: document.getElementById('phone').value,
    rate: document.getElementById('rate').value,
    travelFees: document.getElementById('travelFees').value,
    totalCost: document.getElementById('totalCost').value
  };

  const providers = getProviders();
  if (editingIndex !== null) providers[editingIndex] = { ...providers[editingIndex], ...provider };
  else providers.push(provider);

  setProviders(providers);

  updateProviderList();
  populateTechnicianSuggestions();
  await renderProvidersOnMap({ fit: false }); // ne recentre pas à chaque ajout
  hideForm();
}

function editProvider(index) {
  const providers = getProviders();
  const p = providers[index];
  if (!p) return;

  document.getElementById('companyName').value = p.companyName || '';
  document.getElementById('contactName').value = p.contactName || '';
  document.getElementById('firstName').value = p.firstName || '';
  document.getElementById('address').value = p.address || '';
  document.getElementById('email').value = p.email || '';
  document.getElementById('phone').value = p.phone || '';
  document.getElementById('rate').value = p.rate || '';
  document.getElementById('travelFees').value = p.travelFees || '';
  document.getElementById('totalCost').value = p.totalCost || '';

  // Si index.html définit updateTotal, on le laisse faire le calcul UI.
  if (typeof window.updateTotal === 'function') window.updateTotal();

  editingIndex = index;
  document.getElementById('providerFormSection').style.display = 'flex';
}

function deleteProvider(index) {
  const providers = getProviders();
  if (!providers[index]) return;
  if (!confirm('Confirmer la suppression ?')) return;
  providers.splice(index, 1);
  setProviders(providers);
  updateProviderList();
  populateTechnicianSuggestions();
  renderProvidersOnMap({ fit: true });
}

// -----------------------------
// 6) Liste des prestataires (panneau)
// -----------------------------

function toggleProviderList() {
  const list = document.getElementById('providerList');
  if (!list) return;
  const isHidden = getComputedStyle(list).display === 'none';
  list.style.display = isHidden ? 'block' : 'none';
}

function updateProviderList() {
  const container = document.getElementById('providerList');
  if (!container) return;

  container.innerHTML = '';
  const providers = getProviders();

  providers.forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'provider-entry';
    div.innerHTML = `
      <strong>${escapeHtml(p.companyName || '')}</strong><br>
      ${p.contactName ? `👤 ${escapeHtml([p.firstName, p.contactName].filter(Boolean).join(' '))}<br>` : ''}
      ${p.email ? `📧 ${escapeHtml(p.email)}<br>` : ''}
      ${p.phone ? `📞 ${escapeHtml(p.phone)}<br>` : ''}
      ${p.totalCost ? `💰 Tarif total HT : ${escapeHtml(p.totalCost)}<br>` : ''}
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;">
        <button type="button" onclick="editProvider(${i})">✏️ Modifier</button>
        <button type="button" onclick="deleteProvider(${i})">🗑️ Supprimer</button>
      </div>
    `;
    container.appendChild(div);
  });
}

// -----------------------------
// 7) Recherche prestataire le plus proche (simple)
// -----------------------------

async function searchNearest() {
  const city = document.getElementById('cityInput').value.trim();
  if (!city) return;

  const c = await geocodeAddress(city);
  if (!c) {
    alert('Ville non trouvée.');
    return;
  }

  const userLat = c.lat;
  const userLon = c.lon;

  const providers = getProviders();
  if (!providers.length) {
    alert('Aucun prestataire enregistré.');
    return;
  }

  // On réutilise les coords déjà enregistrées si possible
  let nearest = null;
  let minDistance = Infinity;

  for (const p of providers) {
    let lat = p.lat, lon = p.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      const g = await geocodeAddress(p.address);
      if (!g) continue;
      lat = g.lat; lon = g.lon;
      p.lat = lat; p.lon = lon;
    }
    const dist = Math.hypot(lat - userLat, lon - userLon);
    if (dist < minDistance) {
      minDistance = dist;
      nearest = { ...p, lat, lon };
    }
  }
  setProviders(providers);

  if (!nearest) {
    alert('Aucun prestataire trouvé.');
    return;
  }

  map.setView([nearest.lat, nearest.lon], 12);
  L.popup()
    .setLatLng([nearest.lat, nearest.lon])
    .setContent(createPopupHtml(nearest))
    .openOn(map);
}

// -----------------------------
// 8) Burger menu (ouverture/fermeture)
// -----------------------------

function setupBurgerMenu() {
  const burger = document.getElementById('burgerMenu');
  const dropdown = document.getElementById('menuDropdown');
  if (!burger || !dropdown) return;

  burger.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('hidden');
  });

  document.addEventListener('click', () => dropdown.classList.add('hidden'));
  dropdown.addEventListener('click', (e) => e.stopPropagation());
}

// -----------------------------
// 9) Rapport d’intervention (modale + PDF)
// -----------------------------

function openReportForm() {
  const modal = document.getElementById('reportModal');
  if (!modal) return;
  modal.style.display = 'flex';
  populateTechnicianSuggestions();
}

function closeReportForm() {
  const modal = document.getElementById('reportModal');
  if (!modal) return;
  modal.style.display = 'none';
}

function populateTechnicianSuggestions() {
  const datalist = document.getElementById('technicianList');
  if (!datalist) return;

  datalist.innerHTML = '';
  const providers = getProviders();

  const uniq = new Set();
  providers.forEach(p => {
    const full = [p.firstName, p.contactName].filter(Boolean).join(' ').trim();
    if (full) uniq.add(full);
  });

  [...uniq].sort((a, b) => a.localeCompare(b, 'fr')).forEach(name => {
    const option = document.createElement('option');
    option.value = name;
    datalist.appendChild(option);
  });
}

function getReportValues() {
  const form = document.getElementById('reportForm');
  if (!form) return null;

  const get = (name) => (form.querySelector(`[name="${name}"]`)?.value || '').trim();
  return {
    ticket: get('ticket'),
    interventionDate: get('interventionDate'),
    siteAddress: get('siteAddress'),
    technician: get('technician'),
    todo: get('todo'),
    done: get('done'),
    start: get('start'),
    end: get('end'),
    signTech: get('signTech'),
    signClient: get('signClient')
  };
}

function buildReportDom(values) {
  const wrap = document.createElement('div');
  wrap.style.fontFamily = 'Arial, sans-serif';
  wrap.style.color = '#000';
  wrap.style.padding = '20px';
  wrap.style.width = '794px'; // ~ A4 @ 96dpi (stabilise le rendu)

  wrap.innerHTML = `
    <div style="display:flex; align-items:center; gap:14px; border-bottom:2px solid #004080; padding-bottom:10px;">
      <img src="logikart-logo.png" alt="LOGIKART" style="height:50px;" />
      <div style="flex:1; text-align:center;">
        <div style="font-size:18px; font-weight:700; color:#004080;">Rapport d’intervention LOGIKART</div>
        <div style="font-size:12px; opacity:.85;">${escapeHtml(values.interventionDate)}</div>
      </div>
    </div>

    <div style="margin-top:16px; line-height:1.4;">
      <p><strong>Ticket :</strong> ${escapeHtml(values.ticket)}</p>
      <p><strong>Adresse du site :</strong> ${escapeHtml(values.siteAddress)}</p>
      <p><strong>Technicien :</strong> ${escapeHtml(values.technician)}</p>
      <p><strong>Heure d’arrivée :</strong> ${escapeHtml(values.start)} &nbsp; | &nbsp; <strong>Heure de départ :</strong> ${escapeHtml(values.end)}</p>
    </div>

    <div style="margin-top:12px;">
      <h3 style="margin:0 0 6px 0; color:#004080;">Travail à faire</h3>
      <div style="border:1px solid #ccc; padding:10px; min-height:80px; white-space:pre-wrap;">${escapeHtml(values.todo)}</div>
    </div>

    <div style="margin-top:12px;">
      <h3 style="margin:0 0 6px 0; color:#004080;">Travail effectué</h3>
      <div style="border:1px solid #ccc; padding:10px; min-height:120px; white-space:pre-wrap;">${escapeHtml(values.done)}</div>
    </div>

    <div style="margin-top:16px; display:flex; gap:16px;">
      <div style="flex:1;">
        <div style="font-weight:700; margin-bottom:6px;">Signature technicien</div>
        <div style="border:1px solid #ccc; height:70px;"></div>
        <div style="text-align:center; margin-top:6px;">${escapeHtml(values.signTech)}</div>
      </div>
      <div style="flex:1;">
        <div style="font-weight:700; margin-bottom:6px;">Signature client</div>
        <div style="border:1px solid #ccc; height:70px;"></div>
        <div style="text-align:center; margin-top:6px;">${escapeHtml(values.signClient)}</div>
      </div>
    </div>
  `;

  return wrap;
}

async function generatePDF() {
  const values = getReportValues();
  if (!values) return;

  // On construit un DOM hors de la modale pour éviter les rendus blancs (display/overflow/z-index)
  const container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.left = '-10000px';
  container.style.top = '0';
  container.style.background = 'white';
  container.style.zIndex = '999999';

  const reportDom = buildReportDom(values);
  container.appendChild(reportDom);
  document.body.appendChild(container);

  // Laisse un “tick” pour que l’image/logo se charge avant capture
  await new Promise(r => setTimeout(r, 250));

  const opt = {
    margin: 10,
    filename: 'rapport_intervention_LOGIKART.pdf',
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
    jsPDF: { unit: 'pt', format: 'a4', orientation: 'portrait' }
  };

  try {
    await html2pdf().set(opt).from(reportDom).save();
  } finally {
    document.body.removeChild(container);
  }
}

// -----------------------------
// 10) Itinéraire (laissé tel quel : vos fonctions peuvent exister ailleurs)
// -----------------------------

function openItineraryTool() {
  const modal = document.getElementById('itineraryModal');
  if (!modal) return;
  modal.style.display = 'flex';
  const result = document.getElementById('routeResult');
  if (result) result.innerHTML = '';
}

function closeItineraryModal() {
  const modal = document.getElementById('itineraryModal');
  if (!modal) return;
  modal.style.display = 'none';
  document.getElementById('itineraryForm')?.reset();
  const extra = document.getElementById('extraDestinations');
  if (extra) extra.innerHTML = '';
}

function addDestinationField() {
  const container = document.getElementById('extraDestinations');
  if (!container) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Destination supplémentaire';
  input.classList.add('extra-destination');
  container.appendChild(input);
}

// ---- Itinéraire : Nominatim -> OpenRouteService (comme votre version précédente)
// IMPORTANT : remplacez ORS_API_KEY par votre clé ORS si besoin.
// Si vous ne mettez pas de clé, le calcul d'itinéraire affichera un message clair.
const ORS_API_KEY = window.eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6ImQ4YTg5NTg4NjE0OTQ5NjZhMDY3YzgxZjJjOGE3ODI3IiwiaCI6Im11cm11cjY0In0= || '';

async function calculateRoute() {
  const start = document.getElementById('startAddress')?.value?.trim() || '';
  const end = document.getElementById('endAddress')?.value?.trim() || '';
  const extras = Array.from(document.getElementsByClassName('extra-destination'))
    .map(i => i.value.trim())
    .filter(Boolean);

  if (!start || !end) {
    alert('Veuillez saisir une adresse de départ et de destination.');
    return;
  }

  const points = [start, ...extras, end];

  // Adresses -> coordonnées
  const coords = [];
  for (const address of points) {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(address)}`;
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json'
      }
    });
    const data = await res.json();
    if (!data?.length) {
      alert(`Adresse non trouvée : ${address}`);
      return;
    }
    // ORS attend [lon, lat]
    coords.push([parseFloat(data[0].lon), parseFloat(data[0].lat)]);
  }

  if (!ORS_API_KEY) {
    alert('Clé OpenRouteService manquante (ORS_API_KEY).');
    return;
  }

  const orsRes = await fetch('https://api.openrouteservice.org/v2/directions/driving-car/geojson', {
    method: 'POST',
    headers: {
      'Authorization': ORS_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      coordinates: coords,
      language: 'fr',
      instructions: true
    })
  });

  if (!orsRes.ok) {
    alert('Erreur lors du calcul d’itinéraire.');
    return;
  }

  const geojson = await orsRes.json();

  // Instructions
  const steps = geojson?.features?.[0]?.properties?.segments?.[0]?.steps || [];
  window.lastRouteInstructions = steps.map((step, i) => `${i + 1}. ${step.instruction} (${(step.distance / 1000).toFixed(2)} km)`);

  // Affiche le trajet sur la carte
  if (window.routeLine) map.removeLayer(window.routeLine);
  window.routeLine = L.geoJSON(geojson, { style: { weight: 4 } }).addTo(map);
  map.fitBounds(window.routeLine.getBounds());

  const summary = geojson?.features?.[0]?.properties?.summary;
  const distanceKm = summary ? (summary.distance / 1000).toFixed(2) : '0';
  const durationMin = summary ? Math.round(summary.duration / 60) : 0;

  const result = document.getElementById('routeResult');
  if (result) {
    result.innerHTML = `
      <p>📏 Distance totale : <strong>${distanceKm} km</strong></p>
      <p>⏱️ Durée estimée : <strong>${durationMin} minutes</strong></p>
    `;
  }
  document.getElementById('exportPdfBtn')?.style && (document.getElementById('exportPdfBtn').style.display = 'inline-block');
}

function exportItineraryToPDF() {
  const start = document.getElementById('startAddress')?.value?.trim() || '';
  const end = document.getElementById('endAddress')?.value?.trim() || '';
  const extras = Array.from(document.getElementsByClassName('extra-destination'))
    .map(i => i.value.trim())
    .filter(Boolean);

  const distanceText = document.querySelector('#routeResult')?.innerText || '';

  if (typeof leafletImage !== 'function') {
    alert('leaflet-image manquant.');
    return;
  }

  leafletImage(map, function (err, canvas) {
    if (err) {
      alert('Erreur lors du rendu de la carte.');
      return;
    }

    const mapImage = canvas.toDataURL('image/jpeg');
    const container = document.createElement('div');
    container.style.padding = '20px';
    container.style.fontFamily = 'Arial, sans-serif';

    container.innerHTML = `
      <h2 style="color:#004080; margin-top:0;">🧭 Itinéraire LOGIKART</h2>
      <p><strong>Départ :</strong> ${escapeHtml(start)}</p>
      ${extras.map((dest, i) => `<p><strong>Étape ${i + 1} :</strong> ${escapeHtml(dest)}</p>`).join('')}
      <p><strong>Arrivée :</strong> ${escapeHtml(end)}</p>
      <p style="margin-top:10px;">${escapeHtml(distanceText).replace(/\n/g, '<br>')}</p>
    `;

    if (window.lastRouteInstructions && window.lastRouteInstructions.length) {
      const instructionsHtml = window.lastRouteInstructions.map(i => `<li>${escapeHtml(i)}</li>`).join('');
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
      margin: 10,
      filename: 'itineraire_LOGIKART.pdf',
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
      jsPDF: { unit: 'pt', format: 'a4', orientation: 'portrait' }
    }).from(container).save();
  });
}
// 11) Bootstrap
// -----------------------------

document.addEventListener('DOMContentLoaded', async () => {
  setupBurgerMenu();
  updateProviderList();
  populateTechnicianSuggestions();
  await renderProvidersOnMap({ fit: true });
});

// Expose globalement (utilisé par les onclick="...")
window.addProvider = addProvider;
window.hideForm = hideForm;
window.searchNearest = searchNearest;
window.toggleProviderList = toggleProviderList;
window.editProvider = editProvider;
window.deleteProvider = deleteProvider;
window.openItineraryTool = openItineraryTool;
window.closeItineraryModal = closeItineraryModal;
window.addDestinationField = addDestinationField;
window.openReportForm = openReportForm;
window.closeReportForm = closeReportForm;
window.generatePDF = generatePDF;
window.updateProviderList = updateProviderList;
window.populateTechnicianSuggestions = populateTechnicianSuggestions;
