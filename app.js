/* Art Display — playback engine */

// IMPORTANT: these allowlists are mirrored in 3 other files. Keep in sync:
//   - scripts/generate-media-json.js  (VALID_EXTENSIONS)
//   - sync-media.ps1                  ($ValidExtensions)
//   - media/.gitignore                (one !*.<ext> per extension, both cases)
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm']);

const IMAGE_DURATION = 1_200_000; // 20 minutes in ms
const IMAGE_LOAD_TIMEOUT = 15_000; // skip image if onload/onerror don't fire in 15s

const VIDEO_LOAD_TIMEOUT = 15_000; // skip video if oncanplay doesn't fire in 15s
const VIDEO_STALL_TIMEOUT = 10_000; // skip video if no timeupdate fires for 10s mid-play

const CROSSFADE_DURATION = 1_500; // matches CSS transition (1.5s)
const CROSSFADE_CLEANUP_DELAY = CROSSFADE_DURATION + 100; // slight buffer past transition
const POLL_INTERVAL = 300_000; // 5 min — check for media list updates

// --- State ---
let mediaList = [];
let shuffled = [];
let currentIndex = 0;
let activeLayer = 'a';
let imageTimer = null;
let isPlaying = false;
let wakeLock = null;
let pollTimer = null;
// Disposer for the currently in-flight video (null when no video is loading
// or playing). stopPlayback() calls this to kill the video's loadTimeout
// and stallTimer; without it, an orphaned timer from the prior session
// could fire into a fresh session and clobber the active layer.
let activeVideoDispose = null;

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
    if (mediaList.length === 0) {
      shuffled = [];
      currentIndex = 0;
      return;
    }
    const lastPlayed = shuffled.length > 0 ? shuffled[shuffled.length - 1] : null;
    shuffled = fisherYatesShuffle(mediaList);
    // Prevent back-to-back repeat across cycles (if more than 1 item)
    if (shuffled.length > 1 && lastPlayed && shuffled[0] === lastPlayed) {
      const swapIdx = 1 + Math.floor(Math.random() * (shuffled.length - 1));
      shuffled[0] = shuffled[swapIdx];
      shuffled[swapIdx] = lastPlayed;
    }
    currentIndex = 0;
  }
}

function showNext() {
  if (!isPlaying) return;

  // Guard: no media available (all removed or empty after poll update)
  if (shuffled.length === 0 || currentIndex >= shuffled.length) {
    imageTimer = setTimeout(showNext, POLL_INTERVAL);
    return;
  }

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

  // If the image stalls (no onload/onerror), skip after IMAGE_LOAD_TIMEOUT
  const loadTimeout = setTimeout(() => {
    if (settled || !isPlaying) return;
    settled = true;
    advanceIndex();
    showNext();
  }, IMAGE_LOAD_TIMEOUT);

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

  // Disposal flag prevents stale events from a replaced video element
  // (still being garbage-collected) from advancing the slideshow.
  let disposed = false;
  let advanced = false;
  let stallTimer = null;
  let loadTimeout = null;

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (stallTimer) clearTimeout(stallTimer);
    if (loadTimeout) clearTimeout(loadTimeout);
    stallTimer = null;
    loadTimeout = null;
    video.oncanplay = null;
    video.ontimeupdate = null;
    video.onended = null;
    video.onerror = null;
    // If we're still the registered active disposer, clear that pointer.
    // Don't blindly null it — a later showVideo may have replaced us.
    if (activeVideoDispose === dispose) {
      activeVideoDispose = null;
    }
  }

  function ensureAdvance() {
    if (!advanced) {
      advanceIndex();
      advanced = true;
    }
  }

  function skipToNext() {
    if (disposed || !isPlaying) return;
    ensureAdvance();
    dispose();
    showNext();
  }

  function armStall() {
    if (stallTimer) clearTimeout(stallTimer);
    // No timeupdate for STALL_TIMEOUT means playback is hung. The HTML5
    // video element fires timeupdate several times per second while
    // playing, so a 10s gap is unambiguously stalled.
    stallTimer = setTimeout(skipToNext, VIDEO_STALL_TIMEOUT);
  }

  // 15s ceiling for initial canplay (matches showImage's loadTimeout).
  loadTimeout = setTimeout(skipToNext, VIDEO_LOAD_TIMEOUT);

  video.oncanplay = () => {
    if (disposed || !isPlaying) return;
    // Null handler so a second canplay (e.g. after seek) doesn't re-swap.
    video.oncanplay = null;
    clearTimeout(loadTimeout);
    loadTimeout = null;
    swapLayers(inactiveId);
    ensureAdvance();
    armStall();
  };

  video.ontimeupdate = () => {
    if (disposed || !isPlaying) return;
    armStall();
  };

  video.onended = () => {
    if (disposed || !isPlaying) return;
    dispose();
    showNext();
  };

  video.onerror = () => {
    if (disposed || !isPlaying) return;
    ensureAdvance();
    dispose();
    showNext();
  };

  // Register dispose so stopPlayback can kill us if the player shuts down
  // mid-load. Replaces any prior disposer (whose video has already been
  // handed off — its dispose() at end-of-flow will no-op via activeVideoDispose
  // === dispose check).
  activeVideoDispose = dispose;

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

// --- Live polling for media changes ---

const FILENAME_PATTERN = /^[^/\\:.*?#][^/\\:*?#]*$/;

function validateMediaList(data) {
  if (!Array.isArray(data)) return [];
  return data
    .filter(item => typeof item === 'string' && item.trim().length > 0)
    .map(item => item.trim())
    .filter(item => FILENAME_PATTERN.test(item));
}

function applyMediaChanges(freshList) {
  const currentSet = new Set(mediaList);
  const freshSet = new Set(freshList);

  const removed = mediaList.filter(f => !freshSet.has(f));
  const hasAdded = freshList.some(f => !currentSet.has(f));

  if (!hasAdded && removed.length === 0) return;

  const wasEmpty = mediaList.length === 0 || shuffled.length === 0;
  mediaList = freshList;

  if (removed.length > 0) {
    const removedSet = new Set(removed);
    const played = shuffled.slice(0, currentIndex);
    const remaining = shuffled.slice(currentIndex).filter(f => !removedSet.has(f));
    shuffled = played.concat(remaining);

    // Clamp currentIndex if removals pushed it out of bounds
    if (currentIndex >= shuffled.length) {
      currentIndex = 0;
    }
  }

  // If the player was stuck (empty list) and we now have files, rebuild shuffled
  if (wasEmpty && mediaList.length > 0) {
    shuffled = fisherYatesShuffle(mediaList);
    currentIndex = 0;
  }
}

async function pollForChanges() {
  try {
    const response = await fetch('media.json', { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json();
    const freshList = validateMediaList(data);
    if (freshList.length === 0) return; // don't clear a working slideshow
    applyMediaChanges(freshList);
  } catch {
    // Network error — silently retry next interval
  }
}

// --- Start / Stop ---

function stopPlayback() {
  isPlaying = false;
  releaseWakeLock();
  clearTimeout(imageTimer);
  clearInterval(pollTimer);
  imageTimer = null;
  pollTimer = null;

  // Kill any in-flight video's loadTimeout / stallTimer / handlers so they
  // can't fire into a future startPlayback() session and clobber the layer.
  if (activeVideoDispose) {
    activeVideoDispose();
    activeVideoDispose = null;
  }

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
    alert('No media found. Add image files to the media/ folder and redeploy.');
    return;
  }

  if (!Array.isArray(data) || data.length === 0) {
    alert('No media found. Add image files to the media/ folder and redeploy.');
    return;
  }

  mediaList = validateMediaList(data);

  if (mediaList.length === 0) {
    alert('No valid media files found. Check the media/ folder.');
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
  pollTimer = setInterval(pollForChanges, POLL_INTERVAL);
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
