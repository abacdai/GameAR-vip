/**
 * audio-sync.js
 * ---------------------------------------------------------------------------
 * Handles the ultrasonic "who got shot" handshake and the compass heading
 * (DeviceOrientation) needed to resolve it, for the AR Laser Tag game.
 *
 * DESIGN GOALS (per spec):
 *  - Works in noisy classrooms/hallways/outdoors with talking, shouting, etc.
 *  - Zero reliance on GPS/QR codes.
 *  - Cheap enough to run continuously at 60 FPS on low-end phones (this file
 *    NEVER touches the camera or any ML model — only Web Audio + a tiny FFT
 *    read every animation frame, which costs practically nothing).
 *
 * HOW IT WORKS
 *  1. SHOOTER emits a pure 19,000 Hz sine tone for 100ms through the phone's
 *     speaker (inaudible to virtually everyone, but every modern phone
 *     speaker/mic pair can reproduce/capture it).
 *  2. Every OTHER phone in the room is continuously sampling its microphone
 *     through a two-stage filter chain that surgically isolates the
 *     18.5-19.5kHz band:
 *       mic -> Highpass Biquad (17,000 Hz cutoff)  [kills voices/school noise]
 *           -> Bandpass Biquad (19,000 Hz, high Q) [isolates the exact tone]
 *           -> AnalyserNode (FFT)                  [measures energy there]
 *     Human speech / shouting / clapping / footsteps essentially have zero
 *     energy above 17kHz, so this is extremely resistant to noisy rooms.
 *  3. When a target's analyser sees a sharp energy spike in that band it
 *     fires the `onUltrasonicPing` callback with a timestamp.
 *  4. game.js combines that detection with "is my compass heading roughly
 *     180 degrees opposite the shooter's heading?" (the two players are
 *     facing each other) to decide whether IT was the intended target, then
 *     asks the server to confirm (server re-validates heading authoritatively).
 * ---------------------------------------------------------------------------
 */

const ULTRASONIC_FREQ = 19000; // Hz - inaudible to virtually all human ears
const PING_DURATION_MS = 100; // spec: exactly 100ms burst
const HIGHPASS_CUTOFF = 17000; // Hz - blocks all human voice/noise energy
const BANDPASS_Q = 12; // narrow band around the ultrasonic carrier

const AudioSync = (() => {
  let audioCtx = null;
  let micStream = null;
  let analyser = null;
  let freqData = null;
  let listening = false;
  let rafHandle = null;

  // Adaptive noise floor so the detector self-calibrates to each phone's
  // mic sensitivity / ambient conditions instead of using one fixed magic
  // number that could false-trigger or under-trigger across devices.
  let noiseFloorDb = -100;
  let calibrated = false;
  let sampleCount = 0;

  let lastDetectionAt = 0;
  const DETECTION_COOLDOWN_MS = 350; // ignore re-triggers from the same 100ms ping

  let targetBinIndex = 0;
  let onPingDetected = null;

  let latestHeading = 0;
  let headingReady = false;
  let onHeadingChange = null;

  /** Must be called from within a user-gesture handler (tap) on iOS/Safari. */
  function ensureContext() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctx();
    }
    if (audioCtx.state === "suspended") {
      audioCtx.resume();
    }
    return audioCtx;
  }

  /**
   * Emits the 19kHz ultrasonic "shot fired" ping for exactly 100ms.
   * Uses a short gain envelope (5ms fade in/out) purely to avoid an audible
   * "click" transient — the tone itself stays inaudible to humans.
   */
  function playUltrasonicPing() {
    const ctx = ensureContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(ULTRASONIC_FREQ, ctx.currentTime);

    const now = ctx.currentTime;
    const fade = 0.005; // 5ms
    const dur = PING_DURATION_MS / 1000;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + fade);
    gain.gain.setValueAtTime(1, now + dur - fade);
    gain.gain.linearRampToValueAtTime(0, now + dur);

    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + dur + 0.01);
  }

  /**
   * Starts the always-on (but cheap) ultrasonic listener. Requests
   * microphone access, builds the highpass -> bandpass -> analyser chain,
   * and polls it once per animation frame.
   */
  async function startListening(callback) {
    onPingDetected = callback;
    if (listening) return true;

    const ctx = ensureContext();
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false, // would attenuate/deform our tone
          autoGainControl: false,
          channelCount: 1,
        },
      });
    } catch (err) {
      console.error("[AudioSync] microphone permission denied", err);
      return false;
    }

    const source = ctx.createMediaStreamSource(micStream);

    // Stage 1: Highpass filter @ 17kHz — removes essentially all human
    // speech, shouting, footsteps, and background classroom/school noise
    // (human voice fundamentals + harmonics rarely exceed ~8-12kHz).
    const highpass = ctx.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = HIGHPASS_CUTOFF;
    highpass.Q.value = 0.7;

    // Stage 2: Narrow bandpass centered exactly on our ultrasonic carrier,
    // further isolating the ping from mic self-noise / ultrasonic artifacts.
    const bandpass = ctx.createBiquadFilter();
    bandpass.type = "bandpass";
    bandpass.frequency.value = ULTRASONIC_FREQ;
    bandpass.Q.value = BANDPASS_Q;

    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048; // resolution ~= sampleRate/fftSize per bin
    analyser.smoothingTimeConstant = 0.2; // fast response to short 100ms pings
    freqData = new Float32Array(analyser.frequencyBinCount);

    source.connect(highpass);
    highpass.connect(bandpass);
    bandpass.connect(analyser);
    // Intentionally NOT connected to destination — we never want to hear it.

    const nyquist = ctx.sampleRate / 2;
    const binHz = nyquist / analyser.frequencyBinCount;
    targetBinIndex = Math.round(ULTRASONIC_FREQ / binHz);

    listening = true;
    calibrated = false;
    sampleCount = 0;
    noiseFloorDb = -100;
    pollLoop();
    return true;
  }

  function stopListening() {
    listening = false;
    if (rafHandle) cancelAnimationFrame(rafHandle);
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }
  }

  function readBandEnergyDb() {
    analyser.getFloatFrequencyData(freqData);
    // Average a tiny window of bins around the target frequency to be
    // resilient to minor oscillator/mic sample-rate drift.
    const span = 2;
    let sum = 0;
    let n = 0;
    for (let i = targetBinIndex - span; i <= targetBinIndex + span; i++) {
      if (i >= 0 && i < freqData.length) {
        sum += freqData[i];
        n++;
      }
    }
    return n ? sum / n : -Infinity;
  }

  function pollLoop() {
    if (!listening) return;
    const db = readBandEnergyDb();

    // Calibrate ambient ultrasonic noise floor for the first ~40 frames
    // (roughly 0.6s) so we adapt to each device/room instead of a fixed
    // threshold.
    if (!calibrated) {
      noiseFloorDb = sampleCount === 0 ? db : noiseFloorDb * 0.9 + db * 0.1;
      sampleCount++;
      if (sampleCount > 40) calibrated = true;
    } else {
      const threshold = Math.max(noiseFloorDb + 18, -70); // 18dB above ambient
      const now = performance.now();
      if (db > threshold && now - lastDetectionAt > DETECTION_COOLDOWN_MS) {
        lastDetectionAt = now;
        if (onPingDetected) onPingDetected({ strength: db, timestamp: Date.now() });
      } else {
        // Slowly track a rising noise floor too (e.g. mic gain changes)
        // without letting genuine pings pollute the average.
        if (db < threshold) noiseFloorDb = noiseFloorDb * 0.995 + db * 0.005;
      }
    }
    rafHandle = requestAnimationFrame(pollLoop);
  }

  // ---------------------------------------------------------------------
  // Compass heading (DeviceOrientation). iOS requires an explicit
  // permission prompt triggered by a user gesture; Android exposes it
  // directly via `deviceorientationabsolute` (or the webkitCompassHeading
  // property on iOS's plain `deviceorientation` event).
  // ---------------------------------------------------------------------
  async function requestOrientationPermission() {
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === "function") {
      try {
        const res = await DOE.requestPermission();
        return res === "granted";
      } catch (err) {
        console.error("[AudioSync] orientation permission error", err);
        return false;
      }
    }
    return true; // Android / desktop: no explicit permission needed
  }

  function handleOrientation(event) {
    let heading = null;
    if (typeof event.webkitCompassHeading === "number") {
      // iOS Safari: already a true compass heading (0 = North), no need to invert.
      heading = event.webkitCompassHeading;
    } else if (event.absolute && typeof event.alpha === "number") {
      // Android absolute orientation: alpha is measured counter-clockwise
      // from North, so convert to clockwise compass heading.
      heading = (360 - event.alpha) % 360;
    } else if (typeof event.alpha === "number") {
      heading = (360 - event.alpha) % 360;
    }
    if (heading != null && !Number.isNaN(heading)) {
      latestHeading = (heading + 360) % 360;
      headingReady = true;
      if (onHeadingChange) onHeadingChange(latestHeading);
    }
  }

  async function startCompass(callback) {
    onHeadingChange = callback;
    const granted = await requestOrientationPermission();
    if (!granted) return false;
    if ("ondeviceorientationabsolute" in window) {
      window.addEventListener("deviceorientationabsolute", handleOrientation, true);
    } else {
      window.addEventListener("deviceorientation", handleOrientation, true);
    }
    return true;
  }

  function getHeading() {
    return latestHeading;
  }

  function isHeadingReady() {
    return headingReady;
  }

  /** Smallest angular difference (0-180) between two compass headings. */
  function angularDiff(a, b) {
    let diff = Math.abs(a - b) % 360;
    if (diff > 180) diff = 360 - diff;
    return diff;
  }

  /** True if heading `a` is within `tolerance` degrees of being opposite `b`. */
  function isOpposite(a, b, tolerance = 15) {
    const diff = angularDiff(a, b);
    return Math.abs(diff - 180) <= tolerance;
  }

  return {
    ensureContext,
    playUltrasonicPing,
    startListening,
    stopListening,
    startCompass,
    getHeading,
    isHeadingReady,
    isOpposite,
    angularDiff,
    ULTRASONIC_FREQ,
    PING_DURATION_MS,
  };
})();

window.AudioSync = AudioSync;
