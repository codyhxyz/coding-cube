import { Choice, Eyes } from '/vendor/hunch/4d2deca/live.js';
import prompts from './air-swipe-prompts.js';

// EmbeddingGemma 2's image path, converted by hunch's examples/browser/convert.py and
// named for the first 12 hex digits of weights.bin's sha256, so a new conversion is a new
// URL and a cached copy can never be a stale one. 580 MB: too big for Pages, so R2.
const WEIGHTS = 'https://models.codyh.xyz/eg2/0cf0e46d9ae3';
const CACHE = 'coding-cube-eg2-0cf0e46d9ae3';
const SURE = 0.75;
const MOTION_WIDTH = 64;
const MOTION_HEIGHT = 48;
const MOTION_THRESHOLD = 24; // of 255: what counts as a pixel having changed
const PROGRESS_MS = 100;

let eyes = null;
let choice = null;
let seeing = false;
let previous = null;
const motionCanvas = new OffscreenCanvas(MOTION_WIDTH, MOTION_HEIGHT);
const motionContext = motionCanvas.getContext('2d', { willReadFrequently: true });

cacheWeights();
initialize().catch((error) => {
  self.postMessage({ type: 'error', message: error?.message || String(error) });
});

self.addEventListener('message', ({ data }) => {
  if (data.type !== 'frame' || !eyes) {
    data.frame?.close();
    return;
  }

  try {
    self.postMessage({ type: 'motion', timestamp: data.timestamp, generation: data.generation, ...motion(data.frame) });
    // Eyes.see reads the frame into its own canvas before it returns, so the bitmap can
    // be released straight away; only the GPU work is still in flight. One look at a
    // time: motion keeps the camera's rate while the embedding takes what it can.
    if (!seeing) {
      seeing = true;
      eyes.see(data.frame).then(({ x }) => {
        const answer = choice.ask(x);
        self.postMessage({
          type: 'hand',
          timestamp: data.timestamp,
          generation: data.generation,
          open: answer.name === 'open_hand' && answer.p >= SURE,
          p: answer.probs.open_hand,
        });
      }).catch((error) => {
        self.postMessage({ type: 'error', message: error?.message || String(error) });
      }).finally(() => {
        seeing = false;
      });
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: error?.message || String(error) });
  } finally {
    data.frame.close();
  }
});

async function initialize() {
  let progressAt = 0;
  eyes = await Eyes.open({
    weights: WEIGHTS,
    tokens: 70,
    onProgress(loaded, total) {
      const now = performance.now();
      if (now - progressAt < PROGRESS_MS && loaded < total) return;
      progressAt = now;
      self.postMessage({ type: 'progress', loaded, total });
    },
  });
  choice = new Choice(prompts, { empty: 'none', quiet: Object.keys(prompts).filter((name) => name !== 'open_hand') });
  self.postMessage({ type: 'ready' });
}

// The changed pixels between this frame and the last, as a share of the frame and the
// centroid of where they are. x is mirrored so that it reads the way the person moved.
function motion(frame) {
  motionContext.drawImage(frame, 0, 0, MOTION_WIDTH, MOTION_HEIGHT);
  const { data } = motionContext.getImageData(0, 0, MOTION_WIDTH, MOTION_HEIGHT);
  const gray = new Uint8Array(MOTION_WIDTH * MOTION_HEIGHT);
  for (let i = 0, j = 0; i < gray.length; i += 1, j += 4) gray[i] = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8;

  let changed = 0;
  let sumX = 0;
  let sumY = 0;
  if (previous) {
    for (let i = 0; i < gray.length; i += 1) {
      if (Math.abs(gray[i] - previous[i]) < MOTION_THRESHOLD) continue;
      changed += 1;
      sumX += i % MOTION_WIDTH;
      sumY += Math.floor(i / MOTION_WIDTH);
    }
  }
  previous = gray;
  if (!changed) return { mass: 0, x: 0.5, y: 0.5 };
  return {
    mass: changed / gray.length,
    x: 1 - (sumX / changed + 0.5) / MOTION_WIDTH,
    y: (sumY / changed + 0.5) / MOTION_HEIGHT,
  };
}

// hunch fetches its weights with a plain fetch(), and 580 MB is more than a browser's
// HTTP cache can be trusted to keep, so in this worker the weights go through Cache
// Storage: downloaded once, then read from disk. Earlier conversions are deleted.
function cacheWeights() {
  const network = self.fetch.bind(self);
  self.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith(`${WEIGHTS}/`)) return network(input, init);

    let cache = null;
    try {
      cache = (await globalThis.caches?.open(CACHE)) || null;
      const hit = await cache?.match(url);
      if (hit) return hit;
    } catch {
      cache = null;
    }

    const response = await network(input, init);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    cache?.put(url, response.clone()).catch(() => {});
    return response;
  };

  globalThis.caches?.keys().then((names) => Promise.all(names
    .filter((name) => name.startsWith('coding-cube-eg2-') && name !== CACHE)
    .map((name) => caches.delete(name)))).catch(() => {});
}
