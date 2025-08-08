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

function handleFormSubmit(event) {
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

  if (editingIndex !== null) {
    providers[editingIndex] = provider;
  } else {
    providers.push(provider);
  }

  localStorage.setItem("providers", JSON.stringify(providers));

  clearMarkers();
  loadProvidersFromLocalStorage();
  hideForm();
}

// -- Affichage sur carte
function geocodeAndAddToMap(provider) {
  fetch(`https://proxy-logikart.samir-mouheb.workers.dev/?url=${encodeURIComponent('https://nominatim.openstreetmap.org/search?format=json&q=' + provider.address)}`)
    .then(response => response.json())
    .then(data => {
      if (data.length > 0) {
        const { lat, lon } = data[0];
        const marker = L.marker([lat, lon])
          .addTo(map)
          .bindPopup(`<strong>${provider.companyName}</strong><br>${provider.contactName}<br>${provider.email}<br>${provider.phone}`);
        markers.push(marker);
      }
    })
    .catch(error => {
      console.error("Erreur de géocodage :", error);
    });
}

function clearMarkers() {
  markers.forEach(marker => map.removeLayer(marker));
  markers = [];
}

async function searchNearest() {
  const city = document.getElementById("cityInput").value.trim();
  if (!city) return;

  const response = await fetch(`https://proxy-logikart.samir-mouheb.workers.dev/?url=${encodeURIComponent('https://nominatim.openstreetmap.org/search?format=json&q=' + city)}`);
  const data = await response.json();

  if (data.length === 0) {
    alert("Ville non trouvée.");
    return;
  }

  const userLat = parseFloat(data[0].lat);
  const userLon = parseFloat(data[0].lon);

  const providers = JSON.parse(localStorage.getItem("providers")) || [];

  let nearest = null;
  let minDistance = Infinity;

  for (const provider of providers) {
    const geo = await fetch(`https://proxy-logikart.samir-mouheb.workers.dev/?url=${encodeURIComponent('https://nominatim.openstreetmap.org/search?format=json&q=' + provider.address)}`).then(r => r.json());
    if (geo.length === 0) continue;

    const lat = parseFloat(geo[0].lat);
    const lon = parseFloat(geo[0].lon);
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
      👤 ${p.contactName}<br>
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

  document.getElementById("companyName").value = p.companyName;
  document.getElementById("contactName").value = p.contactName;
  document.getElementById("address").value = p.address;
  document.getElementById("email").value = p.email;
  document.getElementById("phone").value = p.phone;
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

function deleteProvider(index) {
  const providers = JSON.parse(localStorage.getItem("providers")) || [];
  if (!confirm("Confirmer la suppression ?")) return;
  providers.splice(index, 1);
  localStorage.setItem("providers", JSON.stringify(providers));
  clearMarkers();
  loadProvidersFromLocalStorage();
}

// --- Menu / init
document.addEventListener("DOMContentLoaded", () => {
  loadProvidersFromLocalStorage();

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

// --- Rapport d’intervention
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

  // ➤ Affichage temporaire pour html2pdf
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

// --- Itinéraire
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
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}`, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'LOGIKART/1.0 (contact@logikart.app)'
      }
    });
    const data = await res.json();
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
      <p style="margin-top:10px;">${distanceText.replace(/\\n/g, "<br>")}</p>
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

// --- Exposer au scope global (pour onclick HTML) ---
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
window.deleteProvider = deleteProvider;
