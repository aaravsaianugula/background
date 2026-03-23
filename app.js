/* Art Display — playback engine */

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm']);

const IMAGE_DURATION = 1_200_000; // 20 minutes in ms

const CROSSFADE_DURATION = 1_500; // matches CSS transition (1.5s)
const CROSSFADE_CLEANUP_DELAY = CROSSFADE_DURATION + 100; // slight buffer past transition

// --- State ---
let mediaList = [];
let shuffled = [];
let currentIndex = 0;
let activeLayer = 'a';
let imageTimer = null;
let isPlaying = false;
let wakeLock = null;

// --- DOM refs (resolved after DOMContentLoaded) ---
let startScreen;
let startBtn;
let layerA;
let layerB;

// --- Utilities ---

function getExtension(filename) {
  const parts = filename.split('.');
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
}

function fisherYatesShuffle(array) {
  const arr = array.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = arr[i];
    arr[i] = arr[j];
    arr[j] = temp;
  }
  return arr;
}

// --- Layer helpers ---

function getLayerElement(id) {
  return id === 'a' ? layerA : layerB;
}

function getInactiveLayerId() {
  return activeLayer === 'a' ? 'b' : 'a';
}

function clearLayer(el) {
  // Use replaceChildren() to avoid any innerHTML XSS surface
  el.replaceChildren();
}

function swapLayers(inactiveId) {
  const inactiveEl = getLayerElement(inactiveId);
  const activeEl = getLayerElement(activeLayer);

  inactiveEl.classList.add('active');
  activeEl.classList.remove('active');

  // Keep a reference to the old active element before updating state
  const oldActiveEl = activeEl;
  activeLayer = inactiveId;

  // Clean up old layer content after the CSS fade completes
  setTimeout(() => {
    clearLayer(oldActiveEl);
  }, CROSSFADE_CLEANUP_DELAY);
}

// --- Playback ---

function advanceIndex() {
  currentIndex += 1;
  if (currentIndex >= shuffled.length) {
    const lastPlayed = shuffled[shuffled.length - 1];
    shuffled = fisherYatesShuffle(mediaList);
    // Prevent back-to-back repeat across cycles (if more than 1 item)
    if (shuffled.length > 1 && shuffled[0] === lastPlayed) {
      const swapIdx = 1 + Math.floor(Math.random() * (shuffled.length - 1));
      shuffled[0] = shuffled[swapIdx];
      shuffled[swapIdx] = lastPlayed;
    }
    currentIndex = 0;
  }
}

function showNext() {
  if (!isPlaying) return;

  const filename = shuffled[currentIndex];
  const ext = getExtension(filename);
  const inactiveId = getInactiveLayerId();
  const inactiveEl = getLayerElement(inactiveId);

  clearLayer(inactiveEl);

  if (IMAGE_EXTENSIONS.has(ext)) {
    showImage(filename, inactiveId, inactiveEl);
  } else if (VIDEO_EXTENSIONS.has(ext)) {
    showVideo(filename, inactiveId, inactiveEl);
  } else {
    // Unknown type — skip (async to prevent stack overflow on all-unknown decks)
    advanceIndex();
    setTimeout(showNext, 0);
  }
}

function showImage(filename, inactiveId, inactiveEl) {
  const img = document.createElement('img');
  img.alt = '';

  let settled = false;

  // If the image stalls (no onload/onerror), skip after 15s
  const loadTimeout = setTimeout(() => {
    if (settled || !isPlaying) return;
    settled = true;
    advanceIndex();
    showNext();
  }, 15_000);

  img.onload = () => {
    if (settled || !isPlaying) return;
    settled = true;
    clearTimeout(loadTimeout);
    swapLayers(inactiveId);
    advanceIndex();
    imageTimer = setTimeout(showNext, IMAGE_DURATION);
  };

  img.onerror = () => {
    if (settled || !isPlaying) return;
    settled = true;
    clearTimeout(loadTimeout);
    advanceIndex();
    setTimeout(showNext, 0);
  };

  img.src = 'media/' + encodeURIComponent(filename);
  inactiveEl.appendChild(img);
}

function showVideo(filename, inactiveId, inactiveEl) {
  const video = document.createElement('video');
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.controls = false;
  video.style.maxWidth = '100%';
  video.style.maxHeight = '100%';
  video.style.objectFit = 'contain';

  video.oncanplay = () => {
    if (!isPlaying) return;
    // Null out handler to guard against repeated canplay events
    video.oncanplay = null;
    swapLayers(inactiveId);
    advanceIndex();
  };

  video.onended = () => {
    if (!isPlaying) return;
    showNext();
  };

  video.onerror = () => {
    if (!isPlaying) return;
    advanceIndex();
    showNext();
  };

  video.src = 'media/' + encodeURIComponent(filename);
  inactiveEl.appendChild(video);
  video.load();
}

// --- Wake Lock (prevent screen sleep) ---

async function acquireWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
    } catch {
      // Wake lock denied — OS may still sleep, but playback continues
    }
  }
}

async function releaseWakeLock() {
  if (wakeLock) {
    try { await wakeLock.release(); } catch { /* already released */ }
    wakeLock = null;
  }
}

// --- Start / Stop ---

function stopPlayback() {
  isPlaying = false;
  releaseWakeLock();
  clearTimeout(imageTimer);
  imageTimer = null;

  layerA.classList.remove('active');
  layerB.classList.remove('active');

  // Delay clear so any in-progress fade doesn't flash
  setTimeout(() => {
    clearLayer(layerA);
    clearLayer(layerB);
  }, CROSSFADE_CLEANUP_DELAY);

  document.body.classList.remove('playing');
  startScreen.style.display = 'flex';
}

async function startPlayback() {
  let data;

  try {
    const response = await fetch('media.json');
    if (!response.ok) throw new Error('Fetch failed');
    data = await response.json();
  } catch {
    alert('No media found. Add files to media/ and update media.json');
    return;
  }

  if (!Array.isArray(data) || data.length === 0) {
    alert('No media found. Add files to media/ and update media.json');
    return;
  }

  mediaList = data.filter(item =>
    typeof item === 'string' &&
    item.trim().length > 0 &&
    /^[^/\\:.*?#][^/\\:*?#]*$/.test(item.trim())
  );

  if (mediaList.length === 0) {
    alert('No valid media files found in media.json');
    return;
  }

  shuffled = fisherYatesShuffle(mediaList);
  currentIndex = 0;
  activeLayer = 'a';

  try {
    await document.documentElement.requestFullscreen();
  } catch {
    // Fullscreen may be denied (e.g. iframe sandbox) — continue without it
  }

  startScreen.style.display = 'none';
  document.body.classList.add('playing');
  isPlaying = true;

  await acquireWakeLock();
  showNext();
}

// --- Fullscreen change handler ---

function onFullscreenChange() {
  if (!document.fullscreenElement && isPlaying) {
    // ChromeOS can exit fullscreen involuntarily (notifications, sleep/wake).
    // Try to re-enter; only stop if the user deliberately exits.
    document.documentElement.requestFullscreen().catch(() => {
      // Fullscreen truly denied — keep playing anyway, don't stop
    });
  }
}

// --- Boot ---

document.addEventListener('DOMContentLoaded', () => {
  startScreen = document.getElementById('start-screen');
  startBtn = document.getElementById('start-btn');
  layerA = document.getElementById('layer-a');
  layerB = document.getElementById('layer-b');

  startBtn.addEventListener('click', startPlayback);
  document.addEventListener('fullscreenchange', onFullscreenChange);

  // Re-acquire wake lock when tab becomes visible again
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isPlaying) {
      acquireWakeLock();
    }
  });
});
