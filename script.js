// LOGIKART - script.js
// Robuste: évite les crashes qui rendent les boutons inactifs et la carte blanche.

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  function safeJsonParse(s, fallback) {
    try { return JSON.parse(s); } catch { return fallback; }
  }

  function readProviders() {
    return safeJsonParse(localStorage.getItem('providers'), []);
  }

  function writeProviders(providers) {
    localStorage.setItem('providers', JSON.stringify(providers));
  }

  
  // ---------- Storage helpers ----------
  function readTechnicians() {
    return safeJsonParse(localStorage.getItem('technicians'), []);
  }

  function writeTechnicians(techs) {
    localStorage.setItem('technicians', JSON.stringify(techs));
  }

  function readGeocodeCache() {
    return safeJsonParse(localStorage.getItem('geocodeCache'), {});
  }

  function writeGeocodeCache(cache) {
    localStorage.setItem('geocodeCache', JSON.stringify(cache));
  }

function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ---------- Map ----------
  let map = null;
  let markers = [];

  function clearMarkers() {
    if (!map) return;
    for (const m of markers) map.removeLayer(m);
    markers = [];
  }

    const inFlightGeocode = new Map();

  async function geocode(address) {
    const q = String(address || '').trim();
    if (!q) return null;

    const key = q.toLowerCase();
    const cache = readGeocodeCache();
    if (cache[key]) return cache[key];

    if (inFlightGeocode.has(key)) return inFlightGeocode.get(key);

    const p = (async () => {
      const url = 'https://proxy-logikart.samir-mouheb.workers.dev/?url=' +
        encodeURIComponent('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + q);

      const res = await fetch(url);
      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) return null;

      const geo = { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
      cache[key] = geo;
      writeGeocodeCache(cache);
      return geo;
    })();

    inFlightGeocode.set(key, p);
    try { return await p; }
    finally { inFlightGeocode.delete(key); }
  }

  function markerPopup(provider) {
    return (
      '<strong>' + escapeHtml(provider.companyName) + '</strong><br>' +
      '👤 ' + escapeHtml(provider.firstName ? (provider.firstName + ' ' + provider.contactName) : provider.contactName) + '<br>' +
      '📧 ' + escapeHtml(provider.email) + '<br>' +
      '📞 ' + escapeHtml(provider.phone)
    );
  }

  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }



    async function geocodeAndAddToMap(provider) {
    try {
      if (!map) return null;

      // Utilise les coordonnées déjà connues (affichage instantané)
      let geo = (provider && typeof provider.lat === 'number' && typeof provider.lon === 'number')
        ? { lat: provider.lat, lon: provider.lon }
        : null;

      // Sinon géocode (avec cache) puis mémorise sur le prestataire
      if (!geo) {
        geo = await geocode(provider.address);
        if (!geo) {
          console.warn('Géocodage introuvable pour:', provider.address);
          return null;
        }
        provider.lat = geo.lat;
        provider.lon = geo.lon;
      }

      const marker = L.marker([geo.lat, geo.lon]).addTo(map).bindPopup(markerPopup(provider));
      markers.push(marker);
      return geo;
    } catch (e) {
      console.error('Erreur géocodage:', e);
      return null;
    }
  }

    async function loadProvidersToMap() {
    clearMarkers();
    const providers = readProviders();

    // Conserve les coordonnées si on modifie sans changer l'adresse
    if (editingIndex !== null && providers[editingIndex] && providers[editingIndex].address === provider.address) {
      provider.lat = providers[editingIndex].lat;
      provider.lon = providers[editingIndex].lon;
    }

    let changed = false;

    // Géocodage en série légère (évite 429) + cache local (accélère fortement après 1er passage)
    for (const p of providers) {
      const hadCoords = (typeof p.lat === 'number' && typeof p.lon === 'number');
      // eslint-disable-next-line no-await-in-loop
      await geocodeAndAddToMap(p);
      if (!hadCoords && typeof p.lat === 'number' && typeof p.lon === 'number') changed = true;
    }

    if (changed) writeProviders(providers);
    updateProviderList();
  }

  // ---------- UI Prestataires ----------
  let editingIndex = null;

  function showProviderForm() {
    const overlay = $('providerFormSection');
    if (overlay) overlay.style.display = 'flex';
  }

  function hideProviderForm() {
    const form = $('providerForm');
    if (form) form.reset();
    const overlay = $('providerFormSection');
    if (overlay) overlay.style.display = 'none';
    editingIndex = null;
  }

  function updateProviderList() {
    const container = $('providerList');
    if (!container) return;

    const providers = readProviders();

    // Conserve les coordonnées si on modifie sans changer l'adresse
    if (editingIndex !== null && providers[editingIndex] && providers[editingIndex].address === provider.address) {
      provider.lat = providers[editingIndex].lat;
      provider.lon = providers[editingIndex].lon;
    }

    container.innerHTML = '';

    providers.forEach((p, i) => {
      const div = document.createElement('div');
      div.className = 'provider-entry';
      div.innerHTML =
        '<strong>' + escapeHtml(p.companyName) + '</strong><br>' +
        '👤 ' + escapeHtml((p.firstName ? (p.firstName + ' ') : '') + (p.contactName || '')) + '<br>' +
        '📧 ' + escapeHtml(p.email || '') + '<br>' +
        '📞 ' + escapeHtml(p.phone || '') + '<br>' +
        '💰 Tarif total HT : ' + escapeHtml(p.totalCost || 'N/A') + '<br>' +
        '<div style="display:flex; gap:8px; margin-top:8px; flex-wrap:wrap;">' +
        '<button type="button" onclick="editProvider(' + i + ')">✏️ Modifier</button>' +
        '<button type="button" onclick="deleteProvider(' + i + ')">🗑️ Supprimer</button>' +
        '</div>';

      container.appendChild(div);
    });
  }

  function editProvider(index) {
    const providers = readProviders();

    // Conserve les coordonnées si on modifie sans changer l'adresse
    if (editingIndex !== null && providers[editingIndex] && providers[editingIndex].address === provider.address) {
      provider.lat = providers[editingIndex].lat;
      provider.lon = providers[editingIndex].lon;
    }

    const p = providers[index];
    if (!p) return;

    $('companyName').value = p.companyName || '';
    $('contactName').value = p.contactName || '';
    $('firstName').value = p.firstName || '';
    $('address').value = p.address || '';
    $('email').value = p.email || '';
    $('phone').value = p.phone || '';
    $('rate').value = p.rate || '';
    $('travelFees').value = p.travelFees || '';
    $('totalCost').value = p.totalCost || '';

    editingIndex = index;
    showProviderForm();
  }

  function deleteProvider(index) {
    const providers = readProviders();

    // Conserve les coordonnées si on modifie sans changer l'adresse
    if (editingIndex !== null && providers[editingIndex] && providers[editingIndex].address === provider.address) {
      provider.lat = providers[editingIndex].lat;
      provider.lon = providers[editingIndex].lon;
    }

    if (!providers[index]) return;
    if (!confirm('Confirmer la suppression ?')) return;
    providers.splice(index, 1);
    writeProviders(providers);
    loadProvidersToMap();
  }

  async function handleFormSubmit(event) {
    event.preventDefault();

    const provider = {
      companyName: $('companyName').value,
      contactName: $('contactName').value,
      firstName: $('firstName').value,
      address: $('address').value,
      email: $('email').value,
      phone: $('phone').value,
      rate: $('rate').value,
      travelFees: $('travelFees').value,
      totalCost: $('totalCost').value
    };

    const providers = readProviders();

    // Conserve les coordonnées si on modifie sans changer l'adresse
    if (editingIndex !== null && providers[editingIndex] && providers[editingIndex].address === provider.address) {
      provider.lat = providers[editingIndex].lat;
      provider.lon = providers[editingIndex].lon;
    }

    if (editingIndex !== null) providers[editingIndex] = provider;
    else providers.push(provider);
    writeProviders(providers);

    hideProviderForm();
    await loadProvidersToMap();
  }

  // ---------- Search nearest ----------
    async function searchNearest() {
    const city = ($('cityInput')?.value || '').trim();
    if (!city) return;

    const cityGeo = await geocode(city);
    if (!cityGeo) {
      alert('Ville non trouvée.');
      return;
    }

    const userLat = cityGeo.lat;
    const userLon = cityGeo.lon;

    const providers = readProviders();

    // Conserve les coordonnées si on modifie sans changer l'adresse
    if (editingIndex !== null && providers[editingIndex] && providers[editingIndex].address === provider.address) {
      provider.lat = providers[editingIndex].lat;
      provider.lon = providers[editingIndex].lon;
    }

    let nearest = null;
    let minKm = Infinity;
    let changed = false;

    for (const p of providers) {
      let lat = (typeof p.lat === 'number') ? p.lat : null;
      let lon = (typeof p.lon === 'number') ? p.lon : null;

      if (lat === null || lon === null) {
        // eslint-disable-next-line no-await-in-loop
        const g = await geocode(p.address);
        if (!g) continue;
        p.lat = g.lat; p.lon = g.lon;
        lat = g.lat; lon = g.lon;
        changed = true;
      }

      const km = haversineKm(userLat, userLon, lat, lon);
      if (km < minKm) {
        minKm = km;
        nearest = { ...p, lat, lon };
      }
    }

    if (changed) writeProviders(providers);

    if (nearest && map) {
      map.setView([nearest.lat, nearest.lon], 12);
      L.popup()
        .setLatLng([nearest.lat, nearest.lon])
        .setContent(markerPopup(nearest) + '<br><small>📍 Distance approx. : ' + minKm.toFixed(1) + ' km</small>')
        .openOn(map);
    } else {
      alert('Aucun prestataire trouvé.');
    }
  }

  // ---------- Burger menu ----------
  function initBurgerMenu() {
    const burger = $('burgerMenu');
    const dropdown = $('menuDropdown');
    if (!burger || !dropdown) return;

    burger.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.toggle('hidden');
    });

    document.addEventListener('click', () => {
      dropdown.classList.add('hidden');
    });
  }

  function toggleProviderList() {
    const list = $('providerList');
    if (!list) return;
    list.style.display = (list.style.display === 'none' || list.style.display === '') ? 'block' : 'none';
  }


  // ---------- Techniciens (import / export) ----------
  function mergeUnique(a, b) {
    const out = [];
    const seen = new Set();
    [...a, ...b].forEach(x => {
      const v = (x || '').trim();
      if (!v || seen.has(v)) return;
      seen.add(v);
      out.push(v);
    });
    return out;
  }

  function importTechnicians() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,.txt,.json';
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;

      const text = await file.text();
      let names = [];

      try {
        if (file.name.toLowerCase().endsWith('.json')) {
          const arr = safeJsonParse(text, []);
          if (Array.isArray(arr)) names = arr.map(String);
        } else {
          // CSV/TXT : 1 nom par ligne ou première colonne
          names = text
            .split(/\r?\n/)
            .map(l => l.split(';')[0].split(',')[0].trim())
            .filter(Boolean);
        }
      } catch (e) {
        console.error(e);
        alert('Fichier illisible.');
        return;
      }

      const current = readTechnicians();
      const merged = mergeUnique(current, names);
      writeTechnicians(merged);
      alert('Techniciens importés : ' + merged.length);
    });
    input.click();
  }

  function exportTechnicians() {
    // Export union: techniciens importés + techniciens issus des prestataires
    const providers = readProviders();

    // Conserve les coordonnées si on modifie sans changer l'adresse
    if (editingIndex !== null && providers[editingIndex] && providers[editingIndex].address === provider.address) {
      provider.lat = providers[editingIndex].lat;
      provider.lon = providers[editingIndex].lon;
    }

    const fromProviders = providers
      .map(p => ((p.firstName || '') + ' ' + (p.contactName || '')).trim())
      .filter(Boolean);

    const merged = mergeUnique(readTechnicians(), fromProviders);
    const csv = merged.join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'techniciens_logikart.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }



  // ---------- Rapport (PDF fiable) ----------
  function openReportForm() {
    const modal = $('reportModal');
    if (modal) modal.style.display = 'flex';
    populateTechnicianSuggestions();
  }

  function closeReportForm() {
    const modal = $('reportModal');
    if (modal) modal.style.display = 'none';
  }

    function populateTechnicianSuggestions() {
    const datalist = $('technicianList');
    if (!datalist) return;
    datalist.innerHTML = '';

    const providers = readProviders();

    // Conserve les coordonnées si on modifie sans changer l'adresse
    if (editingIndex !== null && providers[editingIndex] && providers[editingIndex].address === provider.address) {
      provider.lat = providers[editingIndex].lat;
      provider.lon = providers[editingIndex].lon;
    }

    const techs = readTechnicians();
    const seen = new Set();

    const add = (name) => {
      const n = (name || '').trim();
      if (!n || seen.has(n)) return;
      seen.add(n);
      const opt = document.createElement('option');
      opt.value = n;
      datalist.appendChild(opt);
    };

    // 1) depuis les prestataires
    providers.forEach(p => {
      const name = ((p.firstName || '') + ' ' + (p.contactName || '')).trim();
      add(name);
    });

    // 2) depuis la liste techniciens importée (si présente)
    techs.forEach(add);
  }

  function reportValues() {
    const form = $('reportForm');
    const get = (name) => (form?.querySelector('[name="' + name + '"]')?.value || '').trim();
    return {
      ticket: get('ticket'),
      date: get('interventionDate'),
      site: get('siteAddress'),
      tech: get('technician'),
      todo: get('todo'),
      done: get('done'),
      start: get('start'),
      end: get('end'),
      signTech: get('signTech'),
      signClient: get('signClient')
    };
  }

  function buildReportNode(v) {
    const root = document.createElement('div');
    root.style.fontFamily = 'Arial, sans-serif';
    root.style.color = '#000';
    root.style.padding = '18px';

    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.alignItems = 'center';
    header.style.gap = '12px';
    header.style.borderBottom = '2px solid #004080';
    header.style.paddingBottom = '10px';

    const logo = document.createElement('img');
    logo.src = 'logikart-logo.png';
    logo.alt = 'LOGIKART';
    logo.style.height = '50px';

    const title = document.createElement('h2');
    title.textContent = 'Rapport d\'intervention LOGIKART';
    title.style.margin = '0';
    title.style.flexGrow = '1';
    title.style.textAlign = 'center';
    title.style.color = '#004080';

    const date = document.createElement('div');
    date.textContent = v.date || '';
    date.style.fontSize = '12px';
    date.style.minWidth = '80px';
    date.style.textAlign = 'right';

    header.appendChild(logo);
    header.appendChild(title);
    header.appendChild(date);
    root.appendChild(header);

    const info = document.createElement('div');
    info.style.marginTop = '16px';
    info.innerHTML =
      '<p><strong>Ticket :</strong> ' + escapeHtml(v.ticket) + '</p>' +
      '<p><strong>Adresse du site :</strong> ' + escapeHtml(v.site) + '</p>' +
      '<p><strong>Nom du technicien :</strong> ' + escapeHtml(v.tech) + '</p>';
    root.appendChild(info);

    function section(label, text) {
      const s = document.createElement('div');
      s.style.marginTop = '14px';
      const h = document.createElement('h4');
      h.textContent = label;
      h.style.margin = '0 0 8px 0';
      const box = document.createElement('div');
      box.style.border = '1px solid #ccc';
      box.style.padding = '10px';
      box.style.minHeight = '60px';
      box.innerHTML = escapeHtml(text).replace(/\n/g, '<br>');
      s.appendChild(h);
      s.appendChild(box);
      return s;
    }

    root.appendChild(section('Travail à faire', v.todo));
    const doneSec = section('Travail effectué', v.done);
    doneSec.querySelector('div').style.minHeight = '80px';
    root.appendChild(doneSec);

    const times = document.createElement('div');
    times.style.marginTop = '14px';
    times.innerHTML =
      '<p><strong>Heure d\'arrivée :</strong> ' + escapeHtml(v.start) + '</p>' +
      '<p><strong>Heure de départ :</strong> ' + escapeHtml(v.end) + '</p>';
    root.appendChild(times);

    const sig = document.createElement('div');
    sig.style.marginTop = '14px';
    sig.style.display = 'flex';
    sig.style.gap = '12px';

    function sigBox(label, name) {
      const wrap = document.createElement('div');
      wrap.style.width = '48%';
      const p = document.createElement('p');
      p.innerHTML = '<strong>' + label + '</strong>';
      const box = document.createElement('div');
      box.style.border = '1px solid #ccc';
      box.style.height = '60px';
      const n = document.createElement('p');
      n.style.textAlign = 'center';
      n.style.marginTop = '5px';
      n.textContent = name || '';
      wrap.appendChild(p);
      wrap.appendChild(box);
      wrap.appendChild(n);
      return wrap;
    }

    sig.appendChild(sigBox('Signature du technicien :', v.signTech));
    sig.appendChild(sigBox('Signature du client :', v.signClient));
    root.appendChild(sig);

    return root;
  }

  function waitImages(container) {
    const imgs = container.querySelectorAll('img');
    if (!imgs.length) return Promise.resolve();

    return new Promise((resolve) => {
      let done = 0;
      const total = imgs.length;
      const step = () => { done += 1; if (done >= total) resolve(); };

      imgs.forEach((img) => {
        if (img.complete) step();
        else {
          img.onload = step;
          img.onerror = step;
        }
      });
    });
  }

  async function generatePDF() {
    if (typeof html2pdf === 'undefined') {
      alert('Librairie PDF introuvable (html2pdf).');
      return;
    }

    const v = reportValues();

    // conteneur temporaire VISIBLE hors écran (évite PDF blanc)
    const tmp = document.createElement('div');
    tmp.style.position = 'fixed';
    tmp.style.left = '-9999px';
    tmp.style.top = '0';
    tmp.style.width = '794px';
    tmp.style.background = '#fff';
    tmp.style.color = '#000';

    tmp.appendChild(buildReportNode(v));
    document.body.appendChild(tmp);

    await waitImages(tmp);

    const opt = {
      margin: 10,
      filename: 'rapport_intervention_LOGIKART.pdf',
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true, logging: false, backgroundColor: '#ffffff' },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
    };

    try {
      await html2pdf().set(opt).from(tmp).save();
    } finally {
      tmp.remove();
    }
  }

  // ---------- Itinéraire ----------
  const ORS_API_KEY = 'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6ImQ4YTg5NTg4NjE0OTQ5NjZhMDY3YzgxZjJjOGE3ODI3IiwiaCI6Im11cm11cjY0In0='; // <-- Mets ta clé ORS ici

  function openItineraryTool() {
    const modal = $('itineraryModal');
    if (modal) modal.style.display = 'flex';
    const result = $('routeResult');
    if (result) result.innerHTML = '';
  }

  function closeItineraryModal() {
    const modal = $('itineraryModal');
    if (modal) modal.style.display = 'none';
    $('itineraryForm')?.reset();
    const extra = $('extraDestinations');
    if (extra) extra.innerHTML = '';
    const btn = $('exportPdfBtn');
    if (btn) btn.style.display = 'none';
  }

  function addDestinationField() {
    const container = $('extraDestinations');
    if (!container) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Destination supplémentaire';
    input.classList.add('extra-destination');
    container.appendChild(input);
  }

  async function calculateRoute() {
    if (!ORS_API_KEY) {
      alert('Clé OpenRouteService manquante. Ajoute-la dans script.js (ORS_API_KEY).');
      return;
    }

    const start = ($('startAddress')?.value || '').trim();
    const end = ($('endAddress')?.value || '').trim();
    const extras = Array.from(document.getElementsByClassName('extra-destination'))
      .map(i => i.value.trim())
      .filter(Boolean);

    const points = [start, ...extras, end].filter(Boolean);
    if (points.length < 2) return;

    const coords = [];
    for (const addr of points) {
      // eslint-disable-next-line no-await-in-loop
      const g = await geocode(addr);
      if (!g) {
        alert('Adresse non trouvée : ' + addr);
        return;
      }
      coords.push([g.lon, g.lat]); // ORS expects [lon,lat]
    }

    const orsRes = await fetch('https://api.openrouteservice.org/v2/directions/driving-car/geojson', {
      method: 'POST',
      headers: {
        'Authorization': ORS_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ coordinates: coords, language: 'fr', instructions: true })
    });

    if (!orsRes.ok) {
      alert('Erreur lors du calcul d\'itinéraire.');
      return;
    }

    const geojson = await orsRes.json();
    const summary = geojson?.features?.[0]?.properties?.summary;

    // tracer sur carte
    if (map) {
      if (window.routeLine) map.removeLayer(window.routeLine);
      window.routeLine = L.geoJSON(geojson, { style: { color: 'blue', weight: 4 } }).addTo(map);
      map.fitBounds(window.routeLine.getBounds());
    }

    const distanceKm = summary ? (summary.distance / 1000).toFixed(2) : '—';
    const durationMin = summary ? Math.round(summary.duration / 60) : '—';

    $('routeResult').innerHTML =
      '<p>📏 Distance totale : <strong>' + distanceKm + ' km</strong></p>' +
      '<p>⏱️ Durée estimée : <strong>' + durationMin + ' minutes</strong></p>';

    const btn = $('exportPdfBtn');
    if (btn) btn.style.display = 'inline-block';
  }

  // ---------- Boot ----------
  function init() {
    // Leaflet
    if (typeof L === 'undefined') {
      console.error('Leaflet non chargé (L is undefined). Vérifie les <script> leaflet dans index.html.');
      return;
    }

    map = L.map('map').setView([48.8566, 2.3522], 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors'
    }).addTo(map);

    // Form submit
    const form = $('providerForm');
    if (form) form.addEventListener('submit', handleFormSubmit);

    initBurgerMenu();
    loadProvidersToMap();
  }

  document.addEventListener('DOMContentLoaded', init);

  // ---------- Expose globals for inline onclick in index.html ----------
  window.addProvider = showProviderForm;
  window.hideForm = hideProviderForm;
  window.searchNearest = searchNearest;
  window.toggleProviderList = toggleProviderList;
  window.importTechnicians = importTechnicians;
  window.exportTechnicians = exportTechnicians;
  window.editProvider = editProvider;
  window.deleteProvider = deleteProvider;

  window.openReportForm = openReportForm;
  window.closeReportForm = closeReportForm;
  window.generatePDF = generatePDF;

  window.openItineraryTool = openItineraryTool;
  window.closeItineraryModal = closeItineraryModal;
  window.addDestinationField = addDestinationField;
  window.calculateRoute = calculateRoute;

})();
