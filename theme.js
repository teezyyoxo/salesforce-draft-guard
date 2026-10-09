(() => {
  const key = "sfdg:ui-theme";
  const system = matchMedia("(prefers-color-scheme: dark)");
  let preference = "system";
  const appearanceControl = document.getElementById("themeToggle");
  function render() {
    const dark = preference === "system" ? system.matches : preference === "dark";
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    appearanceControl.value = preference;
  }
  render();
  chrome.storage.local.get(key).then(stored => {
    if (["system", "light", "dark"].includes(stored[key])) preference = stored[key];
    render();
  }).catch(console.error);
  appearanceControl.addEventListener("change", async () => {
    preference = appearanceControl.value;
    render();
    try { await chrome.storage.local.set({ [key]: preference }); }
    catch (error) { console.error("Could not save interface theme.", error); }
  });
  system.addEventListener("change", render);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[key]) {
      preference = ["system", "light", "dark"].includes(changes[key].newValue) ? changes[key].newValue : "system";
      render();
    }
  });
})();
