const { ipcRenderer } = require("electron");

const form = document.getElementById("settingsForm");
const aiProviderSelect = document.getElementById("aiProvider");
const apiKeyInput = document.getElementById("apiKey");
const googleApiKeyInput = document.getElementById("googleApiKey");
const openaiKeyGroup = document.getElementById("openaiKeyGroup");
const googleKeyGroup = document.getElementById("googleKeyGroup");
const languageSelect = document.getElementById("language");
const pasteMethodSelect = document.getElementById("pasteMethod");
const cancelBtn = document.getElementById("cancelBtn");

const settings = ipcRenderer.sendSync("get-settings");

if (settings.aiProvider) {
  aiProviderSelect.value = settings.aiProvider;
}

if (settings.apiKey) {
  apiKeyInput.value = settings.apiKey;
}

if (settings.googleApiKey) {
  googleApiKeyInput.value = settings.googleApiKey;
}

if (settings.language) {
  languageSelect.value = settings.language;
}

if (settings.pasteMethod) {
  pasteMethodSelect.value = settings.pasteMethod;
}

function toggleApiKeyFields() {
  const provider = aiProviderSelect.value;
  if (provider === "google") {
    openaiKeyGroup.style.display = "none";
    googleKeyGroup.style.display = "block";
    apiKeyInput.removeAttribute("required");
    googleApiKeyInput.setAttribute("required", "required");
  } else {
    openaiKeyGroup.style.display = "block";
    googleKeyGroup.style.display = "none";
    apiKeyInput.setAttribute("required", "required");
    googleApiKeyInput.removeAttribute("required");
  }
}

toggleApiKeyFields();

aiProviderSelect.addEventListener("change", toggleApiKeyFields);

form.addEventListener("submit", (e) => {
  e.preventDefault();

  const newSettings = {
    aiProvider: aiProviderSelect.value,
    apiKey: apiKeyInput.value.trim(),
    googleApiKey: googleApiKeyInput.value.trim(),
    language: languageSelect.value,
  };

  ipcRenderer.send("save-settings", newSettings);
  ipcRenderer.send("save-paste-method", pasteMethodSelect.value);
});

cancelBtn.addEventListener("click", () => {
  window.close();
});
