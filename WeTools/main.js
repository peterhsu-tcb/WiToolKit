const descriptions = {
  "File Manager": "Browse and organize files with a focused two-pane workflow.",
  "Text Compare": "Compare text or code snippets with fast side-by-side diffing.",
  "Media Converter": "Convert common media formats through guided steps.",
  "PDF Text Extract": "Extract searchable text from PDF documents quickly.",
  "Agentic Client": "Interact with MCP/agent workflows from one compact view.",
  "Media Manager": "Play media, extract subtitles, transcribe voice, cut clips, and build YouTube download commands. No history is saved.",
};

const workspace = document.getElementById("workspace-content");
const cards = Array.from(document.querySelectorAll(".tool-card"));

function renderEmpty(toolName) {
  const desc = descriptions[toolName] ?? `No preview available for ${toolName}.`;
  workspace.replaceChildren();
  const wrap = document.createElement("div");
  wrap.className = "empty-state";
  wrap.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
    <h2>${toolName ?? "Select a tool"}</h2>
    <p>${desc}</p>`;
  workspace.appendChild(wrap);
}

function selectCard(card) {
  const previous = cards.find((c) => c.getAttribute("aria-pressed") === "true");
  const previousTool = previous ? previous.dataset.tool : null;
  const toolName = card.dataset.tool;

  cards.forEach((c) => c.setAttribute("aria-pressed", c === card ? "true" : "false"));

  // Tear down Media Manager when leaving it
  if (previousTool === "Media Manager" && toolName !== "Media Manager" && window.WeToolsMediaManager) {
    window.WeToolsMediaManager.unmount(workspace);
  }

  if (toolName === "Media Manager" && window.WeToolsMediaManager) {
    window.WeToolsMediaManager.mount(workspace);
    return;
  }

  renderEmpty(toolName);
}

cards.forEach((card, index) => {
  card.addEventListener("click", () => selectCard(card));
  card.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const next = cards[(index + delta + cards.length) % cards.length];
    next.focus();
  });
});
