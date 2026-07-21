(function exposeMicrophoneSelector(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ariMicrophoneSelector = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  const SIGNAL_THRESHOLD = 0.0001;
  const DEFAULT_PROBE_MS = 160;
  const MAX_ALTERNATIVES = 8;
  let rememberedSelection = null;

  function cleanLabel(label) {
    return String(label || 'Microphone').replace(/^(default|communications)\s*-\s*/i, '').trim() || 'Microphone';
  }

  function labelPreference(label) {
    const value = cleanLabel(label).toLowerCase();
    let score = 0;
    if (/microphone array|built[- ]?in|internal|macbook/.test(value)) score += 80;
    if (/usb|headset|airpods|earbuds|microphone/.test(value)) score += 25;
    if (/virtual|cable|voice changer|stereo mix|loopback|obs|cam & voice/.test(value)) score -= 5_000;
    if (/iphone.*hands-free/.test(value)) score -= 100;
    return score;
  }

  function candidateScore({ peak = 0, label = '', isDefault = false } = {}) {
    const signal = Number(peak) >= SIGNAL_THRESHOLD;
    return (signal ? 10_000 + Math.min(2_000, Number(peak) * 20_000) : 0)
      + labelPreference(label)
      - (isDefault && !signal ? 40 : 0);
  }

  function stopStream(stream) {
    stream?.getTracks?.().forEach((track) => track.stop());
  }

  function forgetSelection() {
    rememberedSelection = null;
  }

  async function measureMicrophone(stream, {
    AudioContextCtor = globalThis.AudioContext,
    probeMs = DEFAULT_PROBE_MS,
  } = {}) {
    const context = new AudioContextCtor();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const values = new Float32Array(analyser.fftSize);
    let peak = 0;
    let sumSquares = 0;
    let count = 0;
    const deadline = performance.now() + probeMs;
    try {
      while (performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        analyser.getFloatTimeDomainData(values);
        for (const value of values) {
          peak = Math.max(peak, Math.abs(value));
          sumSquares += value * value;
          count += 1;
        }
      }
      return { peak, rms: Math.sqrt(sumSquares / Math.max(1, count)) };
    } finally {
      source.disconnect();
      await context.close().catch(() => {});
    }
  }

  function constraints(deviceId) {
    return {
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    };
  }

  async function selectMicrophone({
    mediaDevices = navigator.mediaDevices,
    measure = measureMicrophone,
    probeMs = DEFAULT_PROBE_MS,
    maxAlternatives = MAX_ALTERNATIVES,
  } = {}) {
    if (rememberedSelection?.deviceId) {
      try {
        const stream = await mediaDevices.getUserMedia(constraints(rememberedSelection.deviceId));
        return { ...rememberedSelection, stream, signalDetected: true, remembered: true };
      } catch (_) {
        forgetSelection();
      }
    }

    const defaultStream = await mediaDevices.getUserMedia(constraints());
    const defaultTrack = defaultStream.getAudioTracks()[0];
    const defaultLabel = defaultTrack?.label || 'System default microphone';
    const defaultLevel = await measure(defaultStream, { probeMs });
    let best = {
      stream: defaultStream,
      label: cleanLabel(defaultLabel),
      deviceId: defaultTrack?.getSettings?.().deviceId || 'default',
      peak: defaultLevel.peak || 0,
      rms: defaultLevel.rms || 0,
      isDefault: true,
    };
    if (best.peak >= SIGNAL_THRESHOLD) return { ...best, signalDetected: true };

    const devices = (await mediaDevices.enumerateDevices())
      .filter((device) => device.kind === 'audioinput' && device.deviceId && !['default', 'communications'].includes(device.deviceId))
      .filter((device, index, all) => all.findIndex((candidate) => candidate.deviceId === device.deviceId) === index)
      .filter((device) => device.deviceId !== best.deviceId && cleanLabel(device.label).toLowerCase() !== best.label.toLowerCase())
      .sort((left, right) => labelPreference(right.label) - labelPreference(left.label))
      .slice(0, maxAlternatives);

    for (const device of devices) {
      let stream;
      try {
        stream = await mediaDevices.getUserMedia(constraints(device.deviceId));
        const level = await measure(stream, { probeMs });
        const candidate = {
          stream,
          label: cleanLabel(device.label),
          deviceId: device.deviceId,
          peak: level.peak || 0,
          rms: level.rms || 0,
          isDefault: false,
        };
        if (candidate.peak >= SIGNAL_THRESHOLD && labelPreference(candidate.label) > -1_000) {
          stopStream(best.stream);
          rememberedSelection = { ...candidate, stream: undefined };
          stream = null;
          return { ...candidate, signalDetected: true, remembered: false };
        }
        if (candidateScore(candidate) > candidateScore(best)) {
          stopStream(best.stream);
          best = candidate;
          stream = null;
        }
      } catch (_) {
        // Unavailable devices are skipped; their identifiers never leave this renderer.
      } finally {
        if (stream) stopStream(stream);
      }
    }

    return { ...best, signalDetected: best.peak >= SIGNAL_THRESHOLD };
  }

  return {
    DEFAULT_PROBE_MS,
    MAX_ALTERNATIVES,
    SIGNAL_THRESHOLD,
    candidateScore,
    cleanLabel,
    constraints,
    forgetSelection,
    labelPreference,
    measureMicrophone,
    selectMicrophone,
    stopStream,
  };
}));
