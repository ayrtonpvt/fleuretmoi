(() => {
  "use strict";

  const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
  const TARGET_COUNT = 6;
  const PAGE_STEP = 6;
  const ANALYSIS_MAX = 112;
  const CROP_ASPECT = 4 / 5;
  const WEIGHTS = { A: 34, C: 19, D: 18, E: 12, F: 10, P: 7 };
  const QUALITY_THRESHOLD = 58;
  const analysisCache = new Map();

  const picker = {
    dialog: document.getElementById("illustrationPickerDialog"),
    title: document.getElementById("illustrationPickerTitle"),
    subtitle: document.getElementById("illustrationPickerSubtitle"),
    status: document.getElementById("illustrationPickerStatus"),
    progress: document.getElementById("illustrationPickerProgress"),
    progressBar: document.getElementById("illustrationPickerProgressBar"),
    grid: document.getElementById("illustrationPickerGrid"),
    more: document.getElementById("illustrationPickerMore"),
    cancel: document.getElementById("illustrationPickerCancel"),
  };

  const editor = {
    dialog: document.getElementById("illustrationEditorDialog"),
    canvas: document.getElementById("illustrationEditorCanvas"),
    zoom: document.getElementById("illustrationEditorZoom"),
    change: document.getElementById("illustrationEditorChange"),
    reset: document.getElementById("illustrationEditorReset"),
    cancel: document.getElementById("illustrationEditorCancel"),
    save: document.getElementById("illustrationEditorSave"),
    status: document.getElementById("illustrationEditorStatus"),
  };

  let pickerState = { species: null, ranked: [], visible: PAGE_STEP, token: 0, choosing: false };
  let editorState = null;
  let editorPointer = null;

  function closeIllustrationPicker() {
    // Invalide aussi un téléchargement encore en cours : une ancienne sélection
    // ne doit jamais rouvrir l’éditeur après que l’utilisateur a quitté la fenêtre.
    pickerState.token += 1;
    pickerState.choosing = false;
    if (picker.dialog?.open) picker.dialog.close();
  }

  picker.cancel?.addEventListener("click", closeIllustrationPicker);
  picker.dialog?.addEventListener("pointerdown", (event) => {
    if (event.target === picker.dialog) closeIllustrationPicker();
  });
  picker.more?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!pickerState.ranked.length) return;
    const nextVisible = Math.min(pickerState.ranked.length, pickerState.visible + PAGE_STEP);
    if (nextVisible <= pickerState.visible) {
      picker.more.hidden = true;
      return;
    }
    pickerState.visible = nextVisible;
    renderPickerGrid();
  });
  editor.cancel?.addEventListener("click", closeIllustrationEditor);
  editor.dialog?.addEventListener("pointerdown", (event) => {
    if (event.target === editor.dialog) closeIllustrationEditor();
  });
  editor.change?.addEventListener("click", async () => {
    if (!editorState?.species) return;
    const species = editorState.species;
    closeIllustrationEditor();
    await openIllustrationPicker(species);
  });
  editor.reset?.addEventListener("click", resetIllustrationEditor);
  editor.zoom?.addEventListener("input", () => {
    if (!editorState) return;
    editorState.zoom = Number(editor.zoom.value);
    drawIllustrationEditor();
  });
  editor.save?.addEventListener("click", saveIllustrationEditor);

  editor.canvas?.addEventListener("pointerdown", (event) => {
    if (!editorState) return;
    editor.canvas.setPointerCapture(event.pointerId);
    editorPointer = { x: event.clientX, y: event.clientY, panX: editorState.panX, panY: editorState.panY };
  });
  editor.canvas?.addEventListener("pointermove", (event) => {
    if (!editorState || !editorPointer) return;
    const rect = editor.canvas.getBoundingClientRect();
    const scaleX = editor.canvas.width / rect.width;
    const scaleY = editor.canvas.height / rect.height;
    editorState.panX = editorPointer.panX + (event.clientX - editorPointer.x) * scaleX;
    editorState.panY = editorPointer.panY + (event.clientY - editorPointer.y) * scaleY;
    drawIllustrationEditor();
  });
  editor.canvas?.addEventListener("pointerup", () => { editorPointer = null; });
  editor.canvas?.addEventListener("pointercancel", () => { editorPointer = null; });

  async function renderSpeciesIllustration(species) {
    const card = document.getElementById("speciesIdentityCard");
    const button = document.getElementById("speciesIllustrationButton");
    const media = document.getElementById("speciesIllustrationMedia");
    const actions = document.getElementById("speciesIllustrationActions");
    const source = document.getElementById("speciesIllustrationSource");
    if (!button || !media) return;

    media.innerHTML = "";
    if (actions) actions.hidden = true;
    if (source) {
      source.hidden = true;
      source.removeAttribute("href");
      source.textContent = "";
    }
    resetSpeciesIdentityTheme(card);

    const illustration = species?.illustration;
    const blob = illustration?.displayBlob || illustration?.sourceBlob;
    if (!(blob instanceof Blob)) {
      const placeholder = document.createElement("div");
      placeholder.className = "speciesIllustrationPlaceholderInner";
      placeholder.innerHTML = '<span>Illustration botanique</span><small>CHOISIR</small>';
      media.appendChild(placeholder);
      button.setAttribute("aria-label", "Choisir une illustration botanique");
      button.onclick = () => openIllustrationPicker(species);
      return;
    }

    try {
      const img = document.createElement("img");
      img.alt = `Illustration botanique de ${species.scientificNameWithoutAuthor || species.scientificName}`;
      img.src = blobUrl(blob, "speciesObjectUrls");
      media.appendChild(img);
      button.setAttribute("aria-label", "Ajuster l’illustration botanique");
      button.onclick = () => openExistingIllustrationEditor(species);

      // Une couleur déjà enregistrée est utilisée immédiatement. Pour les
      // illustrations créées avant cette fonction, on la recalcule une fois.
      let backgroundColor = illustration?.backgroundColor;
      if (!backgroundColor) {
        backgroundColor = await extractIllustrationBackgroundColor(blob);
        try {
          const fresh = await dbGet(STORE_SPECIES, species.id);
          if (fresh?.illustration && !fresh.illustration.backgroundColor) {
            fresh.illustration.backgroundColor = backgroundColor;
            await dbPut(STORE_SPECIES, fresh);
          }
        } catch (persistError) {
          console.warn("Couleur de fond non mémorisée", persistError);
        }
      }
      if (state.currentSpeciesId === species.id) applySpeciesIdentityTheme(card, backgroundColor);
    } catch (error) {
      // Même avec une ancienne donnée d’illustration invalide, la fiche reste
      // accessible et permet à l’utilisateur de choisir une nouvelle image.
      console.error("Illustration botanique illisible", error);
      media.innerHTML = '<div class="speciesIllustrationPlaceholderInner"><span>Illustration indisponible</span><small>CHANGER</small></div>';
      button.setAttribute("aria-label", "Changer l’illustration botanique");
      button.onclick = () => openIllustrationPicker(species);
    }
  }

  async function openIllustrationPicker(species) {
    if (!picker.dialog) return;
    pickerState = { species, ranked: [], visible: PAGE_STEP, token: pickerState.token + 1, choosing: false };
    const token = pickerState.token;
    picker.title.textContent = "Choisir une illustration";
    picker.subtitle.textContent = species.scientificNameWithoutAuthor || species.scientificName || "";
    picker.grid.innerHTML = "";
    picker.more.hidden = true;
    // chooseCandidate() désactive ce bouton pendant le téléchargement. Si la
    // fenêtre est fermée après un choix puis rouverte, cet état DOM persistait
    // et « Afficher 6 autres » restait bloqué malgré un nouvel état de picker.
    picker.more.disabled = false;
    setPickerProgress(0, false);
    setPickerStatus("Recherche de la catégorie botanique exacte…");
    picker.dialog.showModal();

    try {
      const scientificName = (species.scientificNameWithoutAuthor || species.scientificName || "").trim();
      if (!scientificName) throw new Error("Le nom scientifique de cette espèce est manquant.");
      const cached = analysisCache.get(scientificName);
      if (cached) {
        pickerState.ranked = cached;
        renderPickerGrid();
        setPickerStatus(`${cached.length} propositions classées. Les images multi-espèces restent en dernier recours.`);
        return;
      }

      const category = `Category:${scientificName} - botanical illustrations`;
      const exists = await categoryExists(category);
      if (token !== pickerState.token) return;
      if (!exists) throw new Error(`Aucune catégorie Commons exacte « ${scientificName} - botanical illustrations » n’a été trouvée. Fleuretmoi n’élargit pas automatiquement à une autre espèce.`);

      setPickerStatus("Récupération des illustrations de l’espèce…");
      const members = await fetchAllCategoryFiles(category);
      if (!members.length) throw new Error("Cette catégorie ne contient aucune illustration directe.");
      const meta = await fetchFileMetadata(members.map((m) => m.title));
      if (token !== pickerState.token) return;

      const candidates = meta.filter((item) => item.thumbUrl).map((item) => ({
        ...item,
        otherSpecies: detectOtherIllustratedSpecies(item.categories, category),
        analysis: null,
        cropAnalysis: null,
        cropScore: null,
      }));

      let done = 0;
      setPickerProgress(0, true);
      setPickerStatus(`Analyse esthétique de ${candidates.length} illustrations…`);
      await mapConcurrent(candidates, 5, async (candidate) => {
        try {
          candidate.analysis = await analyzeRemoteImage(candidate.thumbUrl, candidate.width, candidate.height);
        } catch (error) {
          candidate.loadError = error?.message || String(error);
        } finally {
          done += 1;
          setPickerProgress(Math.round(done / candidates.length * 100), true);
          setPickerStatus(`Analyse esthétique : ${done}/${candidates.length}…`);
        }
      });
      if (token !== pickerState.token) return;

      const usable = candidates.filter((c) => c.analysis);
      if (!usable.length) throw new Error("Les miniatures Wikimedia n’ont pas pu être analysées.");
      const ranked = rankCandidates(usable);
      analysisCache.set(scientificName, ranked);
      pickerState.ranked = ranked;
      renderPickerGrid();
      setPickerProgress(100, false);
      setPickerStatus(`${ranked.length} propositions classées. Choisis-en une ou affiche les suivantes.`);
    } catch (error) {
      console.error(error);
      setPickerProgress(0, false);
      setPickerStatus(error?.message || String(error), true);
    }
  }

  function renderPickerGrid() {
    picker.grid.innerHTML = "";
    // Ce bouton n’est volontairement jamais laissé en état disabled. Son état
    // dépend uniquement du nombre de résultats encore disponibles.
    picker.more.disabled = false;
    const visibleCount = Math.min(pickerState.visible, pickerState.ranked.length);
    const visible = pickerState.ranked.slice(0, visibleCount);
    visible.forEach((candidate, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "illustrationCandidate";
      button.disabled = Boolean(pickerState.choosing);
      button.innerHTML = `
        <span class="illustrationCandidateRank">${index + 1}</span>
        <span class="illustrationCandidateImage"><img loading="lazy" src="${escapeAttr(candidate.thumbUrl)}" alt=""></span>
        <span class="illustrationCandidateMeta">
          <strong>${escapeHtml(candidate.title.replace(/^File:/, ""))}</strong>
          <small>${candidate.otherSpecies.length ? "Plusieurs espèces · dernier recours" : `Score ${candidate.rankScore.toFixed(0)}/100`}${candidate.useCrop ? " · recadrage utile" : ""}</small>
        </span>`;
      button.addEventListener("click", () => chooseCandidate(candidate));
      picker.grid.appendChild(button);
    });
    picker.more.hidden = visibleCount >= pickerState.ranked.length;
  }

  async function chooseCandidate(candidate) {
    const species = pickerState.species;
    if (!species || pickerState.choosing) return;
    const token = pickerState.token;
    pickerState.choosing = true;
    renderPickerGrid();
    setPickerStatus("Téléchargement d’une version de bonne qualité…");
    try {
      const asset = await fetchSelectionAsset(candidate.title);
      if (token !== pickerState.token) return;
      const response = await fetch(asset.assetUrl, { mode: "cors", credentials: "omit" });
      if (!response.ok) throw new Error(`Téléchargement Wikimedia : HTTP ${response.status}`);
      const sourceBlob = await response.blob();
      if (token !== pickerState.token) return;
      if (!sourceBlob.size) throw new Error("Le fichier Wikimedia téléchargé est vide.");
      pickerState.choosing = false;
      if (picker.dialog?.open) picker.dialog.close();
      await openIllustrationEditor({
        mode: "new",
        species,
        sourceBlob,
        metadata: {
          source: "wikimedia-commons",
          fileTitle: candidate.title,
          descriptionUrl: asset.descriptionUrl || candidate.descriptionUrl,
          originalUrl: asset.originalUrl || candidate.originalUrl,
          assetUrl: asset.assetUrl,
          width: asset.width || candidate.width,
          height: asset.height || candidate.height,
          author: asset.author,
          licenseShort: asset.licenseShort,
          credit: asset.credit,
          selectedAt: Date.now(),
        }
      });
    } catch (error) {
      if (token !== pickerState.token) return;
      console.error(error);
      pickerState.choosing = false;
      setPickerStatus(error?.message || String(error), true);
      renderPickerGrid();
    }
  }

  async function openExistingIllustrationEditor(species) {
    const sourceBlob = species.illustration?.sourceBlob || species.illustration?.displayBlob;
    if (!sourceBlob) return;
    await openIllustrationEditor({ mode: "existing", species, sourceBlob, metadata: species.illustration });
  }

  async function openIllustrationEditor({ mode, species, sourceBlob, metadata }) {
    try {
      const image = await loadImageFromBlob(sourceBlob);
      const framing = mode === "existing" ? (metadata?.framing || {}) : {};
      const minZoom = illustrationFitZoom(image);
      const requestedZoom = Number.isFinite(Number(framing.zoom)) ? Number(framing.zoom) : 1;
      const zoom = Math.max(minZoom, Math.min(Number(editor.zoom.max || 3), requestedZoom));
      const panX = Number.isFinite(Number(framing.panX)) ? Number(framing.panX) : 0;
      const panY = Number.isFinite(Number(framing.panY)) ? Number(framing.panY) : 0;
      editorState = { mode, species, sourceBlob, metadata, image, zoom, minZoom, panX, panY };
      editor.zoom.min = String(minZoom);
      editor.zoom.value = String(zoom);
      editor.status.textContent = "";
      drawIllustrationEditor();
      editor.dialog.showModal();
    } catch {
      alert("Cette illustration ne peut pas être ouverte dans l’éditeur de ce navigateur.");
    }
  }

  function illustrationFitZoom(image) {
    if (!image?.naturalWidth || !image?.naturalHeight) return 0.25;
    const cover = Math.max(editor.canvas.width / image.naturalWidth, editor.canvas.height / image.naturalHeight);
    const contain = Math.min(editor.canvas.width / image.naturalWidth, editor.canvas.height / image.naturalHeight);
    // Minimum = image entière visible dans le cadre. On autorise donc un vrai
    // dézoom sans permettre de réduire l’illustration jusqu’à devenir minuscule.
    return Math.max(0.2, Math.min(1, contain / cover));
  }

  function resetIllustrationEditor() {
    if (!editorState) return;
    editorState.zoom = 1;
    editorState.panX = 0;
    editorState.panY = 0;
    editor.zoom.value = "1";
    drawIllustrationEditor();
  }

  function clampIllustrationPan() {
    if (!editorState) return;
    const { image, zoom } = editorState;
    const baseScale = Math.max(editor.canvas.width / image.naturalWidth, editor.canvas.height / image.naturalHeight);
    const displayedW = image.naturalWidth * baseScale * zoom;
    const displayedH = image.naturalHeight * baseScale * zoom;
    const maxX = Math.max(0, (displayedW - editor.canvas.width) / 2);
    const maxY = Math.max(0, (displayedH - editor.canvas.height) / 2);
    editorState.panX = Math.max(-maxX, Math.min(maxX, editorState.panX));
    editorState.panY = Math.max(-maxY, Math.min(maxY, editorState.panY));
  }

  function drawIllustrationEditor(targetCanvas = editor.canvas) {
    if (!editorState) return;
    if (targetCanvas === editor.canvas) clampIllustrationPan();
    const ctx = targetCanvas.getContext("2d");
    const logicalW = editor.canvas.width;
    const logicalH = editor.canvas.height;
    const factor = Math.min(targetCanvas.width / logicalW, targetCanvas.height / logicalH);
    const offsetX = (targetCanvas.width - logicalW * factor) / 2;
    const offsetY = (targetCanvas.height - logicalH * factor) / 2;
    const { image, zoom, panX, panY } = editorState;
    const baseScale = Math.max(logicalW / image.naturalWidth, logicalH / image.naturalHeight);
    const finalScale = baseScale * zoom * factor;

    ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
    ctx.fillStyle = "#f4f0e7";
    ctx.fillRect(0, 0, targetCanvas.width, targetCanvas.height);
    ctx.save();
    ctx.translate(offsetX + (logicalW / 2 + panX) * factor, offsetY + (logicalH / 2 + panY) * factor);
    ctx.scale(finalScale, finalScale);
    ctx.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2);
    ctx.restore();
  }

  function exportIllustrationDisplayBlob() {
    return new Promise((resolve) => {
      clampIllustrationPan();
      drawIllustrationEditor();
      const canvas = document.createElement("canvas");
      canvas.width = 1280;
      canvas.height = 1600;
      drawIllustrationEditor(canvas);
      canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.92);
    });
  }

  async function saveIllustrationEditor() {
    if (!editorState) return;
    editor.save.disabled = true;
    editor.status.textContent = "Enregistrement…";
    try {
      const displayBlob = await exportIllustrationDisplayBlob();
      if (!displayBlob) throw new Error("Impossible de produire l’illustration recadrée.");
      const backgroundColor = await extractIllustrationBackgroundColor(displayBlob);
      const species = await dbGet(STORE_SPECIES, editorState.species.id);
      if (!species) throw new Error("La fiche d’espèce n’existe plus.");
      species.illustration = {
        ...editorState.metadata,
        sourceBlob: editorState.sourceBlob,
        displayBlob,
        backgroundColor,
        framing: { zoom: editorState.zoom, panX: editorState.panX, panY: editorState.panY },
        updatedAt: Date.now(),
      };
      await dbPut(STORE_SPECIES, species);
      closeIllustrationEditor();
      await renderSpecies(species);
      await renderHerbarium();
    } catch (error) {
      console.error(error);
      editor.status.textContent = error?.message || String(error);
    } finally {
      editor.save.disabled = false;
    }
  }

  function closeIllustrationEditor() {
    if (editor.dialog?.open) editor.dialog.close();
    editorState = null;
    editorPointer = null;
    if (editor.status) editor.status.textContent = "";
  }

  function resetSpeciesIdentityTheme(card) {
    if (!card) return;
    card.classList.remove("illustrationThemed");
    ["--species-theme-bg", "--species-theme-ink", "--species-theme-muted", "--species-theme-chip", "--species-theme-border"].forEach((name) => card.style.removeProperty(name));
  }

  function applySpeciesIdentityTheme(card, backgroundColor) {
    if (!card || !backgroundColor) return;
    const rgb = parseRgbCss(backgroundColor);
    if (!rgb) return;
    const luminance = relativeLuminance(rgb.r, rgb.g, rgb.b);
    const dark = luminance < 0.34;
    card.style.setProperty("--species-theme-bg", `rgb(${rgb.r} ${rgb.g} ${rgb.b})`);
    card.style.setProperty("--species-theme-ink", dark ? "#f8faf7" : "#173025");
    card.style.setProperty("--species-theme-muted", dark ? "rgba(248,250,247,.78)" : "rgba(23,48,37,.72)");
    card.style.setProperty("--species-theme-chip", dark ? "rgba(255,255,255,.13)" : "rgba(255,255,255,.42)");
    card.style.setProperty("--species-theme-border", dark ? "rgba(255,255,255,.18)" : "rgba(23,48,37,.12)");
    card.classList.add("illustrationThemed");
  }

  async function extractIllustrationBackgroundColor(blob) {
    const image = await loadImageFromBlob(blob);
    const canvas = document.createElement("canvas");
    canvas.width = 80;
    canvas.height = 100;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

    // Le fond d’une planche botanique est généralement la couleur la plus
    // fréquente près des bords. On regroupe les pixels en petits "bacs" de
    // couleur plutôt que de prendre une moyenne, qui était trop facilement
    // neutralisée par le dessin, une reliure sombre ou du texte.
    const bins = new Map();
    const depth = 11;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      if (x >= depth && x < canvas.width - depth && y >= depth && y < canvas.height - depth) continue;
      const i = (y * canvas.width + x) * 4;
      if (data[i + 3] < 220) continue;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const qr = Math.round(r / 16) * 16;
      const qg = Math.round(g / 16) * 16;
      const qb = Math.round(b / 16) * 16;
      const key = `${qr},${qg},${qb}`;
      const bin = bins.get(key) || { count: 0, r: 0, g: 0, b: 0 };
      bin.count += 1; bin.r += r; bin.g += g; bin.b += b;
      bins.set(key, bin);
    }
    if (!bins.size) return "rgb(244 247 242)";
    const best = [...bins.values()].sort((a, b) => b.count - a.count)[0];
    let r = Math.round(best.r / best.count);
    let g = Math.round(best.g / best.count);
    let b = Math.round(best.b / best.count);

    // Évite qu’un blanc pur soit visuellement indistinguable du fond de la
    // page tout en conservant la teinte réelle du papier.
    if (r > 248 && g > 248 && b > 248) { r = 246; g = 246; b = 243; }
    return `rgb(${r} ${g} ${b})`;
  }

  function parseRgbCss(value) {
    const match = String(value || "").match(/rgb\(\s*(\d+)\s+[, ]?\s*(\d+)\s+[, ]?\s*(\d+)\s*\)/i);
    if (!match) return null;
    return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
  }

  function relativeLuminance(r, g, b) {
    const channel = (v) => {
      v /= 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  }

  function rankCandidates(candidates) {
    for (const candidate of candidates) {
      candidate.fullScore = weightedScore(candidate.analysis);
      candidate.tier = null;
      candidate.rankScore = candidate.fullScore;
      candidate.useCrop = false;
    }
    const exact = candidates.filter((c) => c.otherSpecies.length === 0);
    const multi = candidates.filter((c) => c.otherSpecies.length > 0);
    const exactGood = exact.filter((c) => c.fullScore >= QUALITY_THRESHOLD).sort(sortByFullScore);
    const exactLow = exact.filter((c) => c.fullScore < QUALITY_THRESHOLD).sort(sortByFullScore);

    if (exactGood.length < TARGET_COUNT) {
      for (const candidate of exactLow.slice(0, Math.min(18, exactLow.length))) {
        candidate.cropAnalysis = findBestCrop(candidate.analysis, candidate.width, candidate.height);
        if (candidate.cropAnalysis) candidate.cropScore = weightedScore(candidate.cropAnalysis.features);
      }
    }

    const exactCropRescue = exactLow
      .filter((c) => c.cropScore >= QUALITY_THRESHOLD)
      .sort((a, b) => (b.cropScore - a.cropScore) || sortByFullScore(a, b));
    const rescued = new Set(exactCropRescue);
    const exactRemaining = exactLow.filter((c) => !rescued.has(c)).sort(sortByFullScore);
    const multiGood = multi.filter((c) => c.fullScore >= QUALITY_THRESHOLD).sort(sortByFullScore);
    const multiLow = multi.filter((c) => c.fullScore < QUALITY_THRESHOLD).sort(sortByFullScore);

    const ordered = [];
    exactGood.forEach((c) => { c.tier = 1; ordered.push(c); });
    exactCropRescue.forEach((c) => { c.tier = 2; c.rankScore = c.cropScore; c.useCrop = true; ordered.push(c); });
    exactRemaining.forEach((c) => { c.tier = 3; ordered.push(c); });
    multiGood.forEach((c) => { c.tier = 4; ordered.push(c); });
    multiLow.forEach((c) => { c.tier = 5; ordered.push(c); });
    return dedupeCandidates(ordered);
  }

  async function categoryExists(categoryTitle) {
    const data = await commonsGet({ action: "query", prop: "categoryinfo", titles: categoryTitle });
    return Object.values(data?.query?.pages || {}).some((page) => !page.missing && page.categoryinfo);
  }

  async function fetchAllCategoryFiles(categoryTitle) {
    const files = [];
    let continuation = null;
    do {
      const params = { action: "query", list: "categorymembers", cmtitle: categoryTitle, cmtype: "file", cmlimit: "max" };
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
        const params = { action: "query", prop: "imageinfo|categories", titles: batch.join("|"), iiprop: "url|size|mime", iiurlwidth: "520", cllimit: "max" };
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
          width: ii.width || 0,
          height: ii.height || 0,
          originalUrl: ii.url || "",
          thumbUrl: ii.thumburl || ii.url || "",
          descriptionUrl: ii.descriptionurl || `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}`,
          categories: unique(categoryMap.get(normalizeTitle(page.title)) || []),
        });
      }
    }
    return out;
  }

  async function fetchSelectionAsset(title) {
    const data = await commonsGet({ action: "query", prop: "imageinfo", titles: title, iiprop: "url|size|mime|extmetadata", iiurlwidth: "1800" });
    const page = Object.values(data?.query?.pages || {})[0];
    const ii = page?.imageinfo?.[0];
    if (!ii) throw new Error("Métadonnées Wikimedia indisponibles.");
    const ext = ii.extmetadata || {};
    return {
      assetUrl: ii.thumburl || ii.url,
      originalUrl: ii.url || "",
      descriptionUrl: ii.descriptionurl || "",
      width: ii.width || 0,
      height: ii.height || 0,
      author: stripHtml(ext.Artist?.value || ""),
      licenseShort: stripHtml(ext.LicenseShortName?.value || ext.License?.value || ""),
      credit: stripHtml(ext.Credit?.value || ""),
    };
  }

  function detectOtherIllustratedSpecies(categories, targetCategory) {
    const targetTaxon = targetCategory.replace(/^Category:/i, "").replace(/ - botanical illustrations$/i, "").trim();
    const targetBinomial = binomialKey(targetTaxon);
    return unique((categories || [])
      .filter((cat) => / - botanical illustrations$/i.test(cat))
      .map((cat) => cat.replace(/^Category:/i, "").replace(/ - botanical illustrations$/i, "").trim())
      .filter(isLikelySpeciesTaxon)
      .filter((taxon) => binomialKey(taxon) !== targetBinomial));
  }

  function binomialKey(taxon) { return String(taxon || "").trim().split(/\s+/).slice(0, 2).join(" ").toLocaleLowerCase("en"); }
  function isLikelySpeciesTaxon(taxon) {
    const parts = String(taxon || "").trim().split(/\s+/);
    if (parts.length < 2) return false;
    const [genus, epithet] = parts;
    return /^[A-Z][A-Za-zÀ-ÖØ-öø-ÿ.-]+$/.test(genus) && /^[a-z][a-zà-öø-ÿ.-]+$/.test(epithet);
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
    const img = await loadRemoteImage(url);
    const scale = Math.min(1, ANALYSIS_MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(24, Math.round(img.naturalWidth * scale));
    const h = Math.max(24, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
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
    const pixels = [], border = [];
    const borderDepth = Math.max(2, Math.round(Math.min(w, h) * 0.07));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const p = [data[i], data[i + 1], data[i + 2]];
      pixels.push(p);
      if (x < borderDepth || y < borderDepth || x >= w - borderDepth || y >= h - borderDepth) border.push(p);
    }
    const bg = [median(border.map((p) => p[0])), median(border.map((p) => p[1])), median(border.map((p) => p[2]))];
    const bgStats = rgbStats(border);
    const bgHsl = rgbToHsl(bg[0], bg[1], bg[2]);
    const mask = new Uint8Array(w * h);
    let fgCount = 0, strongColorCount = 0, vividColorCount = 0, strongChromaSum = 0;
    let separationSum = 0, centroidX = 0, centroidY = 0, borderFg = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const p = pixels[idx];
      const dist = colorDistance(p, bg);
      const hsl = rgbToHsl(p[0], p[1], p[2]);
      const lumDiff = Math.abs(hsl.l - bgHsl.l);
      const isFg = dist > 0.115 || (dist > 0.072 && hsl.s > bgHsl.s + 0.10) || lumDiff > 0.16;
      if (!isFg) continue;
      mask[idx] = 1; fgCount++;
      const chroma = (Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2])) / 255;
      if (chroma >= 0.13) { strongColorCount++; strongChromaSum += chroma; }
      if (chroma >= 0.24) vividColorCount++;
      separationSum += dist; centroidX += x; centroidY += y;
      const edge = Math.max(1, Math.round(Math.min(w, h) * 0.025));
      if (x < edge || y < edge || x >= w - edge || y >= h - edge) borderFg++;
    }
    if (!fgCount) return { A: 0, C: 0, D: 0, E: 0, F: technicalScore(originalWidth, originalHeight), P: portraitScore(originalWidth, originalHeight) };
    const dilated = dilateMask(mask, w, h);
    const components = componentSizes(dilated, w, h);
    const largest = components.length ? components[0] : fgCount;
    const dilatedCount = components.reduce((a, b) => a + b, 0) || fgCount;
    const mainRatio = clamp01(largest / dilatedCount);
    const occupancy = fgCount / (w * h);
    const occupancyScore = bellScore(occupancy, 0.43, 0.34);
    const cx = centroidX / fgCount / Math.max(1, w - 1), cy = centroidY / fgCount / Math.max(1, h - 1);
    const centerDist = Math.hypot(cx - 0.5, cy - 0.5) / 0.7071;
    const centerScore = clamp01(1 - centerDist * 1.15);
    const edgePenalty = clamp01(borderFg / fgCount * 5.5);
    const A = clamp01(0.42 * occupancyScore + 0.34 * mainRatio + 0.18 * centerScore + 0.06 * (1 - edgePenalty));
    const strongColorFraction = strongColorCount / fgCount;
    const vividColorFraction = vividColorCount / fgCount;
    const meanStrongChroma = strongColorCount ? strongChromaSum / strongColorCount : 0;
    const C = strongColorFraction < 0.012 ? 0 : clamp01(
      0.50 * clamp01(strongColorFraction / 0.42) +
      0.30 * clamp01(vividColorFraction / 0.20) +
      0.20 * clamp01((meanStrongChroma - 0.10) / 0.28)
    );
    const meanSeparation = separationSum / fgCount;
    const bgHomogeneity = clamp01(1 - bgStats.std / 55);
    const D = clamp01(0.68 * clamp01(meanSeparation / 0.34) + 0.32 * bgHomogeneity);
    const E = clamp01(1 - clamp01((1 - mainRatio) * 1.15));
    return { A, C, D, E, F: technicalScore(originalWidth, originalHeight), P: portraitScore(originalWidth, originalHeight), occupancy, mainRatio, bgHomogeneity };
  }

  function weightedScore(features) {
    const total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0) || 1;
    return Object.entries(WEIGHTS).reduce((sum, [key, weight]) => sum + (features[key] || 0) * weight, 0) / total * 100;
  }
  function technicalScore(width, height) {
    const minSide = Math.min(width || 0, height || 0), maxSide = Math.max(width || 0, height || 0);
    return 0.7 * clamp01((minSide - 450) / 1550) + 0.3 * clamp01((maxSide - 700) / 2300);
  }
  function portraitScore(width, height) {
    if (!width || !height) return 0.5;
    const r = height / width;
    if (r >= 1.25) return 1;
    if (r >= 1) return 0.72 + (r - 1) / 0.25 * 0.28;
    if (r >= 0.8) return 0.32 + (r - 0.8) / 0.2 * 0.40;
    return clamp01(0.32 * (r / 0.8));
  }

  function findBestCrop(baseAnalysis, originalWidth, originalHeight) {
    const data = baseAnalysis.pixelData, w = baseAnalysis.pixelWidth, h = baseAnalysis.pixelHeight;
    if (!data || !w || !h) return null;
    const candidates = [], scales = [0.82, 0.68, 0.56], positions = [0, 0.5, 1];
    for (const scale of scales) {
      let cropW = Math.max(16, Math.round(w * scale));
      let cropH = Math.round(cropW / CROP_ASPECT);
      if (cropH > h * scale) { cropH = Math.max(16, Math.round(h * scale)); cropW = Math.round(cropH * CROP_ASPECT); }
      if (cropW > w || cropH > h) continue;
      for (const py of positions) for (const px of positions) {
        const x = Math.round((w - cropW) * px), y = Math.round((h - cropH) * py);
        const cropped = extractPixels(data, w, h, x, y, cropW, cropH);
        candidates.push({ features: analyzePixels(cropped, cropW, cropH, originalWidth * cropW / w, originalHeight * cropH / h) });
      }
    }
    candidates.sort((a, b) => weightedScore(b.features) - weightedScore(a.features));
    return candidates[0] || null;
  }

  function computeDHash(img, crop = null) {
    const canvas = document.createElement("canvas"); canvas.width = 9; canvas.height = 8;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (crop) {
      const sx = Math.round(img.naturalWidth * crop.x);
      const sy = Math.round(img.naturalHeight * crop.y);
      const sw = Math.max(2, Math.round(img.naturalWidth * crop.w));
      const sh = Math.max(2, Math.round(img.naturalHeight * crop.h));
      ctx.drawImage(img, sx, sy, Math.min(sw, img.naturalWidth - sx), Math.min(sh, img.naturalHeight - sy), 0, 0, 9, 8);
    } else ctx.drawImage(img, 0, 0, 9, 8);
    const d = ctx.getImageData(0, 0, 9, 8).data;
    let hash = 0n, bit = 0n;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const i1 = (y * 9 + x) * 4, i2 = (y * 9 + x + 1) * 4;
      const g1 = 0.299 * d[i1] + 0.587 * d[i1 + 1] + 0.114 * d[i1 + 2];
      const g2 = 0.299 * d[i2] + 0.587 * d[i2 + 1] + 0.114 * d[i2 + 2];
      if (g1 > g2) hash |= (1n << bit); bit++;
    }
    return hash;
  }

  function computePHash(img, crop = null) {
    const size = 16, low = 8;
    const canvas = document.createElement("canvas"); canvas.width = size; canvas.height = size;
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
    // Plusieurs cadrages rendent la détection beaucoup plus robuste aux paires
    // « original / cropped » et aux scans dont seules les marges ont changé.
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
    let x = a ^ b, count = 0;
    while (x) { count += Number(x & 1n); x >>= 1n; }
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
    return normalizeTitle(title).replace(/^file:/, "").replace(/\b(cropped|crop|original|uncropped|retouched|edited|version|scan|restored)\b/g, " ")
      .replace(/\([^)]*\)/g, " ").replace(/\b\d{3,}\b/g, " ").replace(/[^a-zà-öø-ÿ]+/g, " ").replace(/\s+/g, " ").trim();
  }
  function tokenSimilarity(a, b) {
    const aa = new Set(titleCore(a).split(" ").filter((x) => x.length > 2)), bb = new Set(titleCore(b).split(" ").filter((x) => x.length > 2));
    if (!aa.size || !bb.size) return 0;
    let common = 0; aa.forEach((t) => { if (bb.has(t)) common++; });
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
    // Deux numéros de planche explicitement différents ne sont fusionnés que
    // si l’image elle-même est pratiquement identique.
    if (markerA && markerB && markerA !== markerB) return p <= 3 && d <= 4;
    if (p <= 4 || d <= 3) return true;
    if (p <= 7 && d <= 8 && similarity >= 0.18) return true;
    if (p <= 10 && d <= 12 && similarity >= 0.52) return true;
    return false;
  }
  function dedupeCandidates(candidates) {
    const out = [];
    for (const candidate of candidates) {
      if (!out.some((kept) => areNearDuplicates(candidate, kept))) out.push(candidate);
    }
    return out;
  }

  function sortByFullScore(a, b) { return (b.fullScore - a.fullScore) || a.title.localeCompare(b.title); }
  function loadRemoteImage(url) { return new Promise((resolve, reject) => { const img = new Image(); img.crossOrigin = "anonymous"; img.decoding = "async"; img.onload = () => resolve(img); img.onerror = () => reject(new Error("Miniature Wikimedia inaccessible")); img.src = url; }); }
  async function mapConcurrent(items, concurrency, fn) { let cursor = 0; await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => { while (cursor < items.length) await fn(items[cursor++]); })); }
  function dilateMask(mask, w, h) { const out = new Uint8Array(mask.length); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const idx = y * w + x; if (!mask[idx]) continue; for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= h) continue; for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx >= 0 && xx < w) out[yy * w + xx] = 1; } } } return out; }
  function componentSizes(mask, w, h) { const seen = new Uint8Array(mask.length), sizes = [], q = new Int32Array(mask.length); for (let start = 0; start < mask.length; start++) { if (!mask[start] || seen[start]) continue; let head = 0, tail = 0, size = 0; q[tail++] = start; seen[start] = 1; while (head < tail) { const idx = q[head++], x = idx % w, y = Math.floor(idx / w); size++; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { if (!dx && !dy) continue; const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue; const ni = ny * w + nx; if (mask[ni] && !seen[ni]) { seen[ni] = 1; q[tail++] = ni; } } } sizes.push(size); } return sizes.sort((a, b) => b - a); }
  function extractPixels(data, w, h, x0, y0, cw, ch) { const out = new Uint8ClampedArray(cw * ch * 4); let oi = 0; for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { const si = ((y0 + y) * w + x0 + x) * 4; out[oi++] = data[si]; out[oi++] = data[si + 1]; out[oi++] = data[si + 2]; out[oi++] = data[si + 3]; } return out; }
  function rgbStats(pixels) { if (!pixels.length) return { std: 0 }; const lum = pixels.map((p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]); const mean = lum.reduce((a, b) => a + b, 0) / lum.length; return { std: Math.sqrt(lum.reduce((s, v) => s + (v - mean) ** 2, 0) / lum.length) }; }
  function rgbToHsl(r, g, b) { r /= 255; g /= 255; b /= 255; const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2; if (max === min) return { h: 0, s: 0, l }; const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min); let h; if (max === r) h = (g - b) / d + (g < b ? 6 : 0); else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; return { h: h / 6, s, l }; }
  function colorDistance(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / 441.67295593; }
  function bellScore(value, center, halfWidth) { return clamp01(1 - Math.abs(value - center) / halfWidth); }
  function median(values) { if (!values.length) return 0; values.sort((a, b) => a - b); const mid = Math.floor(values.length / 2); return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2; }
  function normalizeTitle(title) { return String(title || "").replace(/_/g, " ").replace(/\s+/g, " ").trim().toLocaleLowerCase("en"); }
  function unique(values) { return [...new Set(values)]; }
  function clamp01(v) { return Math.max(0, Math.min(1, v)); }
  function stripHtml(value) { const div = document.createElement("div"); div.innerHTML = String(value || ""); return (div.textContent || "").replace(/\s+/g, " ").trim(); }
  function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[c]); }
  function escapeAttr(value) { return escapeHtml(value); }
  function setPickerStatus(text, isError = false) { picker.status.textContent = text; picker.status.classList.toggle("error", isError); }
  function setPickerProgress(value, visible) { picker.progress.hidden = !visible; picker.progressBar.style.width = `${Math.max(0, Math.min(100, value))}%`; }

  window.FleuretmoiIllustrations = { renderSpeciesIllustration, openIllustrationPicker };
})();
