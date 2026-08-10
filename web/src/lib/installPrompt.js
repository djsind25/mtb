// "Add to Home Screen" install-prompt support.
//
// Chrome/Android fires beforeinstallprompt once, early in the page's life, and only if it isn't
// handled it falls back to the browser's own generic mini-infobar. To have our own "Install
// MyTrashBid" button work reliably no matter when the user happens to visit the Account tab, the
// listener has to attach at app boot (imported for its side effect in main.jsx), not inside the
// InstallPrompt component itself — that component may mount minutes after the event already fired.
// iOS Safari never fires this event at all (Apple doesn't support programmatic install), so iOS
// always falls through to the manual "tap Share, then Add to Home Screen" instructions instead.

let deferredEvent = null;
let listeners = [];

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredEvent = e;
    listeners.forEach(fn => fn(e));
  });
  // Fires once the user actually completes installation (via our button or the browser's own
  // fallback UI) — clear the saved event so a stale prompt() call can't be attempted again.
  window.addEventListener("appinstalled", () => {
    deferredEvent = null;
  });
}

export function getDeferredInstallPrompt() {
  return deferredEvent;
}

// Returns an unsubscribe function, same shape as every other subscribe helper in this app.
export function onInstallPromptAvailable(fn) {
  listeners.push(fn);
  return () => { listeners = listeners.filter(l => l !== fn); };
}

export function clearDeferredInstallPrompt() {
  deferredEvent = null;
}

export function isStandaloneDisplay() {
  return (typeof window !== "undefined" && window.matchMedia?.("(display-mode: standalone)")?.matches)
    || window.navigator?.standalone === true; // iOS Safari's own (non-standard) flag
}

export function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}

export function isAndroid() {
  return /Android/.test(navigator.userAgent);
}
