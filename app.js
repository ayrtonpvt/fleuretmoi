const MAX_PHOTOS = 5;
const DB_NAME = "which-flower-db";
const DB_VERSION = 1;
const STORE_HISTORY = "history";
const STORE_QUEUE = "queue";
const API_KEY_STORAGE = "which-flower-plantnet-api-key";
const PLANTNET_API_URL = "https://my-api.plantnet.org/v2/identify/all";

const state = { photos: [] };

const $ = (selector) => document.querySelector(selector);
const photoInput = $("#photoInput");
const photoSection = $("#photoSection");
const photoGrid = $("#photoGrid");
const photoCount = $("#photoCount");
const identifyButton = $("#identifyButton");
const statusText = $("#statusText");
const resultSection = $("#resultSection");
const historyList = $("#historyList");
const queueList = $("#queueList");
const queueCount = $("#queueCount");
const connectionBadge = $("#connectionBadge");
const apiKeyInput = $("#apiKeyInput");
const apiStatus = $("#apiStatus");
const forgetApiKeyButton = $("#forgetApiKeyButton");

function getApiKey() {
  return localStorage.getItem(API_KEY_STORAGE)?.trim() || "";
}

function renderApiKeyState() {
  const configured = Boolean(getApiKey());
  apiStatus.textContent = configured ? "Saved" : "Not set";
  forgetApiKeyButton.classList.toggle("hidden", !configured);
  apiKeyInput.placeholder = configured ? "Key saved on this device" : "Paste your Pl@ntNet API key";
}

$("#originText").textContent = location.origin;
$("#saveApiKeyButton").addEventListener("click", async () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    statusText.textContent = "Paste your Pl@ntNet API key first.";
    apiKeyInput.focus();
    return;
  }
  localStorage.setItem(API_KEY_STORAGE, key);
  apiKeyInput.value = "";
  renderApiKeyState();
  statusText.textContent = "API key saved only on this device.";
  if (navigator.onLine) await processQueue();
});

forgetApiKeyButton.addEventListener("click", () => {
  localStorage.removeItem(API_KEY_STORAGE);
  renderApiKeyState();
  statusText.textContent = "API key removed from this device.";
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
    connectionBadge.textContent = "Online";
    connectionBadge.classList.remove("offline");
  } else {
    connectionBadge.textContent = "Offline";
    connectionBadge.classList.add("offline");
  }
}

photoInput.addEventListener("change", () => {
  const room = MAX_PHOTOS - state.photos.length;
  const incoming = [...photoInput.files].slice(0, room);
  incoming.forEach((file) => state.photos.push({ file, organ: "auto", preview: URL.createObjectURL(file) }));
  photoInput.value = "";
  renderPhotos();
});

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
    data.append("images", photo.file, photo.file.name || "plant.jpg");
    data.append("organs", photo.organ || "auto");
  });
  return data;
}

function normalizePlantNet(payload) {
  const results = (payload.results || []).slice(0, 5).map((item) => {
    const species = item.species || {};
    return {
      score: Number(item.score || 0),
      scientificName: species.scientificName || "Unknown",
      scientificNameWithoutAuthor: species.scientificNameWithoutAuthor || species.scientificName || "Unknown",
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
  if (!apiKey) throw new Error("NO_API_KEY");

  const lang = (navigator.language || "en").split("-")[0];
  const params = new URLSearchParams({
    "api-key": apiKey,
    lang,
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
      ? `The browser could not reach Pl@ntNet. Make sure ${location.origin} is allowed for this API key in your Pl@ntNet client/CORS access settings.`
      : "You are offline.";
    throw new Error(corsHint, { cause: error });
  }

  let payload;
  try { payload = await response.json(); } catch { payload = {}; }
  if (!response.ok) {
    const detail = payload.message || payload.error || payload.detail || `Pl@ntNet returned HTTP ${response.status}.`;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return normalizePlantNet(payload);
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
    statusText.textContent = "Add your Pl@ntNet API key in the setup card first.";
    apiKeyInput.focus();
    identifyButton.disabled = false;
    return;
  }

  statusText.textContent = "Identifying…";
  try {
    const result = await sendIdentification(state.photos);
    await saveResult(result);
    showResult(result);
    statusText.textContent = result.remainingIdentificationRequests != null
      ? `${result.remainingIdentificationRequests} Pl@ntNet identifications remaining today.`
      : "Identification complete.";
    await renderHistory();
  } catch (error) {
    if (!navigator.onLine) {
      await queueCurrentPhotos();
    } else {
      statusText.textContent = `Could not identify: ${error.message}`;
    }
  } finally {
    identifyButton.disabled = false;
  }
});

async function queueCurrentPhotos() {
  const queuePhotos = await Promise.all(state.photos.map(async ({ file, organ }) => ({
    blob: file,
    name: file.name,
    type: file.type,
    organ,
  })));
  await dbAdd(STORE_QUEUE, { createdAt: Date.now(), photos: queuePhotos });
  statusText.textContent = "Saved offline. It will retry when you're back online.";
  await renderQueue();
}

function showResult(result) {
  const best = result.results?.[0];
  if (!best) {
    statusText.textContent = "Pl@ntNet did not return a confident plant match.";
    return;
  }
  $("#bestCommonName").textContent = best.commonNames?.[0] || best.scientificNameWithoutAuthor;
  $("#bestScientificName").textContent = best.scientificName;
  $("#bestScore").textContent = `${Math.round(best.score * 100)}%`;
  const meta = $("#bestMeta");
  meta.innerHTML = "";
  [best.family && `Family: ${best.family}`, best.genus && `Genus: ${best.genus}`]
    .filter(Boolean)
    .forEach((text) => {
      const chip = document.createElement("span");
      chip.className = "metaChip";
      chip.textContent = text;
      meta.appendChild(chip);
    });

  const alternatives = $("#alternatives");
  alternatives.innerHTML = "";
  result.results.slice(1).forEach((item) => {
    const row = document.createElement("div");
    row.className = "altRow";
    row.innerHTML = `
      <div><div class="altName"></div><div class="altScientific"></div></div>
      <div class="altScore">${Math.round(item.score * 100)}%</div>`;
    row.querySelector(".altName").textContent = item.commonNames?.[0] || item.scientificNameWithoutAuthor;
    row.querySelector(".altScientific").textContent = item.scientificName;
    alternatives.appendChild(row);
  });
  resultSection.classList.remove("hidden");
  resultSection.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function saveResult(result) {
  const best = result.results?.[0];
  if (!best) return;
  await dbAdd(STORE_HISTORY, {
    createdAt: Date.now(),
    commonName: best.commonNames?.[0] || best.scientificNameWithoutAuthor,
    scientificName: best.scientificName,
    score: best.score,
  });
}

async function renderHistory() {
  const rows = (await dbGetAll(STORE_HISTORY)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 30);
  historyList.innerHTML = "";
  historyList.classList.toggle("emptyState", rows.length === 0);
  if (!rows.length) {
    historyList.textContent = "No identifications yet.";
    return;
  }
  rows.forEach((item) => {
    const row = document.createElement("div");
    row.className = "historyRow";
    const date = new Date(item.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    row.innerHTML = `
      <div><div class="historyName"></div><div class="historyMeta"></div></div>
      <strong>${Math.round(item.score * 100)}%</strong>`;
    row.querySelector(".historyName").textContent = item.commonName;
    row.querySelector(".historyMeta").textContent = `${item.scientificName} · ${date}`;
    historyList.appendChild(row);
  });
}

async function renderQueue() {
  const items = (await dbGetAll(STORE_QUEUE)).sort((a, b) => a.createdAt - b.createdAt);
  queueCount.textContent = String(items.length);
  queueList.innerHTML = "";
  queueList.classList.toggle("emptyState", items.length === 0);
  if (!items.length) {
    queueList.textContent = "Nothing waiting.";
    return;
  }
  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "queueRow";
    row.innerHTML = `<span>${item.photos.length} photo${item.photos.length === 1 ? "" : "s"}</span><span class="muted">Waiting for connection</span>`;
    queueList.appendChild(row);
  });
}

async function processQueue() {
  if (!navigator.onLine || !getApiKey()) return;
  const items = (await dbGetAll(STORE_QUEUE)).sort((a, b) => a.createdAt - b.createdAt);
  for (const item of items) {
    const photos = item.photos.map((p) => ({
      file: new File([p.blob], p.name || "plant.jpg", { type: p.type || "image/jpeg" }),
      organ: p.organ || "auto",
    }));
    try {
      const result = await sendIdentification(photos);
      await saveResult(result);
      await dbDelete(STORE_QUEUE, item.id);
    } catch {
      break;
    }
  }
  await renderQueue();
  await renderHistory();
}

$("#clearHistoryButton").addEventListener("click", async () => {
  await dbClear(STORE_HISTORY);
  await renderHistory();
});

window.addEventListener("online", async () => {
  setConnectionUi();
  statusText.textContent = "Back online. Checking saved observations…";
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
