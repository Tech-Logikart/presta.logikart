// LOGIKART - script.js (propre)
// - Prestataires : panneau fonctionne + tri alphabétique
// - Géocodage rapide : cache localStorage + lat/lon stockées sur prestataire
// - Recherche "Ville" (prestataire le plus proche)
// - Itinéraire ORS + export PDF itinéraire
// - Rapport : PDF non blanc (conteneur hors écran + attente images)
// - Import/Export techniciens (CSV/TXT/JSON)

(function () {
  'use strict';

  // ================= CONFIG =================
  const ORS_API_KEY =
    "eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6ImQ4YTg5NTg4NjE0OTQ5NjZhMDY3YzgxZjJjOGE3ODI3IiwiaCI6Im11cm11cjY0In0=";
  const NOMINATIM_PROXY = "https://proxy-logikart.samir-mouheb.workers.dev/?url=";
  const GEO_CACHE_KEY = "geocodeCache";

  const $ = (id) => document.getElementById(id);

  function safeJsonParse(s, fallback) {
    try {
      return JSON.parse(s);
    } catch {
      return fallback;
    }
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // ================= STORAGE =================
  function readProviders() {
    return safeJsonParse(localStorage.getItem("providers"), []);
  }
  function writeProviders(providers) {
    localStorage.setItem("providers", JSON.stringify(providers));
  }

  function readTechnicians() {
    return safeJsonParse(localStorage.getItem("technicians"), []);
  }
  function writeTechnicians(list) {
    localStorage.setItem("technicians", JSON.stringify(list));
  }

  // ================= GEO CACHE =================
  function readGeoCache() {
    return safeJsonParse(localStorage.getItem(GEO_CACHE_KEY), {});
  }
  function writeGeoCache(cache) {
    localStorage.setItem(GEO_CACHE_KEY, JSON.stringify(cache));
  }

  async function geocode(address) {
    const q = String(address || "").trim();
    if (!q) return null;

    const cache = readGeoCache();
    if (cache[q] && typeof cache[q].lat === "number" && typeof cache[q].lon === "number") {
      return cache[q];
    }

    const target =
      "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" +
      encodeURIComponent(q);
    const url = NOMINATIM_PROXY + encodeURIComponent(target);

    const res = await fetch(url);
    if (!res.ok) return null;

    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;

    const geo = { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
    if (!Number.isFinite(geo.lat) || !Number.isFinite(geo.lon)) return null;

    cache[q] = geo;
    writeGeoCache(cache);
    return geo;
  }

  // ================= MAP =================
  let map = null;
  let markers = [];
  let routeLine = null;

  function clearMarkers() {
    if (!map) return;
    markers.forEach((m) => map.removeLayer(m));
    markers = [];
  }

  function markerPopup(provider) {
    const name = ((provider.firstName || "") + " " + (provider.contactName || "")).trim();
    return (
      "<strong>" + escapeHtml(provider.companyName || "") + "</strong><br>" +
      "👤 " + escapeHtml(name) + "<br>" +
      "📧 " + escapeHtml(provider.email || "") + "<br>" +
      "📞 " + escapeHtml(provider.phone || "") +
      (provider.totalCost ? "<br>💰 " + escapeHtml(provider.totalCost) : "")
    );
  }

  async function ensureProviderCoords(provider, index) {
    if (!provider) return provider;

    if (typeof provider.lat === "number" && typeof provider.lon === "number") return provider;

    const g = await geocode(provider.address);
    if (!g) return provider;

    // Persister dans le storage
    const providers = readProviders();
    if (providers[index]) {
      providers[index].lat = g.lat;
      providers[index].lon = g.lon;
      writeProviders(providers);
    }

    provider.lat = g.lat;
    provider.lon = g.lon;
    return provider;
  }

  async function addMarkerForProvider(provider, index) {
    if (!map) return;

    const p = await ensureProviderCoords(provider, index);
    if (!p || typeof p.lat !== "number" || typeof p.lon !== "number") return;

    const marker = L.marker([p.lat, p.lon]).addTo(map).bindPopup(markerPopup(p));
    markers.push(marker);
  }

  async function loadProvidersToMap() {
    clearMarkers();
    const providers = readProviders();

    // Géocodage léger : 3 en parallèle
    const concurrency = 3;
    let cursor = 0;

    async function worker() {
      while (cursor < providers.length) {
        const idx = cursor++;
        // eslint-disable-next-line no-await-in-loop
        await addMarkerForProvider(providers[idx], idx);
      }
    }

    const workers = Array.from(
      { length: Math.min(concurrency, providers.length) },
      () => worker()
    );
    await Promise.all(workers);

    // Refresh liste si visible
    updateProviderList();
  }

  // ================= PROVIDER FORM =================
  let editingIndex = null;

  function showProviderForm() {
    const overlay = $("providerFormSection");
    if (overlay) overlay.style.display = "flex";
  }

  function hideProviderForm() {
    $("providerForm")?.reset();
    const overlay = $("providerFormSection");
    if (overlay) overlay.style.display = "none";
    editingIndex = null;
  }

  async function handleFormSubmit(event) {
    event.preventDefault();

    const provider = {
      companyName: $("companyName")?.value || "",
      contactName: $("contactName")?.value || "",
      firstName: $("firstName")?.value || "",
      address: $("address")?.value || "",
      email: $("email")?.value || "",
      phone: $("phone")?.value || "",
      rate: $("rate")?.value || "",
      travelFees: $("travelFees")?.value || "",
      totalCost: $("totalCost")?.value || "",
    };

    // Géocode maintenant pour accélérer carte + recherche
    const g = await geocode(provider.address);
    if (g) {
      provider.lat = g.lat;
      provider.lon = g.lon;
    }

    const providers = readProviders();
    if (editingIndex !== null) providers[editingIndex] = provider;
    else providers.push(provider);

    writeProviders(providers);
    hideProviderForm();
    await loadProvidersToMap();
  }

  function editProvider(index) {
    const providers = readProviders();
    const p = providers[index];
    if (!p) return;

    $("companyName").value = p.companyName || "";
    $("contactName").value = p.contactName || "";
    $("firstName").value = p.firstName || "";
    $("address").value = p.address || "";
    $("email").value = p.email || "";
    $("phone").value = p.phone || "";
    $("rate").value = p.rate || "";
    $("travelFees").value = p.travelFees || "";
    $("totalCost").value = p.totalCost || "";

    editingIndex = index;
    showProviderForm();
  }

  function deleteProvider(index) {
    const providers = readProviders();
    if (!providers[index]) return;
    if (!confirm("Confirmer la suppression ?")) return;

    providers.splice(index, 1);
    writeProviders(providers);
    loadProvidersToMap();
  }

  // ================= PROVIDER LIST (TRI) =================
  function updateProviderList() {
    const container = $("providerList");
    if (!container) return;

    // on remplit uniquement si la liste est visible
    if (container.style.display !== "block") return;

    const providers = readProviders();

    // Tri alphabétique : raison sociale, puis nom, puis prénom
    providers.sort((a, b) => {
      const aCompany = (a.companyName || "").trim();
      const bCompany = (b.companyName || "").trim();
      const c = aCompany.localeCompare(bCompany, "fr", { sensitivity: "base" });
      if (c !== 0) return c;

      const aName = ((a.contactName || "") + " " + (a.firstName || "")).trim();
      const bName = ((b.contactName || "") + " " + (b.firstName || "")).trim();
      return aName.localeCompare(bName, "fr", { sensitivity: "base" });
    });

    container.innerHTML = "";

    if (!providers.length) {
      container.innerHTML = `<div class="provider-entry">Aucun prestataire enregistré.</div>`;
      return;
    }

    providers.forEach((p, i) => {
      const div = document.createElement("div");
      div.className = "provider-entry";
      const name = ((p.firstName || "") + " " + (p.contactName || "")).trim();

      div.innerHTML =
        "<strong>" + escapeHtml(p.companyName || "") + "</strong><br>" +
        "👤 " + escapeHtml(name) + "<br>" +
        "📧 " + escapeHtml(p.email || "") + "<br>" +
        "📞 " + escapeHtml(p.phone || "") + "<br>" +
        "💰 Tarif total HT : " + escapeHtml(p.totalCost || "N/A") + "<br>" +
        '<div style="display:flex; gap:8px; margin-top:8px; flex-wrap:wrap;">' +
        '<button type="button" onclick="editProvider(' + i + ')">✏️ Modifier</button>' +
        '<button type="button" onclick="deleteProvider(' + i + ')">🗑️ Supprimer</button>' +
        "</div>";

      container.appendChild(div);
    });
  }

  function toggleProviderList() {
    const list = $("providerList");
    if (!list) return;

    const willShow = list.style.display === "none" || list.style.display === "";
    list.style.display = willShow ? "block" : "none";

    if (willShow) updateProviderList();
  }

  // ================= SEARCH NEAREST =================
  async function searchNearest() {
    const city = ($("cityInput")?.value || "").trim();
    if (!city) return;

    const cityGeo = await geocode(city);
    if (!cityGeo) {
      alert("Ville non trouvée.");
      return;
    }

    const userLat = cityGeo.lat;
    const userLon = cityGeo.lon;

    const providers = readProviders();
    let nearest = null;
    let minDistance = Infinity;

    for (let i = 0; i < providers.length; i++) {
      const p = providers[i];
      // eslint-disable-next-line no-await-in-loop
      const ensured = await ensureProviderCoords(p, i);
      if (!ensured || typeof ensured.lat !== "number" || typeof ensured.lon !== "number") continue;

      const d = Math.sqrt(Math.pow(ensured.lat - userLat, 2) + Math.pow(ensured.lon - userLon, 2));
      if (d < minDistance) {
        minDistance = d;
        nearest = ensured;
      }
    }

    if (nearest && map) {
      map.setView([nearest.lat, nearest.lon], 12);
      L.popup().setLatLng([nearest.lat, nearest.lon]).setContent(markerPopup(nearest)).openOn(map);
    } else {
      alert("Aucun prestataire trouvé.");
    }
  }

  // ================= BURGER MENU =================
  function initBurgerMenu() {
    const burger = $("burgerMenu");
    const dropdown = $("menuDropdown");
    if (!burger || !dropdown) return;

    burger.addEventListener("click", (e) => {
      e.stopPropagation();
      dropdown.classList.toggle("hidden");
    });

    document.addEventListener("click", () => dropdown.classList.add("hidden"));
  }

  // ================= TECHNICIANS =================
  function combinedTechnicians() {
    const imported = readTechnicians();
    const providers = readProviders();

    const fromProviders = providers
      .map((p) => ((p.firstName || "") + " " + (p.contactName || "")).trim())
      .filter(Boolean);

    const all = [...imported, ...fromProviders].map((s) => s.trim()).filter(Boolean);
    return Array.from(new Set(all)).sort((a, b) => a.localeCompare(b, "fr", { sensitivity: "base" }));
  }

  function populateTechnicianSuggestions() {
    const datalist = $("technicianList");
    if (!datalist) return;

    datalist.innerHTML = "";
    combinedTechnicians().forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      datalist.appendChild(opt);
    });
  }

  function openImportTechnicians() {
    const input = $("technicianFileInput");
    if (!input) {
      alert("Input fichier introuvable.");
      return;
    }
    input.value = "";
    input.click();
  }

  function parseTechniciansText(text) {
    const t = String(text || "");
    const json = safeJsonParse(t, null);

    if (json) {
      if (Array.isArray(json)) return json.map(String);
      if (Array.isArray(json.technicians)) return json.technicians.map(String);
    }

    return t.split(/\r?\n|,|;/g).map((s) => s.trim()).filter(Boolean);
  }

  function handleTechnicianFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      const list = parseTechniciansText(reader.result);
      const current = readTechnicians();
      const merged = Array.from(new Set([...current, ...list].map((s) => s.trim()).filter(Boolean)));

      writeTechnicians(merged);
      alert("Import terminé : " + merged.length + " technicien(s).");
      populateTechnicianSuggestions();
    };
    reader.readAsText(file, "utf-8");
  }

  function exportTechnicians() {
    const list = combinedTechnicians();
    if (!list.length) {
      alert("Aucun technicien à exporter.");
      return;
    }

    const csv = "technician\n" + list.map((n) => `"${n.replace(/"/g, '""')}"`).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = "techniciens_LOGIKART.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // ================= REPORT (PDF) =================
  function openReportForm() {
    const modal = $("reportModal");
    if (modal) modal.style.display = "flex";
    populateTechnicianSuggestions();
  }

  function closeReportForm() {
    const modal = $("reportModal");
    if (modal) modal.style.display = "none";
  }

  function reportValues() {
    const form = $("reportForm");
    const get = (name) => (form?.querySelector(`[name="${name}"]`)?.value || "").trim();
    return {
      ticket: get("ticket"),
      date: get("interventionDate"),
      site: get("siteAddress"),
      tech: get("technician"),
      todo: get("todo"),
      done: get("done"),
      start: get("start"),
      end: get("end"),
      signTech: get("signTech"),
      signClient: get("signClient"),
    };
  }

  function buildReportNode(v) {
    const root = document.createElement("div");
    root.style.fontFamily = "Arial, sans-serif";
    root.style.color = "#000";
    root.style.background = "#fff";
    root.style.padding = "18px";

    const header = document.createElement("div");
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.gap = "12px";
    header.style.borderBottom = "2px solid #004080";
    header.style.paddingBottom = "10px";

    const logo = document.createElement("img");
    logo.src = "logikart-logo.png";
    logo.alt = "LOGIKART";
    logo.style.height = "50px";

    const title = document.createElement("h2");
    title.textContent = "Rapport d'intervention LOGIKART";
    title.style.margin = "0";
    title.style.flexGrow = "1";
    title.style.textAlign = "center";
    title.style.color = "#004080";

    const date = document.createElement("div");
    date.textContent = v.date || "";
    date.style.fontSize = "12px";
    date.style.minWidth = "80px";
    date.style.textAlign = "right";

    header.appendChild(logo);
    header.appendChild(title);
    header.appendChild(date);
    root.appendChild(header);

    const info = document.createElement("div");
    info.style.marginTop = "16px";
    info.innerHTML =
      `<p><strong>Ticket :</strong> ${escapeHtml(v.ticket)}</p>` +
      `<p><strong>Adresse du site :</strong> ${escapeHtml(v.site)}</p>` +
      `<p><strong>Nom du technicien :</strong> ${escapeHtml(v.tech)}</p>`;
    root.appendChild(info);

    function section(label, text, minH) {
      const s = document.createElement("div");
      s.style.marginTop = "14px";
      const h = document.createElement("h4");
      h.textContent = label;
      h.style.margin = "0 0 8px 0";
      const box = document.createElement("div");
      box.style.border = "1px solid #ccc";
      box.style.padding = "10px";
      box.style.minHeight = (minH || 60) + "px";
      box.innerHTML = escapeHtml(text).replace(/\n/g, "<br>");
      s.appendChild(h);
      s.appendChild(box);
      return s;
    }

    root.appendChild(section("Travail à faire", v.todo, 60));
    root.appendChild(section("Travail effectué", v.done, 90));

    const times = document.createElement("div");
    times.style.marginTop = "14px";
    times.innerHTML =
      `<p><strong>Heure d'arrivée :</strong> ${escapeHtml(v.start)}</p>` +
      `<p><strong>Heure de départ :</strong> ${escapeHtml(v.end)}</p>`;
    root.appendChild(times);

    const sig = document.createElement("div");
    sig.style.marginTop = "14px";
    sig.style.display = "flex";
    sig.style.gap = "12px";

    function sigBox(label, name) {
      const wrap = document.createElement("div");
      wrap.style.width = "48%";
      const p = document.createElement("p");
      p.innerHTML = `<strong>${label}</strong>`;
      const box = document.createElement("div");
      box.style.border = "1px solid #ccc";
      box.style.height = "60px";
      const n = document.createElement("p");
      n.style.textAlign = "center";
      n.style.marginTop = "5px";
      n.textContent = name || "";
      wrap.appendChild(p);
      wrap.appendChild(box);
      wrap.appendChild(n);
      return wrap;
    }

    sig.appendChild(sigBox("Signature du technicien :", v.signTech));
    sig.appendChild(sigBox("Signature du client :", v.signClient));
    root.appendChild(sig);

    return root;
  }

  function waitImages(container) {
    const imgs = container.querySelectorAll("img");
    if (!imgs.length) return Promise.resolve();

    return new Promise((resolve) => {
      let done = 0;
      const total = imgs.length;
      const step = () => {
        done += 1;
        if (done >= total) resolve();
      };

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
    if (typeof html2pdf === "undefined") {
      alert("Librairie PDF introuvable (html2pdf).");
      return;
    }

    const v = reportValues();

    // Conteneur hors écran (évite PDF blanc)
    const tmp = document.createElement("div");
    tmp.style.position = "fixed";
    tmp.style.left = "-9999px";
    tmp.style.top = "0";
    tmp.style.width = "794px";
    tmp.style.background = "#fff";
    tmp.style.color = "#000";

    tmp.appendChild(buildReportNode(v));
    document.body.appendChild(tmp);

    await waitImages(tmp);

    const opt = {
      margin: 10,
      filename: "rapport_intervention_LOGIKART.pdf",
      image: { type: "jpeg", quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true, logging: false, backgroundColor: "#ffffff" },
      jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
    };

    try {
      await html2pdf().set(opt).from(tmp).save();
    } finally {
      tmp.remove();
    }
  }

  // ================= ITINERARY =================
  function openItineraryTool() {
    const modal = $("itineraryModal");
    if (modal) modal.style.display = "flex";
    const result = $("routeResult");
    if (result) result.innerHTML = "";
    const btn = $("exportPdfBtn");
    if (btn) btn.style.display = "none";
    if (routeLine && map) {
      map.removeLayer(routeLine);
      routeLine = null;
    }
  }

  function closeItineraryModal() {
    const modal = $("itineraryModal");
    if (modal) modal.style.display = "none";
    $("itineraryForm")?.reset();
    const extra = $("extraDestinations");
    if (extra) extra.innerHTML = "";
    const btn = $("exportPdfBtn");
    if (btn) btn.style.display = "none";
  }

  function addDestinationField() {
    const container = $("extraDestinations");
    if (!container) return;
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Destination supplémentaire";
    input.classList.add("extra-destination");
    container.appendChild(input);
  }

  async function calculateRoute() {
    if (!ORS_API_KEY) {
      alert("Clé OpenRouteService manquante.");
      return;
    }

    const start = ($("startAddress")?.value || "").trim();
    const end = ($("endAddress")?.value || "").trim();
    const extras = Array.from(document.getElementsByClassName("extra-destination"))
      .map((i) => i.value.trim())
      .filter(Boolean);

    const points = [start, ...extras, end].filter(Boolean);
    if (points.length < 2) return;

    const coords = [];
    for (const addr of points) {
      // eslint-disable-next-line no-await-in-loop
      const g = await geocode(addr);
      if (!g) {
        alert("Adresse non trouvée : " + addr);
        return;
      }
      coords.push([g.lon, g.lat]); // ORS = [lon,lat]
    }

    const orsRes = await fetch(
      "https://api.openrouteservice.org/v2/directions/driving-car/geojson",
      {
        method: "POST",
        headers: {
          Authorization: ORS_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ coordinates: coords, language: "fr", instructions: true }),
      }
    );

    if (!orsRes.ok) {
      alert("Erreur lors du calcul d'itinéraire.");
      return;
    }

    const geojson = await orsRes.json();
    const summary = geojson?.features?.[0]?.properties?.summary;

    try {
      const steps = geojson.features[0].properties.segments[0].steps || [];
      window.lastRouteInstructions = steps.map(
        (s, i) => `${i + 1}. ${s.instruction} (${(s.distance / 1000).toFixed(2)} km)`
      );
    } catch {
      window.lastRouteInstructions = [];
    }

    if (map) {
      if (routeLine) map.removeLayer(routeLine);
      routeLine = L.geoJSON(geojson, { style: { color: "blue", weight: 4 } }).addTo(map);
      map.fitBounds(routeLine.getBounds());
    }

    const distanceKm = summary ? (summary.distance / 1000).toFixed(2) : "—";
    const durationMin = summary ? Math.round(summary.duration / 60) : "—";

    $("routeResult").innerHTML =
      `<p>📏 Distance totale : <strong>${distanceKm} km</strong></p>` +
      `<p>⏱️ Durée estimée : <strong>${durationMin} minutes</strong></p>`;

    const btn = $("exportPdfBtn");
    if (btn) btn.style.display = "inline-block";
  }

  function exportItineraryToPDF() {
    if (typeof leafletImage === "undefined") {
      alert("Librairie leaflet-image introuvable.");
      return;
    }
    if (typeof html2pdf === "undefined") {
      alert("Librairie PDF introuvable (html2pdf).");
      return;
    }
    if (!map) return;

    const start = ($("startAddress")?.value || "").trim();
    const end = ($("endAddress")?.value || "").trim();
    const extras = Array.from(document.getElementsByClassName("extra-destination"))
      .map((i) => i.value.trim())
      .filter(Boolean);

    const distanceText = $("routeResult")?.innerText || "";

    leafletImage(map, function (err, canvas) {
      if (err || !canvas) {
        alert("Erreur lors du rendu de la carte.");
        return;
      }

      const mapImage = canvas.toDataURL("image/jpeg", 0.92);

      const container = document.createElement("div");
      container.style.padding = "20px";
      container.style.fontFamily = "Arial";
      container.style.color = "#000";
      container.style.background = "#fff";
      container.style.width = "794px";

      container.innerHTML = `
        <h2 style="color:#004080; margin-top:0;">🧭 Itinéraire LOGIKART</h2>
        <p><strong>Départ :</strong> ${escapeHtml(start)}</p>
        ${extras
          .map((d, i) => `<p><strong>Étape ${i + 1} :</strong> ${escapeHtml(d)}</p>`)
          .join("")}
        <p><strong>Arrivée :</strong> ${escapeHtml(end)}</p>
        <div style="margin-top:10px;">${escapeHtml(distanceText).replace(/\n/g, "<br>")}</div>
      `;

      if (Array.isArray(window.lastRouteInstructions) && window.lastRouteInstructions.length) {
        const lis = window.lastRouteInstructions.map((i) => `<li>${escapeHtml(i)}</li>`).join("");
        container.innerHTML += `<p style="margin-top:14px;"><strong>🧭 Instructions pas à pas :</strong></p><ol>${lis}</ol>`;
      }

      container.innerHTML += `
        <hr style="margin:16px 0;">
        <p><strong>Carte de l’itinéraire :</strong></p>
        <img src="${mapImage}" style="width:100%; max-height:520px; margin-top:10px; border:1px solid #ddd; border-radius:8px;" />
      `;

      html2pdf()
        .set({
          margin: 10,
          filename: "itineraire_LOGIKART.pdf",
          image: { type: "jpeg", quality: 0.98 },
          html2canvas: { scale: 2, useCORS: true, backgroundColor: "#ffffff" },
          jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
        })
        .from(container)
        .save();
    });
  }

  // ================= INIT =================
  function init() {
    if (typeof L === "undefined") {
      console.error("Leaflet non chargé (L is undefined).");
      return;
    }

    map = L.map("map").setView([48.8566, 2.3522], 5);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap contributors",
    }).addTo(map);

    const form = $("providerForm");
    if (form) form.addEventListener("submit", handleFormSubmit);

    const techInput = $("technicianFileInput");
    if (techInput) techInput.addEventListener("change", handleTechnicianFileChange);

    initBurgerMenu();
    loadProvidersToMap();
  }

  document.addEventListener("DOMContentLoaded", init);

  // ================= EXPOSE GLOBALS (onclick HTML) =================
  window.addProvider = showProviderForm;
  window.hideForm = hideProviderForm;
  window.searchNearest = searchNearest;

  window.toggleProviderList = toggleProviderList;
  window.editProvider = editProvider;
  window.deleteProvider = deleteProvider;

  window.openReportForm = openReportForm;
  window.closeReportForm = closeReportForm;
  window.generatePDF = generatePDF;

  window.openItineraryTool = openItineraryTool;
  window.closeItineraryModal = closeItineraryModal;
  window.addDestinationField = addDestinationField;
  window.calculateRoute = calculateRoute;
  window.exportItineraryToPDF = exportItineraryToPDF;

  window.openImportTechnicians = openImportTechnicians;
  window.exportTechnicians = exportTechnicians;
})();
