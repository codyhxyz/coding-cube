import { isPageActive, onPageActivity } from './activity.js';

// A swipe is armed by a raised open hand (hunch, in the worker) and read from frame
// differences (also the worker): the centroid of what changed between two frames, in
// mirrored coordinates so "right" is the person's right. Neither alone is enough — a
// raised hand says nothing about direction, and motion alone is every reach for a mug.
const ARM_MS = 600; // a fast stroke blurs the hand, so the hand only has to have been seen recently
const WINDOW_MS = 450; // a swipe is quick; a slower travel is a drift and never fires
const STILL_MS = 120; // this long without motion ends a stroke
const MIN_TRAVEL = 0.3; // of the frame, along the swipe's axis
const AXIS_RATIO = 2; // pages go four ways, so a stroke must clearly pick one
const MIN_MASS = 0.004; // of the frame's pixels changed: less than that is sensor noise
const MAX_MASS = 0.4; // more than that is the whole person or the camera moving
const REFRACTORY_MS = 500;
const RETURN_MS = 800; // the hand coming back from a swipe is not a swipe the other way
const OPPOSITE = { left: 'right', right: 'left', up: 'down', down: 'up' };

const STATUS = {
  searching: 'Raise an open hand',
  ready: 'Ready — swipe',
};

export class SwipeGate {
  constructor() {
    this.reset();
  }

  reset() {
    this.openAt = -Infinity;
    this.track = [];
    this.last = null;
  }

  hand(time, open) {
    if (open) this.openAt = time;
  }

  ready(time) {
    return time - this.openAt <= ARM_MS;
  }

  motion(time, { mass, x, y }) {
    if (mass > MAX_MASS) {
      this.track = [];
      return null;
    }
    if (mass < MIN_MASS) {
      if (this.track.length && time - this.track.at(-1).time > STILL_MS) this.track = [];
      return null;
    }

    this.track.push({ time, x, y });
    while (time - this.track[0].time > WINDOW_MS) this.track.shift();
    if (!this.ready(time) || (this.last && time - this.last.time < REFRACTORY_MS)) return null;

    const direction = strokeDirection(x - this.track[0].x, y - this.track[0].y);
    if (!direction) return null;
    this.track = [];
    if (this.last && time - this.last.time < RETURN_MS && direction === OPPOSITE[this.last.direction]) return null;
    this.last = { time, direction };
    return direction;
  }
}

function strokeDirection(dx, dy) {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax >= MIN_TRAVEL && ax >= AXIS_RATIO * ay) return dx > 0 ? 'right' : 'left';
  if (ay >= MIN_TRAVEL && ay >= AXIS_RATIO * ax) return dy > 0 ? 'down' : 'up';
  return null;
}

export function airSwipeSupported() {
  return Boolean(globalThis.navigator?.gpu && navigator.mediaDevices?.getUserMedia && globalThis.Worker && globalThis.createImageBitmap);
}

export function createAirSwipe({ video, onSwipe = () => {}, onReady = () => {}, onStatus = () => {} }) {
  let enabled = false;
  let stream = null;
  let worker = null;
  let workerReady = null;
  let resolveWorker = null;
  let rejectWorker = null;
  let workerBusy = false;
  let frame = 0;
  let frameKind = '';
  let generation = 0;
  let lastVideoTime = -1;
  let lastState = '';
  let readyShown = false;
  let running = false;
  const gate = new SwipeGate();

  onPageActivity(handleActivity);

  async function enable(deviceId) {
    if (enabled) return true;
    if (!airSwipeSupported()) return false;

    enabled = true;
    generation += 1;
    lastState = '';
    running = false;
    onStatus('Starting…', true);

    try {
      await openCamera(deviceId);
      await ensureWorker();
      if (!enabled) return false;
      handleActivity();
      return true;
    } catch (error) {
      // The cause is for whoever opens the console. The person in Settings gets a
      // sentence they can act on, not a GPU adapter or a fetch error.
      console.warn('[coding-cube] air swipe unavailable:', error);
      disable(error?.name === 'NotAllowedError' ? 'Camera access was not allowed' : 'Couldn’t start air swipe. Try again.');
      return false;
    }
  }

  function disable(status = 'Off') {
    stopTracking();
    onStatus(status, false);
  }

  function selectCamera(deviceId) {
    if (!enabled) return true;
    stopTracking();
    return enable(deviceId);
  }

  function stopTracking() {
    enabled = false;
    generation += 1;
    running = false;
    stopLoop();
    resetGate();
    closeCamera();
  }

  function resetGate() {
    gate.reset();
    setReady(false);
  }

  function setReady(ready) {
    if (ready === readyShown) return;
    readyShown = ready;
    onReady(ready);
  }

  function updateStatus(time) {
    const ready = gate.ready(time);
    setReady(ready);
    const state = ready ? 'ready' : 'searching';
    if (!enabled || state === lastState) return;
    lastState = state;
    onStatus(STATUS[state], true);
  }

  async function openCamera(deviceId) {
    closeCamera();
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }),
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30, max: 30 },
      },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    lastVideoTime = -1;
    for (const track of stream.getVideoTracks()) {
      track.onended = () => {
        if (enabled) disable('Camera disconnected');
      };
    }
  }

  function closeCamera() {
    for (const track of stream?.getTracks() || []) {
      track.onended = null;
      track.stop();
    }
    stream = null;
    video.srcObject = null;
  }

  async function cameras() {
    const devices = await navigator.mediaDevices?.enumerateDevices?.();
    return (devices || []).filter((device) => device.kind === 'videoinput');
  }

  function ensureWorker() {
    if (workerReady) return workerReady;

    worker = new Worker('/app/swipe-worker.js', { type: 'module' });
    worker.addEventListener('message', handleWorkerMessage);
    worker.addEventListener('error', (event) => failWorker(event.error || new Error(event.message || 'Swipe worker failed')));
    workerReady = new Promise((resolve, reject) => {
      resolveWorker = resolve;
      rejectWorker = reject;
    });
    return workerReady;
  }

  function handleWorkerMessage({ data }) {
    if (data.type === 'ready') {
      resolveWorker?.();
      resolveWorker = null;
      rejectWorker = null;
      return;
    }

    if (data.type === 'progress') {
      if (enabled && data.total) onStatus(`Downloading ${megabytes(data.loaded)} / ${megabytes(data.total)} MB`, true);
      return;
    }

    if (data.type === 'error') {
      failWorker(new Error(data.message));
      return;
    }

    if (data.type === 'motion') workerBusy = false;
    if (!enabled || !running || data.generation !== generation) return;

    if (data.type === 'hand') {
      gate.hand(data.timestamp, data.open);
    } else if (data.type === 'motion') {
      const direction = gate.motion(data.timestamp, data);
      if (direction) onSwipe(direction);
    } else {
      return;
    }
    updateStatus(data.timestamp);
  }

  function failWorker(error) {
    const wasStarting = Boolean(rejectWorker);
    rejectWorker?.(error);
    resolveWorker = null;
    rejectWorker = null;
    worker?.terminate();
    worker = null;
    workerReady = null;
    workerBusy = false;
    if (!wasStarting && enabled) {
      console.warn('[coding-cube] air swipe stopped:', error);
      disable('Air swipe stopped. Turn it on again to retry.');
    }
  }

  function handleActivity(active = isPageActive()) {
    if (!enabled) return;
    if (running === active) return;
    running = active;
    stream?.getTracks().forEach((track) => { track.enabled = active; });
    resetGate();
    if (active) {
      lastState = 'searching';
      onStatus(STATUS.searching, true);
      schedule();
    } else {
      stopLoop();
      lastState = '';
      onStatus('Paused', true);
    }
  }

  function schedule() {
    if (frame || !enabled || !running) return;
    if (typeof video.requestVideoFrameCallback === 'function') {
      frameKind = 'video';
      frame = video.requestVideoFrameCallback(processFrame);
    } else {
      frameKind = 'animation';
      frame = requestAnimationFrame(processFrame);
    }
  }

  function stopLoop() {
    if (!frame) return;
    if (frameKind === 'video') video.cancelVideoFrameCallback(frame);
    else cancelAnimationFrame(frame);
    frame = 0;
  }

  function processFrame(timestamp) {
    frame = 0;
    if (!enabled || !running || !worker || !video.srcObject) return;

    if (!workerBusy && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      workerBusy = true;
      const currentGeneration = generation;
      createImageBitmap(video).then((bitmap) => {
        if (!enabled || !running || !worker || currentGeneration !== generation) {
          bitmap.close();
          workerBusy = false;
          return;
        }
        worker.postMessage({ type: 'frame', frame: bitmap, timestamp, generation: currentGeneration }, [bitmap]);
      }).catch((error) => {
        workerBusy = false;
        console.warn('[coding-cube] camera frame unavailable:', error);
      });
    }
    schedule();
  }

  return {
    enable,
    disable,
    selectCamera,
    cameras,
    cameraId: () => stream?.getVideoTracks()[0]?.getSettings().deviceId || '',
  };
}

function megabytes(bytes) {
  return Math.round(bytes / 1e6);
}
