const STORAGE_KEY = "notebook-notes";
const AUTOSAVE_DELAY = 800;

const noteForm = document.getElementById("note-form");
const noteIdField = document.getElementById("note-id");
const noteTitleField = document.getElementById("note-title");
const noteContentField = document.getElementById("note-content");
const metadataLineEl = document.getElementById("metadata-line");
const saveStatusEl = document.getElementById("save-status");
const deleteBtn = document.getElementById("delete-note");
const pinToggleBtn = document.getElementById("pin-toggle");
const linkSuggestionsEl = document.getElementById("link-suggestions");
const linkedReferencesEl = document.getElementById("linked-references");
const similarNotesListEl = document.getElementById("similar-notes-list");
const similarNotesSection = document.querySelector(".similar-notes");

const paletteEl = document.getElementById("command-palette");
const paletteSearchInput = document.getElementById("palette-search");
const paletteResultsEl = document.getElementById("palette-results");
const homeTrigger = document.getElementById("home-trigger");
const homeOverlay = document.getElementById("home-overlay");
const homeNoteList = document.getElementById("home-note-list");
const homeSortButtons = document.querySelectorAll(".sort-btn");
const homeNewNoteBtn = document.getElementById("home-new-note");
const homeCloseBtn = document.getElementById("home-close");
const homePinnedToggleBtn = document.getElementById("home-pinned-toggle");
const noteStatusSection = document.querySelector(".note-status");
const backlinksSection = document.querySelector(".backlinks");

let notes = loadNotes();
let selectedNoteId = null;
let autosaveTimer = null;
let currentLinkSuggestions = [];
let currentLinkTrigger = null;
let activeSuggestionIndex = -1;
let paletteItems = [];
let paletteActiveIndex = 0;
let pendingDecoration = null;
let pendingDecorationCaret = null;
let homeSortMode = "updated";
let homePinnedOnly = false;
const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "that",
  "with",
  "from",
  "this",
  "have",
  "would",
  "there",
  "their",
  "about",
  "could",
  "into",
  "such",
  "over",
  "were",
  "just",
  "your",
  "them",
  "more",
  "when",
  "like",
  "than",
  "some",
  "other",
  "what",
  "which",
  "while",
  "where",
  "been",
  "also",
  "because",
  "only",
  "every",
  "after",
  "before",
  "through",
  "though",
  "here",
  "they",
  "them",
  "then",
  "there",
  "much",
  "many",
  "well",
  "each",
  "most",
  "very",
  "good",
  "back",
  "even",
  "make",
  "made",
  "time",
  "same",
]);

// Cache expensive derived data (title index, backlinks, token stats, link graphs)
// so features can reuse a single pass over the notes collection.
let derivedData = null;

function invalidateDerivedData() {
  derivedData = null;
}

function getDerivedData() {
  if (!derivedData) {
    derivedData = buildDerivedData();
  }
  return derivedData;
}

function buildDerivedData() {
  // Build shared indexes in one sweep for backlinks, search, and similarity checks.
  const titleIndex = new Map();
  const backlinkMap = new Map();
  const tokenMaps = new Map();
  const docFreq = new Map();
  const linkMaps = new Map();

  notes.forEach((note) => {
    const normalizedTitle = note.title?.trim().toLowerCase();
    if (normalizedTitle) {
      titleIndex.set(normalizedTitle, note);
    }

    const linkMap = new Map();
    parseLinks(note.content).forEach((link) => {
      const key = link.trim().toLowerCase();
      if (!key) return;
      linkMap.set(key, link.trim());
      if (!backlinkMap.has(key)) {
        backlinkMap.set(key, new Map());
      }
      const bucket = backlinkMap.get(key);
      if (!bucket.has(note.id)) {
        bucket.set(note.id, {
          sourceId: note.id,
          sourceTitle: note.title,
        });
      }
    });
    if (linkMap.size) {
      linkMaps.set(note.id, linkMap);
    }

    const tokens = tokenize(`${note.title || ""} ${note.content || ""}`);
    if (tokens.length) {
      const counts = new Map();
      const seen = new Set();
      tokens.forEach((token) => {
        counts.set(token, (counts.get(token) || 0) + 1);
        if (!seen.has(token)) {
          seen.add(token);
          docFreq.set(token, (docFreq.get(token) || 0) + 1);
        }
      });
      tokenMaps.set(note.id, counts);
    }
  });

  return {
    titleIndex,
    backlinkMap,
    tokenMaps,
    docFreq,
    linkMaps,
  };
}

function getCurrentPinState() {
  return !!pinToggleBtn?.classList.contains("is-pinned");
}

function setPinState(pinned) {
  if (!pinToggleBtn) return;
  pinToggleBtn.classList.toggle("is-pinned", pinned);
  pinToggleBtn.setAttribute("aria-pressed", pinned ? "true" : "false");
  pinToggleBtn.setAttribute("aria-label", pinned ? "Unpin note" : "Pin note");
}

const WORD_CHAR_RE = /[a-z0-9]/;

function extractQueryTerms(query) {
  if (!query) return [];
  const raw = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (!raw.length) return [];
  const filtered = raw.filter((token) => token.length > 2 && !STOPWORDS.has(token));
  return filtered.length ? filtered : raw;
}

function isWordBoundary(text, index) {
  if (index <= 0) return true;
  return !WORD_CHAR_RE.test(text[index - 1]);
}

function findWordBoundaryIndex(text, needle) {
  if (!needle) return -1;
  let searchIndex = 0;
  while (searchIndex <= text.length) {
    const idx = text.indexOf(needle, searchIndex);
    if (idx === -1) return -1;
    if (isWordBoundary(text, idx)) {
      return idx;
    }
    searchIndex = idx + 1;
  }
  return -1;
}

function scoreMultiTermMatch(text, tokens, enforceBoundary) {
  if (!tokens.length) return null;
  const ranges = [];
  let total = 0;
  for (const token of tokens) {
    if (!token) continue;
    let idx = enforceBoundary ? findWordBoundaryIndex(text, token) : -1;
    if (idx === -1) {
      idx = text.indexOf(token);
    }
    if (idx === -1) {
      return null;
    }
    const boundaryBonus = isWordBoundary(text, idx) ? 40 : 0;
    ranges.push({ start: idx, end: idx + token.length });
    total += 240 - idx * 1.2 + boundaryBonus;
  }
  return {
    score: total / tokens.length,
    ranges: compressRanges(ranges),
  };
}

function evaluateTitleMatch(title, normalized, tokens, options = {}) {
  if (!normalized) return null;
  const lower = title.toLowerCase();
  const {
    allowLooseSubstring = true,
    allowFuzzy = true,
    requireBoundary = false,
  } = options;
  let bestScore = 0;
  let bestRanges = null;
  let exact = false;

  const consider = (score, ranges) => {
    if (score > bestScore) {
      bestScore = score;
      bestRanges = ranges;
    }
  };

  if (lower === normalized) {
    exact = true;
    consider(620, [{ start: 0, end: title.length }]);
  }

  const boundaryIdx = findWordBoundaryIndex(lower, normalized);
  if (boundaryIdx !== -1) {
    consider(460 - boundaryIdx * 1.5, [
      { start: boundaryIdx, end: boundaryIdx + normalized.length },
    ]);
  }

  if (!requireBoundary && allowLooseSubstring) {
    const idx = lower.indexOf(normalized);
    if (idx !== -1) {
      consider(320 - idx, [{ start: idx, end: idx + normalized.length }]);
    }
  }

  if (tokens.length > 1) {
    const multi = scoreMultiTermMatch(lower, tokens, requireBoundary);
    if (multi) {
      consider(multi.score + 80, multi.ranges);
    }
  }

  if (allowFuzzy) {
    const fuzzy = fuzzyMatch(lower, normalized);
    if (fuzzy) {
      const ranges = compressRanges(
        fuzzy.positions.map((pos) => ({ start: pos, end: pos + 1 }))
      );
      consider(180 + fuzzy.score, ranges);
    }
  }

  return bestScore > 0
    ? {
        score: bestScore,
        ranges: bestRanges,
        exact,
      }
    : null;
}

function getRecencyBoostScore(note) {
  const updatedAt = note.metadata?.updatedAt;
  if (!updatedAt) return 0;
  const updated = new Date(updatedAt).getTime();
  if (Number.isNaN(updated)) return 0;
  const ageDays = (Date.now() - updated) / (1000 * 60 * 60 * 24);
  if (!Number.isFinite(ageDays) || ageDays <= 0) return 35;
  if (ageDays >= 90) return 0;
  return Math.max(0, 35 - ageDays / 2);
}

function isWeakQuery(query) {
  const normalized = query.toLowerCase();
  if (normalized.length < 2) return true;
  if (STOPWORDS.has(normalized) && normalized.length <= 5) return true;
  return false;
}

function loadNotes() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? [];
  } catch (err) {
    console.warn("Failed to parse saved notes", err);
    return [];
  }
}

function persistNotes() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
}

function formatDateShort(dateString) {
  if (!dateString) return "—";
  const date = new Date(dateString);
  const day = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  return `${day} ${time}`;
}

function autoTagsFrom(date) {
  const day = date.toISOString().slice(0, 10);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const weekday = date
    .toLocaleDateString(undefined, { weekday: "short" })
    .toLowerCase();
  return [`#${day}`, `#${time}`, `#${weekday}`];
}

function upsertNote({ id, title, content, pinned }) {
  const now = new Date();
  const existing = notes.find((note) => note.id === id);

  if (existing) {
    existing.title = title;
    existing.content = content;
    existing.metadata.updatedAt = now.toISOString();
    existing.metadata.autoTags = autoTagsFrom(now);
    if (typeof pinned === "boolean") {
      existing.metadata.pinned = pinned;
    }
    selectedNoteId = existing.id;
  } else {
    const newNote = {
      id: id || crypto.randomUUID?.() || Date.now().toString(36),
      title,
      content,
      metadata: {
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        autoTags: autoTagsFrom(now),
        pinned: !!pinned,
      },
    };
    notes.unshift(newNote);
    selectedNoteId = newNote.id;
  }

  invalidateDerivedData();
  persistNotes();
}

function deleteNote(id) {
  notes = notes.filter((note) => note.id !== id);
  invalidateDerivedData();
  persistNotes();
  selectedNoteId = notes[0]?.id ?? null;
  if (selectedNoteId) {
    selectNote(selectedNoteId);
  } else {
    startNewNote();
  }
  refreshHomeIfOpen();
}

function selectNote(id) {
  const note = notes.find((item) => item.id === id);
  if (!note) {
    startNewNote();
    return;
  }

  selectedNoteId = note.id;
  noteIdField.value = note.id;
  noteTitleField.value = note.title;
  renderEditorContent(note.content);
  setCaretOffset(note.content.length);
  setPinState(!!note.metadata?.pinned);
  renderMetadata(note);
  renderBacklinks(note);
  renderSimilarNotes(note);
  saveStatusEl.textContent = "Saved";
  updatePostBodyVisibility();
}

function startNewNote(initialTitle = "", focusTarget = "title") {
  selectedNoteId = null;
  noteIdField.value = "";
  noteTitleField.value = initialTitle;
  renderEditorContent("");
  setCaretOffset(0);
  setPinState(false);
  renderMetadata();
  renderBacklinks();
  renderSimilarNotes();
  saveStatusEl.textContent = "Draft";
  updatePostBodyVisibility();
  if (focusTarget === "content") {
    noteContentField.focus();
    setCaretOffset((noteContentField.dataset.raw || "").length);
  } else {
    noteTitleField.focus();
    const length = noteTitleField.value.length;
    noteTitleField.setSelectionRange(length, length);
  }
}

function renderMetadata(note) {
  if (!note) {
    metadataLineEl.textContent = "No note selected";
    return;
  }
  const { metadata, content } = note;
  const words = content.trim() ? content.trim().split(/\s+/).length : 0;
  metadataLineEl.textContent = `Created ${formatDateShort(
    metadata.createdAt
  )} · Updated ${formatDateShort(metadata.updatedAt)} · ${words} words`;
}

function renderBacklinks(currentNote) {
  linkedReferencesEl.innerHTML = "";

  if (!currentNote) {
    linkedReferencesEl.innerHTML = "<li>No linked references yet.</li>";
    return;
  }

  const references = collectLinkedReferences(currentNote);
  if (!references.length) {
    linkedReferencesEl.innerHTML = "<li>No linked references yet.</li>";
    return;
  }

  references.forEach((ref) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = ref.sourceTitle || "(Untitled)";
    button.addEventListener("click", () => selectNote(ref.sourceId));
    li.appendChild(button);
    linkedReferencesEl.appendChild(li);
  });
}

function renderSimilarNotes(currentNote) {
  if (!similarNotesSection || !similarNotesListEl) return;
  similarNotesListEl.innerHTML = "";
  if (!currentNote) {
    similarNotesSection.classList.add("hidden");
    return;
  }
  const matches = computeSimilarNotes(currentNote);
  if (!matches.length) {
    similarNotesSection.classList.add("hidden");
    return;
  }
  similarNotesSection.classList.remove("hidden");
  matches.forEach((match) => {
    const li = document.createElement("li");
    li.className = "similar-note-item";
    const button = document.createElement("button");
    button.type = "button";
    button.innerHTML = `
      <strong>${escapeHTML(match.note.title || "Untitled")}</strong>
      <div class="similar-note-meta">${escapeHTML(match.summary)}</div>
    `;
    button.addEventListener("click", () => selectNote(match.note.id));
    li.appendChild(button);
    similarNotesListEl.appendChild(li);
  });
}

function collectLinkedReferences(currentNote) {
  // Backlinks are resolved through the cached map: no need to rescan every note.
  if (!currentNote) return [];
  const target = currentNote.title?.trim().toLowerCase();
  if (!target) return [];
  const { backlinkMap } = getDerivedData();
  const bucket = backlinkMap.get(target);
  if (!bucket) return [];
  return Array.from(bucket.values()).filter(
    (ref) => ref.sourceId !== currentNote.id
  );
}

function parseLinks(text) {
  const matches = [];
  if (!text) return matches;
  const regex = /\[\[([^[\]]+)\]\]/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const title = match[1].trim();
    if (title) matches.push(title);
  }
  return matches;
}

function computeSimilarNotes(currentNote) {
  // Similarity blends token overlap (weighted by inverse document frequency)
  // with shared [[links]], all sourced from the cached derived data.
  if (!currentNote) return [];
  const { tokenMaps, docFreq, linkMaps } = getDerivedData();
  const currentTokens = tokenMaps.get(currentNote.id) ?? new Map();
  const currentLinks = linkMaps.get(currentNote.id) ?? new Map();
  const results = [];
  notes.forEach((note) => {
    if (note.id === currentNote.id) return;
    const otherTokens = tokenMaps.get(note.id) ?? new Map();
    let score = 0;
    const sharedWords = [];
    currentTokens.forEach((count, token) => {
      const otherCount = otherTokens.get(token);
      if (!otherCount) return;
      const df = docFreq.get(token) || 1;
      const idf = Math.log(1 + notes.length / (1 + df));
      score += (count + otherCount) * idf;
      if (sharedWords.length < 3) {
        sharedWords.push(token);
      }
    });
    const otherLinks = linkMaps.get(note.id) ?? new Map();
    const sharedLinks = [];
    otherLinks.forEach((label, key) => {
      if (currentLinks.has(key)) {
        sharedLinks.push(label);
      }
    });
    if (sharedLinks.length) {
      score += sharedLinks.length * 3;
    }
    if (score > 0) {
      results.push({
        note,
        score,
        sharedWords,
        sharedLinks,
        summary: formatSimilaritySummary(sharedWords, sharedLinks, note),
      });
    }
  });
  return results.sort((a, b) => b.score - a.score).slice(0, 3);
}

function tokenize(text) {
  if (!text) return [];
  return (text.toLowerCase().match(/[a-z0-9]+/g) || []).filter(
    (word) => word.length > 4 && !STOPWORDS.has(word)
  );
}

function formatSimilaritySummary(words, links, note) {
  const parts = [];
  if (links.length) {
    const formatted = links.slice(0, 2).map((link) => `[[${link}]]`).join(", ");
    parts.push(`Links: ${formatted}`);
  }
  if (words.length) {
    parts.push(`Words: ${words.slice(0, 3).join(", ")}`);
  }
  if (!parts.length) {
    parts.push(`Updated ${formatDateShort(note.metadata?.updatedAt)}`);
  }
  return parts.join(" · ");
}

function renderEditorContent(text) {
  noteContentField.textContent = text || "";
  noteContentField.dataset.raw = text || "";
  queueWikiDecoration();
  updatePostBodyVisibility();
}

function escapeHTML(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function scheduleAutosave() {
  saveStatusEl.textContent = "Typing…";
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    const title = noteTitleField.value.trim();
    const content = noteContentField.dataset.raw || "";
    const pinned = getCurrentPinState();
    if (!title && !content.trim()) {
      saveStatusEl.textContent = "Draft";
      return;
    }
    saveStatusEl.textContent = "Saving…";
    upsertNote({
      id: noteIdField.value || null,
      title: title || "Untitled",
      content,
      pinned,
    });
    noteIdField.value = selectedNoteId;
    const current = notes.find((note) => note.id === selectedNoteId);
    if (current) {
      renderMetadata(current);
      renderBacklinks(current);
      renderSimilarNotes(current);
    }
    refreshHomeIfOpen();
    saveStatusEl.textContent = "Saved";
  }, AUTOSAVE_DELAY);
}

function openNoteByTitle(title, { focusTarget = "content" } = {}) {
  const trimmed = title?.trim();
  if (!trimmed) return;
  const normalized = trimmed.toLowerCase();
  const { titleIndex } = getDerivedData();
  const target = titleIndex.get(normalized);
  if (target) {
    selectNote(target.id);
    if (focusTarget === "content") {
      noteContentField.focus();
      setCaretOffset((noteContentField.dataset.raw || "").length);
    } else if (focusTarget === "title") {
      noteTitleField.focus();
      const length = noteTitleField.value.length;
      noteTitleField.setSelectionRange(length, length);
    }
  } else {
    startNewNote(trimmed, focusTarget);
  }
}

function computeLinkTrigger() {
  const cursor = getCaretOffset();
  const value = noteContentField.dataset.raw || "";
  const uptoCursor = value.slice(0, cursor);
  const openIndex = uptoCursor.lastIndexOf("[[");
  if (openIndex === -1) return null;
  const afterOpen = value.slice(openIndex + 2, cursor);
  if (afterOpen.includes("]]") || afterOpen.includes("[[")) return null;
  if (afterOpen.includes("\n")) return null;
  return {
    start: openIndex,
    cursor,
    query: afterOpen,
  };
}

function buildLinkSuggestions(trigger) {
  const query = trigger.query.trim();
  if (!query) {
    return getRecentNotes(5).map((note) => ({
      title: note.title || "Untitled",
      subtitle: `Updated ${formatDateShort(note.metadata?.updatedAt)}`,
      kind: "note",
    }));
  }

  const normalized = query.toLowerCase();
  const tokens = extractQueryTerms(query);
  const allowFuzzy = normalized.length >= 3;
  let hasExact = false;
  const candidates = [];
  const matchOptions = {
    allowLooseSubstring: normalized.length >= 2,
    allowFuzzy,
    requireBoundary: tokens.length > 1,
  };

  notes.forEach((note) => {
    const title = (note.title || "Untitled").trim();
    if (!title) return;
    const match = evaluateTitleMatch(title, normalized, tokens, matchOptions);
    if (match) {
      if (match.exact) hasExact = true;
      const recencyBonus = getRecencyBoostScore(note);
      const totalScore = match.score + recencyBonus;
      candidates.push({
        note,
        score: totalScore,
        title,
        titleHTML: match.ranges ? highlightSnippet(title, match.ranges) : null,
      });
    }
  });

  const suggestions = candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map((entry) => ({
      title: entry.title,
      titleHTML: entry.titleHTML || undefined,
      subtitle: `Updated ${formatDateShort(entry.note.metadata?.updatedAt)}`,
      kind: "note",
    }));

  if (!hasExact) {
    suggestions.push({
      title: query,
      subtitle: "Create new link",
      kind: "create",
    });
  }

  return suggestions;
}

function renderLinkSuggestions() {
  linkSuggestionsEl.innerHTML = "";
  if (!currentLinkSuggestions.length) {
    linkSuggestionsEl.classList.add("hidden");
    return;
  }

  currentLinkSuggestions.forEach((suggestion, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `link-suggestion ${index === activeSuggestionIndex ? "active" : ""}`;
    const titleHTML = suggestion.titleHTML || escapeHTML(suggestion.title);
    const subtitleHTML =
      suggestion.subtitleHTML ??
      (suggestion.subtitle ? escapeHTML(suggestion.subtitle) : "");
    button.innerHTML = `<strong>${titleHTML}</strong><span>${subtitleHTML}</span>`;
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => applyLinkSuggestion(suggestion.title));
    linkSuggestionsEl.appendChild(button);
  });
  linkSuggestionsEl.classList.remove("hidden");
}

function hideLinkSuggestions() {
  currentLinkSuggestions = [];
  activeSuggestionIndex = -1;
  currentLinkTrigger = null;
  linkSuggestionsEl.classList.add("hidden");
  linkSuggestionsEl.innerHTML = "";
}

function applyLinkSuggestion(title) {
  if (!currentLinkTrigger) return;
  const raw = noteContentField.dataset.raw || "";
  const before = raw.slice(0, currentLinkTrigger.start);
  const after = raw.slice(currentLinkTrigger.cursor);
  const replacement = `[[${title}]]`;
  const updated = `${before}${replacement}${after}`;
  renderEditorContent(updated);
  const newCursor = before.length + replacement.length;
  setCaretOffset(newCursor);
  hideLinkSuggestions();
  scheduleAutosave();
}

function handleLinkAutocomplete(eventType) {
  if (eventType === "blur") {
    setTimeout(() => hideLinkSuggestions(), 120);
    return;
  }

  const trigger = computeLinkTrigger();
  if (!trigger) {
    hideLinkSuggestions();
    return;
  }

  const suggestions = buildLinkSuggestions(trigger);
  if (!suggestions.length) {
    hideLinkSuggestions();
    return;
  }

  currentLinkTrigger = trigger;
  currentLinkSuggestions = suggestions;
  activeSuggestionIndex = 0;
  renderLinkSuggestions();
}

function openCommandPalette(initialQuery = "") {
  paletteEl.classList.remove("hidden");
  paletteSearchInput.value = initialQuery;
  renderPaletteResults(initialQuery);
  paletteSearchInput.focus();
}

function closeCommandPalette() {
  paletteEl.classList.add("hidden");
  paletteSearchInput.value = "";
  paletteResultsEl.innerHTML = "";
  paletteItems = [];
  paletteActiveIndex = 0;
}

function renderPaletteResults(query = "") {
  const trimmed = query.trim();
  paletteResultsEl.innerHTML = "";
  paletteItems = [];
  paletteActiveIndex = 0;

  if (!trimmed) {
    paletteItems.push({
      kind: "new",
      label: "New note",
      detailHTML: "Start from scratch",
    });
    getRecentNotes().forEach((note) => {
      const label = note.title || "Untitled";
      paletteItems.push({
        kind: "note",
        id: note.id,
        label,
        detailHTML: escapeHTML(`Updated ${formatDateShort(note.metadata?.updatedAt)}`),
      });
    });
  } else {
    paletteItems.push({
      kind: "create",
      title: trimmed,
      label: `Create “${trimmed}”`,
      detailHTML: "New note",
    });
    const usableQuery = !isWeakQuery(trimmed);
    if (usableQuery) {
      const results = searchNotes(trimmed);
      results.forEach((result) => {
        const fallbackDetail = result.updatedAt
          ? escapeHTML(`Updated ${formatDateShort(result.updatedAt)}`)
          : "";
        paletteItems.push({
          kind: "note",
          id: result.id,
          label: result.title,
          detailHTML: result.snippetHTML || fallbackDetail,
        });
      });
      if (!results.length) {
        const li = document.createElement("li");
        li.className = "palette-item";
        li.innerHTML = "<span>No matches yet.</span>";
        paletteResultsEl.appendChild(li);
      }
    } else {
      const li = document.createElement("li");
      li.className = "palette-item";
      li.innerHTML = "<span>Type a more specific query to search notes.</span>";
      paletteResultsEl.appendChild(li);
    }
  }

  paletteItems.forEach((item, index) => {
    const li = document.createElement("li");
    li.className = `palette-item ${index === paletteActiveIndex ? "active" : ""}`;
    li.dataset.index = index.toString();
    const label = escapeHTML(item.label);
    const detail =
      item.kind === "note"
        ? item.detailHTML ?? ""
        : escapeHTML(item.detailHTML ?? "");
    li.innerHTML = `<strong>${label}</strong><span>${detail}</span>`;
    li.addEventListener("mouseenter", () => {
      paletteActiveIndex = index;
      updatePaletteActive();
    });
    li.addEventListener("mousedown", (event) => event.preventDefault());
    li.addEventListener("click", () => selectPaletteItem(index));
    paletteResultsEl.appendChild(li);
  });
}

function updatePaletteActive() {
  const items = paletteResultsEl.querySelectorAll(".palette-item");
  items.forEach((item, idx) => {
    if (idx === paletteActiveIndex) {
      item.classList.add("active");
    } else {
      item.classList.remove("active");
    }
  });
  const active = items[paletteActiveIndex];
  if (active) active.scrollIntoView({ block: "nearest" });
}

function selectPaletteItem(index) {
  const item = paletteItems[index];
  if (!item) return;

  if (item.kind === "note") {
    closeCommandPalette();
    selectNote(item.id);
    return;
  }

  if (item.kind === "new") {
    closeCommandPalette();
    startNewNote();
    return;
  }

  if (item.kind === "create") {
    closeCommandPalette();
    startNewNote(item.title);
  }
}

function openHome() {
  if (!homeOverlay) return;
  renderHomeList();
  homeOverlay.classList.remove("hidden");
}

function closeHome() {
  if (!homeOverlay) return;
  homeOverlay.classList.add("hidden");
}

function renderHomeList() {
  if (!homeNoteList) return;
  updateHomeControls();
  homeNoteList.innerHTML = "";
  const sorted = getNotesForHome();
  const list = homePinnedOnly
    ? sorted.filter((note) => note.metadata?.pinned)
    : sorted;
  if (!list.length) {
    const empty = document.createElement("li");
    empty.textContent = notes.length
      ? homePinnedOnly
        ? "No pinned notes yet."
        : "No notes yet. Start fresh to capture something."
      : "No notes yet. Start fresh to capture something.";
    homeNoteList.appendChild(empty);
    return;
  }

  list.forEach((note) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.innerHTML = `
      <strong>${escapeHTML(note.title || "Untitled")}</strong>
      <div class="home-note-meta">
        <span>Updated ${formatDateShort(note.metadata?.updatedAt)}</span>
        <span>Created ${formatDateShort(note.metadata?.createdAt)}</span>
      </div>
      ${renderHomeSnippet(note.content)}
    `;
    button.addEventListener("click", () => {
      closeHome();
      selectNote(note.id);
    });
    li.appendChild(button);
    homeNoteList.appendChild(li);
  });
}

function renderHomeSnippet(content = "") {
  if (!content) return "";
  const snippet = content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length);
  if (!snippet) return "";
  const trimmed = snippet.length > 140 ? `${snippet.slice(0, 137)}…` : snippet;
  return `<p class="home-note-snippet">${escapeHTML(trimmed)}</p>`;
}

function getNotesForHome() {
  const sorted = [...notes];
  if (homeSortMode === "alpha") {
    sorted.sort((a, b) =>
      (a.title || "Untitled").localeCompare(b.title || "Untitled", undefined, {
        sensitivity: "base",
      })
    );
  } else {
    sorted.sort(
      (a, b) =>
        new Date(b.metadata?.updatedAt ?? 0) - new Date(a.metadata?.updatedAt ?? 0)
    );
  }
  return sorted;
}

function updateHomeControls() {
  homeSortButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.sort === homeSortMode);
  });
  if (homePinnedToggleBtn) {
    homePinnedToggleBtn.classList.toggle("active", homePinnedOnly);
  }
}

function refreshHomeIfOpen() {
  if (!homeOverlay || homeOverlay.classList.contains("hidden")) return;
  renderHomeList();
}

noteForm.addEventListener("submit", (event) => {
  event.preventDefault();
});

deleteBtn.addEventListener("click", () => {
  if (!selectedNoteId) return;
  if (confirm("Delete this note?")) {
    deleteNote(selectedNoteId);
  }
});

noteContentField.addEventListener("input", () => {
  noteContentField.dataset.raw = normalizeText(noteContentField.innerText);
  scheduleAutosave();
  handleLinkAutocomplete("input");
  queueWikiDecoration();
  updatePostBodyVisibility();
});

noteContentField.addEventListener("blur", () => handleLinkAutocomplete("blur"));

noteContentField.addEventListener("keydown", (event) => {
  if (linkSuggestionsEl.classList.contains("hidden")) return;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    activeSuggestionIndex =
      (activeSuggestionIndex + 1) % currentLinkSuggestions.length;
    renderLinkSuggestions();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    activeSuggestionIndex =
      (activeSuggestionIndex - 1 + currentLinkSuggestions.length) %
      currentLinkSuggestions.length;
    renderLinkSuggestions();
  } else if (event.key === "Enter") {
    event.preventDefault();
    const suggestion = currentLinkSuggestions[activeSuggestionIndex];
    if (suggestion) applyLinkSuggestion(suggestion.title);
  } else if (event.key === "Escape") {
    event.preventDefault();
    hideLinkSuggestions();
  }
});

noteContentField.addEventListener("click", (event) => {
  const link = event.target.closest(".wiki-link");
  if (link && !event.altKey) {
    event.preventDefault();
    const title = getLinkTitleFromElement(link);
    openNoteByTitle(title, { focusTarget: "content" });
    return;
  }
  handleLinkAutocomplete("click");
});

noteTitleField.addEventListener("input", scheduleAutosave);

pinToggleBtn?.addEventListener("click", () => {
  const next = !getCurrentPinState();
  setPinState(next);
  if (selectedNoteId) {
    const note = notes.find((item) => item.id === selectedNoteId);
    if (note) {
      note.metadata = note.metadata || {};
      note.metadata.pinned = next;
      persistNotes();
      refreshHomeIfOpen();
    }
  } else {
    scheduleAutosave();
  }
});

homeTrigger?.addEventListener("click", openHome);
homeCloseBtn?.addEventListener("click", closeHome);
homeOverlay?.addEventListener("click", (event) => {
  if (event.target === homeOverlay) {
    closeHome();
  }
});
homeNewNoteBtn?.addEventListener("click", () => {
  closeHome();
  startNewNote();
});
homeSortButtons.forEach((button) => {
  button.addEventListener("click", () => {
    homeSortMode = button.dataset.sort === "alpha" ? "alpha" : "updated";
    renderHomeList();
  });
});

homePinnedToggleBtn?.addEventListener("click", () => {
  homePinnedOnly = !homePinnedOnly;
  renderHomeList();
});

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (paletteEl.classList.contains("hidden")) {
      openCommandPalette("");
    } else {
      closeCommandPalette();
    }
  } else if (event.key === "Escape") {
    if (!homeOverlay?.classList.contains("hidden")) {
      closeHome();
    } else if (!paletteEl.classList.contains("hidden")) {
      closeCommandPalette();
    }
  } else if (!paletteEl.classList.contains("hidden")) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      paletteActiveIndex = Math.min(
        paletteItems.length - 1,
        paletteActiveIndex + 1
      );
      updatePaletteActive();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      paletteActiveIndex = Math.max(0, paletteActiveIndex - 1);
      updatePaletteActive();
    } else if (event.key === "Enter") {
      event.preventDefault();
      selectPaletteItem(paletteActiveIndex);
    }
  }
});

paletteSearchInput.addEventListener("input", (event) => {
  renderPaletteResults(event.target.value);
});

paletteSearchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    selectPaletteItem(paletteActiveIndex);
  }
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./service-worker.js")
      .catch((error) => console.warn("SW registration failed", error));
  });
}

if (selectedNoteId) {
  selectNote(selectedNoteId);
} else {
  startNewNote();
}

function getCaretOffset() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return (noteContentField.dataset.raw || "").length;
  }
  const range = selection.getRangeAt(0);
  const preRange = range.cloneRange();
  preRange.selectNodeContents(noteContentField);
  preRange.setEnd(range.endContainer, range.endOffset);
  return normalizeText(preRange.toString()).length;
}

function setCaretOffset(offset) {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  let current = 0;
  const target = Math.max(0, offset);
  const walker = document.createTreeWalker(
    noteContentField,
    NodeFilter.SHOW_TEXT,
    null
  );
  let node;
  while ((node = walker.nextNode())) {
    const length = node.textContent.length;
    const next = current + length;
    if (target <= next) {
      range.setStart(node, Math.max(0, target - current));
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    current = next;
  }
  range.selectNodeContents(noteContentField);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function normalizeText(value) {
  return value.replace(/\r/g, "").replace(/\u00a0/g, " ");
}

function updatePostBodyVisibility() {
  const empty = !(noteContentField.dataset.raw || "").trim();
  [noteStatusSection, backlinksSection].forEach((section) => {
    if (!section) return;
    section.classList.toggle("hidden", empty);
  });
}

function queueWikiDecoration() {
  const selection = window.getSelection();
  if (selection && selection.rangeCount) {
    pendingDecorationCaret = getCaretOffset();
  } else {
    pendingDecorationCaret = null;
  }
  if (pendingDecoration) cancelAnimationFrame(pendingDecoration);
  pendingDecoration = requestAnimationFrame(() => {
    pendingDecoration = null;
    decorateWikiLinks();
  });
}

function decorateWikiLinks() {
  if (!noteContentField.isConnected) return;
  const caretOffset = pendingDecorationCaret;
  pendingDecorationCaret = null;
  cleanupBrokenWikiSpans();
  const walker = document.createTreeWalker(
    noteContentField,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (!node.textContent.includes("[[")) return NodeFilter.FILTER_REJECT;
        if (node.parentElement?.closest(".wiki-link")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );
  const nodes = [];
  let textNode;
  while ((textNode = walker.nextNode())) {
    nodes.push(textNode);
  }
  const changed = nodes.some((node) => wrapWikiMatches(node));
  if (changed && caretOffset !== null) {
    setCaretOffset(caretOffset);
  }
}

function cleanupBrokenWikiSpans() {
  const spans = Array.from(noteContentField.querySelectorAll(".wiki-link"));
  spans.forEach((span) => {
    const text = span.textContent;
    if (/^\[\[[^[\]]+\]\]$/.test(text)) {
      const title = text.slice(2, -2).trim();
      span.dataset.linkTitle = encodeURIComponent(title);
      span.classList.toggle("missing", !noteExists(title));
      return;
    }
    const replacement = document.createTextNode(text);
    span.replaceWith(replacement);
  });
}

function wrapWikiMatches(textNode) {
  const text = textNode.textContent;
  const regex = /\[\[([^[\]]+)\]\]/g;
  let match;
  let index = 0;
  let hasMatch = false;
  const fragment = document.createDocumentFragment();
  while ((match = regex.exec(text)) !== null) {
    hasMatch = true;
    if (match.index > index) {
      fragment.appendChild(document.createTextNode(text.slice(index, match.index)));
    }
    const inner = match[1].trim();
    const span = document.createElement("span");
    span.className = `wiki-link${noteExists(inner) ? "" : " missing"}`;
    span.dataset.linkTitle = encodeURIComponent(inner);
    span.textContent = match[0];
    fragment.appendChild(span);
    index = match.index + match[0].length;
  }
  if (!hasMatch) return false;
  if (index < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(index)));
  }
  textNode.replaceWith(fragment);
  return true;
}

function noteExists(title) {
  const normalized = title?.trim().toLowerCase();
  if (!normalized) return false;
  const { titleIndex } = getDerivedData();
  return titleIndex.has(normalized);
}

function getLinkTitleFromElement(element) {
  if (!element) return "";
  const encoded = element.dataset.linkTitle;
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      // fall back to text content
    }
  }
  return element.textContent.replace(/\[|\]/g, "").trim();
}

function getRecentNotes(limit = 6) {
  return [...notes]
    .sort(
      (a, b) =>
        new Date(b.metadata?.updatedAt ?? 0) -
        new Date(a.metadata?.updatedAt ?? 0)
    )
    .slice(0, limit);
}

function searchNotes(query, options = {}) {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const normalizedQuery = trimmed.toLowerCase();
  const queryTokens = extractQueryTerms(trimmed);
  const { limit = 10, titleOnly = false } = options;
  const results = [];

  notes.forEach((note) => {
    const title = note.title || "Untitled";
    const content = note.content || "";
    let bestScore = 0;
    let snippetInfo = null;

    const titleMatch = title
      ? evaluateTitleMatch(title, normalizedQuery, queryTokens, {
          allowLooseSubstring: true,
          allowFuzzy: normalizedQuery.length >= 3,
          requireBoundary: false,
        })
      : null;
    if (titleMatch) {
      const snippetHTML = highlightSnippet(title, titleMatch.ranges || []);
      const score = titleMatch.score + 60;
      bestScore = score;
      snippetInfo = { snippet: title, snippetHTML };
    } else if (titleOnly) {
      return;
    }

    if (!titleOnly) {
      const wikiMatch = findWikiLinkMatch(content, trimmed);
      if (wikiMatch && wikiMatch.score >= bestScore) {
        const snippetHTML = highlightSnippet(wikiMatch.snippet, wikiMatch.ranges);
        bestScore = wikiMatch.score;
        snippetInfo = { snippet: wikiMatch.snippet, snippetHTML };
      }

      const substringMatch = findContentSubstringMatch(content, normalizedQuery);
      if (substringMatch && substringMatch.score >= bestScore) {
        const snippetHTML = highlightSnippet(
          substringMatch.snippet,
          substringMatch.ranges
        );
        bestScore = substringMatch.score;
        snippetInfo = {
          snippet: substringMatch.snippet,
          snippetHTML,
        };
      } else if (queryTokens.length > 1) {
        const tokenMatch = findContentTokenMatch(content, queryTokens);
        if (tokenMatch && tokenMatch.score >= bestScore) {
          const snippetHTML = highlightSnippet(tokenMatch.snippet, tokenMatch.ranges);
          bestScore = tokenMatch.score;
          snippetInfo = {
            snippet: tokenMatch.snippet,
            snippetHTML,
          };
        }
      }
    }

    if (bestScore > 0 && snippetInfo) {
      results.push({
        note,
        snippet: snippetInfo.snippet,
        snippetHTML: snippetInfo.snippetHTML,
        score: bestScore,
      });
    }
  });

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => ({
      id: entry.note.id,
      title: entry.note.title || "Untitled",
      snippet: entry.snippet,
      snippetHTML: entry.snippetHTML,
      updatedAt: entry.note.metadata?.updatedAt,
    }));
}

function fuzzyMatch(text, query) {
  if (!text || !query) return null;
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  let lastIndex = -1;
  const positions = [];

  for (const char of needle) {
    const found = hay.indexOf(char, lastIndex + 1);
    if (found === -1) return null;
    positions.push(found);
    lastIndex = found;
  }

  const exactIndex = hay.indexOf(needle);
  if (exactIndex !== -1) {
    const contiguousPositions = [];
    for (let i = 0; i < needle.length; i++) {
      contiguousPositions.push(exactIndex + i);
    }
    const exactScore = 140 - exactIndex;
    return { score: exactScore, positions: contiguousPositions };
  }

  let score = 80;
  for (let i = 1; i < positions.length; i++) {
    const gap = positions[i] - positions[i - 1] - 1;
    if (gap > 0) score -= gap * 4;
  }
  score -= positions[0];
  return { score: Math.max(score, 1), positions };
}

function extractSnippet(text, positions, radius = 48) {
  if (!text) {
    return { snippet: "", ranges: [] };
  }
  if (!positions || !positions.length) {
    const snippet = text.slice(0, Math.min(radius * 2, text.length));
    return { snippet, ranges: [] };
  }

  const sorted = [...positions].sort((a, b) => a - b);
  const start = Math.max(sorted[0] - radius, 0);
  const end = Math.min(text.length, sorted[sorted.length - 1] + radius + 1);
  const core = text.slice(start, end);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  const snippet = `${prefix}${core}${suffix}`;
  const ranges = compressRanges(
    sorted.map((pos) => ({
      start: pos - start + prefix.length,
      end: pos - start + 1 + prefix.length,
    }))
  );
  return { snippet, ranges };
}

function highlightSnippet(snippet, ranges = []) {
  if (!snippet) return "";
  if (!ranges.length) return escapeHTML(snippet);

  const parts = [];
  let cursor = 0;
  ranges.forEach((range) => {
    const start = Math.max(range.start, 0);
    const end = Math.min(range.end, snippet.length);
    if (start > cursor) {
      parts.push(escapeHTML(snippet.slice(cursor, start)));
    }
    parts.push(
      `<span class="snippet-match">${escapeHTML(snippet.slice(start, end))}</span>`
    );
    cursor = end;
  });
  if (cursor < snippet.length) {
    parts.push(escapeHTML(snippet.slice(cursor)));
  }
  return parts.join("");
}

function compressRanges(ranges) {
  if (!ranges.length) return [];
  const sorted = ranges
    .map((range) => ({
      start: Math.max(0, range.start),
      end: Math.max(range.start, range.end),
    }))
    .sort((a, b) => a.start - b.start);
  const merged = [];
  let current = { ...sorted[0] };
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    if (next.start <= current.end) {
      current.end = Math.max(current.end, next.end);
    } else {
      merged.push(current);
      current = { ...next };
    }
  }
  merged.push(current);
  return merged;
}

function findWikiLinkMatch(content, query) {
  if (!content || !query) return null;
  const normalized = query.toLowerCase();
  if (!normalized) return null;
  const tokens = extractQueryTerms(query);
  const regex = /\[\[([^[\]]+)\]\]/g;
  let match;
  let best = null;

  while ((match = regex.exec(content)) !== null) {
    const title = match[1].trim();
    if (!title) continue;
    const evaluation = evaluateTitleMatch(title, normalized, tokens, {
      allowLooseSubstring: true,
      allowFuzzy: normalized.length >= 4,
      requireBoundary: tokens.length > 1,
    });
    if (!evaluation) continue;
    const ranges = (evaluation.ranges || []).map((range) => ({
      start: range.start + 2,
      end: range.end + 2,
    }));
    const snippet = `[[${title}]]`;
    const score = evaluation.score + 40;
    if (!best || score > best.score) {
      best = { snippet, ranges, score };
    }
  }

  return best;
}

function findContentSubstringMatch(content, normalized) {
  if (!content || !normalized) return null;
  const lower = content.toLowerCase();
  const idx = lower.indexOf(normalized);
  if (idx === -1) return null;
  const positions = [];
  for (let i = 0; i < normalized.length; i++) {
    positions.push(idx + i);
  }
  const snippet = extractSnippet(content, positions);
  return {
    snippet: snippet.snippet,
    ranges: snippet.ranges,
    score: Math.max(40, 180 - idx * 0.5),
  };
}

function findContentTokenMatch(content, tokens) {
  if (!content || !tokens.length) return null;
  const lower = content.toLowerCase();
  const uniqueTokens = Array.from(new Set(tokens));
  const positions = [];
  let earliest = null;
  for (const token of uniqueTokens) {
    const idx = lower.indexOf(token);
    if (idx === -1) return null;
    if (earliest === null || idx < earliest) earliest = idx;
    for (let i = 0; i < token.length; i++) {
      positions.push(idx + i);
    }
  }
  if (!positions.length) return null;
  const snippet = extractSnippet(content, positions);
  return {
    snippet: snippet.snippet,
    ranges: snippet.ranges,
    score: Math.max(30, 130 - (earliest ?? 0) * 0.4 + uniqueTokens.length * 8),
  };
}
