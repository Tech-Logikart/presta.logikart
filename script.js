
// Initialisation de la carte Leaflet
const map = L.map('map').setView([48.8566, 2.3522], 5);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap contributors'
}).addTo(map);

let markers = [];
let editingIndex = null;

// Firebase Firestore déjà initialisé dans index.html
const db = firebase.firestore();

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
    const existing = providers[editingIndex];
    providers[editingIndex] = { ...existing, ...provider };
    localStorage.setItem("providers", JSON.stringify(providers));

    if (existing.id) {
      db.collection("prestataires").doc(existing.id).update(provider)
        .then(() => console.log("Prestataire mis à jour dans Firebase"))
        .catch(err => console.error("Erreur mise à jour Firebase :", err));
    }

  } else {
    db.collection("prestataires").add(provider)
      .then(docRef => {
        provider.id = docRef.id;
        providers.push(provider);
        localStorage.setItem("providers", JSON.stringify(providers));
        clearMarkers();
        loadProvidersFromLocalStorage();
        hideForm();
      })
      .catch(error => console.error("Erreur Firebase :", error));
    return;
  }

  clearMarkers();
  loadProvidersFromLocalStorage();
  hideForm();
}

function deleteProvider(index) {
  const providers = JSON.parse(localStorage.getItem("providers")) || [];
  if (!confirm("Confirmer la suppression ?")) return;
  const toDelete = providers[index];
  providers.splice(index, 1);
  localStorage.setItem("providers", JSON.stringify(providers));

  if (toDelete.id) {
    db.collection("prestataires").doc(toDelete.id).delete()
      .then(() => console.log("Prestataire supprimé de Firebase"))
      .catch(err => console.error("Erreur suppression Firebase :", err));
  }

  clearMarkers();
  loadProvidersFromLocalStorage();
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
  document.getElementById("providerFormSection").style.display = "flex";
}

function addProvider() {
  document.getElementById("providerFormSection").style.display = "flex";
}

function hideForm() {
  document.getElementById("providerForm").reset();
  document.getElementById("providerFormSection").style.display = "none";
  editingIndex = null;
}

function toggleProviderList() {
  const list = document.getElementById("providerList");
  list.style.display = list.style.display === "none" ? "block" : "none";
}

function searchNearest() {
  alert("🧭 Fonction de recherche à intégrer...");
}

function openItineraryTool() {
  alert("🧭 Outil d’itinéraire à intégrer...");
}

function openReportForm() {
  alert("📝 Rapport à intégrer...");
}

function generatePDF() {
  alert("📄 Génération de PDF à intégrer...");
}

function exportItineraryToPDF() {
  alert("📄 Export PDF itinéraire à intégrer...");
}

// Rendre les fonctions globales
window.searchNearest = searchNearest;
window.addProvider = addProvider;
window.hideForm = hideForm;
window.toggleProviderList = toggleProviderList;
window.openItineraryTool = openItineraryTool;
window.openReportForm = openReportForm;
window.generatePDF = generatePDF;
window.exportItineraryToPDF = exportItineraryToPDF;

// Initialisation au chargement
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

function clearMarkers() {
  markers.forEach(marker => map.removeLayer(marker));
  markers = [];
}

function loadProvidersFromLocalStorage() {
  clearMarkers();
  const providers = JSON.parse(localStorage.getItem("providers")) || [];
  providers.forEach(provider => {
    geocodeAndAddToMap(provider);
  });
  updateProviderList();
}

function geocodeAndAddToMap(provider) {
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
