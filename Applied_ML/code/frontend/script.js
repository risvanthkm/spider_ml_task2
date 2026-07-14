const API_URL = "http://127.0.0.1:8000/chat"; // Change to your backend endpoint

// There's only one route on the backend (/chat), so there's no dedicated
// /health endpoint to poll. As a best-effort substitute we send a lightweight
// OPTIONS request to /chat on a timer — we don't care what it replies with,
// only whether the request reaches the server at all. If your server has
// CORS locked down tightly, an OPTIONS preflight can fail even when the
// server is actually up; adding a real GET /health route server-side would
// make this fully reliable.
const HEALTH_CHECK_INTERVAL_MS = 30000;
const HEALTH_CHECK_TIMEOUT_MS = 6000;

// Where the Source Ledger loads your RAG's source CSV from. Point this at
// your data folder — e.g. "./data/sources.csv" — and drop the file there.
const CSV_URL = "./data/sources.csv";

// ---------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------

const chatWindow = document.getElementById("chat-window");
const chatInner = document.getElementById("chat-inner");
const input = document.getElementById("user-input");
const sendBtn = document.getElementById("send-btn");
const toastEl = document.getElementById("toast");

const themeToggle = document.getElementById("theme-toggle");
const themeLabel = document.getElementById("theme-label");
const exportBtn = document.getElementById("export-btn");
const clearBtn = document.getElementById("clear-btn");

const healthPill = document.getElementById("health-pill");
const healthLabel = document.getElementById("health-label");
const pulseStrip = document.getElementById("pulse-strip");
const pulsePath = document.getElementById("pulse-path");

const csvToggleBtn = document.getElementById("csv-toggle-btn");
const csvCloseBtn = document.getElementById("csv-close-btn");
const csvPanel = document.getElementById("csv-panel");
const csvResizeHandle = document.getElementById("csv-resize-handle");
const csvSubtitle = document.getElementById("csv-subtitle");
const csvColgroup = document.getElementById("csv-colgroup");
const csvThead = document.getElementById("csv-thead");
const csvTbody = document.getElementById("csv-tbody");
const csvTableWrap = document.getElementById("csv-table-wrap");
const csvEmpty = document.getElementById("csv-empty");
const csvRowInput = document.getElementById("csv-row-input");
const csvJumpBtn = document.getElementById("csv-jump-btn");
const csvFilterInput = document.getElementById("csv-filter-input");

// Keeps a plain-text record of the conversation so we can export it later.
// This only lives in memory for the current session — nothing is written
// to disk or browser storage.
let conversation = [];

// Snapshot of the welcome bubble so "Clear conversation" can restore it.
const WELCOME_HTML = chatInner.innerHTML;

// Shared copy-icon markup, reused on message bubbles and Source Ledger rows
const COPY_ICON_SVG = `
    <svg viewBox="0 0 16 16" fill="none">
        <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.3"/>
        <path d="M3.5 10.5V3.5A1 1 0 0 1 4.5 2.5H10.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
    </svg>
`;

const WARNING_ICON_SVG = `
    <svg viewBox="0 0 16 16" fill="none">
        <path d="M8 1.5 15 14H1L8 1.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
        <path d="M8 6.3V9.3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
        <circle cx="8" cy="11.6" r=".9" fill="currentColor"/>
    </svg>
`;

// ---------------------------------------------------------------
// Theme (light / dark)
// ---------------------------------------------------------------

function initTheme() {
    const prefersDark = window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.setAttribute("data-theme", prefersDark ? "dark" : "light");
    updateThemeLabel();
}

function updateThemeLabel() {
    const current = document.documentElement.getAttribute("data-theme");
    themeLabel.textContent = current === "dark" ? "Light mode" : "Dark mode";
}

themeToggle.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme");
    document.documentElement.setAttribute("data-theme", current === "dark" ? "light" : "dark");
    updateThemeLabel();
});

// ---------------------------------------------------------------
// Backend health check
// ---------------------------------------------------------------

function setHealthStatus(status) {
    // status is one of "online" | "offline" | "checking"
    healthPill.classList.remove("online", "offline", "checking");
    healthPill.classList.add(status);

    pulseStrip.classList.remove("online", "offline", "checking");
    pulseStrip.classList.add(status);
    pulsePath.setAttribute("d", status === "offline" ? HEALTH_FLAT_PATH : HEALTH_PULSE_PATH);

    const labels = {
        online: "Backend online",
        offline: "Backend unreachable",
        checking: "Checking…"
    };

    healthLabel.textContent = labels[status];
    healthPill.title = `Backend connection status — ${labels[status]}`;
}

async function checkBackendHealth() {
    setHealthStatus("checking");

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

    try {
        await fetch(API_URL, { method: "OPTIONS", signal: controller.signal });
        setHealthStatus("online");
    } catch (err) {
        setHealthStatus("offline");
    } finally {
        clearTimeout(timeoutId);
    }
}

// Header pulse-strip waveform (two repeats of the same unit, tiled 0-600
// and 600-1200, so translateX(-50%) loops seamlessly).
const HEALTH_PULSE_PATH =
    "M0,20 L60,20 L75,9 L90,20 L150,20 L163,33 L176,3 L189,33 L202,20 L260,20 L278,10 L296,20 L600,20 " +
    "L660,20 L675,9 L690,20 L750,20 L763,33 L776,3 L789,33 L802,20 L860,20 L878,10 L896,20 L1200,20";
const HEALTH_FLAT_PATH = "M0,20 L1200,20";

// ---------------------------------------------------------------
// Confidence bar — a plain progress bar, colored by band:
// >=80% green, 50-79% amber, <50% red.
// ---------------------------------------------------------------

function getConfidenceBand(confidencePct) {
    if (confidencePct >= 80) return "good";
    if (confidencePct >= 50) return "warn";
    return "bad";
}

const BAND_DESCRIPTOR = { good: "steady", warn: "moderate", bad: "unstable" };

function buildConfidenceMeter(confidencePct) {
    const band = getConfidenceBand(confidencePct);

    const wrap = document.createElement("div");
    wrap.className = "progress-bar-track";
    wrap.innerHTML = `<div class="progress-bar-fill band-${band}" style="width:0%;"></div>`;

    const fill = wrap.querySelector(".progress-bar-fill");
    return { wrap, fill, band };
}

// ---------------------------------------------------------------
// Toast + copy to clipboard
// ---------------------------------------------------------------

let toastTimer;

function showToast(message) {
    toastEl.textContent = message;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200);
}

async function copyToClipboard(text) {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
        } else {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            document.body.removeChild(ta);
        }
        showToast("Copied to clipboard");
    } catch (err) {
        showToast("Could not copy — please copy manually");
        console.error(err);
    }
}

function buildMetaRow(copyText, timeLabel) {
    const meta = document.createElement("div");
    meta.className = "msg-meta";

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "copy-btn";
    copyBtn.innerHTML = `${COPY_ICON_SVG} Copy`;
    copyBtn.addEventListener("click", () => copyToClipboard(copyText));

    const time = document.createElement("span");
    time.className = "msg-time";
    time.textContent = timeLabel;

    meta.appendChild(copyBtn);
    meta.appendChild(time);
    return meta;
}

function nowLabel() {
    return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ---------------------------------------------------------------
// Sending / rendering messages
// ---------------------------------------------------------------

sendBtn.addEventListener("click", sendMessage);

input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendMessage();
});

async function sendMessage() {

    const question = input.value.trim();

    if (!question) return;
    addMessage(question, "user");
    input.value = "";

    sendBtn.classList.add("sending");
    setTimeout(() => sendBtn.classList.remove("sending"), 350);

    const typing = addTypingIndicator();

    try {
        const response = await fetch(API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: question })
        });

        if (!response.ok) {
            throw new Error("Server Error");
        }

        const data = await response.json();
        typing.remove();
        addAssistantMessage(data);

    } catch (err) {
        typing.remove();
        addMessage(
            "Unable to connect to the backend. Please try again.",
            "assistant"
        );
        setHealthStatus("offline");
        console.error(err);
    }
}

function addMessage(text, sender) {

    const wrapper = document.createElement("div");
    wrapper.className = `message ${sender}`;
    const bubble = document.createElement("div");
    bubble.className = "bubble";

    bubble.innerHTML = `<p>${escapeHTML(text)}</p>`;

    const timeLabel = nowLabel();
    bubble.appendChild(buildMetaRow(text, timeLabel));

    wrapper.appendChild(bubble);
    chatInner.appendChild(wrapper);
    scrollBottom();

    if (sender === "user") {
        conversation.push({ role: "user", text, time: timeLabel });
    }
}

function addAssistantMessage(data) {
    const wrapper = document.createElement("div");
    wrapper.className = "message assistant";

    const bubble = document.createElement("div");
    bubble.className = "bubble";

    const confidence = Math.round((data.confidence || 0) * 100);

    const rawHtml = marked.parse(data.content || "");
    const safeHtml = window.DOMPurify ? DOMPurify.sanitize(rawHtml) : rawHtml;

    bubble.innerHTML = safeHtml;

    const card = document.createElement("div");
    card.className = "confidence-card";

    const band = getConfidenceBand(confidence);
    card.innerHTML = `
        <div class="confidence-title">
            <svg viewBox="0 0 16 16" fill="none" class="shield-icon"><path d="M8 1.5 13.5 3.5V7.5C13.5 11 11.2 13.5 8 14.5C4.8 13.5 2.5 11 2.5 7.5V3.5L8 1.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
            <span class="confidence-label">Confidence</span>
            <span class="confidence-value">${confidence}%</span>
            <span class="confidence-descriptor band-${band}">${BAND_DESCRIPTOR[band]}</span>
        </div>
    `;

    const { wrap: meterEl, fill: meterFill } = buildConfidenceMeter(confidence);
    card.appendChild(meterEl);
    bubble.appendChild(card);

    if (data.caution) {
        const caution = document.createElement("div");
        caution.className = "caution";
        caution.innerHTML = `${WARNING_ICON_SVG}<span>This information is for educational purposes only — please consult a healthcare professional if needed.</span>`;
        bubble.appendChild(caution);
    }

    const timeLabel = nowLabel();
    bubble.appendChild(buildMetaRow(data.content || "", timeLabel));

    wrapper.appendChild(bubble);
    chatInner.appendChild(wrapper);
    scrollBottom();

    // set the fill width on the next frame so its CSS transition animates in
    requestAnimationFrame(() => {
        meterFill.style.width = confidence + "%";
    });

    conversation.push({
        role: "assistant",
        text: data.content || "",
        confidence,
        caution: !!data.caution,
        time: timeLabel
    });

    // a real answer just came back, so the backend is definitely alive
    setHealthStatus("online");
}

function addTypingIndicator() {
    const wrapper = document.createElement("div");
    wrapper.className = "message assistant";

    wrapper.innerHTML = `
        <div class="bubble">
            <div class="typing"><span></span><span></span><span></span></div>
        </div>
    `;

    chatInner.appendChild(wrapper);
    scrollBottom();
    return wrapper;
}

function scrollBottom() {
    chatWindow.scrollTop = chatWindow.scrollHeight;
}

function escapeHTML(str) {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------
// Export + clear conversation
// ---------------------------------------------------------------

function exportConversation() {
    if (conversation.length === 0) {
        showToast("Nothing to export yet");
        return;
    }

    const stamp = new Date();

    let md = `# TrustyMed Conversation Export\n\n`;
    md += `Exported: ${stamp.toLocaleString()}\n\n---\n\n`;

    conversation.forEach((entry) => {
        if (entry.role === "user") {
            md += `**You** _(${entry.time})_\n\n${entry.text}\n\n`;
        } else {
            md += `**TrustyMed** _(${entry.time}, confidence ${entry.confidence}%)_\n\n${entry.text}\n\n`;
            if (entry.caution) {
                md += `> Educational information only — consult a healthcare professional.\n\n`;
            }
        }
        md += `---\n\n`;
    });

    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const fileStamp = stamp.toISOString().slice(0, 16).replace(/[:T]/g, "-");
    a.download = `trustymed-conversation-${fileStamp}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast("Conversation exported");
}

function clearConversation() {
    if (conversation.length === 0) return;

    const confirmed = window.confirm("Clear this conversation? This can't be undone.");
    if (!confirmed) return;

    conversation = [];
    chatInner.innerHTML = WELCOME_HTML;
    showToast("Conversation cleared");
}

exportBtn.addEventListener("click", exportConversation);
clearBtn.addEventListener("click", clearConversation);

// ---------------------------------------------------------------
// Source Ledger — docked, resizable CSV panel
// ---------------------------------------------------------------
//
// Loaded on first open (not on page load) via PapaParse's chunk streaming —
// rows render into the table as they arrive instead of blocking on the
// whole file, so this stays smooth even on a large CSV. "Row #" scrolls to
// that row once it exists; if it hasn't streamed in yet, the request just
// waits for it.

let csvHeader = null;
let csvColumnTypes = [];       // "text" | "source" | "focus" | "default", per column
let csvRows = [];              // ALL parsed rows live here as plain data — {n, cells, search} —
                                // never as DOM. Only a small window of them ever becomes <tr> elements.
let csvFilteredRows = null;    // null = no filter active; otherwise a filtered view of csvRows
let csvLoading = false;
let csvHasLoadedOnce = false;
let csvFirstWindowRendered = false;
let pendingScrollTarget = null;
let csvPanelWidth = 460;       // remembered across open/close, adjustable by drag

// Rendering only ~150-250 <tr> at a time (instead of every row in the file)
// is what actually fixes the lag on a large CSV — a 22MB file can easily be
// tens of thousands of rows, and creating that many DOM nodes up front is
// what was freezing the tab, not the parsing itself.
const RENDER_BATCH = 150;        // rows added per scroll-triggered extension
const RENDER_WINDOW_RADIUS = 100; // rows rendered on either side of a jump target
const ROW_HEIGHT_ESTIMATE = 46;  // px — used only to size the scroll spacers

let winStart = 0; // [winStart, winEnd) = currently-rendered slice of the active dataset
let winEnd = 0;
let csvScrollTicking = false;
let filterDebounceTimer = null;

function activeCsvDataset() {
    return csvFilteredRows !== null ? csvFilteredRows : csvRows;
}

function classifyColumn(name) {
    const n = (name || "").trim().toLowerCase();
    if (n.includes("question") || n.includes("answer")) return "text";
    if (n.includes("source")) return "source";
    if (n.includes("focus")) return "focus";
    return "default";
}

function openCsvPanel() {
    csvPanel.classList.add("open");
    csvPanel.style.width = csvPanelWidth + "px";
    csvToggleBtn.setAttribute("aria-pressed", "true");

    if (!csvHasLoadedOnce) {
        csvHasLoadedOnce = true;
        loadCsv(CSV_URL);
    }
}

function closeCsvPanel() {
    csvPanel.classList.remove("open");
    csvPanel.style.width = "0";
    csvToggleBtn.setAttribute("aria-pressed", "false");
}

function toggleCsvPanel() {
    if (csvPanel.classList.contains("open")) {
        closeCsvPanel();
    } else {
        openCsvPanel();
    }
}

function resetCsvTable() {
    csvHeader = null;
    csvColumnTypes = [];
    csvRows = [];
    csvFilteredRows = null;
    csvFirstWindowRendered = false;
    winStart = 0;
    winEnd = 0;
    pendingScrollTarget = null;
    csvColgroup.innerHTML = "";
    csvThead.innerHTML = "";
    csvTbody.innerHTML = "";
    csvEmpty.hidden = true;
    csvRowInput.value = "";
    csvFilterInput.value = "";
    csvJumpBtn.textContent = "Go";
    csvJumpBtn.disabled = false;
}

function loadCsv(source) {
    resetCsvTable();
    csvLoading = true;
    csvSubtitle.textContent = "Loading…";

    const config = {
        skipEmptyLines: true,
        chunkSize: 1024 * 256, // stream the download in ~256KB pieces
        chunk: (results) => handleCsvChunk(results.data),
        complete: () => {
            csvLoading = false;
            finalizeCsvLoad();
        },
        error: (err) => {
            csvLoading = false;
            if (window.location.protocol === "file:") {
                csvSubtitle.textContent =
                    "This page is open directly from disk (file://) — browsers block CSV fetches from local files. " +
                    "Serve this folder over HTTP instead, e.g. run: python3 -m http.server 8080 " +
                    "from this folder, then open http://localhost:8080";
            } else {
                csvSubtitle.textContent = `Couldn't load "${CSV_URL}" — check the CSV_URL path in script.js and confirm the file is reachable at that URL.`;
            }
            console.error("CSV load failed:", err);
        }
    };

    if (typeof source === "string") {
        config.download = true;
        Papa.parse(source, config);
    } else {
        Papa.parse(source, config);
    }
}

function handleCsvChunk(rows) {
    rows.forEach((row) => {
        if (csvHeader === null) {
            csvHeader = row;
            csvColumnTypes = row.map(classifyColumn);
            renderCsvColgroup(csvColumnTypes);
            renderCsvHeader(csvHeader, csvColumnTypes);
            return;
        }
        // Cheap to keep every row's data in memory — the expensive part was
        // ever turning all of them into DOM nodes, which we no longer do.
        csvRows.push({
            n: csvRows.length + 1,
            cells: row,
            search: row.join(" ").toLowerCase()
        });
    });

    csvSubtitle.textContent = `${csvRows.length} rows loaded so far…`;

    if (!csvFirstWindowRendered && csvRows.length > 0) {
        csvFirstWindowRendered = true;
        buildWindow(0, Math.min(RENDER_BATCH, csvRows.length));
    } else if (csvFilteredRows === null) {
        updateBottomSpacerHeight(); // dataset grew — keep the scrollbar length honest
    }

    resolvePendingScroll(false);
}

function finalizeCsvLoad() {
    csvEmpty.hidden = csvRows.length !== 0;
    csvSubtitle.textContent = csvRows.length
        ? `${csvRows.length} rows`
        : "This file looks empty.";
    resolvePendingScroll(true);
}

function renderCsvColgroup(columnTypes) {
    csvColgroup.innerHTML = "";

    const rowNumCol = document.createElement("col");
    rowNumCol.style.width = "48px";
    csvColgroup.appendChild(rowNumCol);

    columnTypes.forEach((type) => {
        const col = document.createElement("col");
        if (type === "text") col.style.width = "26%";
        else if (type === "source" || type === "focus") col.style.width = "13%";
        else col.style.width = "16%";
        csvColgroup.appendChild(col);
    });

    const actionCol = document.createElement("col");
    actionCol.style.width = "36px";
    csvColgroup.appendChild(actionCol);
}

function renderCsvHeader(headerRow, columnTypes) {
    const tr = document.createElement("tr");

    const rowNumTh = document.createElement("th");
    rowNumTh.className = "row-num-col";
    rowNumTh.textContent = "#";
    tr.appendChild(rowNumTh);

    headerRow.forEach((label) => {
        const th = document.createElement("th");
        th.textContent = label;
        tr.appendChild(th);
    });

    tr.appendChild(document.createElement("th")); // spacer above the copy column
    csvThead.appendChild(tr);
}

function totalColumnCount() {
    return csvColumnTypes.length + 2; // row-num + data columns + action
}

function buildRowElement(rowObj) {
    const tr = document.createElement("tr");
    tr.id = `csv-row-${rowObj.n}`;
    if (rowObj.n % 10 === 0) tr.classList.add("tick");

    const numTd = document.createElement("td");
    numTd.className = "row-num";
    numTd.textContent = rowObj.n;
    tr.appendChild(numTd);

    csvColumnTypes.forEach((type, i) => {
        const cell = rowObj.cells[i] ?? "";
        const td = document.createElement("td");

        if (type === "text") {
            td.className = "col-text";
            td.textContent = cell;
        } else if (type === "source") {
            td.className = "col-tag";
            td.innerHTML = cell ? `<span class="tag-chip source">${escapeHTML(cell)}</span>` : "";
        } else if (type === "focus") {
            td.className = "col-tag";
            td.innerHTML = cell ? `<span class="tag-chip focus">${escapeHTML(cell)}</span>` : "";
        } else {
            td.textContent = cell;
        }

        tr.appendChild(td);
    });

    const actionTd = document.createElement("td");
    actionTd.className = "row-action";
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "copy-btn";
    copyBtn.innerHTML = COPY_ICON_SVG;
    copyBtn.addEventListener("click", () =>
        copyToClipboard(`Row ${rowObj.n}: ${rowObj.cells.join(" | ")}`)
    );
    actionTd.appendChild(copyBtn);
    tr.appendChild(actionTd);

    return tr;
}

function makeSpacerRow(className, heightPx) {
    const tr = document.createElement("tr");
    tr.className = className;
    const td = document.createElement("td");
    td.colSpan = totalColumnCount();
    td.style.height = Math.max(0, heightPx) + "px";
    td.style.padding = "0";
    td.style.border = "none";
    tr.appendChild(td);
    return tr;
}

// Renders only rows [start, end) of the active dataset, with two spacer
// rows standing in for everything above and below so the scrollbar still
// reflects the full dataset length.
function buildWindow(start, end) {
    const ds = activeCsvDataset();
    start = Math.max(0, Math.min(start, ds.length));
    end = Math.max(start, Math.min(end, ds.length));

    csvTbody.innerHTML = "";
    winStart = start;
    winEnd = end;

    csvTbody.appendChild(makeSpacerRow("csv-spacer csv-spacer-top", start * ROW_HEIGHT_ESTIMATE));
    for (let i = start; i < end; i++) {
        csvTbody.appendChild(buildRowElement(ds[i]));
    }
    csvTbody.appendChild(makeSpacerRow("csv-spacer csv-spacer-bottom", (ds.length - end) * ROW_HEIGHT_ESTIMATE));
}

function updateBottomSpacerHeight() {
    const ds = activeCsvDataset();
    const bottom = csvTbody.querySelector(".csv-spacer-bottom td");
    if (bottom) bottom.style.height = Math.max(0, (ds.length - winEnd) * ROW_HEIGHT_ESTIMATE) + "px";
}

function extendWindowForward() {
    const ds = activeCsvDataset();
    const newEnd = Math.min(ds.length, winEnd + RENDER_BATCH);
    if (newEnd === winEnd) return;

    const bottomSpacer = csvTbody.querySelector(".csv-spacer-bottom");
    const frag = document.createDocumentFragment();
    for (let i = winEnd; i < newEnd; i++) frag.appendChild(buildRowElement(ds[i]));
    csvTbody.insertBefore(frag, bottomSpacer);

    winEnd = newEnd;
    updateBottomSpacerHeight();
}

function extendWindowBackward() {
    const ds = activeCsvDataset();
    const newStart = Math.max(0, winStart - RENDER_BATCH);
    if (newStart === winStart) return;

    const topSpacer = csvTbody.querySelector(".csv-spacer-top");
    const firstRealRow = topSpacer.nextSibling;
    const frag = document.createDocumentFragment();
    for (let i = newStart; i < winStart; i++) frag.appendChild(buildRowElement(ds[i]));
    csvTbody.insertBefore(frag, firstRealRow);

    const prevScrollHeight = csvTableWrap.scrollHeight;
    winStart = newStart;
    topSpacer.querySelector("td").style.height = (winStart * ROW_HEIGHT_ESTIMATE) + "px";
    // keep the viewport anchored on what the user was looking at
    csvTableWrap.scrollTop += (csvTableWrap.scrollHeight - prevScrollHeight);
}

function handleCsvScroll() {
    if (csvScrollTicking) return;
    csvScrollTicking = true;
    requestAnimationFrame(() => {
        csvScrollTicking = false;
        const ds = activeCsvDataset();
        const wrap = csvTableWrap;
        const nearBottom = wrap.scrollTop + wrap.clientHeight > wrap.scrollHeight - 400;
        const nearTop = wrap.scrollTop < 400;

        if (nearBottom && winEnd < ds.length) extendWindowForward();
        if (nearTop && winStart > 0) extendWindowBackward();
    });
}

function scrollToCsvRow(n) {
    const row = document.getElementById(`csv-row-${n}`);
    if (!row) {
        showToast(`Row ${n} not found`);
        return;
    }
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    row.classList.add("flash");
    setTimeout(() => row.classList.remove("flash"), 1600);
}

function resolvePendingScroll(finished) {
    if (pendingScrollTarget === null) return;

    if (pendingScrollTarget <= csvRows.length) {
        jumpToRow(pendingScrollTarget);
        pendingScrollTarget = null;
        csvJumpBtn.textContent = "Go";
        csvJumpBtn.disabled = false;
    } else if (finished) {
        showToast(`This CSV only has ${csvRows.length} rows`);
        pendingScrollTarget = null;
        csvJumpBtn.textContent = "Go";
        csvJumpBtn.disabled = false;
    }
}

// Jumping rebuilds the rendered window centered on the target row instead
// of requiring everything before it to already be in the DOM — that's what
// makes "jump to row 40,000" instant instead of a full-file render.
function jumpToRow(n) {
    if (csvFilteredRows !== null) {
        csvFilterInput.value = "";
        csvFilteredRows = null;
    }
    const idx = n - 1;
    buildWindow(idx - RENDER_WINDOW_RADIUS, idx + RENDER_WINDOW_RADIUS + 1);
    requestAnimationFrame(() => scrollToCsvRow(n));
}

function handleCsvJumpRequest() {
    const target = parseInt(csvRowInput.value, 10);

    if (!target || target < 1) {
        showToast("Enter a valid row number");
        return;
    }

    if (target <= csvRows.length) {
        jumpToRow(target);
    } else if (csvLoading) {
        pendingScrollTarget = target;
        csvJumpBtn.textContent = "Waiting…";
        csvJumpBtn.disabled = true;
        showToast(`Still loading — will jump to row ${target} once it's ready`);
    } else {
        showToast(csvRows.length ? `This CSV only has ${csvRows.length} rows` : "No CSV loaded yet");
    }
}

function applyCsvFilter() {
    const query = csvFilterInput.value.trim().toLowerCase();

    if (!query) {
        csvFilteredRows = null;
        buildWindow(0, Math.min(RENDER_BATCH, csvRows.length));
        csvSubtitle.textContent = csvLoading
            ? `${csvRows.length} rows loaded so far…`
            : `${csvRows.length} rows`;
        return;
    }

    // row.search is precomputed once at parse time, so re-filtering on every
    // keystroke stays cheap even with tens of thousands of rows.
    csvFilteredRows = csvRows.filter((r) => r.search.includes(query));
    buildWindow(0, Math.min(RENDER_BATCH, csvFilteredRows.length));
    csvSubtitle.textContent = `${csvFilteredRows.length} of ${csvRows.length} rows match "${csvFilterInput.value.trim()}"`;
}

csvToggleBtn.addEventListener("click", toggleCsvPanel);
csvCloseBtn.addEventListener("click", closeCsvPanel);

csvJumpBtn.addEventListener("click", handleCsvJumpRequest);
csvRowInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleCsvJumpRequest();
});

// Debounced so typing a filter query doesn't re-scan the dataset on every
// single keystroke.
csvFilterInput.addEventListener("input", () => {
    clearTimeout(filterDebounceTimer);
    filterDebounceTimer = setTimeout(applyCsvFilter, 200);
});

csvTableWrap.addEventListener("scroll", handleCsvScroll, { passive: true });

// ---- resizing the docked panel by dragging its left edge ----

let isResizingCsv = false;
let resizeStartX = 0;
let resizeStartWidth = 0;

function startCsvResize(clientX) {
    isResizingCsv = true;
    resizeStartX = clientX;
    resizeStartWidth = csvPanel.getBoundingClientRect().width;
    csvPanel.classList.add("resizing");
    document.body.style.userSelect = "none";
}

function moveCsvResize(clientX) {
    if (!isResizingCsv) return;
    const delta = resizeStartX - clientX; // dragging left grows the panel
    const next = Math.max(300, Math.min(resizeStartWidth + delta, window.innerWidth * 0.75));
    csvPanelWidth = next;
    csvPanel.style.width = next + "px";
}

function endCsvResize() {
    if (!isResizingCsv) return;
    isResizingCsv = false;
    csvPanel.classList.remove("resizing");
    document.body.style.userSelect = "";
}

csvResizeHandle.addEventListener("mousedown", (e) => startCsvResize(e.clientX));
window.addEventListener("mousemove", (e) => moveCsvResize(e.clientX));
window.addEventListener("mouseup", endCsvResize);

csvResizeHandle.addEventListener("touchstart", (e) => startCsvResize(e.touches[0].clientX), { passive: true });
window.addEventListener("touchmove", (e) => moveCsvResize(e.touches[0].clientX), { passive: true });
window.addEventListener("touchend", endCsvResize);

// ---------------------------------------------------------------
// Init
// ---------------------------------------------------------------

initTheme();
checkBackendHealth();
setInterval(checkBackendHealth, HEALTH_CHECK_INTERVAL_MS);
