// Browser-local dashboard background image, loaded as a module after app.js.
// Only the stored data URL under BACKGROUND_KEY is touched; other browser
// settings, including the API key filter, are left alone.

const BACKGROUND_KEY = 'cliproxyapi-monitor.background';
const DEFAULT_BACKGROUND_URL = './1.png';
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const MAX_EDGE = 2560;
const MAX_DATA_URL_CHARS = 2000000;
const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
// Bounded base64 raster data URLs only: never a remote, blob, or script source.
const DATA_URL_PATTERN = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

const backgroundInput = document.getElementById('background-image');
const backgroundReset = document.getElementById('background-reset');
const backgroundStatus = document.getElementById('background-status');
const backgroundPreview = document.getElementById('background-preview');

const MESSAGES = {
  processing: 'Processing image...',
  unsupported: 'Choose a JPEG, PNG, or WebP image.',
  empty: 'That image file is empty.',
  oversizedSource: 'Image is larger than 12 MB. Choose a smaller file.',
  oversizedSave: 'Image is too detailed to save. Try a smaller image.',
  undecodable: 'That image could not be read. Try another file.',
  savedInvalid: 'Saved background is invalid. Using the default.',
  storageWrite: 'Browser storage is unavailable. Allow site storage and try again.',
  storageFull: 'Browser storage is full. Try a smaller image or free up site storage.',
  storageRead: 'Browser storage is unavailable. Using the default background.',
  saved: 'Background updated.',
  reset: 'Default background restored.',
  resetUnsaved: 'Default restored, but browser storage is unavailable.',
};

// Bumped on every new selection or reset so stale async work cannot apply.
let backgroundGeneration = 0;

function setStatus(message) {
  if (!backgroundStatus) return;
  backgroundStatus.textContent = message;
  backgroundStatus.dataset.error = String(![MESSAGES.processing, MESSAGES.saved, MESSAGES.reset].includes(message));
}

function isValidBackgroundDataUrl(value) {
  return typeof value === 'string'
    && value.length <= MAX_DATA_URL_CHARS
    && DATA_URL_PATTERN.test(value);
}

function showBackground(dataUrl) {
  document.documentElement.style.setProperty('--dashboard-background', `url("${dataUrl}")`);
  if (backgroundPreview) backgroundPreview.src = dataUrl;
}

function showDefaultBackground() {
  document.documentElement.style.removeProperty('--dashboard-background');
  if (backgroundPreview) backgroundPreview.src = DEFAULT_BACKGROUND_URL;
}

function dropSavedBackground() {
  try {
    localStorage.removeItem(BACKGROUND_KEY);
  } catch {
    // Best effort; the visible fallback still applies when storage is blocked.
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(MESSAGES.undecodable));
    reader.readAsDataURL(file);
  });
}

function decodeImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(MESSAGES.undecodable));
    image.src = dataUrl;
  });
}

async function encodeBackground(file, token) {
  if (!ACCEPTED_TYPES.has(file.type)) throw new Error(MESSAGES.unsupported);
  if (!file.size) throw new Error(MESSAGES.empty);
  if (file.size > MAX_SOURCE_BYTES) throw new Error(MESSAGES.oversizedSource);

  const source = await readFileAsDataUrl(file);
  if (token !== backgroundGeneration) return null;
  const image = await decodeImage(source);
  if (token !== backgroundGeneration) return null;

  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (!width || !height) throw new Error(MESSAGES.undecodable);

  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);

  let dataUrl = canvas.toDataURL('image/webp', 0.85);
  if (!dataUrl || !dataUrl.startsWith('data:image/webp')) {
    dataUrl = canvas.toDataURL('image/png');
  }
  if (dataUrl.length > MAX_DATA_URL_CHARS) dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  if (!isValidBackgroundDataUrl(dataUrl)) throw new Error(MESSAGES.oversizedSave);
  return dataUrl;
}

async function handleSelection() {
  const file = backgroundInput?.files?.[0];
  if (!file) return;
  const token = ++backgroundGeneration;
  setStatus(MESSAGES.processing);

  let dataUrl;
  try {
    dataUrl = await encodeBackground(file, token);
  } catch (error) {
    if (token === backgroundGeneration) {
      backgroundInput.value = '';
      setStatus(error.message);
    }
    return;
  }
  if (dataUrl === null || token !== backgroundGeneration) return;

  try {
    // Persist before applying so a rejected save keeps the previous background.
    localStorage.setItem(BACKGROUND_KEY, dataUrl);
  } catch (error) {
    if (token === backgroundGeneration) {
      backgroundInput.value = '';
      setStatus(error?.name === 'QuotaExceededError' ? MESSAGES.storageFull : MESSAGES.storageWrite);
    }
    return;
  }

  showBackground(dataUrl);
  if (backgroundInput) backgroundInput.value = '';
  setStatus(MESSAGES.saved);
}

function handleReset() {
  backgroundGeneration += 1;
  let cleared = true;
  try {
    localStorage.removeItem(BACKGROUND_KEY);
  } catch {
    cleared = false;
  }
  showDefaultBackground();
  if (backgroundInput) backgroundInput.value = '';
  setStatus(cleared ? MESSAGES.reset : MESSAGES.resetUnsaved);
}

function restoreBackground() {
  let saved;
  try {
    saved = localStorage.getItem(BACKGROUND_KEY);
  } catch {
    setStatus(MESSAGES.storageRead);
    return;
  }
  if (!saved) return;

  if (!isValidBackgroundDataUrl(saved)) {
    dropSavedBackground();
    showDefaultBackground();
    setStatus(MESSAGES.savedInvalid);
    return;
  }

  const token = ++backgroundGeneration;
  decodeImage(saved).then(() => {
    if (token !== backgroundGeneration) return;
    showBackground(saved);
  }, () => {
    if (token !== backgroundGeneration) return;
    dropSavedBackground();
    showDefaultBackground();
    setStatus(MESSAGES.savedInvalid);
  });
}

if (backgroundInput) backgroundInput.addEventListener('change', handleSelection);
if (backgroundReset) backgroundReset.addEventListener('click', handleReset);
restoreBackground();