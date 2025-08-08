console.log("script.js chargé");

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

window.searchNearest = searchNearest;
window.addProvider = addProvider;
window.hideForm = hideForm;
window.toggleProviderList = toggleProviderList;
window.openItineraryTool = openItineraryTool;
window.openReportForm = openReportForm;
window.generatePDF = generatePDF;
window.exportItineraryToPDF = exportItineraryToPDF;

