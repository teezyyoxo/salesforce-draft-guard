chrome.runtime.onInstalled.addListener(enableSessionAccess);
chrome.runtime.onStartup.addListener(enableSessionAccess);

async function enableSessionAccess() {
  if (!chrome.storage.session || !chrome.storage.session.setAccessLevel) {
    return;
  }

  try {
    await chrome.storage.session.setAccessLevel({
      accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS"
    });
  } catch (error) {
    console.error("Salesforce Draft Guard failed to enable session storage access.", error);
  }
}
