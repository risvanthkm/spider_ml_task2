const API_URL = "http://127.0.0.1:8000/chat";

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

let conversation = [];
const WELCOME_HTML = chatInner.innerHTML;

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
// Theme Control
// ---------------------------------------------------------------
function initTheme() {
    const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
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
// Utilities & Chat Messaging
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

        if (!response.ok) throw new Error("Server Error");

        const data = await readStreamedJSON(response);
        typing.remove();
        addAssistantMessage(data);
    } catch (err) {
        typing.remove();
        addMessage("Unable to connect to the backend. Please try again.", "assistant");
        console.error(err);
    }
}

// ---------------------------------------------------------------
// Streamed response reader
// ---------------------------------------------------------------
// Long medical answers can take several minutes to generate on the backend.
// Awaiting response.json() directly leaves the connection sitting on a
// single unresolved read, and idle sockets like that are exactly what
// browsers/proxies kill with a NetworkError before any bytes ever show up.
// Reading the body incrementally through the Streams API + TextDecoder
// keeps bytes actively flowing across the connection as the server produces
// them, so a ~10 minute wait doesn't get treated as a dead connection.
// Once every chunk has arrived, the accumulated text is parsed as JSON.
async function readStreamedJSON(response) {
    if (!response.body || !response.body.getReader) {
        // Environments without a readable stream body (older browsers) fall
        // back to the standard one-shot parse.
        return response.json();
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let fullText = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fullText += decoder.decode(value, { stream: true });
    }
    fullText += decoder.decode();

    return JSON.parse(fullText);
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
    chatWindow.scrollTop = chatWindow.scrollHeight;

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
    bubble.innerHTML = window.DOMPurify ? DOMPurify.sanitize(rawHtml) : rawHtml;

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
        caution.innerHTML = `${WARNING_ICON_SVG}<span>This information is for educational purposes only — please consult a healthcare professional.</span>`;
        bubble.appendChild(caution);
    }

    const timeLabel = nowLabel();
    bubble.appendChild(buildMetaRow(data.content || "", timeLabel));
    wrapper.appendChild(bubble);
    chatInner.appendChild(wrapper);
    chatWindow.scrollTop = chatWindow.scrollHeight;

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
}

function addTypingIndicator() {
    const wrapper = document.createElement("div");
    wrapper.className = "message assistant";
    wrapper.innerHTML = `<div class="bubble"><div class="typing"><span></span><span></span><span></span></div></div>`;
    chatInner.appendChild(wrapper);
    chatWindow.scrollTop = chatWindow.scrollHeight;
    return wrapper;
}

function escapeHTML(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function exportConversation() {
    if (conversation.length === 0) {
        showToast("Nothing to export yet");
        return;
    }
    const stamp = new Date();
    let md = `# TrustyMed Conversation Export\n\nExported: ${stamp.toLocaleString()}\n\n---\n\n`;

    conversation.forEach((entry) => {
        if (entry.role === "user") {
            md += `**You** _(${entry.time})_\n\n${entry.text}\n\n`;
        } else {
            md += `**TrustyMed** _(${entry.time}, confidence ${entry.confidence}%)_\n\n${entry.text}\n\n`;
            if (entry.caution) md += `> Educational information only — consult a healthcare professional.\n\n`;
        }
        md += `---\n\n`;
    });

    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `trustymed-conversation-${stamp.toISOString().slice(0, 10)}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function clearConversation() {
    if (conversation.length === 0) return;
    if (!window.confirm("Clear this conversation? This can't be undone.")) return;
    conversation = [];
    chatInner.innerHTML = WELCOME_HTML;
    showToast("Conversation cleared");
}

exportBtn.addEventListener("click", exportConversation);
clearBtn.addEventListener("click", clearConversation);

// Initialization
initTheme();