const MAX_PHOTOS = 5;
// Keep the old database/storage names so the existing API key and history survive the update.
const DB_NAME = "which-flower-db";
const DB_VERSION = 2;
const STORE_HISTORY = "history";
const STORE_QUEUE = "queue";
const API_KEY_STORAGE = "which-flower-plantnet-api-key";
const PLANTNET_API_URL = "https://my-api.plantnet.org/v2/identify/all";

const state = {
  photos: [],
  currentHistoryId: null,
  detailObjectUrls: [],
  historyObjectUrls: [],
};

const $ = (selector) => document.querySelector(selector);
const cameraInput = $("#cameraInput");
const galleryInput = $("#galleryInput");
const photoSection = $("#photoSection");
const photoGrid = $("#photoGrid");
const photoCount = $("#photoCount");
const identifyButton = $("#identifyButton");
const statusText = $("#statusText");
const historyList = $("#historyList");
const queueList = $("#queueList");
const queueCount = $("#queueCount");
const connectionBadge = $("#connectionBadge");
const setupCard = $("#setupCard");
const apiKeyInput = $("#apiKeyInput");
const apiStatus = $("#apiStatus");
const homeView = $("#homeView");
const captureView = $("#captureView");
const bestScore = $("#bestScore");

function getApiKey() {
  return localStorage.getItem(API_KEY_STORAGE)?.trim() || "";
}

function renderApiKeyState() {
  const configured = Boolean(getApiKey());
  setupCard.classList.toggle("hidden", configured);
  apiStatus.textContent = configured ? "Enregistrée" : "Non configurée";
}

$("#originText").textContent = location.origin;
$("#saveApiKeyButton").addEventListener("click", async () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    statusText.textContent = "Collez d’abord votre clé API Pl@ntNet.";
    apiKeyInput.focus();
    return;
  }
  localStorage.setItem(API_KEY_STORAGE, key);
  apiKeyInput.value = "";
  renderApiKeyState();
  statusText.textContent = "Clé API enregistrée sur cet appareil.";
  if (navigator.onLine) await processQueue();
});

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_HISTORY)) {
        db.createObjectStore(STORE_HISTORY, { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_QUEUE)) {
        db.createObjectStore(STORE_QUEUE, { keyPath: "id", autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbAdd(storeName, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const req = tx.objectStore(storeName).add(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(storeName, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const req = tx.objectStore(storeName).put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGet(storeName, id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGetAll(storeName) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbDelete(storeName, id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const req = tx.objectStore(storeName).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function dbClear(storeName) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const req = tx.objectStore(storeName).clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function setConnectionUi() {
  if (navigator.onLine) {
    connectionBadge.textContent = "En ligne";
    connectionBadge.classList.remove("offline");
  } else {
    connectionBadge.textContent = "Hors ligne";
    connectionBadge.classList.add("offline");
  }
}

function addSelectedPhotos(input) {
  const room = MAX_PHOTOS - state.photos.length;
  const incoming = [...input.files].slice(0, room);

  incoming.forEach((file) => {
    state.photos.push({
      file,
      organ: "auto",
      preview: URL.createObjectURL(file),
    });
  });

  if (input.files.length > room) {
    statusText.textContent = `Vous pouvez ajouter au maximum ${MAX_PHOTOS} photos de la même plante.`;
  }

  input.value = "";
  renderPhotos();
}

cameraInput.addEventListener("change", () => addSelectedPhotos(cameraInput));
galleryInput.addEventListener("change", () => addSelectedPhotos(galleryInput));

function renderPhotos() {
  photoGrid.innerHTML = "";
  state.photos.forEach((photo, index) => {
    const node = $("#photoTemplate").content.cloneNode(true);
    const img = node.querySelector("img");
    const select = node.querySelector("select");
    const remove = node.querySelector("button");
    img.src = photo.preview;
    select.value = photo.organ;
    select.addEventListener("change", (event) => { state.photos[index].organ = event.target.value; });
    remove.addEventListener("click", () => {
      URL.revokeObjectURL(state.photos[index].preview);
      state.photos.splice(index, 1);
      renderPhotos();
    });
    photoGrid.appendChild(node);
  });
  photoSection.classList.toggle("hidden", state.photos.length === 0);
  photoCount.textContent = `${state.photos.length}/${MAX_PHOTOS}`;
}

function buildFormData(photos) {
  const data = new FormData();
  photos.forEach((photo) => {
    data.append("images", photo.file, photo.file.name || "plante.jpg");
    data.append("organs", photo.organ || "auto");
  });
  return data;
}

function normalizePlantNet(payload) {
  const results = (payload.results || []).slice(0, 5).map((item) => {
    const species = item.species || {};
    return {
      score: Number(item.score || 0),
      scientificName: species.scientificName || "Inconnue",
      scientificNameWithoutAuthor: species.scientificNameWithoutAuthor || species.scientificName || "Inconnue",
      commonNames: Array.isArray(species.commonNames) ? species.commonNames : [],
      family: species.family?.scientificName || species.family?.scientificNameWithoutAuthor || "",
      genus: species.genus?.scientificName || species.genus?.scientificNameWithoutAuthor || "",
      images: Array.isArray(item.images) ? item.images.slice(0, 3) : [],
    };
  });
  return {
    bestMatch: payload.bestMatch,
    predictedOrgans: payload.predictedOrgans || [],
    results,
    remainingIdentificationRequests: payload.remainingIdentificationRequests,
    version: payload.version,
  };
}

async function sendIdentification(photos) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("Aucune clé API n’est enregistrée.");

  const params = new URLSearchParams({
    "api-key": apiKey,
    lang: "fr",
    "nb-results": "5",
    "include-related-images": "true",
  });

  let response;
  try {
    response = await fetch(`${PLANTNET_API_URL}?${params}`, {
      method: "POST",
      body: buildFormData(photos),
    });
  } catch (error) {
    const corsHint = navigator.onLine
      ? `Le navigateur n’a pas pu joindre Pl@ntNet. Vérifiez que ${location.origin} est autorisé dans les réglages client/CORS de votre clé.`
      : "Vous êtes hors ligne.";
    throw new Error(corsHint, { cause: error });
  }

  let payload;
  try { payload = await response.json(); } catch { payload = {}; }
  if (!response.ok) {
    const detail = payload.message || payload.error || payload.detail || `Pl@ntNet a renvoyé l’erreur HTTP ${response.status}.`;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return normalizePlantNet(payload);
}

function toStoredPhotos(photos) {
  return photos.map(({ file, organ }) => ({
    blob: file,
    name: file.name,
    type: file.type,
    organ,
  }));
}

function storedPhotosToFiles(photos = []) {
  return photos.map((p) => ({
    file: new File([p.blob], p.name || "plante.jpg", { type: p.type || "image/jpeg" }),
    organ: p.organ || "auto",
  }));
}

identifyButton.addEventListener("click", async () => {
  if (!state.photos.length) return;
  identifyButton.disabled = true;

  if (!navigator.onLine) {
    await queueCurrentPhotos();
    identifyButton.disabled = false;
    return;
  }

  if (!getApiKey()) {
    renderApiKeyState();
    statusText.textContent = "Ajoutez d’abord votre clé API Pl@ntNet.";
    apiKeyInput.focus();
    identifyButton.disabled = false;
    return;
  }

  statusText.textContent = "Identification en cours…";
  try {
    const result = await sendIdentification(state.photos);
    const storedPhotos = toStoredPhotos(state.photos);
    const historyId = await saveResult(result, storedPhotos);
    state.photos.forEach((photo) => URL.revokeObjectURL(photo.preview));
    state.photos = [];
    renderPhotos();
    statusText.textContent = result.remainingIdentificationRequests != null
      ? `${result.remainingIdentificationRequests} identifications Pl@ntNet restantes aujourd’hui.`
      : "Identification terminée.";
    await renderHistory();
    await openCapture(historyId);
  } catch (error) {
    if (!navigator.onLine) {
      await queueCurrentPhotos();
    } else {
      statusText.textContent = `Identification impossible : ${error.message}`;
    }
  } finally {
    identifyButton.disabled = false;
  }
});

async function queueCurrentPhotos() {
  await dbAdd(STORE_QUEUE, { createdAt: Date.now(), photos: toStoredPhotos(state.photos) });
  statusText.textContent = "Observation enregistrée hors connexion. L’identification reprendra au retour du réseau.";
  await renderQueue();
}

async function saveResult(result, photos = [], createdAt = Date.now()) {
  const best = result.results?.[0];
  if (!best) return null;
  return dbAdd(STORE_HISTORY, {
    createdAt,
    verified: false,
    verifiedAt: null,
    commonName: best.commonNames?.[0] || best.scientificNameWithoutAuthor,
    scientificName: best.scientificName,
    score: best.score,
    result,
    photos,
  });
}

function clearObjectUrls(key) {
  state[key].forEach((url) => URL.revokeObjectURL(url));
  state[key] = [];
}

function getResultFromHistory(item) {
  if (item.result?.results?.length) return item.result;
  return {
    results: [{
      score: Number(item.score || 0),
      scientificName: item.scientificName || "Inconnue",
      scientificNameWithoutAuthor: item.scientificName || "Inconnue",
      commonNames: item.commonName ? [item.commonName] : [],
      family: "",
      genus: "",
      images: [],
    }],
  };
}

function findReferenceImageUrl(best) {
  const image = best?.images?.[0];
  if (!image) return "";
  if (typeof image === "string") return image;
  if (typeof image.url === "string") return image.url;
  if (image.url && typeof image.url === "object") {
    return image.url.m || image.url.o || image.url.s || image.url.original || Object.values(image.url).find((value) => typeof value === "string") || "";
  }
  return image.imageUrl || image.urlM || image.urlO || image.urlS || "";
}

function checkSvg() {
  return `<svg class="checkIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.3 4.3L19 7.2"/></svg>`;
}

async function openCapture(id) {
  const item = await dbGet(STORE_HISTORY, id);
  if (!item) return;
  state.currentHistoryId = id;
  renderCapture(item);
  homeView.classList.add("hidden");
  captureView.classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "instant" });
}

function closeCapture() {
  captureView.classList.add("hidden");
  homeView.classList.remove("hidden");
  state.currentHistoryId = null;
  clearObjectUrls("detailObjectUrls");
  window.scrollTo({ top: 0, behavior: "instant" });
}

$("#backButton").addEventListener("click", closeCapture);

function renderCapture(item) {
  clearObjectUrls("detailObjectUrls");
  const result = getResultFromHistory(item);
  const best = result.results?.[0];
  if (!best) return;

  $("#captureDate").textContent = new Date(item.createdAt).toLocaleString("fr-FR", {
    dateStyle: "long",
    timeStyle: "short",
  });

  const capturePhotoGrid = $("#capturePhotoGrid");
  capturePhotoGrid.innerHTML = "";
  const photos = Array.isArray(item.photos) ? item.photos : [];
  $("#legacyPhotoNote").classList.toggle("hidden", photos.length > 0);
  photos.forEach((photo, index) => {
    if (!photo.blob) return;
    const url = URL.createObjectURL(photo.blob);
    state.detailObjectUrls.push(url);
    const img = document.createElement("img");
    img.src = url;
    img.alt = `Photo ${index + 1} de l’observation`;
    img.loading = "lazy";
    capturePhotoGrid.appendChild(img);
  });

  $("#bestCommonName").textContent = best.commonNames?.[0] || best.scientificNameWithoutAuthor;
  $("#bestScientificName").textContent = best.scientificName;

  const verificationLabel = $("#verificationLabel");
  const verificationHint = $("#verificationHint");
  verificationLabel.textContent = item.verified ? "Vérifiée" : "Non vérifiée";
  verificationLabel.classList.toggle("verified", Boolean(item.verified));
  bestScore.classList.toggle("verified", Boolean(item.verified));
  bestScore.disabled = Boolean(item.verified);
  if (item.verified) {
    bestScore.innerHTML = checkSvg();
    bestScore.setAttribute("aria-label", "Identification vérifiée");
    verificationHint.textContent = "Cette espèce a été confirmée pour cette observation.";
  } else {
    bestScore.textContent = `${Math.round(best.score * 100)}%`;
    bestScore.setAttribute("aria-label", "Valider cette identification");
    verificationHint.textContent = "Touchez le pourcentage pour confirmer que cette proposition correspond bien à la plante observée.";
  }

  const meta = $("#bestMeta");
  meta.innerHTML = "";
  [best.family && `Famille : ${best.family}`, best.genus && `Genre : ${best.genus}`]
    .filter(Boolean)
    .forEach((text) => {
      const chip = document.createElement("span");
      chip.className = "metaChip";
      chip.textContent = text;
      meta.appendChild(chip);
    });

  const referencePhotoBlock = $("#referencePhotoBlock");
  const referencePhoto = $("#referencePhoto");
  const referenceUrl = findReferenceImageUrl(best);
  referencePhotoBlock.classList.toggle("hidden", !referenceUrl);
  if (referenceUrl) referencePhoto.src = referenceUrl;
  else referencePhoto.removeAttribute("src");

  const alternatives = $("#alternatives");
  alternatives.innerHTML = "";
  if (result.results.length > 1) {
    const title = document.createElement("p");
    title.className = "alternativesTitle";
    title.textContent = "Autres propositions";
    alternatives.appendChild(title);
  }
  result.results.slice(1).forEach((candidate) => {
    const row = document.createElement("div");
    row.className = "altRow";
    row.innerHTML = `
      <div><div class="altName"></div><div class="altScientific"></div></div>
      <div class="altScore">${Math.round(candidate.score * 100)}%</div>`;
    row.querySelector(".altName").textContent = candidate.commonNames?.[0] || candidate.scientificNameWithoutAuthor;
    row.querySelector(".altScientific").textContent = candidate.scientificName;
    alternatives.appendChild(row);
  });
}

bestScore.addEventListener("click", async () => {
  if (!state.currentHistoryId) return;
  const item = await dbGet(STORE_HISTORY, state.currentHistoryId);
  if (!item || item.verified) return;
  item.verified = true;
  item.verifiedAt = Date.now();
  await dbPut(STORE_HISTORY, item);
  renderCapture(item);
  await renderHistory();
});

async function renderHistory() {
  clearObjectUrls("historyObjectUrls");
  const rows = (await dbGetAll(STORE_HISTORY)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
  historyList.innerHTML = "";
  historyList.classList.toggle("emptyState", rows.length === 0);
  if (!rows.length) {
    historyList.textContent = "Aucune identification pour le moment.";
    return;
  }

  rows.forEach((item) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "historyRow historyButton";
    row.setAttribute("aria-label", `Ouvrir l’observation ${item.commonName || item.scientificName || ""}`);

    const media = document.createElement("div");
    media.className = "historyMedia";
    const photo = item.photos?.[0];
    if (photo?.blob) {
      const url = URL.createObjectURL(photo.blob);
      state.historyObjectUrls.push(url);
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      media.appendChild(img);
    } else {
      media.classList.add("historyMediaEmpty");
    }

    const content = document.createElement("div");
    content.className = "historyContent";
    const name = document.createElement("div");
    name.className = "historyName";
    name.textContent = item.commonName || item.scientificName || "Identification";
    const meta = document.createElement("div");
    meta.className = "historyMeta";
    const date = new Date(item.createdAt).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
    meta.textContent = `${item.scientificName || ""}${item.scientificName ? " · " : ""}${date}`;
    content.append(name, meta);

    const status = document.createElement("span");
    status.className = `historyStatus${item.verified ? " verified" : ""}`;
    if (item.verified) {
      status.innerHTML = checkSvg();
      status.setAttribute("aria-label", "Vérifiée");
    } else {
      status.textContent = `${Math.round(Number(item.score || 0) * 100)}%`;
      status.setAttribute("aria-label", "Non vérifiée");
    }

    row.append(media, content, status);
    row.addEventListener("click", () => openCapture(item.id));
    historyList.appendChild(row);
  });
}

async function renderQueue() {
  const items = (await dbGetAll(STORE_QUEUE)).sort((a, b) => a.createdAt - b.createdAt);
  queueCount.textContent = String(items.length);
  queueList.innerHTML = "";
  queueList.classList.toggle("emptyState", items.length === 0);
  if (!items.length) {
    queueList.textContent = "Aucune observation en attente.";
    return;
  }
  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "queueRow";
    const count = item.photos.length;
    row.innerHTML = `<span>${count} photo${count > 1 ? "s" : ""}</span><span class="muted">En attente de connexion</span>`;
    queueList.appendChild(row);
  });
}

async function processQueue() {
  if (!navigator.onLine || !getApiKey()) return;
  const items = (await dbGetAll(STORE_QUEUE)).sort((a, b) => a.createdAt - b.createdAt);
  for (const item of items) {
    const photos = storedPhotosToFiles(item.photos);
    try {
      const result = await sendIdentification(photos);
      await saveResult(result, item.photos, item.createdAt);
      await dbDelete(STORE_QUEUE, item.id);
    } catch {
      break;
    }
  }
  await renderQueue();
  await renderHistory();
}

$("#clearHistoryButton").addEventListener("click", async () => {
  if (!confirm("Effacer tout l’historique enregistré sur cet appareil ?")) return;
  await dbClear(STORE_HISTORY);
  await renderHistory();
});

window.addEventListener("online", async () => {
  setConnectionUi();
  statusText.textContent = "Connexion rétablie. Vérification des observations en attente…";
  await processQueue();
  statusText.textContent = "";
});
window.addEventListener("offline", setConnectionUi);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js"));
}

setConnectionUi();
renderApiKeyState();
renderHistory();
renderQueue();
if (navigator.onLine) processQueue();
