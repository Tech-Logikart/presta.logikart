// Initialisation de la carte
const map = L.map('map').setView([48.8566, 2.3522], 5);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap contributors'
}).addTo(map);

let markers = [];
let editingIndex = null;

function addProvider() {
  document.getElementById("providerFormSection").style.display = "flex";
}

function hideForm() {
  document.getElementById("providerForm").reset();
  document.getElementById("providerFormSection").style.display = "none";
  editingIndex = null;
}

document.getElementById("providerForm").addEventListener("submit", handleFormSubmit);

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

async function geocodeAndAddToMap(provider) {
  fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(provider.address)}`)
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

  const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(city)}`);
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
    const geo = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(provider.address)}`).then(r => r.json());
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

async function loadProvidersFromLocalStorage() {
  clearMarkers();
  const providers = JSON.parse(localStorage.getItem("providers")) || [];
  const geocodePromises = providers.map(provider => geocodeAndAddToMap(provider));
  await Promise.all(geocodePromises);
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
  document.getElementById("providerFormSection").style.display = "flex";
}

function deleteProvider(index) {
  const providers = JSON.parse(localStorage.getItem("providers")) || [];
  if (!confirm("Confirmer la suppression ?")) return;
  providers.splice(index, 1);
  localStorage.setItem("providers", JSON.stringify(providers));
  clearMarkers();
  loadProvidersFromLocalStorage();
}

document.addEventListener("DOMContentLoaded", () => {
  loadProvidersFromLocalStorage();

  const burger = document.getElementById("burgerMenu");
  const dropdown = document.getElementById("menuDropdown");

  burger.addEventListener("click", (e) => {
    e.stopPropagation();
    dropdown.classList.toggle("hidden");
  });

  document.addEventListener("click", () => {
    dropdown.classList.add("hidden");
  });
});

function toggleProviderList() {
  const list = document.getElementById("providerList");
  list.style.display = list.style.display === "none" ? "block" : "none";
}

function openItineraryTool() {
  alert("🧭 Outil d’itinéraire en cours de développement...");
}

function openReportForm() {
  document.getElementById("reportModal").style.display = "flex";

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
}

function closeReportForm() {
  document.getElementById("reportModal").style.display = "none";
}

function generatePDF() {
  console.log("Génération PDF");

  const element = document.getElementById("reportContent");
  if (!element) {
    alert("⚠️ Élément à exporter introuvable !");
    return;
  }

  const opt = {
    margin: 0.5,
    filename: 'rapport_intervention_LOGIKART.pdf',
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2 },
    jsPDF: { unit: 'in', format: 'a4', orientation: 'portrait' }
  };

  html2pdf().set(opt).from(element).save();
}
