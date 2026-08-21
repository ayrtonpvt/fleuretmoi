(() => {
  "use strict";

  const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
  const TARGET_COUNT = 6;
  const PAGE_STEP = 6;
  const ANALYSIS_MAX = 112;
  const CROP_ASPECT = 4 / 5;
  const FALLBACK_MIN_STRICT = 12;
  const FALLBACK_METADATA_BATCH = 10;

  const CALIBRATION = {
    "Malva sylvestris": [
      "File:A curious herbal (Plate 22) BHL296177.jpg",
      "File:Familiar wild flowers figured and described (Pl. 21) (8768062965).jpg",
      "File:Gadeceau-adventices-mauve.jpg",
      "File:Koeh-222-cropped.jpg",
      "File:Mallow and Damselfly.jpg",
      "File:Wild flowers (Pl. 08) (8512668299).jpg",
      "File:The American Flora. Vol. 1, 1855 - pl. 20 Malva sylvestris (6021775615).jpg"
    ],
    "Raphanus sativus": [
      "File:Seed annual 1906 (1906) (14778255014).jpg",
      "File:1893 Maule's seed catalogue (1893) (16665138111).jpg",
      "File:Childs' rare flowers, vegetables and fruits (1915) (20614541031).jpg"
    ],
    "Nerium oleander": [
      "File:An oleander plant (Nerium oleander); flowering stem. Coloure Wellcome V0044587.jpg",
      "File:Die Giftpflanzen Deutschlands (1910) (20926451845).jpg",
      "File:Flore coloriée de poche du littoral méditerranéen de Gênes à Barcelone y compris la Corse (6243946989).jpg",
      "File:Nerium oleander Blanco1.37.jpg",
      "File:Nerium oleander - Nerion laurier-rose (NYPL b14485031-1109335).tiff",
      "File:The Botanical register (Plate 74) BHL8497.jpg"
    ],
    "Narcissus poeticus": [
      "File:Die Alpenpflanzen nach der Natur gemalt (Page 99) (7216053790).jpg",
      "File:PEIGNE, Madame (French, active 1770, died 1815), Narcissus poëticus, Gouache on toned paper31 ½ x 26 ½ in, Arader Galleries, New York City.jpg",
      "File:The flowering plants, grasses, sedges, and ferns of Great Britain (Pl. 224) (8518757124).jpg",
      "File:TheRomanceOfNature 0061.jpg",
      "File:Narcissus poeticus — Flora Batava — Volume v17.jpg",
      "File:Illustration Narcissus poeticus0.jpg"
    ]
  };

  const DEFAULT_WEIGHTS = { A: 34, C: 19, D: 18, E: 12, F: 10, P: 7 };
  const WEIGHT_LABELS = {
    A: "A · Composition",
    C: "C · Couleur",
    D: "D · Séparation sujet/fond",
    E: "E · Faible densité parasite",
    F: "F · Qualité technique",
    P: "Préférence portrait"
  };

  const el = {
    speciesSelect: document.getElementById("speciesSelect"),
    customField: document.getElementById("customField"),
    customSpecies: document.getElementById("customSpecies"),
    runButton: document.getElementById("runButton"),
    resetWeights: document.getElementById("resetWeights"),
    weightsGrid: document.getElementById("weightsGrid"),
    threshold: document.getElementById("qualityThreshold"),
    thresholdValue: document.getElementById("qualityThresholdValue"),
    statusText: document.getElementById("statusText"),
    progressTrack: document.getElementById("progressTrack"),
    progressBar: document.getElementById("progressBar"),
    metricsPanel: document.getElementById("metricsPanel"),
    resultsSection: document.getElementById("resultsSection"),
    resultCategory: document.getElementById("resultCategory"),
    resultsGrid: document.getElementById("resultsGrid"),
    showMoreButton: document.getElementById("showMoreButton")
  };

  let weights = { ...DEFAULT_WEIGHTS };
  let rawCandidates = [];
  let rankedCandidates = [];
  let activeSpecies = "";
  let visibleCount = 12;
  let runToken = 0;

  buildWeightControls();

  el.speciesSelect.addEventListener("change", () => {
    el.customField.hidden = el.speciesSelect.value !== "__custom__";
  });
  el.threshold.addEventListener("input", () => {
    el.thresholdValue.value = el.threshold.value;
    if (rawCandidates.length) rerank();
  });
  el.runButton.addEventListener("click", runAnalysis);
  el.resetWeights.addEventListener("click", () => {
    weights = { ...DEFAULT_WEIGHTS };
    syncWeightControls();
    if (rawCandidates.length) rerank();
  });
  el.showMoreButton.addEventListener("click", () => {
    visibleCount += PAGE_STEP;
    renderResults();
  });

  function buildWeightControls() {
    el.weightsGrid.innerHTML = "";
    Object.entries(WEIGHT_LABELS).forEach(([key, label]) => {
      const wrap = document.createElement("div");
      wrap.className = "weight-control";
      wrap.innerHTML = `
        <label for="weight-${key}">${escapeHtml(label)}</label>
        <output id="weight-${key}-value">${weights[key]}</output>
        <input id="weight-${key}" data-weight="${key}" type="range" min="0" max="50" value="${weights[key]}" step="1">
      `;
      const input = wrap.querySelector("input");
      input.addEventListener("input", () => {
        weights[key] = Number(input.value);
        wrap.querySelector("output").value = input.value;
        if (rawCandidates.length) rerank();
      });
      el.weightsGrid.appendChild(wrap);
    });
  }

  function syncWeightControls() {
    Object.entries(weights).forEach(([key, value]) => {
      const input = document.querySelector(`[data-weight="${key}"]`);
      if (!input) return;
      input.value = value;
      document.getElementById(`weight-${key}-value`).value = value;
    });
  }

  function getRequestedSpecies() {
    if (el.speciesSelect.value !== "__custom__") return el.speciesSelect.value.trim();
    return el.customSpecies.value.trim();
  }

  async function runAnalysis() {
    const species = getRequestedSpecies();
    if (!species) {
      setStatus("Saisis un nom scientifique exact.", false);
      return;
    }

    const myToken = ++runToken;
    activeSpecies = species;
    rawCandidates = [];
    rankedCandidates = [];
    visibleCount = 12;
    el.runButton.disabled = true;
    el.resultsSection.hidden = true;
    el.metricsPanel.hidden = true;
    setProgress(0, true);

    try {
      const discovery = await discoverCommonsIllustrationsForTest(species, myToken);
      if (myToken !== runToken) return;
      const meta = discovery.items;
      if (!meta.length) throw new Error(`Aucune illustration botanique fiable de « ${species} » trouvée sur Commons.`);

      const preferred = new Set((CALIBRATION[species] || []).map(normalizeTitle));
      const candidates = meta
        .filter((item) => item.thumbUrl)
        .map((item) => ({
          ...item,
          preferred: preferred.has(normalizeTitle(item.title)),
          otherSpecies: detectOtherIllustratedSpecies(item.categories, species),
          analysis: null,
          cropAnalysis: null,
          loadError: null
        }));

      setStatus(`Analyse visuelle locale de ${candidates.length} miniatures…`);
      const concurrency = 5;
      let done = 0;
      await mapConcurrent(candidates, concurrency, async (candidate) => {
        if (myToken !== runToken) return;
        try {
          candidate.analysis = await analyzeRemoteImage(candidate.thumbUrl, candidate.width, candidate.height);
        } catch (error) {
          candidate.loadError = error?.message || String(error);
        } finally {
          done += 1;
          setProgress(Math.round((done / candidates.length) * 100), true);
          setStatus(`Analyse visuelle locale : ${done}/${candidates.length}…`);
        }
      });
      if (myToken !== runToken) return;

      rawCandidates = candidates.filter((c) => c.analysis);
      if (!rawCandidates.length) throw new Error("Les miniatures n’ont pas pu être analysées. Vérifie la connexion ou les autorisations CORS de Commons.");

      rerank();
      const fallbackText = discovery.usedFallback
        ? ` Fallback espèce générale : ${discovery.fallbackAccepted} illustration${discovery.fallbackAccepted > 1 ? "s" : ""} retenue${discovery.fallbackAccepted > 1 ? "s" : ""}.`
        : "";
      setStatus(`${rawCandidates.length} illustrations analysées.${fallbackText} Les filtres taxonomiques restent prioritaires sur le score esthétique.`, false);
    } catch (error) {
      console.error(error);
      setStatus(error?.message || String(error), false);
      setProgress(0, false);
    } finally {
      if (myToken === runToken) el.runButton.disabled = false;
    }
  }

  async function discoverCommonsIllustrationsForTest(species, myToken) {
    const strictCategory = `Category:${species} - botanical illustrations`;
    const generalCategory = `Category:${species}`;
    const byTitle = new Map();
    let strictCount = 0;
    let usedFallback = false;
    let fallbackAccepted = 0;

    setStatus(`Vérification de ${strictCategory}…`);
    const strictExists = await categoryExists(strictCategory);
    if (myToken !== runToken) return { items: [], usedFallback: false, fallbackAccepted: 0 };

    if (strictExists) {
      const members = await fetchAllCategoryFiles(strictCategory);
      const meta = await fetchFileMetadata(members.map((m) => m.title));
      meta.forEach((item) => {
        item.discovery = "strict";
        item.illustrationEvidence = "catégorie botanique exacte";
        byTitle.set(normalizeTitle(item.title), item);
      });
      strictCount = meta.length;
    }

    if (!strictExists || strictCount < FALLBACK_MIN_STRICT) {
      usedFallback = true;
      setStatus(`Fallback : inspection de ${generalCategory}…`);
      const generalExists = await categoryExists(generalCategory);
      if (generalExists) {
        const members = await fetchAllCategoryFiles(generalCategory);
        if (myToken !== runToken) return { items: [], usedFallback, fallbackAccepted: 0 };
        const meta = await fetchFileMetadata(members.map((m) => m.title));
        const filtered = await filterGeneralCategoryIllustrationsForTest(meta, myToken);
        for (const item of filtered) {
          const key = normalizeTitle(item.title);
          if (byTitle.has(key)) continue;
          item.discovery = "general-category";
          byTitle.set(key, item);
          fallbackAccepted += 1;
        }
      }
    }

    return { items: [...byTitle.values()], usedFallback, fallbackAccepted, strictCount };
  }

  async function filterGeneralCategoryIllustrationsForTest(items, myToken) {
    const accepted = [];
    const uncertain = [];
    for (const item of items) {
      const basic = basicIllustrationEvidence(item);
      if (basic.curated) {
        item.illustrationEvidence = basic.reason;
        accepted.push(item);
      } else if (!basic.obviousPhoto && basic.score >= 18) uncertain.push(item);
    }

    for (let i = 0; i < uncertain.length; i += FALLBACK_METADATA_BATCH) {
      if (myToken !== runToken) return [];
      const batch = uncertain.slice(i, i + FALLBACK_METADATA_BATCH);
      const details = await fetchClassifierMetadata(batch.map((item) => item.title));
      for (const item of batch) {
        const verdict = classifyIllustrationCandidate(item, details.get(normalizeTitle(item.title)) || {});
        if (!verdict.accept) continue;
        item.illustrationEvidence = verdict.reason;
        accepted.push(item);
      }
      setStatus(`Filtrage documentaire : ${Math.min(i + FALLBACK_METADATA_BATCH, uncertain.length)}/${uncertain.length}…`);
    }
    return accepted;
  }

  function basicIllustrationEvidence(item) {
    const categories = (item.categories || []).map(normalizeTitle);
    const title = normalizeTitle(item.title.replace(/^File:/i, ""));
    if (categories.some((cat) => /botanical illustrations?\b/.test(cat))) {
      return { curated: true, score: 100, obviousPhoto: false, reason: "catégorie Commons d’illustrations botaniques" };
    }
    let score = 0;
    const text = `${title} ${categories.join(" ")}`;
    if (/\b(?:botanical|botanique|botanisch|botanica)\b.*\b(?:illustration|plate|drawing|art)\b/.test(text)) score += 70;
    if (/\b(?:illustration|illustrations|illustrated|plate|plates|chromolithograph|chromolithography|lithograph|lithography|engraving|engraved|woodcut|gouache|watercolou?r|aquarelle)\b/.test(text)) score += 45;
    if (/\b(?:flora|flore|floræ|florilegium|botanical register|botanical magazine|icones?|herbal|herbier illustré)\b/.test(text)) score += 28;
    if (/\b(?:biodiversity heritage library|files from the biodiversity heritage library|bhl)\b/.test(text)) score += 24;
    if (/\b(?:drawings?|paintings?|prints?|engravings?|lithographs?) of plants\b/.test(text)) score += 45;
    const obviousPhoto = /\b(?:dsc[_ -]?\d|img[_ -]?\d|pxl[_ -]?\d|iphone|smartphone|photographs? by|taken with|camera model)\b/.test(text)
      || /\b(?:botanic(?:al)? garden|jardin botanique|huntington botanical gardens|brooklyn botanic garden)\b/.test(title)
      || /\b20\d{2}[-_.]\d{2}[-_.]\d{2}\b/.test(title);
    if (obviousPhoto) score -= 70;
    return { curated: false, score, obviousPhoto, reason: "indices documentaires" };
  }

  async function fetchClassifierMetadata(titles) {
    const out = new Map();
    for (let i = 0; i < titles.length; i += FALLBACK_METADATA_BATCH) {
      const batch = titles.slice(i, i + FALLBACK_METADATA_BATCH);
      const data = await commonsGet({ action: "query", prop: "imageinfo", titles: batch.join("|"), iiprop: "metadata|extmetadata" });
      for (const page of Object.values(data?.query?.pages || {})) {
        const ii = page.imageinfo?.[0] || {};
        out.set(normalizeTitle(page.title), { extmetadata: ii.extmetadata || {}, metadata: ii.metadata || [] });
      }
    }
    return out;
  }

  function classifyIllustrationCandidate(item, detail) {
    const basic = basicIllustrationEvidence(item);
    const ext = detail.extmetadata || {};
    const exif = detail.metadata || [];
    const extText = Object.entries(ext)
      .filter(([key]) => ["ImageDescription", "ObjectName", "Credit", "Artist", "DateTimeOriginal"].includes(key))
      .map(([, value]) => stripHtml(value?.value || value || ""))
      .join(" ");
    const exifText = exif.map((entry) => `${entry?.name || ""} ${metadataValueToText(entry?.value)}`).join(" ");
    const allText = normalizeTitle(`${item.title} ${(item.categories || []).join(" ")} ${extText} ${exifText}`);
    let score = basic.score;
    const reasons = [];
    if (/\b(?:botanical illustrations?|botanical plates?|botanical drawings?)\b/.test(allText)) { score += 90; reasons.push("illustration botanique"); }
    if (/\b(?:chromolithograph|chromolithography|lithograph|lithography|engraving|engraved|woodcut|etching|gouache|watercolou?r|aquarelle)\b/.test(allText)) { score += 62; reasons.push("technique graphique"); }
    if (/\b(?:illustrated(?: with)?|colou?red plates?|color plates?|plate\s+\d+|pl\.\s*\d+|illustration|drawing|painting)\b/.test(allText)) { score += 48; reasons.push("planche/illustration"); }
    if (/\b(?:flora|flore|floræ|florilegium|botanical register|botanical magazine|icones?|herbal)\b/.test(allText)) { score += 30; reasons.push("ouvrage botanique"); }
    if (/\b(?:biodiversity heritage library|files from the biodiversity heritage library|bhl page|bhl)\b/.test(allText)) { score += 26; reasons.push("BHL"); }
    if (/\b(?:public domain scan|pd-scan|mechanical scan|scanned from|scan of)\b/.test(allText)) score += 18;
    const cameraNames = new Set(["make", "model", "exposuretime", "fnumber", "isospeedratings", "isospeed", "focallength", "lensmodel", "exposureprogram"]);
    const cameraFields = exif.filter((entry) => cameraNames.has(normalizeTitle(entry?.name))).length;
    const photoText = /\b(?:this photo was taken|photograph(?:ed|s|y)? by|own work|camera model|taken with)\b/.test(allText);
    const modernPhotoTitle = /\b(?:dsc[_ -]?\d|img[_ -]?\d|pxl[_ -]?\d|iphone|smartphone)\b/.test(allText)
      || /\b20\d{2}[-_.]\d{2}[-_.]\d{2}\b/.test(normalizeTitle(item.title));
    const year = extractPlausibleYear(`${stripHtml(ext.DateTimeOriginal?.value || "")} ${item.title}`);
    const historical = year && year <= 1950;
    if (basic.curated) return { accept: true, score: 100, reason: basic.reason };
    if ((cameraFields >= 2 || photoText || modernPhotoTitle) && score < 105) return { accept: false, score, reason: "indices photographiques" };
    if (historical && score >= 58) return { accept: true, score, reason: reasons.slice(0, 2).join(" + ") || "illustration historique" };
    if (score >= 82 && cameraFields < 2 && !photoText) return { accept: true, score, reason: reasons.slice(0, 2).join(" + ") || "indices d’illustration" };
    return { accept: false, score, reason: "preuve insuffisante" };
  }

  function metadataValueToText(value) {
    if (value == null) return "";
    if (typeof value === "string" || typeof value === "number") return String(value);
    try { return JSON.stringify(value); } catch { return String(value); }
  }

  function extractPlausibleYear(text) {
    const matches = String(text || "").match(/\b(1[5-9]\d{2}|20\d{2})\b/g) || [];
    const years = matches.map(Number).filter((year) => year >= 1500 && year <= new Date().getFullYear());
    return years.length ? Math.min(...years) : 0;
  }

  async function categoryExists(categoryTitle) {
    const data = await commonsGet({
      action: "query",
      prop: "categoryinfo",
      titles: categoryTitle
    });
    const pages = Object.values(data?.query?.pages || {});
    return pages.some((page) => !page.missing && page.categoryinfo);
  }

  async function fetchAllCategoryFiles(categoryTitle) {
    const files = [];
    let continuation = null;
    do {
      const params = {
        action: "query",
        list: "categorymembers",
        cmtitle: categoryTitle,
        cmtype: "file",
        cmlimit: "max"
      };
      if (continuation) Object.assign(params, continuation);
      const data = await commonsGet(params);
      files.push(...(data?.query?.categorymembers || []));
      continuation = data?.continue || null;
    } while (continuation);
    return files;
  }

  async function fetchFileMetadata(titles) {
    const out = [];
    for (let i = 0; i < titles.length; i += 40) {
      const batch = titles.slice(i, i + 40);
      let continuation = null;
      const categoryMap = new Map();
      let imagePages = null;
      do {
        const params = {
          action: "query",
          prop: "imageinfo|categories",
          titles: batch.join("|"),
          iiprop: "url|size|mime",
          iiurlwidth: "520",
          cllimit: "max"
        };
        if (continuation) Object.assign(params, continuation);
        const data = await commonsGet(params);
        const pages = Object.values(data?.query?.pages || {});
        if (!imagePages) imagePages = pages;
        for (const page of pages) {
          const key = normalizeTitle(page.title);
          if (!categoryMap.has(key)) categoryMap.set(key, []);
          categoryMap.get(key).push(...(page.categories || []).map((c) => c.title));
        }
        continuation = data?.continue || null;
      } while (continuation);

      for (const page of imagePages || []) {
        const ii = page.imageinfo?.[0];
        if (!ii) continue;
        out.push({
          title: page.title,
          pageId: page.pageid,
          width: ii.width || 0,
          height: ii.height || 0,
          mime: ii.mime || "",
          originalUrl: ii.url || "",
          thumbUrl: ii.thumburl || ii.url || "",
          descriptionUrl: ii.descriptionurl || `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}`,
          categories: unique(categoryMap.get(normalizeTitle(page.title)) || [])
        });
      }
    }
    return out;
  }

  function detectOtherIllustratedSpecies(categories, scientificName) {
    const targetBinomial = binomialKey(scientificName);
    return unique((categories || [])
      .filter((cat) => / - botanical illustrations$/i.test(cat))
      .map((cat) => cat.replace(/^Category:/i, "").replace(/ - botanical illustrations$/i, "").trim())
      .filter((taxon) => isLikelySpeciesTaxon(taxon))
      .filter((taxon) => binomialKey(taxon) !== targetBinomial));
  }

  function taxonCoreParts(taxon) {
    return String(taxon || "")
      .normalize("NFKC")
      .replace(/[✕✖]/g, "×")
      .replace(/\s*[×]\s*/g, " × ")
      .replace(/\s+\b[xX]\b\s+/g, " × ")
      .trim()
      .split(/\s+/)
      .filter((part) => part && part !== "×" && part.toLowerCase() !== "x");
  }

  function binomialKey(taxon) {
    return taxonCoreParts(taxon).slice(0, 2).join(" ").toLocaleLowerCase("en");
  }

  function isLikelySpeciesTaxon(taxon) {
    const parts = taxonCoreParts(taxon);
    if (parts.length < 2) return false;
    const [genus, epithet] = parts;
    if (!/^[A-Z][A-Za-zÀ-ÖØ-öø-ÿ.-]+$/.test(genus)) return false;
    if (!/^[a-z][a-zà-öø-ÿ.-]+$/.test(epithet)) return false;
    const obviousCommonWords = new Set([
      "plants", "flowers", "trees", "shrubs", "fruits", "leaves", "roots",
      "weeds", "vegetables", "herbs", "grasses", "ferns", "orchids", "roses"
    ]);
    return !obviousCommonWords.has(epithet.toLocaleLowerCase("en"));
  }

  async function commonsGet(params) {
    const url = new URL(COMMONS_API);
    const all = { format: "json", formatversion: "2", origin: "*", ...params };
    Object.entries(all).forEach(([key, value]) => url.searchParams.set(key, value));
    const response = await fetch(url.toString(), { mode: "cors", credentials: "omit" });
    if (!response.ok) throw new Error(`Commons API : HTTP ${response.status}`);
    const data = await response.json();
    if (data.error) throw new Error(`Commons API : ${data.error.info || data.error.code}`);
    return data;
  }

  async function analyzeRemoteImage(url, originalWidth, originalHeight) {
    const img = await loadImage(url);
    const maxSide = ANALYSIS_MAX;
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(24, Math.round(img.naturalWidth * scale));
    const h = Math.max(24, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const imageData = ctx.getImageData(0, 0, w, h);
    const base = analyzePixels(imageData.data, w, h, originalWidth || img.naturalWidth, originalHeight || img.naturalHeight);
    base.pixelData = imageData.data;
    base.pixelWidth = w;
    base.pixelHeight = h;
    base.dhash = computeDHash(img);
    base.perceptualHashes = computePerceptualHashes(img);
    return base;
  }

  function analyzePixels(data, w, h, originalWidth, originalHeight) {
    const pixels = [];
    const border = [];
    const borderDepth = Math.max(2, Math.round(Math.min(w, h) * 0.07));

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const p = [data[i], data[i + 1], data[i + 2]];
        pixels.push(p);
        if (x < borderDepth || y < borderDepth || x >= w - borderDepth || y >= h - borderDepth) border.push(p);
      }
    }

    const bg = [median(border.map((p) => p[0])), median(border.map((p) => p[1])), median(border.map((p) => p[2]))];
    const bgStats = rgbStats(border);
    const mask = new Uint8Array(w * h);
    let fgCount = 0;
    let strongColorCount = 0;
    let vividColorCount = 0;
    let strongChromaSum = 0;
    let separationSum = 0;
    let centroidX = 0;
    let centroidY = 0;
    let borderFg = 0;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        const p = pixels[idx];
        const dist = colorDistance(p, bg);
        const hsl = rgbToHsl(p[0], p[1], p[2]);
        const bgHsl = rgbToHsl(bg[0], bg[1], bg[2]);
        const lumDiff = Math.abs(hsl.l - bgHsl.l);
        const isFg = dist > 0.115 || (dist > 0.072 && hsl.s > bgHsl.s + 0.10) || lumDiff > 0.16;
        if (!isFg) continue;
        mask[idx] = 1;
        fgCount++;
        // Use absolute RGB chroma instead of HSL saturation. Old sepia/grey scans
        // can have deceptively high HSL saturation at some luminances even when
        // they are visually monochrome. Chroma keeps genuinely grey images near 0.
        const chroma = (Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2])) / 255;
        if (chroma >= 0.13) {
          strongColorCount++;
          strongChromaSum += chroma;
        }
        if (chroma >= 0.24) vividColorCount++;
        separationSum += dist;
        centroidX += x;
        centroidY += y;
        const edge = Math.max(1, Math.round(Math.min(w, h) * 0.025));
        if (x < edge || y < edge || x >= w - edge || y >= h - edge) borderFg++;
      }
    }

    if (!fgCount) {
      return { A: 0, C: 0, D: 0, E: 0, F: technicalScore(originalWidth, originalHeight), P: portraitScore(originalWidth, originalHeight), occupancy: 0, mainRatio: 0, bgHomogeneity: 0 };
    }

    const dilated = dilateMask(mask, w, h);
    const components = componentSizes(dilated, w, h);
    const largest = components.length ? components[0] : fgCount;
    const dilatedCount = components.reduce((a, b) => a + b, 0) || fgCount;
    const mainRatio = clamp01(largest / dilatedCount);
    const occupancy = fgCount / (w * h);
    const occupancyScore = bellScore(occupancy, 0.43, 0.34);
    const cx = centroidX / fgCount / Math.max(1, w - 1);
    const cy = centroidY / fgCount / Math.max(1, h - 1);
    const centerDist = Math.hypot(cx - 0.5, cy - 0.5) / 0.7071;
    const centerScore = clamp01(1 - centerDist * 1.15);
    const edgePenalty = clamp01(borderFg / fgCount * 5.5);
    const edgeScore = 1 - edgePenalty;

    const A = clamp01(0.42 * occupancyScore + 0.34 * mainRatio + 0.18 * centerScore + 0.06 * edgeScore);

    const strongColorFraction = strongColorCount / fgCount;
    const vividColorFraction = vividColorCount / fgCount;
    const meanStrongChroma = strongColorCount ? strongChromaSum / strongColorCount : 0;
    // A truly monochrome image should score close to zero even if the paper is
    // yellowed. Coloured subjects get credit for extent, vivid accents and depth.
    const C = strongColorFraction < 0.012 ? 0 : clamp01(
      0.50 * clamp01(strongColorFraction / 0.42) +
      0.30 * clamp01(vividColorFraction / 0.20) +
      0.20 * clamp01((meanStrongChroma - 0.10) / 0.28)
    );

    const meanSeparation = separationSum / fgCount;
    const bgHomogeneity = clamp01(1 - bgStats.std / 55);
    const D = clamp01(0.68 * clamp01(meanSeparation / 0.34) + 0.32 * bgHomogeneity);

    const componentPenalty = clamp01((1 - mainRatio) * 1.15);
    const E = clamp01(1 - componentPenalty);

    const F = technicalScore(originalWidth, originalHeight);
    const P = portraitScore(originalWidth, originalHeight);

    return { A, C, D, E, F, P, occupancy, mainRatio, bgHomogeneity };
  }

  function technicalScore(width, height) {
    const minSide = Math.min(width || 0, height || 0);
    const maxSide = Math.max(width || 0, height || 0);
    const minScore = clamp01((minSide - 450) / 1550);
    const maxScore = clamp01((maxSide - 700) / 2300);
    return 0.7 * minScore + 0.3 * maxScore;
  }

  function portraitScore(width, height) {
    if (!width || !height) return 0.5;
    const r = height / width;
    if (r >= 1.25) return 1;
    if (r >= 1) return 0.72 + (r - 1) / 0.25 * 0.28;
    if (r >= 0.8) return 0.32 + (r - 0.8) / 0.2 * 0.40;
    return clamp01(0.32 * (r / 0.8));
  }

  function weightedScore(features) {
    const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
    const raw = Object.entries(weights).reduce((sum, [key, weight]) => sum + (features[key] || 0) * weight, 0);
    return raw / totalWeight * 100;
  }

  function rerank() {
    const threshold = Number(el.threshold.value);
    for (const candidate of rawCandidates) {
      candidate.fullScore = weightedScore(candidate.analysis);
      candidate.tier = null;
      candidate.rankScore = candidate.fullScore;
      candidate.useCrop = false;
    }

    const exact = rawCandidates.filter((c) => c.otherSpecies.length === 0);
    const multi = rawCandidates.filter((c) => c.otherSpecies.length > 0);
    const exactGood = exact.filter((c) => c.fullScore >= threshold).sort(sortByFullScore);
    const exactLow = exact.filter((c) => c.fullScore < threshold).sort(sortByFullScore);

    const provisional = [...exactGood];
    const needRescue = provisional.length < TARGET_COUNT;

    if (needRescue && exactLow.length) {
      const rescuePool = exactLow.slice(0, Math.min(18, exactLow.length));
      for (const candidate of rescuePool) {
        if (!candidate.cropAnalysis) candidate.cropAnalysis = findBestCrop(candidate.analysis, candidate.width, candidate.height);
        if (candidate.cropAnalysis) candidate.cropScore = weightedScore(candidate.cropAnalysis.features);
      }
    }

    const exactCropRescue = exactLow
      .filter((c) => c.cropScore >= threshold)
      .sort((a, b) => (b.cropScore - a.cropScore) || sortByFullScore(a, b));
    const rescuedSet = new Set(exactCropRescue);
    const exactRemaining = exactLow.filter((c) => !rescuedSet.has(c)).sort(sortByFullScore);

    const multiGood = multi.filter((c) => c.fullScore >= threshold).sort(sortByFullScore);
    const multiLow = multi.filter((c) => c.fullScore < threshold).sort(sortByFullScore);

    // Absolute order: single-species usable as-is → single-species rescued by crop →
    // remaining single-species → only then multi-species. Multi-species never outranks
    // an available single-species candidate merely because it looks better.
    const ordered = [];
    exactGood.forEach((c) => { c.tier = 1; c.rankScore = c.fullScore; ordered.push(c); });
    exactCropRescue.forEach((c) => { c.tier = 2; c.rankScore = c.cropScore; c.useCrop = true; ordered.push(c); });
    exactRemaining.forEach((c) => { c.tier = 3; c.rankScore = c.fullScore; ordered.push(c); });
    multiGood.forEach((c) => { c.tier = 4; c.rankScore = c.fullScore; ordered.push(c); });
    multiLow.forEach((c) => { c.tier = 5; c.rankScore = c.fullScore; ordered.push(c); });

    // Keep the highest-ranked representative of visually near-identical files.
    // Commons often contains original/cropped/re-encoded copies of one plate.
    rankedCandidates = dedupeCandidates(ordered);
    renderMetrics();
    renderResults();
  }

  function findBestCrop(baseAnalysis, originalWidth, originalHeight) {
    const data = baseAnalysis.pixelData;
    const w = baseAnalysis.pixelWidth;
    const h = baseAnalysis.pixelHeight;
    if (!data || !w || !h) return null;

    const candidates = [];
    const scales = [0.82, 0.68, 0.56];
    const positions = [0, 0.5, 1];

    for (const scale of scales) {
      let cropW = Math.max(16, Math.round(w * scale));
      let cropH = Math.round(cropW / CROP_ASPECT);
      if (cropH > h * scale) {
        cropH = Math.max(16, Math.round(h * scale));
        cropW = Math.round(cropH * CROP_ASPECT);
      }
      if (cropW > w || cropH > h) continue;
      for (const py of positions) {
        for (const px of positions) {
          const x = Math.round((w - cropW) * px);
          const y = Math.round((h - cropH) * py);
          const cropped = extractPixels(data, w, h, x, y, cropW, cropH);
          const ow = originalWidth * (cropW / w);
          const oh = originalHeight * (cropH / h);
          const features = analyzePixels(cropped, cropW, cropH, ow, oh);
          candidates.push({ features, rect: { x: x / w, y: y / h, w: cropW / w, h: cropH / h } });
        }
      }
    }

    candidates.sort((a, b) => weightedScore(b.features) - weightedScore(a.features));
    return candidates[0] || null;
  }

  function computeDHash(img, crop = null) {
    const canvas = document.createElement("canvas");
    canvas.width = 9;
    canvas.height = 8;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (crop) {
      const sx = Math.round(img.naturalWidth * crop.x);
      const sy = Math.round(img.naturalHeight * crop.y);
      const sw = Math.max(2, Math.round(img.naturalWidth * crop.w));
      const sh = Math.max(2, Math.round(img.naturalHeight * crop.h));
      ctx.drawImage(img, sx, sy, Math.min(sw, img.naturalWidth - sx), Math.min(sh, img.naturalHeight - sy), 0, 0, 9, 8);
    } else ctx.drawImage(img, 0, 0, 9, 8);
    const d = ctx.getImageData(0, 0, 9, 8).data;
    let hash = 0n;
    let bit = 0n;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const i1 = (y * 9 + x) * 4;
        const i2 = (y * 9 + x + 1) * 4;
        const g1 = 0.299 * d[i1] + 0.587 * d[i1 + 1] + 0.114 * d[i1 + 2];
        const g2 = 0.299 * d[i2] + 0.587 * d[i2 + 1] + 0.114 * d[i2 + 2];
        if (g1 > g2) hash |= (1n << bit);
        bit++;
      }
    }
    return hash;
  }

  function computePHash(img, crop = null) {
    const size = 16, low = 8;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (crop) {
      const sx = Math.round(img.naturalWidth * crop.x);
      const sy = Math.round(img.naturalHeight * crop.y);
      const sw = Math.max(2, Math.round(img.naturalWidth * crop.w));
      const sh = Math.max(2, Math.round(img.naturalHeight * crop.h));
      ctx.drawImage(img, sx, sy, Math.min(sw, img.naturalWidth - sx), Math.min(sh, img.naturalHeight - sy), 0, 0, size, size);
    } else ctx.drawImage(img, 0, 0, size, size);
    const rgba = ctx.getImageData(0, 0, size, size).data;
    const gray = new Float64Array(size * size);
    for (let i = 0; i < gray.length; i++) {
      const j = i * 4;
      gray[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
    }
    const coeff = [];
    for (let v = 0; v < low; v++) for (let u = 0; u < low; u++) {
      let sum = 0;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        sum += gray[y * size + x]
          * Math.cos(((2 * x + 1) * u * Math.PI) / (2 * size))
          * Math.cos(((2 * y + 1) * v * Math.PI) / (2 * size));
      }
      coeff.push(sum);
    }
    const threshold = median(coeff.slice(1));
    let hash = 0n;
    coeff.forEach((value, index) => { if (value > threshold) hash |= (1n << BigInt(index)); });
    return hash;
  }

  function computePerceptualHashes(img) {
    const crops = [
      null,
      { x: .05, y: .05, w: .90, h: .90 },
      { x: .10, y: .10, w: .80, h: .80 },
      { x: .15, y: .15, w: .70, h: .70 },
      { x: .06, y: .13, w: .88, h: .76 },
      { x: .13, y: .06, w: .74, h: .88 },
    ];
    return crops.map((crop) => ({ d: computeDHash(img, crop), p: computePHash(img, crop) }));
  }

  function hammingDistance64(a, b) {
    if (typeof a !== "bigint" || typeof b !== "bigint") return 64;
    let x = a ^ b;
    let count = 0;
    while (x) {
      count += Number(x & 1n);
      x >>= 1n;
    }
    return count;
  }

  function minimumPerceptualDistance(a, b) {
    const aa = a.analysis?.perceptualHashes || [];
    const bb = b.analysis?.perceptualHashes || [];
    if (!aa.length || !bb.length) return { p: 64, d: 64 };
    let p = 64, d = 64;
    for (const ha of aa) for (const hb of bb) {
      p = Math.min(p, hammingDistance64(ha.p, hb.p));
      d = Math.min(d, hammingDistance64(ha.d, hb.d));
    }
    return { p, d };
  }

  function titleCore(title) {
    return normalizeTitle(title)
      .replace(/^file:/, "")
      .replace(/\b(cropped|crop|original|uncropped|retouched|edited|version|scan|restored)\b/g, " ")
      .replace(/\([^)]*\)/g, " ")
      .replace(/\b\d{3,}\b/g, " ")
      .replace(/[^a-zà-öø-ÿ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function tokenSimilarity(a, b) {
    const aa = new Set(titleCore(a).split(" ").filter((x) => x.length > 2));
    const bb = new Set(titleCore(b).split(" ").filter((x) => x.length > 2));
    if (!aa.size || !bb.size) return 0;
    let common = 0;
    aa.forEach((token) => { if (bb.has(token)) common++; });
    return common / Math.max(aa.size, bb.size);
  }

  function plateMarker(title) {
    const match = normalizeTitle(title).match(/\b(?:plate|pl\.?|page|fig\.?|figure|tab\.?|taf\.?|tav\.?)\s*([0-9ivxlcdm-]+)/i);
    return match?.[1] || "";
  }

  function areNearDuplicates(a, b) {
    const { p, d } = minimumPerceptualDistance(a, b);
    const similarity = tokenSimilarity(a.title, b.title);
    const markerA = plateMarker(a.title), markerB = plateMarker(b.title);
    if (markerA && markerB && markerA !== markerB) return p <= 3 && d <= 4;
    if (p <= 4 || d <= 3) return true;
    if (p <= 7 && d <= 8 && similarity >= 0.18) return true;
    if (p <= 10 && d <= 12 && similarity >= 0.52) return true;
    return false;
  }

  function dedupeCandidates(candidates) {
    const uniqueCandidates = [];
    for (const candidate of candidates) {
      const duplicateOf = uniqueCandidates.find((kept) => areNearDuplicates(candidate, kept));
      if (duplicateOf) {
        candidate.duplicateOf = duplicateOf.title;
        continue;
      }
      uniqueCandidates.push(candidate);
    }
    return uniqueCandidates;
  }

  function renderMetrics() {
    const preferredTitles = CALIBRATION[activeSpecies] || [];
    const preferredSet = new Set(preferredTitles.map(normalizeTitle));
    const rankedPreferred = rankedCandidates
      .map((c, index) => preferredSet.has(normalizeTitle(c.title)) ? index + 1 : null)
      .filter(Boolean);
    const foundPreferred = rankedPreferred.length;
    const top6 = rankedPreferred.filter((rank) => rank <= 6).length;
    const top12 = rankedPreferred.filter((rank) => rank <= 12).length;
    const exactCount = rawCandidates.filter((c) => !c.otherSpecies.length).length;
    const multiCount = rawCandidates.length - exactCount;

    const cards = [
      [String(rawCandidates.length), "illustrations analysées"],
      [`${exactCount} / ${multiCount}`, "espèce seule / multi-espèces détectées"],
      preferredTitles.length ? `${top6}/${preferredTitles.length}` : "—", "références dans le top 6",
      preferredTitles.length ? `${top12}/${preferredTitles.length}` : "—", "références dans le top 12"
    ];
    el.metricsPanel.innerHTML = cards.map(([value, label]) => `<div class="metric-card"><span class="metric-value">${escapeHtml(value)}</span><span class="metric-label">${escapeHtml(label)}</span></div>`).join("");
    el.metricsPanel.hidden = false;

    if (preferredTitles.length && foundPreferred < preferredTitles.length) {
      const missing = preferredTitles.length - foundPreferred;
      el.statusText.textContent = `${rawCandidates.length} illustrations analysées. ${missing} référence(s) utilisateur ne figurent pas dans les fichiers directs récupérés ou n’ont pas pu être chargées.`;
    }
  }

  function renderResults() {
    el.resultsGrid.innerHTML = "";
    const slice = rankedCandidates.slice(0, visibleCount);
    slice.forEach((candidate, index) => {
      const card = document.createElement("article");
      card.className = `result-card${candidate.preferred ? " preferred" : ""}`;
      const tierLabel = tierDescription(candidate.tier);
      const features = candidate.useCrop && candidate.cropAnalysis ? candidate.cropAnalysis.features : candidate.analysis;
      const imgStyle = candidate.useCrop && candidate.cropAnalysis ? cropObjectPosition(candidate.cropAnalysis.rect) : "";
      card.innerHTML = `
        <span class="rank-badge">${index + 1}</span>
        <div class="result-image-wrap${candidate.useCrop ? " crop-rescue" : ""}">
          <img loading="lazy" src="${escapeAttr(candidate.thumbUrl)}" alt="${escapeAttr(candidate.title.replace(/^File:/, ""))}" ${imgStyle}>
        </div>
        <div class="result-body">
          <h3 class="result-title">${escapeHtml(candidate.title.replace(/^File:/, ""))}</h3>
          <div class="badges">
            ${candidate.preferred ? '<span class="badge preferred">Référence utilisateur</span>' : ""}
            ${candidate.useCrop ? '<span class="badge rescue">Secours par recadrage</span>' : ""}
            ${candidate.otherSpecies.length ? '<span class="badge multi">Multi-espèces</span>' : '<span class="badge normal">Espèce seule détectée</span>'}
          </div>
          <div class="score-row"><span class="total-score">${candidate.rankScore.toFixed(1)}</span><span class="metric-label">${escapeHtml(tierLabel)}</span></div>
          <div class="feature-grid">
            ${featureCell("A", features.A)}
            ${featureCell("C", features.C)}
            ${featureCell("D", features.D)}
            ${featureCell("E", features.E)}
            ${featureCell("F", features.F)}
            ${featureCell("Portrait", features.P)}
          </div>
          ${candidate.otherSpecies.length ? `<p class="other-species">Autre(s) catégorie(s) botanique(s) détectée(s) : ${escapeHtml(candidate.otherSpecies.join(", "))}</p>` : ""}
          <a class="commons-link" href="${escapeAttr(candidate.descriptionUrl)}" target="_blank" rel="noopener noreferrer">Voir sur Wikimedia Commons</a>
        </div>
      `;
      el.resultsGrid.appendChild(card);
    });

    el.resultCategory.textContent = `${activeSpecies} · ${rankedCandidates.length} candidats classés`;
    el.resultsSection.hidden = false;
    el.showMoreButton.hidden = visibleCount >= rankedCandidates.length;
  }

  function featureCell(label, value) {
    return `<span>${escapeHtml(label)} <strong>${Math.round((value || 0) * 100)}</strong></span>`;
  }

  function tierDescription(tier) {
    return ({
      1: "espèce seule · plein cadre",
      2: "espèce seule · recadrage secours",
      3: "espèce seule · sous le seuil",
      4: "multi-espèces · dernier recours",
      5: "multi-espèces · sous le seuil"
    })[tier] || "";
  }

  function cropObjectPosition(rect) {
    if (!rect) return "";
    const centerX = (rect.x + rect.w / 2) * 100;
    const centerY = (rect.y + rect.h / 2) * 100;
    const scale = 1 / Math.max(rect.w, rect.h);
    return `style="object-position:${centerX.toFixed(1)}% ${centerY.toFixed(1)}%; transform:scale(${scale.toFixed(2)});"`;
  }

  function setStatus(text, progressVisible = true) {
    el.statusText.textContent = text;
    el.progressTrack.hidden = !progressVisible;
  }

  function setProgress(value, visible) {
    el.progressTrack.hidden = !visible;
    el.progressBar.style.width = `${clamp(value, 0, 100)}%`;
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.decoding = "async";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Miniature inaccessible"));
      img.src = url;
    });
  }

  async function mapConcurrent(items, concurrency, fn) {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        await fn(items[index], index);
      }
    });
    await Promise.all(workers);
  }

  function dilateMask(mask, w, h) {
    const out = new Uint8Array(mask.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (!mask[idx]) continue;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            out[yy * w + xx] = 1;
          }
        }
      }
    }
    return out;
  }

  function componentSizes(mask, w, h) {
    const visited = new Uint8Array(mask.length);
    const sizes = [];
    const qx = new Int16Array(mask.length);
    const qy = new Int16Array(mask.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const start = y * w + x;
        if (!mask[start] || visited[start]) continue;
        let head = 0, tail = 0, size = 0;
        qx[tail] = x; qy[tail] = y; tail++;
        visited[start] = 1;
        while (head < tail) {
          const cx = qx[head], cy = qy[head]; head++; size++;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (!dx && !dy) continue;
              const nx = cx + dx, ny = cy + dy;
              if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
              const ni = ny * w + nx;
              if (!mask[ni] || visited[ni]) continue;
              visited[ni] = 1;
              qx[tail] = nx; qy[tail] = ny; tail++;
            }
          }
        }
        sizes.push(size);
      }
    }
    return sizes.sort((a, b) => b - a);
  }

  function extractPixels(data, w, h, x0, y0, cw, ch) {
    const out = new Uint8ClampedArray(cw * ch * 4);
    let oi = 0;
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const si = ((y0 + y) * w + (x0 + x)) * 4;
        out[oi++] = data[si];
        out[oi++] = data[si + 1];
        out[oi++] = data[si + 2];
        out[oi++] = data[si + 3];
      }
    }
    return out;
  }

  function rgbStats(pixels) {
    if (!pixels.length) return { std: 0 };
    let mean = 0;
    const lum = pixels.map((p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]);
    mean = lum.reduce((a, b) => a + b, 0) / lum.length;
    const variance = lum.reduce((sum, v) => sum + (v - mean) ** 2, 0) / lum.length;
    return { std: Math.sqrt(variance) };
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    return { h: h / 6, s, l };
  }

  function colorDistance(a, b) {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / 441.67295593;
  }

  function bellScore(value, center, halfWidth) {
    return clamp01(1 - Math.abs(value - center) / halfWidth);
  }

  function median(values) {
    if (!values.length) return 0;
    values.sort((a, b) => a - b);
    const mid = Math.floor(values.length / 2);
    return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  }

  function sortByFullScore(a, b) {
    return (b.fullScore - a.fullScore) || a.title.localeCompare(b.title);
  }

  function normalizeTitle(title) {
    return String(title || "").replace(/_/g, " ").replace(/\s+/g, " ").trim().toLocaleLowerCase("en");
  }

  function normalizeCategory(title) {
    return normalizeTitle(String(title || "").replace(/^Category:/i, ""));
  }

  function unique(values) { return [...new Set(values)]; }
  function clamp01(v) { return clamp(v, 0, 1); }
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function stripHtml(value) { const div = document.createElement("div"); div.innerHTML = String(value || ""); return (div.textContent || "").replace(/\s+/g, " ").trim(); }
  function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[c]); }
  function escapeAttr(value) { return escapeHtml(value); }
})();
