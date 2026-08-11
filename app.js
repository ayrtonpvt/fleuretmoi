const MAX_PHOTOS = 5;
const DB_NAME = "which-flower-db";
const DB_VERSION = 3;
const STORE_HISTORY = "history"; // legacy store kept for migration/compatibility
const STORE_QUEUE = "queue";
const STORE_OBSERVATIONS = "observations";
const STORE_SPECIES = "species";
const API_KEY_STORAGE = "which-flower-plantnet-api-key";
const PLANTNET_API_URL = "https://my-api.plantnet.org/v2/identify/all";

const state = {
  photos: [],
  currentObservationId: null,
  currentSpeciesId: null,
  currentMainView: "camera",
  captureReturn: { type: "main", value: "camera" },
  draftNote: "",
  detailObjectUrls: [],
  historyObjectUrls: [],
  herbariumObjectUrls: [],
  speciesObjectUrls: [],
  mapObjectUrls: [],
  map: null,
  mapLayer: null,
  editor: null,
  editorPointer: null,
  swipeGesture: null,
  locationPickerMap: null,
  locationPickerMarker: null,
  pendingLocation: null,
  lastGeocodeAt: 0,
  navDepth: 0,
  handlingPopState: false,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
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
const bestScore = $("#bestScore");
const mainNavigation = $("#mainNavigation");
const draftNote = $("#draftNote");

const views = {
  camera: $("#cameraView"),
  herbarium: $("#herbariumView"),
  map: $("#mapView"),
  capture: $("#captureView"),
  species: $("#speciesView"),
};

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
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const tx = request.transaction;

      if (!db.objectStoreNames.contains(STORE_HISTORY)) {
        db.createObjectStore(STORE_HISTORY, { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_QUEUE)) {
        db.createObjectStore(STORE_QUEUE, { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_OBSERVATIONS)) {
        const observations = db.createObjectStore(STORE_OBSERVATIONS, { keyPath: "id", autoIncrement: true });
        observations.createIndex("createdAt", "createdAt", { unique: false });
        observations.createIndex("captureAt", "captureAt", { unique: false });
        observations.createIndex("speciesId", "speciesId", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_SPECIES)) {
        const species = db.createObjectStore(STORE_SPECIES, { keyPath: "id", autoIncrement: true });
        species.createIndex("scientificKey", "scientificKey", { unique: true });
        species.createIndex("lastSeenAt", "lastSeenAt", { unique: false });
      }

      // Migrate the v2 history once, inside the database upgrade transaction.
      if (event.oldVersion < 3 && db.objectStoreNames.contains(STORE_HISTORY)) {
        const oldStore = tx.objectStore(STORE_HISTORY);
        const newStore = tx.objectStore(STORE_OBSERVATIONS);
        oldStore.openCursor().onsuccess = (cursorEvent) => {
          const cursor = cursorEvent.target.result;
          if (!cursor) return;
          const legacy = cursor.value;
          const result = getResultFromLegacy(legacy);
          const best = result.results?.[0] || {};
          newStore.add({
            createdAt: legacy.createdAt || Date.now(),
            captureAt: legacy.captureAt || legacy.createdAt || Date.now(),
            dateSource: "ancienne_donnée",
            verified: Boolean(legacy.verified),
            verifiedAt: legacy.verifiedAt || null,
            speciesId: null,
            commonName: legacy.commonName || best.commonNames?.[0] || best.scientificNameWithoutAuthor || "Identification",
            scientificName: legacy.scientificName || best.scientificName || "Inconnue",
            scientificNameWithoutAuthor: best.scientificNameWithoutAuthor || legacy.scientificName || "Inconnue",
            score: Number(legacy.score ?? best.score ?? 0),
            result,
            photos: Array.isArray(legacy.photos) ? legacy.photos : [],
            location: legacy.location || null,
            note: legacy.note || "",
            legacyHistoryId: legacy.id,
          });
          cursor.continue();
        };
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

async function dbGetByIndex(storeName, indexName, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).index(indexName).get(value);
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

function formatDate(timestamp, withTime = false) {
  if (!timestamp) return "Date inconnue";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "Date inconnue";
  return date.toLocaleString("fr-FR", withTime
    ? { dateStyle: "long", timeStyle: "short" }
    : { day: "numeric", month: "short", year: "numeric" });
}

function normalizeScientificKey(name = "") {
  return String(name)
    .trim()
    .toLocaleLowerCase("fr")
    .replace(/\s+/g, " ");
}

function googleImagesUrl(scientificName) {
  const q = `${scientificName || "plante"} botanique`;
  return `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(q)}`;
}

function checkSvg() {
  return `<svg class="checkIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.3 4.3L19 7.2"/></svg>`;
}

function clearObjectUrls(key) {
  state[key].forEach((url) => URL.revokeObjectURL(url));
  state[key] = [];
}

function blobUrl(blob, bucket) {
  if (!blob) return "";
  const url = URL.createObjectURL(blob);
  state[bucket].push(url);
  return url;
}

function getResultFromLegacy(item) {
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

function getResultFromObservation(item) {
  return getResultFromLegacy(item);
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

function metadataDateToTimestamp(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  // EXIF commonly uses YYYY:MM:DD HH:mm:ss, which Date.parse does not reliably understand.
  const exifMatch = trimmed.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:\s*([+-]\d{2}:?\d{2}|Z))?$/);
  if (exifMatch) {
    const [, year, month, day, hour, minute, second, fraction = "0", offset] = exifMatch;
    const millis = Number((fraction + "000").slice(0, 3));
    if (offset) {
      const normalizedOffset = offset === "Z" ? "Z" : offset.includes(":") ? offset : `${offset.slice(0, 3)}:${offset.slice(3)}`;
      const parsed = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}.${String(millis).padStart(3, "0")}${normalizedOffset}`);
      if (Number.isFinite(parsed)) return parsed;
    }
    const local = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), millis).getTime();
    if (Number.isFinite(local)) return local;
  }

  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function plausibleFileDate(file) {
  const time = Number(file?.lastModified);
  const lowerBound = new Date(1990, 0, 1).getTime();
  const upperBound = Date.now() + 24 * 60 * 60 * 1000;
  return Number.isFinite(time) && time >= lowerBound && time <= upperBound ? time : null;
}

async function extractPhotoMetadata(file, source) {
  const fileDate = source === "gallery" ? plausibleFileDate(file) : null;
  const meta = {
    capturedAt: fileDate || Date.now(),
    dateSource: source === "camera" ? "capture" : fileDate ? "fichier" : "import",
    location: null,
    exifFound: false,
  };

  if (source === "gallery" && window.exifr) {
    let exif = null;
    try {
      // Full parsing gives us EXIF + XMP + GPS where the selected file actually contains them.
      exif = await window.exifr.parse(file, true);
      meta.exifFound = Boolean(exif && Object.keys(exif).length);
    } catch {
      exif = null;
    }

    if (exif) {
      const dateCandidates = [
        exif.DateTimeOriginal,
        exif.CreateDate,
        exif.DateTimeDigitized,
        exif.DateTime,
        exif.DateCreated,
        exif.CreationDate,
        exif.ModifyDate,
      ];
      for (const candidate of dateCandidates) {
        const timestamp = metadataDateToTimestamp(candidate);
        if (timestamp) {
          meta.capturedAt = timestamp;
          meta.dateSource = "exif";
          break;
        }
      }

      if (Number.isFinite(exif.latitude) && Number.isFinite(exif.longitude)) {
        meta.location = { latitude: exif.latitude, longitude: exif.longitude, source: "exif" };
      }
    }

    if (!meta.location) {
      try {
        const gps = await window.exifr.gps(file);
        if (Number.isFinite(gps?.latitude) && Number.isFinite(gps?.longitude)) {
          meta.location = { latitude: gps.latitude, longitude: gps.longitude, source: "exif" };
        }
      } catch {
        // Android/iOS pickers may redact location metadata before the browser receives the file.
      }
    }
  }

  if (source === "camera") {
    const location = await getCurrentLocation(false);
    if (location) meta.location = { ...location, source: "appareil" };
  }

  return meta;
}

function getCurrentLocation(showErrors = true) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      if (showErrors) statusText.textContent = "La géolocalisation n’est pas disponible sur cet appareil.";
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy,
      }),
      () => {
        if (showErrors) statusText.textContent = "Position non ajoutée : autorisation refusée ou position indisponible.";
        resolve(null);
      },
      { enableHighAccuracy: false, timeout: 7000, maximumAge: 120000 }
    );
  });
}

async function addSelectedPhotos(input, source) {
  const selectedFiles = [...input.files];
  const room = MAX_PHOTOS - state.photos.length;
  const incoming = selectedFiles.slice(0, room);
  input.value = "";

  if (!incoming.length) return;
  statusText.textContent = source === "gallery" ? "Lecture des métadonnées des photos…" : "Préparation de la photo…";

  for (const file of incoming) {
    const metadata = await extractPhotoMetadata(file, source);
    state.photos.push({
      file,
      organ: "auto",
      preview: URL.createObjectURL(file),
      source,
      capturedAt: metadata.capturedAt,
      dateSource: metadata.dateSource,
      location: metadata.location,
    });
  }

  if (incoming.length < selectedFiles.length || room === 0) {
    statusText.textContent = `Vous pouvez ajouter au maximum ${MAX_PHOTOS} photos de la même plante.`;
  } else {
    statusText.textContent = "";
  }
  renderPhotos();
}

cameraInput.addEventListener("change", () => addSelectedPhotos(cameraInput, "camera"));
galleryInput.addEventListener("change", () => addSelectedPhotos(galleryInput, "gallery"));
draftNote.addEventListener("input", () => { state.draftNote = draftNote.value; });

function photoDateLabel(photo) {
  if (!photo?.capturedAt) return "";
  const source = photo.dateSource === "exif"
    ? "date EXIF"
    : photo.dateSource === "fichier"
      ? "date du fichier"
      : photo.dateSource === "capture"
        ? "prise maintenant"
        : "date d’import";
  return `${formatDate(photo.capturedAt)} · ${source}`;
}

function renderPhotos() {
  photoGrid.innerHTML = "";
  state.photos.forEach((photo, index) => {
    const node = $("#photoTemplate").content.cloneNode(true);
    const img = node.querySelector("img");
    const previewButton = node.querySelector(".photoPreviewButton");
    const select = node.querySelector("select");
    const edit = node.querySelector(".editPhotoButton");
    const remove = node.querySelector(".removeButton");
    const meta = node.querySelector(".photoMetaLine");
    img.src = photo.preview;
    select.value = photo.organ;
    meta.textContent = photoDateLabel(photo);
    select.addEventListener("change", (event) => { state.photos[index].organ = event.target.value; });
    previewButton.addEventListener("click", () => openDraftPhotoEditor(index));
    edit.addEventListener("click", () => openDraftPhotoEditor(index));
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
    response = await fetch(`${PLANTNET_API_URL}?${params}`, { method: "POST", body: buildFormData(photos) });
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
  return photos.map(({ file, organ, source, capturedAt, dateSource, location }) => ({
    blob: file,
    name: file.name,
    type: file.type,
    organ,
    source,
    capturedAt,
    dateSource,
    location: location || null,
  }));
}

function storedPhotosToFiles(photos = []) {
  return photos.map((p) => ({
    file: new File([p.blob], p.name || "plante.jpg", { type: p.type || "image/jpeg" }),
    organ: p.organ || "auto",
    source: p.source || "stored",
    capturedAt: p.capturedAt,
    dateSource: p.dateSource,
    location: p.location || null,
  }));
}

function deriveObservationDate(photos, fallback = Date.now()) {
  const dates = photos.map((p) => Number(p.capturedAt)).filter((n) => Number.isFinite(n) && n > 0);
  return dates.length ? Math.min(...dates) : fallback;
}

function deriveObservationLocation(photos) {
  const found = photos.find((p) => Number.isFinite(p.location?.latitude) && Number.isFinite(p.location?.longitude));
  return found ? { ...found.location } : null;
}

identifyButton.addEventListener("click", async () => {
  if (!state.photos.length) return;
  identifyButton.disabled = true;
  state.draftNote = draftNote.value;

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
    const observationId = await saveObservation(result, storedPhotos, {
      note: state.draftNote,
      captureAt: deriveObservationDate(state.photos),
      location: deriveObservationLocation(state.photos),
    });
    resetDraftPhotos();
    if (!result.results?.length) {
      statusText.textContent = "Pl@ntNet n’a proposé aucune correspondance pour ces photos. L’observation a été conservée sans identification.";
    } else {
      statusText.textContent = result.remainingIdentificationRequests != null
        ? `${result.remainingIdentificationRequests} identifications Pl@ntNet restantes aujourd’hui.`
        : "Identification terminée.";
    }
    await refreshAllLists();
    await openCapture(observationId, { type: "main", value: "camera" });
  } catch (error) {
    if (!navigator.onLine) await queueCurrentPhotos();
    else statusText.textContent = `Identification impossible : ${error.message}`;
  } finally {
    identifyButton.disabled = false;
  }
});

function resetDraftPhotos() {
  state.photos.forEach((photo) => URL.revokeObjectURL(photo.preview));
  state.photos = [];
  state.draftNote = "";
  draftNote.value = "";
  renderPhotos();
}

async function queueCurrentPhotos() {
  const stored = toStoredPhotos(state.photos);
  await dbAdd(STORE_QUEUE, {
    createdAt: Date.now(),
    captureAt: deriveObservationDate(state.photos),
    location: deriveObservationLocation(state.photos),
    note: state.draftNote || draftNote.value || "",
    photos: stored,
  });
  statusText.textContent = "Observation enregistrée hors connexion. L’identification reprendra au retour du réseau.";
  resetDraftPhotos();
  await renderQueue();
}

async function saveObservation(result, photos = [], options = {}) {
  // Pl@ntNet can return a 200 OK with an empty results array (e.g. no organ
  // recognized). Previously that made this function return null, which made
  // callers wipe the draft photos / delete the queued item while saving
  // nothing at all — the user's photos disappeared with no trace. We now
  // always persist an observation, flagged as "noMatch", so nothing is lost.
  const hasMatch = Boolean(result.results?.[0]);
  const best = hasMatch ? result.results[0] : {
    score: 0,
    scientificName: "Aucune correspondance",
    scientificNameWithoutAuthor: "Aucune correspondance",
    commonNames: ["Aucune correspondance trouvée"],
    family: "",
    genus: "",
    images: [],
  };
  const storedResult = hasMatch ? result : { ...result, results: [best] };
  return dbAdd(STORE_OBSERVATIONS, {
    createdAt: Date.now(),
    captureAt: options.captureAt || deriveObservationDate(photos),
    dateSource: photos.find((p) => p.capturedAt === (options.captureAt || deriveObservationDate(photos)))?.dateSource || "capture",
    verified: false,
    verifiedAt: null,
    speciesId: null,
    noMatch: !hasMatch,
    commonName: best.commonNames?.[0] || best.scientificNameWithoutAuthor,
    scientificName: best.scientificName,
    scientificNameWithoutAuthor: best.scientificNameWithoutAuthor || best.scientificName,
    score: best.score,
    result: storedResult,
    photos,
    location: options.location || deriveObservationLocation(photos),
    note: options.note || "",
  });
}

async function ensureSpeciesForObservation(observation) {
  if (observation.noMatch) return { species: null, isNew: false };
  const result = getResultFromObservation(observation);
  const best = result.results?.[0];
  if (!best) return { species: null, isNew: false };
  const scientificKey = normalizeScientificKey(best.scientificNameWithoutAuthor || best.scientificName);
  let species = await dbGetByIndex(STORE_SPECIES, "scientificKey", scientificKey);
  const isNew = !species;

  if (!species) {
    species = {
      scientificKey,
      scientificName: best.scientificName,
      scientificNameWithoutAuthor: best.scientificNameWithoutAuthor || best.scientificName,
      commonName: best.commonNames?.[0] || best.scientificNameWithoutAuthor || best.scientificName,
      family: best.family || "",
      genus: best.genus || "",
      observationIds: [observation.id],
      firstSeenAt: observation.captureAt || observation.createdAt,
      lastSeenAt: observation.captureAt || observation.createdAt,
      note: observation.note || "",
      illustration: null,
      createdAt: Date.now(),
    };
    species.id = await dbAdd(STORE_SPECIES, species);
  } else {
    const ids = new Set(species.observationIds || []);
    ids.add(observation.id);
    species.observationIds = [...ids];
    const obsDate = observation.captureAt || observation.createdAt;
    species.firstSeenAt = Math.min(species.firstSeenAt || obsDate, obsDate);
    species.lastSeenAt = Math.max(species.lastSeenAt || obsDate, obsDate);
    if (!species.note && observation.note) species.note = observation.note;
    await dbPut(STORE_SPECIES, species);
  }

  observation.speciesId = species.id;
  observation.verified = true;
  observation.verifiedAt = observation.verifiedAt || Date.now();
  await dbPut(STORE_OBSERVATIONS, observation);
  return { species, isNew };
}

async function syncVerifiedSpecies() {
  const observations = await dbGetAll(STORE_OBSERVATIONS);
  for (const observation of observations) {
    if (observation.verified && !observation.speciesId) {
      await ensureSpeciesForObservation(observation);
    }
  }
}

function hideAllViews() {
  Object.values(views).forEach((view) => view.classList.add("hidden"));
}

function makeHistoryState(route, depth = state.navDepth) {
  return { fleuretmoi: true, route, depth };
}

function recordRoute(route, mode = "push") {
  if (mode === "none" || state.handlingPopState) return;
  if (mode === "replace") {
    history.replaceState(makeHistoryState(route, state.navDepth), "", location.href);
    return;
  }
  const currentRoute = history.state?.fleuretmoi ? history.state.route : null;
  if (currentRoute && JSON.stringify(currentRoute) === JSON.stringify(route)) return;
  state.navDepth = Math.max(0, Number(history.state?.depth ?? state.navDepth ?? 0)) + 1;
  history.pushState(makeHistoryState(route, state.navDepth), "", location.href);
}

async function showMainView(name, { historyMode = "push" } = {}) {
  if (!["camera", "herbarium", "map"].includes(name)) name = "camera";
  hideAllViews();
  views[name].classList.remove("hidden");
  mainNavigation.classList.remove("hidden");
  state.currentMainView = name;
  state.currentObservationId = null;
  state.currentSpeciesId = null;
  clearObjectUrls("detailObjectUrls");
  clearObjectUrls("speciesObjectUrls");
  $$("#mainNavigation [data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
  window.scrollTo({ top: 0, behavior: "instant" });
  if (name === "herbarium") await renderHerbarium();
  if (name === "map") {
    await renderMap();
    setTimeout(() => state.map?.invalidateSize(), 50);
  }
  recordRoute({ type: "main", value: name }, historyMode);
}

$$("#mainNavigation [data-view]").forEach((button) => button.addEventListener("click", () => showMainView(button.dataset.view)));

async function openCapture(id, returnTarget = { type: "main", value: state.currentMainView }, { historyMode = "push" } = {}) {
  const item = await dbGet(STORE_OBSERVATIONS, id);
  if (!item) return;
  state.currentObservationId = id;
  state.captureReturn = returnTarget;
  await renderCapture(item);
  hideAllViews();
  views.capture.classList.remove("hidden");
  mainNavigation.classList.add("hidden");
  window.scrollTo({ top: 0, behavior: "instant" });
  recordRoute({ type: "capture", id, returnTarget }, historyMode);
}

async function closeCapture() {
  if (history.state?.fleuretmoi && Number(history.state.depth || 0) > 0) {
    history.back();
    return;
  }
  state.currentObservationId = null;
  clearObjectUrls("detailObjectUrls");
  const target = state.captureReturn;
  if (target?.type === "species" && target.value) await openSpecies(target.value, { historyMode: "replace" });
  else await showMainView(target?.value || "camera", { historyMode: "replace" });
}

$("#backCaptureButton").addEventListener("click", closeCapture);

async function renderCapture(item) {
  clearObjectUrls("detailObjectUrls");
  const result = getResultFromObservation(item);
  const best = result.results?.[0];
  if (!best) return;

  $("#captureDate").textContent = formatDate(item.captureAt || item.createdAt, true);
  const capturePhotoGrid = $("#capturePhotoGrid");
  capturePhotoGrid.innerHTML = "";
  const photos = Array.isArray(item.photos) ? item.photos : [];
  $("#legacyPhotoNote").classList.toggle("hidden", photos.length > 0);
  photos.forEach((photo, index) => {
    if (!photo.blob) return;
    const img = document.createElement("img");
    img.src = blobUrl(photo.blob, "detailObjectUrls");
    img.alt = `Photo ${index + 1} de l’observation`;
    img.loading = "lazy";
    capturePhotoGrid.appendChild(img);
  });

  $("#bestCommonName").textContent = best.commonNames?.[0] || best.scientificNameWithoutAuthor;
  const scientificLink = $("#bestScientificName");
  scientificLink.textContent = best.scientificNameWithoutAuthor || best.scientificName;
  scientificLink.href = googleImagesUrl(best.scientificNameWithoutAuthor || best.scientificName);

  const verificationLabel = $("#verificationLabel");
  const verificationHint = $("#verificationHint");
  $("#newSpeciesMessage").classList.add("hidden");
  verificationLabel.textContent = item.verified ? "Vérifiée" : (item.noMatch ? "Sans résultat" : "Non vérifiée");
  verificationLabel.classList.toggle("verified", Boolean(item.verified));
  bestScore.classList.toggle("verified", Boolean(item.verified));
  bestScore.disabled = Boolean(item.verified) || Boolean(item.noMatch);
  if (item.verified) {
    bestScore.innerHTML = checkSvg();
    bestScore.setAttribute("aria-label", "Identification vérifiée");
    verificationHint.textContent = "Cette espèce a été confirmée pour cette observation.";
  } else if (item.noMatch) {
    bestScore.textContent = "—";
    bestScore.setAttribute("aria-label", "Aucune correspondance proposée");
    verificationHint.textContent = "Pl@ntNet n’a proposé aucune correspondance pour ces photos. Réessayez avec de nouvelles photos si besoin.";
  } else {
    bestScore.textContent = `${Math.round(best.score * 100)}%`;
    bestScore.setAttribute("aria-label", "Valider cette identification");
    verificationHint.textContent = "Touchez le pourcentage pour confirmer que cette proposition correspond bien à la plante observée.";
  }

  const meta = $("#bestMeta");
  meta.innerHTML = "";
  [best.family && `Famille : ${best.family}`, best.genus && `Genre : ${best.genus}`].filter(Boolean).forEach((text) => {
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
    const left = document.createElement("div");
    const common = document.createElement("div");
    common.className = "altName";
    common.textContent = candidate.commonNames?.[0] || candidate.scientificNameWithoutAuthor;
    const scientific = document.createElement("a");
    scientific.className = "altScientific scientificLink";
    scientific.textContent = candidate.scientificNameWithoutAuthor || candidate.scientificName;
    scientific.href = googleImagesUrl(candidate.scientificNameWithoutAuthor || candidate.scientificName);
    scientific.target = "_blank";
    scientific.rel = "noopener";
    const score = document.createElement("div");
    score.className = "altScore";
    score.textContent = `${Math.round(candidate.score * 100)}%`;
    left.append(common, scientific);
    row.append(left, score);
    alternatives.appendChild(row);
  });

  $("#captureNote").value = item.note || "";
  $("#captureNoteStatus").textContent = "";
  renderCaptureLocation(item);
}

function renderCaptureLocation(item) {
  const row = $("#captureLocationRow");
  row.innerHTML = "";

  const hasLocation = Number.isFinite(item.location?.latitude) && Number.isFinite(item.location?.longitude);
  const text = document.createElement("span");
  text.className = "locationText";
  if (hasLocation) {
    const label = item.location.label ? `${item.location.label} · ` : "";
    text.textContent = `Position enregistrée · ${label}${item.location.latitude.toFixed(5)}, ${item.location.longitude.toFixed(5)}`;
  } else {
    text.textContent = "Aucune position associée à cette observation.";
  }

  const button = document.createElement("button");
  button.className = "secondaryButton";
  button.type = "button";
  button.textContent = hasLocation ? "Modifier la position" : "Ajouter une position";
  button.addEventListener("click", () => openLocationPicker(item));

  row.append(text, button);
}

function setLocationPickerMode(mode) {
  const isMap = mode === "map";
  $("#locationMapMode").classList.toggle("hidden", !isMap);
  $("#locationAddressMode").classList.toggle("hidden", isMap);
  $("#locationMapModeButton").classList.toggle("active", isMap);
  $("#locationAddressModeButton").classList.toggle("active", !isMap);
  if (isMap) setTimeout(() => state.locationPickerMap?.invalidateSize(), 40);
}

function updatePendingLocation(locationData) {
  state.pendingLocation = locationData;
  const summary = $("#locationSelectionSummary");
  const saveButton = $("#saveLocationButton");
  if (!locationData) {
    summary.textContent = "Aucune position sélectionnée.";
    saveButton.disabled = true;
    if (state.locationPickerMarker && state.locationPickerMap) {
      state.locationPickerMap.removeLayer(state.locationPickerMarker);
      state.locationPickerMarker = null;
    }
    return;
  }

  const label = locationData.label ? `${locationData.label} · ` : "";
  summary.textContent = `${label}${locationData.latitude.toFixed(5)}, ${locationData.longitude.toFixed(5)}`;
  saveButton.disabled = false;
  placeLocationPickerMarker(locationData.latitude, locationData.longitude, false);
}

function ensureLocationPickerMap() {
  if (state.locationPickerMap || !window.L) return;
  state.locationPickerMap = L.map("locationPickerMap", { zoomControl: true }).setView([46.5, 2.5], 5);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributeurs',
  }).addTo(state.locationPickerMap);

  state.locationPickerMap.on("click", (event) => {
    updatePendingLocation({
      latitude: event.latlng.lat,
      longitude: event.latlng.lng,
      source: "carte_manuelle",
      label: "",
    });
  });
}

function placeLocationPickerMarker(latitude, longitude, recenter = true) {
  if (!state.locationPickerMap || !window.L) return;
  if (!state.locationPickerMarker) {
    state.locationPickerMarker = L.marker([latitude, longitude], { draggable: true }).addTo(state.locationPickerMap);
    state.locationPickerMarker.on("dragend", () => {
      const point = state.locationPickerMarker.getLatLng();
      state.pendingLocation = {
        latitude: point.lat,
        longitude: point.lng,
        source: "carte_manuelle",
        label: "",
      };
      $("#locationSelectionSummary").textContent = `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
      $("#saveLocationButton").disabled = false;
    });
  } else {
    state.locationPickerMarker.setLatLng([latitude, longitude]);
  }
  if (recenter) state.locationPickerMap.setView([latitude, longitude], Math.max(state.locationPickerMap.getZoom(), 14));
}

function openLocationPicker(item) {
  const dialog = $("#locationPicker");
  $("#locationPickerStatus").textContent = "";
  $("#locationSearchResults").innerHTML = "";
  $("#locationAddressInput").value = "";
  setLocationPickerMode("map");
  ensureLocationPickerMap();

  const hasLocation = Number.isFinite(item.location?.latitude) && Number.isFinite(item.location?.longitude);
  updatePendingLocation(hasLocation ? { ...item.location } : null);
  dialog.showModal();

  setTimeout(() => {
    state.locationPickerMap?.invalidateSize();
    if (hasLocation) placeLocationPickerMarker(item.location.latitude, item.location.longitude, true);
  }, 80);
}

async function searchLocationAddress() {
  const input = $("#locationAddressInput");
  const status = $("#locationPickerStatus");
  const resultsBox = $("#locationSearchResults");
  const query = input.value.trim();
  if (!query) {
    status.textContent = "Saisissez une adresse ou un nom de lieu.";
    input.focus();
    return;
  }

  const wait = 1000 - (Date.now() - state.lastGeocodeAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  state.lastGeocodeAt = Date.now();
  status.textContent = "Recherche de l’adresse…";
  resultsBox.innerHTML = "";

  try {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("q", query);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "5");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("accept-language", "fr");
    const response = await fetch(url.toString(), { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const results = await response.json();
    status.textContent = results.length ? "" : "Aucun lieu trouvé.";

    results.forEach((result) => {
      const latitude = Number(result.lat);
      const longitude = Number(result.lon);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "locationSearchResult";
      button.textContent = result.display_name;
      button.addEventListener("click", () => {
        updatePendingLocation({
          latitude,
          longitude,
          source: "adresse",
          label: result.display_name,
        });
        setLocationPickerMode("map");
        setTimeout(() => placeLocationPickerMarker(latitude, longitude, true), 40);
      });
      resultsBox.appendChild(button);
    });
  } catch (error) {
    console.error(error);
    status.textContent = "Impossible de rechercher cette adresse pour le moment.";
  }
}

$("#locationMapModeButton").addEventListener("click", () => setLocationPickerMode("map"));
$("#locationAddressModeButton").addEventListener("click", () => setLocationPickerMode("address"));
$("#searchLocationAddressButton").addEventListener("click", searchLocationAddress);
$("#locationAddressInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    searchLocationAddress();
  }
});

$("#locationCurrentButton").addEventListener("click", async () => {
  const button = $("#locationCurrentButton");
  const status = $("#locationPickerStatus");
  button.disabled = true;
  status.textContent = "Recherche de votre position…";
  const locationData = await getCurrentLocation(true);
  button.disabled = false;
  if (!locationData) {
    status.textContent = "Impossible d’obtenir votre position actuelle.";
    return;
  }
  status.textContent = "";
  updatePendingLocation({ ...locationData, source: "position_actuelle", label: "Position actuelle" });
  setLocationPickerMode("map");
  setTimeout(() => placeLocationPickerMarker(locationData.latitude, locationData.longitude, true), 40);
});

$("#cancelLocationPickerButton").addEventListener("click", () => $("#locationPicker").close());

$("#saveLocationButton").addEventListener("click", async () => {
  if (!state.currentObservationId || !state.pendingLocation) return;
  const item = await dbGet(STORE_OBSERVATIONS, state.currentObservationId);
  if (!item) return;
  item.location = { ...state.pendingLocation, addedAt: Date.now() };
  await dbPut(STORE_OBSERVATIONS, item);
  $("#locationPicker").close();
  renderCaptureLocation(item);
  await renderMap();
});

bestScore.addEventListener("click", async () => {
  if (!state.currentObservationId) return;
  const item = await dbGet(STORE_OBSERVATIONS, state.currentObservationId);
  if (!item || item.verified) return;
  const { isNew } = await ensureSpeciesForObservation(item);
  const updated = await dbGet(STORE_OBSERVATIONS, item.id);
  await renderCapture(updated);
  if (isNew) {
    $("#newSpeciesMessage").classList.remove("hidden");
    launchConfetti();
  }
  await refreshAllLists();
});

$("#saveCaptureNoteButton").addEventListener("click", async () => {
  if (!state.currentObservationId) return;
  const item = await dbGet(STORE_OBSERVATIONS, state.currentObservationId);
  if (!item) return;
  item.note = $("#captureNote").value.trim();
  await dbPut(STORE_OBSERVATIONS, item);
  if (item.speciesId) {
    const species = await dbGet(STORE_SPECIES, item.speciesId);
    if (species && !species.note && item.note) {
      species.note = item.note;
      await dbPut(STORE_SPECIES, species);
    }
  }
  $("#captureNoteStatus").textContent = "Note enregistrée.";
});

async function renderHistory() {
  clearObjectUrls("historyObjectUrls");
  const rows = (await dbGetAll(STORE_OBSERVATIONS)).sort((a, b) => (b.captureAt || b.createdAt) - (a.captureAt || a.createdAt)).slice(0, 60);
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
      const img = document.createElement("img");
      img.src = blobUrl(photo.blob, "historyObjectUrls");
      img.alt = "";
      media.appendChild(img);
    } else media.classList.add("historyMediaEmpty");

    const content = document.createElement("div");
    content.className = "historyContent";
    const name = document.createElement("div");
    name.className = "historyName";
    name.textContent = item.commonName || item.scientificName || "Identification";
    const meta = document.createElement("div");
    meta.className = "historyMeta";
    const date = formatDate(item.captureAt || item.createdAt);
    meta.textContent = `${item.scientificNameWithoutAuthor || item.scientificName || ""}${item.scientificName ? " · " : ""}${date}`;
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
    row.addEventListener("click", () => openCapture(item.id, { type: "main", value: "camera" }));
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
    row.innerHTML = `<span>${count} photo${count > 1 ? "s" : ""} · ${formatDate(item.captureAt || item.createdAt)}</span><span class="muted">En attente de connexion</span>`;
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
      await saveObservation(result, item.photos, {
        captureAt: item.captureAt || deriveObservationDate(item.photos, item.createdAt),
        location: item.location || deriveObservationLocation(item.photos),
        note: item.note || "",
      });
      await dbDelete(STORE_QUEUE, item.id);
    } catch {
      break;
    }
  }
  await refreshAllLists();
}

async function getSpeciesObservations(species) {
  const ids = new Set(species?.observationIds || []);
  const observations = await dbGetAll(STORE_OBSERVATIONS);
  return observations
    .filter((obs) => ids.has(obs.id) || obs.speciesId === species.id)
    .sort((a, b) => (b.captureAt || b.createdAt) - (a.captureAt || a.createdAt));
}

async function renderHerbarium() {
  clearObjectUrls("herbariumObjectUrls");
  let speciesRows = await dbGetAll(STORE_SPECIES);
  const query = $("#herbariumSearch").value.trim().toLocaleLowerCase("fr");
  const sort = $("#herbariumSort").value;

  if (query) {
    speciesRows = speciesRows.filter((species) => [species.commonName, species.scientificName, species.family, species.genus]
      .filter(Boolean)
      .some((value) => value.toLocaleLowerCase("fr").includes(query)));
  }

  if (sort === "recent") speciesRows.sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
  else if (sort === "first") speciesRows.sort((a, b) => (b.firstSeenAt || 0) - (a.firstSeenAt || 0));
  else speciesRows.sort((a, b) => (a.commonName || a.scientificName).localeCompare(b.commonName || b.scientificName, "fr", { sensitivity: "base" }));

  const allSpecies = await dbGetAll(STORE_SPECIES);
  $("#speciesCount").textContent = `${allSpecies.length} espèce${allSpecies.length > 1 ? "s" : ""}`;
  const list = $("#herbariumList");
  list.innerHTML = "";

  if (!speciesRows.length) {
    const empty = document.createElement("div");
    empty.className = "card herbariumEmpty";
    empty.textContent = query ? "Aucune espèce ne correspond à cette recherche." : "Votre herbier est vide. Confirmez une première identification pour y ajouter une espèce.";
    list.appendChild(empty);
    return;
  }

  for (const species of speciesRows) {
    const observations = await getSpeciesObservations(species);
    const card = document.createElement("article");
    card.className = "card speciesEntry";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "speciesCardButton";
    button.setAttribute("aria-label", `Ouvrir ${species.commonName}`);
    button.addEventListener("click", () => openSpecies(species.id));

    const inner = document.createElement("div");
    inner.className = "speciesCard";
    const thumbs = document.createElement("div");
    thumbs.className = "speciesThumbs";
    const photoBlobs = observations.flatMap((obs) => (obs.photos || []).map((p) => p.blob).filter(Boolean)).slice(0, 3);
    if (photoBlobs.length) {
      photoBlobs.forEach((blob) => {
        const img = document.createElement("img");
        img.className = "speciesThumb";
        img.src = blobUrl(blob, "herbariumObjectUrls");
        img.alt = "";
        thumbs.appendChild(img);
      });
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "speciesThumbPlaceholder";
      placeholder.textContent = "Flore";
      thumbs.appendChild(placeholder);
    }

    const text = document.createElement("div");
    const title = document.createElement("h2");
    title.textContent = species.commonName || species.scientificNameWithoutAuthor;
    const scientific = document.createElement("div");
    scientific.className = "scientific";
    scientific.textContent = species.scientificNameWithoutAuthor || species.scientificName;
    const meta = document.createElement("div");
    meta.className = "speciesCardMeta";
    const last = observations[0]?.captureAt || species.lastSeenAt;
    meta.textContent = `${observations.length} observation${observations.length > 1 ? "s" : ""} · dernière capture ${formatDate(last)}`;
    text.append(title, scientific, meta);
    inner.append(thumbs, text);
    button.appendChild(inner);
    card.appendChild(button);
    list.appendChild(card);
  }
}

$("#herbariumSearch").addEventListener("input", renderHerbarium);
$("#herbariumSort").addEventListener("change", renderHerbarium);

async function openSpecies(id, { historyMode = "push" } = {}) {
  const species = await dbGet(STORE_SPECIES, id);
  if (!species) return;
  state.currentSpeciesId = id;
  await renderSpecies(species);
  hideAllViews();
  views.species.classList.remove("hidden");
  mainNavigation.classList.add("hidden");
  window.scrollTo({ top: 0, behavior: "instant" });
  recordRoute({ type: "species", id }, historyMode);
}

$("#backSpeciesButton").addEventListener("click", async () => {
  if (history.state?.fleuretmoi && Number(history.state.depth || 0) > 0) {
    history.back();
    return;
  }
  state.currentSpeciesId = null;
  clearObjectUrls("speciesObjectUrls");
  await showMainView("herbarium", { historyMode: "replace" });
});

async function renderSpecies(species) {
  clearObjectUrls("speciesObjectUrls");
  const observations = await getSpeciesObservations(species);
  $("#speciesCommonName").textContent = species.commonName || species.scientificNameWithoutAuthor;
  const scientific = $("#speciesScientificName");
  scientific.textContent = species.scientificNameWithoutAuthor || species.scientificName;
  scientific.href = googleImagesUrl(species.scientificNameWithoutAuthor || species.scientificName);

  const meta = $("#speciesMeta");
  meta.innerHTML = "";
  [species.family && `Famille : ${species.family}`, species.genus && `Genre : ${species.genus}`].filter(Boolean).forEach((text) => {
    const chip = document.createElement("span");
    chip.className = "metaChip";
    chip.textContent = text;
    meta.appendChild(chip);
  });

  const list = $("#speciesPhotoList");
  list.innerHTML = "";
  observations.forEach((observation) => {
    const block = document.createElement("article");
    block.className = "speciesObservation";
    const head = document.createElement("div");
    head.className = "observationHeader";
    const date = document.createElement("span");
    date.className = "observationDate";
    date.textContent = formatDate(observation.captureAt || observation.createdAt, true);
    const open = document.createElement("button");
    open.type = "button";
    open.className = "openObservationButton";
    open.textContent = "Voir l’observation";
    open.addEventListener("click", () => openCapture(observation.id, { type: "species", value: species.id }));
    head.append(date, open);

    const photos = document.createElement("div");
    photos.className = "observationPhotos";
    (observation.photos || []).forEach((photo, photoIndex) => {
      if (!photo.blob) return;
      const card = document.createElement("div");
      card.className = "observationPhotoCard";
      const img = document.createElement("img");
      img.src = blobUrl(photo.blob, "speciesObjectUrls");
      img.alt = `Capture du ${formatDate(observation.captureAt || observation.createdAt)}`;
      const crop = document.createElement("button");
      crop.type = "button";
      crop.className = "photoCropMini";
      crop.textContent = "Recadrer";
      crop.addEventListener("click", () => openStoredPhotoEditor(observation.id, photoIndex, species.id));
      card.append(img, crop);
      photos.appendChild(card);
    });
    block.append(head, photos);
    if (observation.note) {
      const observationNote = document.createElement("p");
      observationNote.className = "observationNote";
      observationNote.textContent = observation.note;
      block.appendChild(observationNote);
    }
    list.appendChild(block);
  });

  $("#speciesNote").value = species.note || "";
  $("#speciesNoteStatus").textContent = "";
}

$("#saveSpeciesNoteButton").addEventListener("click", async () => {
  if (!state.currentSpeciesId) return;
  const species = await dbGet(STORE_SPECIES, state.currentSpeciesId);
  if (!species) return;
  species.note = $("#speciesNote").value.trim();
  await dbPut(STORE_SPECIES, species);
  $("#speciesNoteStatus").textContent = "Notes enregistrées.";
});

function initMap() {
  if (state.map || !window.L) return;
  state.map = L.map("plantMap", { zoomControl: true, attributionControl: true }).setView([46.5, 2.5], 5);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributeurs',
  }).addTo(state.map);
  state.mapLayer = L.layerGroup().addTo(state.map);
}

async function renderMap() {
  clearObjectUrls("mapObjectUrls");
  const mapStatus = $("#mapStatus");
  if (!window.L) {
    mapStatus.textContent = "La bibliothèque de carte n’a pas pu être chargée. Une connexion est nécessaire lors du premier chargement.";
    return;
  }
  initMap();
  state.mapLayer.clearLayers();
  const observations = (await dbGetAll(STORE_OBSERVATIONS)).filter((obs) => Number.isFinite(obs.location?.latitude) && Number.isFinite(obs.location?.longitude));
  const allObservations = await dbGetAll(STORE_OBSERVATIONS);
  $("#mapCount").textContent = `${observations.length} capture${observations.length > 1 ? "s" : ""}`;
  const missing = allObservations.length - observations.length;
  mapStatus.textContent = missing > 0
    ? `${missing} observation${missing > 1 ? "s" : ""} sans position ne ${missing > 1 ? "sont" : "est"} pas affichée${missing > 1 ? "s" : ""}.`
    : observations.length ? "Touchez une photo sur la carte pour ouvrir la capture correspondante." : "Aucune observation géolocalisée pour le moment.";

  const bounds = [];
  for (const observation of observations) {
    const firstPhoto = observation.photos?.find((p) => p.blob);
    const photoUrl = firstPhoto?.blob ? blobUrl(firstPhoto.blob, "mapObjectUrls") : "";
    const markerHtml = photoUrl
      ? `<div class="photoMarker"><img src="${photoUrl}" alt=""></div>`
      : `<div class="photoMarker"></div>`;
    const icon = L.divIcon({ className: "photoMarkerWrap", html: markerHtml, iconSize: [52, 52], iconAnchor: [26, 48] });
    const marker = L.marker([observation.location.latitude, observation.location.longitude], { icon }).addTo(state.mapLayer);
    bounds.push([observation.location.latitude, observation.location.longitude]);

    const popup = document.createElement("div");
    popup.className = "mapPopup";
    if (photoUrl) {
      const img = document.createElement("img");
      img.src = photoUrl;
      img.alt = "";
      popup.appendChild(img);
    }
    const common = document.createElement("strong");
    common.textContent = observation.commonName || "Observation";
    const sci = document.createElement("em");
    sci.textContent = observation.scientificNameWithoutAuthor || observation.scientificName || "";
    const date = document.createElement("div");
    date.className = "muted";
    date.textContent = formatDate(observation.captureAt || observation.createdAt);
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = observation.verified && observation.speciesId ? "Ouvrir dans l’herbier" : "Ouvrir l’observation";
    button.addEventListener("click", () => {
      state.map.closePopup();
      if (observation.verified && observation.speciesId) openSpecies(observation.speciesId);
      else openCapture(observation.id, { type: "main", value: "map" });
    });
    popup.append(common, sci, date, button);
    marker.bindPopup(popup);
  }

  if (bounds.length === 1) state.map.setView(bounds[0], 14);
  else if (bounds.length > 1) state.map.fitBounds(bounds, { padding: [35, 35], maxZoom: 15 });
}

// ----- Photo editor -----
const editorDialog = $("#photoEditor");
const editorCanvas = $("#editorCanvas");
const editorZoom = $("#editorZoom");

function loadImageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (error) => { URL.revokeObjectURL(url); reject(error); };
    img.src = url;
  });
}

function rotatedDimensions(img, rotation) {
  const swapped = Math.abs(rotation % 180) === 90;
  return swapped ? { width: img.naturalHeight, height: img.naturalWidth } : { width: img.naturalWidth, height: img.naturalHeight };
}

function setEditorAspect(aspectName) {
  if (!state.editor) return;
  state.editor.aspect = aspectName;
  const img = state.editor.image;
  const rot = rotatedDimensions(img, state.editor.rotation);
  let ratio = 4 / 3;
  if (aspectName === "1:1") ratio = 1;
  if (aspectName === "original") ratio = rot.width / rot.height;
  const base = 800;
  editorCanvas.width = base;
  editorCanvas.height = Math.max(320, Math.min(1000, Math.round(base / ratio)));
  state.editor.panX = 0;
  state.editor.panY = 0;
  $$(".aspectButtons button").forEach((button) => button.classList.toggle("active", button.dataset.aspect === aspectName));
  drawEditor();
}

function clampEditorPan() {
  if (!state.editor) return;
  const { image, rotation, zoom } = state.editor;
  const rot = rotatedDimensions(image, rotation);
  const baseScale = Math.max(editorCanvas.width / rot.width, editorCanvas.height / rot.height);
  const displayedW = rot.width * baseScale * zoom;
  const displayedH = rot.height * baseScale * zoom;
  const maxX = Math.max(0, (displayedW - editorCanvas.width) / 2);
  const maxY = Math.max(0, (displayedH - editorCanvas.height) / 2);
  state.editor.panX = Math.max(-maxX, Math.min(maxX, state.editor.panX));
  state.editor.panY = Math.max(-maxY, Math.min(maxY, state.editor.panY));
}

function drawEditor(targetCanvas = editorCanvas, outputScale = 1) {
  if (!state.editor) return;
  if (targetCanvas === editorCanvas) clampEditorPan();
  const canvas = targetCanvas;
  const ctx = canvas.getContext("2d");
  const { image, rotation, zoom, panX, panY } = state.editor;
  const logicalW = editorCanvas.width;
  const logicalH = editorCanvas.height;

  // IMPORTANT: use one single scale factor for both axes. The crop frame may
  // discard part of the image, but the source image is never stretched or
  // squeezed to fit the requested aspect ratio.
  const factorX = canvas.width / logicalW;
  const factorY = canvas.height / logicalH;
  const outputFactor = Math.min(factorX, factorY);
  const renderedLogicalW = logicalW * outputFactor;
  const renderedLogicalH = logicalH * outputFactor;
  const offsetX = (canvas.width - renderedLogicalW) / 2;
  const offsetY = (canvas.height - renderedLogicalH) / 2;

  const rot = rotatedDimensions(image, rotation);
  // "cover" behaviour: scale uniformly until the whole crop frame is filled.
  // Overflow is intentionally cropped instead of deforming the photograph.
  const baseScale = Math.max(logicalW / rot.width, logicalH / rot.height);
  const finalScale = baseScale * zoom;

  ctx.save();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#16211a";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(
    offsetX + (logicalW / 2 + panX) * outputFactor,
    offsetY + (logicalH / 2 + panY) * outputFactor
  );
  ctx.rotate(rotation * Math.PI / 180);
  ctx.scale(finalScale * outputFactor, finalScale * outputFactor);
  ctx.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2);
  ctx.restore();

  if (canvas === editorCanvas) {
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,.78)";
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 8]);
    ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
    ctx.restore();
  }
}

async function openDraftPhotoEditor(index) {
  const photo = state.photos[index];
  if (!photo) return;
  try {
    const image = await loadImageFromBlob(photo.file);
    state.editor = { mode: "draft", index, image, rotation: 0, zoom: 1, panX: 0, panY: 0, aspect: "original" };
    editorZoom.value = "1";
    setEditorAspect("original");
    editorDialog.showModal();
  } catch {
    statusText.textContent = "Cette image ne peut pas être ouverte dans l’éditeur de ce navigateur.";
  }
}

async function openStoredPhotoEditor(observationId, photoIndex, speciesId) {
  const observation = await dbGet(STORE_OBSERVATIONS, observationId);
  const photo = observation?.photos?.[photoIndex];
  if (!photo?.blob) return;
  try {
    const image = await loadImageFromBlob(photo.blob);
    state.editor = { mode: "stored", observationId, photoIndex, speciesId, image, rotation: 0, zoom: 1, panX: 0, panY: 0, aspect: "original" };
    editorZoom.value = "1";
    setEditorAspect("original");
    editorDialog.showModal();
  } catch {
    $("#speciesNoteStatus").textContent = "Cette image ne peut pas être ouverte dans l’éditeur de ce navigateur.";
  }
}

function closeEditor() {
  if (editorDialog.open) editorDialog.close();
  state.editor = null;
  state.editorPointer = null;
}

$("#cancelEditorButton").addEventListener("click", closeEditor);
$("#rotateLeftButton").addEventListener("click", () => {
  if (!state.editor) return;
  state.editor.rotation = (state.editor.rotation - 90) % 360;
  setEditorAspect(state.editor.aspect);
});
$("#rotateRightButton").addEventListener("click", () => {
  if (!state.editor) return;
  state.editor.rotation = (state.editor.rotation + 90) % 360;
  setEditorAspect(state.editor.aspect);
});
editorZoom.addEventListener("input", () => {
  if (!state.editor) return;
  state.editor.zoom = Number(editorZoom.value);
  drawEditor();
});
$$(".aspectButtons button").forEach((button) => button.addEventListener("click", () => setEditorAspect(button.dataset.aspect)));

editorCanvas.addEventListener("pointerdown", (event) => {
  if (!state.editor) return;
  editorCanvas.setPointerCapture(event.pointerId);
  state.editorPointer = { x: event.clientX, y: event.clientY, panX: state.editor.panX, panY: state.editor.panY };
});
editorCanvas.addEventListener("pointermove", (event) => {
  if (!state.editor || !state.editorPointer) return;
  const rect = editorCanvas.getBoundingClientRect();
  const scaleX = editorCanvas.width / rect.width;
  const scaleY = editorCanvas.height / rect.height;
  state.editor.panX = state.editorPointer.panX + (event.clientX - state.editorPointer.x) * scaleX;
  state.editor.panY = state.editorPointer.panY + (event.clientY - state.editorPointer.y) * scaleY;
  drawEditor();
});
editorCanvas.addEventListener("pointerup", () => { state.editorPointer = null; });
editorCanvas.addEventListener("pointercancel", () => { state.editorPointer = null; });

function exportEditedBlob() {
  return new Promise((resolve) => {
    // Export exactly the framing currently visible in the editor.
    clampEditorPan();
    drawEditor();
    const aspect = editorCanvas.width / editorCanvas.height;
    const outputWidth = 1600;
    const outputHeight = Math.round(outputWidth / aspect);
    const canvas = document.createElement("canvas");
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    drawEditor(canvas);
    canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.92);
  });
}

$("#saveEditorButton").addEventListener("click", async () => {
  if (!state.editor) return;
  const editorState = { ...state.editor };
  const blob = await exportEditedBlob();
  if (!blob) return;
  const file = new File([blob], `fleuretmoi-${Date.now()}.jpg`, { type: "image/jpeg" });

  if (editorState.mode === "draft") {
    const old = state.photos[editorState.index];
    if (old) {
      URL.revokeObjectURL(old.preview);
      old.file = file;
      old.preview = URL.createObjectURL(file);
    }
    closeEditor();
    renderPhotos();
    return;
  }

  if (editorState.mode === "stored") {
    const observation = await dbGet(STORE_OBSERVATIONS, editorState.observationId);
    if (observation?.photos?.[editorState.photoIndex]) {
      const storedPhoto = observation.photos[editorState.photoIndex];
      storedPhoto.blob = blob;
      storedPhoto.name = file.name;
      storedPhoto.type = file.type;
      storedPhoto.editedAt = Date.now();
      storedPhoto.cropAspect = editorCanvas.width / editorCanvas.height;
      await dbPut(STORE_OBSERVATIONS, observation);
    }
    closeEditor();
    const species = await dbGet(STORE_SPECIES, editorState.speciesId);
    if (species) await renderSpecies(species);
    await renderHistory();
    await renderMap();
  }
});

// ----- Confetti without external dependency -----
function launchConfetti() {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const canvas = $("#confettiCanvas");
  const ctx = canvas.getContext("2d");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  canvas.style.width = `${innerWidth}px`;
  canvas.style.height = `${innerHeight}px`;
  ctx.scale(dpr, dpr);
  const colors = ["#244d36", "#6f9878", "#d6a955", "#b86750", "#e8dfb5"];
  const pieces = Array.from({ length: 90 }, () => ({
    x: innerWidth * (.35 + Math.random() * .3),
    y: innerHeight * .28,
    vx: (Math.random() - .5) * 10,
    vy: -4 - Math.random() * 7,
    g: .18 + Math.random() * .12,
    size: 5 + Math.random() * 7,
    rotation: Math.random() * Math.PI,
    vr: (Math.random() - .5) * .25,
    color: colors[Math.floor(Math.random() * colors.length)],
  }));
  const start = performance.now();
  function frame(now) {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    pieces.forEach((p) => {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += p.g;
      p.rotation += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * .65);
      ctx.restore();
    });
    if (now - start < 1650) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, innerWidth, innerHeight);
  }
  requestAnimationFrame(frame);
}

// ----- Mobile edge gestures -----
function isBlockingDialogOpen() {
  return Boolean(editorDialog.open || $("#locationPicker")?.open);
}

function mainViewIsActuallyOpen() {
  return ["camera", "herbarium", "map"].includes(state.currentMainView)
    && !views[state.currentMainView].classList.contains("hidden")
    && views.capture.classList.contains("hidden")
    && views.species.classList.contains("hidden");
}

function getSwipeIntent(touch) {
  if (!mainViewIsActuallyOpen() || isBlockingDialogOpen()) return null;
  const edge = 30;
  const bottomEdge = 60;

  if (touch.clientX <= edge && state.currentMainView !== "map") {
    return { target: "map", axis: "x", sign: 1, side: "left" };
  }
  if (touch.clientX >= window.innerWidth - edge && state.currentMainView !== "herbarium") {
    return { target: "herbarium", axis: "x", sign: -1, side: "right" };
  }
  if (touch.clientY >= window.innerHeight - bottomEdge && state.currentMainView !== "camera") {
    return { target: "camera", axis: "y", sign: -1, side: "bottom" };
  }
  return null;
}

function resetSwipeInlineStyles(view) {
  if (!view) return;
  view.classList.remove("swipePreview", "swipePreviewLeft", "swipePreviewRight", "swipePreviewBottom", "swipeAnimating");
  view.style.removeProperty("transform");
  view.style.removeProperty("transition");
  view.style.removeProperty("pointer-events");
}

function cleanupSwipeGesture({ keepTarget = false } = {}) {
  const gesture = state.swipeGesture;
  if (!gesture) return;
  const source = views[gesture.source];
  const target = views[gesture.target];

  resetSwipeInlineStyles(source);
  resetSwipeInlineStyles(target);
  source.classList.remove("swipeSource");
  document.documentElement.classList.remove("edgeSwiping");

  if (!keepTarget && gesture.target !== state.currentMainView) {
    target.classList.add("hidden");
  }
  state.swipeGesture = null;
}

function prepareSwipePreview(gesture) {
  if (gesture.prepared) return;
  gesture.prepared = true;

  const source = views[gesture.source];
  const target = views[gesture.target];
  source.classList.add("swipeSource");
  target.classList.remove("hidden");
  target.classList.add("swipePreview", `swipePreview${gesture.side[0].toUpperCase()}${gesture.side.slice(1)}`);
  target.style.pointerEvents = "none";

  // The Herbier is already kept fresh by refreshAllLists(). Refresh again in
  // the background, but never delay the gesture waiting for database work.
  if (gesture.target === "herbarium") {
    renderHerbarium().catch(console.error);
  }

  if (gesture.target === "map") {
    renderMap().then(() => {
      requestAnimationFrame(() => {
        state.map?.invalidateSize();
        requestAnimationFrame(() => state.map?.invalidateSize());
      });
    }).catch(console.error);
  }
}

function swipeDistance(gesture, touch) {
  if (gesture.axis === "x") {
    return Math.max(0, Math.min(window.innerWidth, (touch.clientX - gesture.startX) * gesture.sign));
  }
  return Math.max(0, Math.min(window.innerHeight, (touch.clientY - gesture.startY) * gesture.sign));
}

function applySwipeProgress(gesture, distance) {
  const source = views[gesture.source];
  const target = views[gesture.target];
  const extent = gesture.axis === "x" ? window.innerWidth : window.innerHeight;
  const progress = Math.max(0, Math.min(1, distance / extent));
  gesture.progress = progress;

  if (gesture.side === "left") {
    target.style.transform = `translate3d(${(-100 + progress * 100).toFixed(3)}vw, 0, 0)`;
    source.style.transform = `translate3d(${(progress * 14).toFixed(3)}vw, 0, 0)`;
  } else if (gesture.side === "right") {
    target.style.transform = `translate3d(${(100 - progress * 100).toFixed(3)}vw, 0, 0)`;
    source.style.transform = `translate3d(${(-progress * 14).toFixed(3)}vw, 0, 0)`;
  } else {
    target.style.transform = `translate3d(0, ${(100 - progress * 100).toFixed(3)}vh, 0)`;
    source.style.transform = `translate3d(0, ${(-progress * 8).toFixed(3)}vh, 0)`;
  }
}

function animateSwipeTo(gesture, completed) {
  const source = views[gesture.source];
  const target = views[gesture.target];
  source.classList.add("swipeAnimating");
  target.classList.add("swipeAnimating");

  requestAnimationFrame(() => {
    if (completed) {
      target.style.transform = "translate3d(0, 0, 0)";
      if (gesture.side === "left") source.style.transform = "translate3d(18vw, 0, 0)";
      else if (gesture.side === "right") source.style.transform = "translate3d(-18vw, 0, 0)";
      else source.style.transform = "translate3d(0, -10vh, 0)";
    } else {
      if (gesture.side === "left") target.style.transform = "translate3d(-100vw, 0, 0)";
      else if (gesture.side === "right") target.style.transform = "translate3d(100vw, 0, 0)";
      else target.style.transform = "translate3d(0, 100vh, 0)";
      source.style.transform = "translate3d(0, 0, 0)";
    }
  });

  window.setTimeout(async () => {
    if (state.swipeGesture !== gesture) return;

    if (completed) {
      const targetName = gesture.target;
      hideAllViews();
      views[targetName].classList.remove("hidden");
      state.currentMainView = targetName;
      $$("#mainNavigation [data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === targetName));
      window.scrollTo({ top: 0, behavior: "instant" });

      if (targetName === "map") {
        await renderMap();
        setTimeout(() => state.map?.invalidateSize(), 30);
      } else if (targetName === "herbarium") {
        await renderHerbarium();
      }

      recordRoute({ type: "main", value: targetName }, "push");
      cleanupSwipeGesture({ keepTarget: true });
    } else {
      cleanupSwipeGesture();
    }
  }, 245);
}

document.addEventListener("touchstart", (event) => {
  if (event.touches.length !== 1 || isBlockingDialogOpen()) return;
  const touch = event.touches[0];
  const intent = getSwipeIntent(touch);
  if (!intent) {
    state.swipeGesture = null;
    return;
  }

  state.swipeGesture = {
    ...intent,
    source: state.currentMainView,
    startX: touch.clientX,
    startY: touch.clientY,
    startTime: performance.now(),
    lastTime: performance.now(),
    lastDistance: 0,
    progress: 0,
    velocity: 0,
    active: false,
    prepared: false,
  };
}, { passive: true, capture: true });

document.addEventListener("touchmove", (event) => {
  const gesture = state.swipeGesture;
  if (!gesture || event.touches.length !== 1 || isBlockingDialogOpen()) return;

  const touch = event.touches[0];
  const dx = touch.clientX - gesture.startX;
  const dy = touch.clientY - gesture.startY;
  const primary = gesture.axis === "x" ? Math.abs(dx) : Math.abs(dy);
  const secondary = gesture.axis === "x" ? Math.abs(dy) : Math.abs(dx);
  const isCorrectDirection = gesture.axis === "x" ? dx * gesture.sign > 0 : dy * gesture.sign > 0;

  if (!gesture.active) {
    if (primary < 8) return;
    if (!isCorrectDirection || secondary > primary * 0.9) {
      state.swipeGesture = null;
      return;
    }
    gesture.active = true;
    document.documentElement.classList.add("edgeSwiping");
    prepareSwipePreview(gesture);
    if (state.swipeGesture === gesture) {
      applySwipeProgress(gesture, swipeDistance(gesture, touch));
    }
  }

  event.preventDefault();
  const distance = swipeDistance(gesture, touch);
  const now = performance.now();
  gesture.velocity = (distance - gesture.lastDistance) / Math.max(1, now - gesture.lastTime);
  gesture.lastDistance = distance;
  gesture.lastTime = now;

  if (gesture.prepared) applySwipeProgress(gesture, distance);
}, { passive: false, capture: true });

document.addEventListener("touchend", () => {
  const gesture = state.swipeGesture;
  if (!gesture) return;
  if (!gesture.active) {
    state.swipeGesture = null;
    return;
  }
  const completed = gesture.progress >= 0.28
    || (gesture.progress >= 0.08 && Number(gesture.velocity || 0) > 0.55);
  animateSwipeTo(gesture, completed);
}, { passive: true, capture: true });

document.addEventListener("touchcancel", () => {
  const gesture = state.swipeGesture;
  if (!gesture) return;
  if (gesture.active) animateSwipeTo(gesture, false);
  else state.swipeGesture = null;
}, { passive: true, capture: true });

$("#clearHistoryButton").addEventListener("click", async () => {
  if (!confirm("Effacer toutes les observations et toutes les espèces de l’herbier enregistrées sur cet appareil ?")) return;
  await dbClear(STORE_OBSERVATIONS);
  await dbClear(STORE_SPECIES);
  await dbClear(STORE_HISTORY);
  await refreshAllLists();
});

async function renderHistoryRoute(route) {
  if (!route || typeof route !== "object") {
    await showMainView("camera", { historyMode: "none" });
    return;
  }

  if (route.type === "capture" && route.id != null) {
    await openCapture(route.id, route.returnTarget || { type: "main", value: "camera" }, { historyMode: "none" });
    return;
  }
  if (route.type === "species" && route.id != null) {
    await openSpecies(route.id, { historyMode: "none" });
    return;
  }
  await showMainView(route.value || "camera", { historyMode: "none" });
}

window.addEventListener("popstate", async (event) => {
  if (!event.state?.fleuretmoi) return;
  state.handlingPopState = true;
  state.navDepth = Math.max(0, Number(event.state.depth || 0));
  try {
    await renderHistoryRoute(event.state.route);
  } catch (error) {
    console.error("Navigation retour impossible", error);
    await showMainView("camera", { historyMode: "none" });
  } finally {
    state.handlingPopState = false;
  }
});

window.addEventListener("online", async () => {
  setConnectionUi();
  statusText.textContent = "Connexion rétablie. Vérification des observations en attente…";
  await processQueue();
  statusText.textContent = "";
});
window.addEventListener("offline", setConnectionUi);

async function refreshAllLists() {
  await renderQueue();
  await renderHistory();
  await renderHerbarium();
  if (state.map) await renderMap();
}

async function init() {
  setConnectionUi();
  renderApiKeyState();
  await openDb();
  await syncVerifiedSpecies();
  await refreshAllLists();
  if (navigator.onLine) await processQueue();
  state.navDepth = 0;
  await showMainView("camera", { historyMode: "replace" });
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js"));
}

init().catch((error) => {
  console.error(error);
  statusText.textContent = `Impossible d’initialiser l’application : ${error.message}`;
});
