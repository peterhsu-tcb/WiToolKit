const descriptions = {
  "File Manager": "Browse and organize files with a focused two-pane workflow.",
  "Text Compare": "Compare text or code snippets with fast side-by-side diffing.",
  "Media Converter": "Convert common media formats through guided steps.",
  "PDF Text Extract": "Extract searchable text from PDF documents quickly.",
  "Agentic Client": "Interact with MCP/agent workflows from one compact view.",
};

const title = document.getElementById("selected-title");
const description = document.getElementById("selected-description");

document.querySelectorAll(".tool-card").forEach((button) => {
  button.addEventListener("click", () => {
    const toolName = button.dataset.tool;
    title.textContent = toolName;
    description.textContent = descriptions[toolName] ?? "Tool preview not available.";
  });
});
