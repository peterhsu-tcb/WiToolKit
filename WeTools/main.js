const descriptions = {
  "File Manager": "Browse and organize files with a focused two-pane workflow.",
  "Text Compare": "Compare text or code snippets with fast side-by-side diffing.",
  "Media Converter": "Convert common media formats through guided steps.",
  "PDF Text Extract": "Extract searchable text from PDF documents quickly.",
  "Agentic Client": "Interact with MCP/agent workflows from one compact view.",
};

const title = document.getElementById("selected-title");
const description = document.getElementById("selected-description");
const cards = Array.from(document.querySelectorAll(".tool-card"));

function selectCard(card) {
  const toolName = card.dataset.tool;
  cards.forEach((c) => c.setAttribute("aria-pressed", c === card ? "true" : "false"));
  title.textContent = toolName;
  description.textContent = descriptions[toolName] ?? `No preview available for ${toolName}.`;
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
