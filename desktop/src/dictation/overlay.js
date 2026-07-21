'use strict';

const bridge = window.ariDictation;
const microphoneSelector = window.ariMicrophoneSelector;
const turnTools = window.ariDictationTurns;
const bar = document.getElementById('bar');
const title = document.getElementById('title');
const detail = document.getElementById('detail');
const preview = document.getElementById('preview');
const actions = document.getElementById('actions');
const retryButton = document.getElementById('retry');
const copyButton = document.getElementById('copy-last');
const dismissButton = document.getElementById('dismiss');
const elapsed = document.getElementById('elapsed');
const waveform = document.getElementById('waveform');
const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

let current = null;
let microphoneTestRunning = false;
const MAX_QUEUED_AUDIO_FRAMES = 200;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function elapsedText(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function updateElapsed(session) {
  const end = session.recordingEndedAt || performance.now();
  const value = elapsedText(end - session.startedAt);
  elapsed.textContent = value;
  elapsed.dateTime = `PT${Math.max(0, Math.floor((end - session.startedAt) / 1000))}S`;
}

function startElapsedTimer(session) {
  session.startedAt = performance.now();
  updateElapsed(session);
  session.elapsedTimer = setInterval(() => updateElapsed(session), 250);
}

function stopElapsedTimer(session) {
  if (!session?.startedAt) return;
  if (!session.recordingEndedAt) session.recordingEndedAt = performance.now();
  if (session.elapsedTimer) clearInterval(session.elapsedTimer);
  session.elapsedTimer = null;
  updateElapsed(session);
}

let displayedLevel = 0.08;

function waveformLevel(timestamp) {
  const state = bar.dataset.state;
  if (state === 'finalizing' || state === 'polishing' || state === 'pasting') {
    return reduceMotion ? 0.32 : 0.32 + (Math.sin(timestamp / 230) + 1) * 0.08;
  }
  return Math.min(1, Math.max(0.06, Number(current?.liveLevel || 0) * 9));
}

function drawWaveform(timestamp = 0) {
  const bounds = waveform.getBoundingClientRect();
  const width = Math.max(1, bounds.width);
  const height = Math.max(1, bounds.height);
  const scale = Math.min(2, window.devicePixelRatio || 1);
  const pixelWidth = Math.round(width * scale);
  const pixelHeight = Math.round(height * scale);
  if (waveform.width !== pixelWidth || waveform.height !== pixelHeight) {
    waveform.width = pixelWidth;
    waveform.height = pixelHeight;
  }

  const context = waveform.getContext('2d');
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, width, height);

  const targetLevel = waveformLevel(timestamp);
  displayedLevel += (targetLevel - displayedLevel) * 0.16;
  const expanded = bar.dataset.expanded === 'true';
  const amplitude = expanded ? 6.5 : 2.2 + displayedLevel * 10.5;
  const phase = reduceMotion ? 0 : timestamp * 0.0022;
  const points = [];
  const steps = Math.max(48, Math.floor(width));
  for (let index = 0; index <= steps; index += 1) {
    const normalized = index / steps;
    const progress = 0.04 + normalized * 0.92;
    const envelope = Math.pow(Math.sin(Math.PI * normalized), 1.15);
    const modulation = 0.78 + Math.sin(normalized * Math.PI * 3 + phase * 0.45) * 0.22;
    const y = height / 2
      + Math.sin(normalized * Math.PI * 8.2 + phase) * amplitude * envelope * modulation;
    points.push([progress * width, y]);
  }

  const path = new Path2D();
  points.forEach(([x, y], index) => (index ? path.lineTo(x, y) : path.moveTo(x, y)));
  const state = bar.dataset.state;
  const expandedLine = state === 'failed' || state === 'success' ? '#fffdf3' : '#0a0a0a';
  const gradient = context.createLinearGradient(0, 0, width, 0);
  if (expanded) {
    gradient.addColorStop(0, expandedLine);
    gradient.addColorStop(1, expandedLine);
  } else {
    gradient.addColorStop(0, 'rgba(247, 221, 42, 0.08)');
    gradient.addColorStop(0.16, 'rgba(247, 221, 42, 0.55)');
    gradient.addColorStop(0.5, '#f7dd2a');
    gradient.addColorStop(0.84, 'rgba(247, 221, 42, 0.55)');
    gradient.addColorStop(1, 'rgba(247, 221, 42, 0.08)');
  }

  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.strokeStyle = gradient;
  context.globalAlpha = 1;
  context.lineWidth = expanded ? 2.2 : 2;
  context.shadowColor = 'transparent';
  context.shadowBlur = 0;
  context.stroke(path);
  context.setTransform(1, 0, 0, 1, 0, 0);
  window.requestAnimationFrame(drawWaveform);
}

window.requestAnimationFrame(drawWaveform);

function setUi(state, heading, message, {
  showActions = false,
  previewText = '',
  expanded = showActions,
  visible = showActions ? true : undefined,
} = {}) {
  bar.dataset.state = state;
  bar.dataset.expanded = String(Boolean(expanded));
  bar.dataset.hasPreview = String(Boolean(previewText));
  title.textContent = heading;
  detail.textContent = message;
  preview.textContent = previewText;
  preview.hidden = !previewText;
  actions.hidden = !showActions;
  void bridge.setState({
    state: state === 'success' ? 'idle' : state,
    expanded: Boolean(expanded),
    variant: expanded && state === 'success' ? 'ready' : expanded ? 'recovery' : 'default',
    visible,
  }).catch(() => {});
}

function recorderMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return candidates.find((candidate) => window.MediaRecorder?.isTypeSupported?.(candidate)) || '';
}

function startFailure(error) {
  const message = String(error?.message || error || '').toLowerCase();
  if (error?.name === 'NotAllowedError' || message.includes('permission') || message.includes('notallowed')) {
    return { heading: 'Microphone permission needed', message: 'Allow microphone access in Windows settings and try again.' };
  }
  if (error?.name === 'NotFoundError' || message.includes('requested device not found')) {
    return { heading: 'No microphone found', message: 'Connect or enable an input device and try again.' };
  }
  if (message.includes('authentication') || message.includes('backend') || message.includes('dictation service') || message.includes('http 401')) {
    return { heading: 'Ari needs to restart', message: 'Flowtype is out of sync. Quit Ari from the tray, then reopen it.' };
  }
  if (message.includes('assemblyai') || message.includes('temporarily unavailable') || message.includes('not configured')) {
    return { heading: 'Transcription unavailable', message: 'Ari could not connect to AssemblyAI. Check your connection and try again.' };
  }
  return { heading: 'Flowtype could not start', message: 'Flowtype could not initialize audio. Try again or test the microphone in Settings.' };
}

function transcriptText(session) {
  return turnTools.transcriptText(session.turns);
}

function listeningMessage(session) {
  return session.mode === 'hands-free' ? 'Press the shortcut again to finish' : 'Release the shortcut to finish';
}

function updatePreview(session) {
  const text = transcriptText(session);
  if (!text) return;
  preview.textContent = text.slice(-180);
  preview.hidden = false;
}

function sendAudio(session, buffer) {
  if (session.cancelled || session.finalizing) return;
  if (session.socket?.readyState === WebSocket.OPEN && session.socketReady) {
    session.socket.send(buffer);
    return;
  }
  if (session.audioQueue.length >= MAX_QUEUED_AUDIO_FRAMES) {
    session.streamFailed = true;
    return;
  }
  session.audioQueue.push(buffer);
}

function flushAudioQueue(session) {
  if (!session.socketReady || session.socket.readyState !== WebSocket.OPEN || !session.audioQueue.length) return;
  const totalBytes = session.audioQueue.reduce((sum, item) => sum + item.byteLength, 0);
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const item of session.audioQueue) {
    combined.set(new Uint8Array(item), offset);
    offset += item.byteLength;
  }
  session.audioQueue.length = 0;
  session.socket.send(combined.buffer);
}

function handleSocketMessage(session, event) {
  let message;
  try { message = JSON.parse(event.data); } catch (_) { return; }
  if (message.type === 'Begin') {
    session.socketReady = true;
    flushAudioQueue(session);
    if (!session.finalizing) setUi('listening', 'Listening', listeningMessage(session));
    return;
  }
  if (message.type === 'Turn') {
    turnTools.upsertTurn(session.turns, message);
    if (message.language_code) session.languages.add(String(message.language_code));
    updatePreview(session);
    if (message.end_of_turn && session.finalTurnResolve) {
      // A previously completed turn can still be in flight when ForceEndpoint is
      // sent. Wait briefly for the forced final turn as well before terminating
      // the socket, otherwise the last (often code-switched) phrase can be lost.
      if (session.finalTurnSettleTimer) clearTimeout(session.finalTurnSettleTimer);
      session.finalTurnSettleTimer = setTimeout(() => {
        session.finalTurnSettleTimer = null;
        session.finalTurnResolve?.();
        session.finalTurnResolve = null;
      }, 450);
    }
    return;
  }
  if (message.type === 'Termination' && session.terminationResolve) {
    session.terminationResolve();
    session.terminationResolve = null;
  }
}

async function startCapture(session) {
  const configPromise = bridge.session().then(
    (config) => ({ config }),
    (error) => ({ error }),
  );
  setUi('listening', 'Listening', listeningMessage(session));
  const selection = await microphoneSelector.selectMicrophone();
  const { stream } = selection;
  if (session.cancelled) {
    stream.getTracks().forEach((track) => track.stop());
    return;
  }
  session.stream = stream;
  session.microphoneLabel = selection.label;
  session.microphoneDeviceId = selection.deviceId;
  session.probeSignalDetected = selection.signalDetected;

  const mimeType = recorderMimeType();
  session.recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  session.mimeType = session.recorder.mimeType || mimeType || 'audio/webm';
  session.recorder.addEventListener('dataavailable', (event) => {
    if (event.data?.size) session.recordedChunks.push(event.data);
  });
  session.recorder.start(500);

  session.audioContext = new AudioContext({ sampleRate: 16000 });
  await session.audioContext.audioWorklet.addModule(new URL('pcm-worklet.js', location.href).href);
  session.worklet = new AudioWorkletNode(session.audioContext, 'ari-pcm-processor');
  session.source = session.audioContext.createMediaStreamSource(stream);
  session.muted = session.audioContext.createGain();
  session.muted.gain.value = 0;
  session.source.connect(session.worklet);
  session.worklet.connect(session.muted);
  session.muted.connect(session.audioContext.destination);
  session.worklet.port.onmessage = (event) => {
    if (event.data?.type === 'audio') sendAudio(session, event.data.buffer);
    if (event.data?.type === 'level') {
      session.liveLevel = Number(event.data.value) || 0;
      session.maxLevel = Math.max(session.maxLevel, session.liveLevel);
    }
  };

  const configResult = await configPromise;
  if (configResult.error) throw configResult.error;
  const { config } = configResult;
  if (session.cancelled) return;
  session.socket = new WebSocket(config.websocketUrl);
  session.socket.binaryType = 'arraybuffer';
  session.socket.addEventListener('open', () => {
    if (session.cancelled) {
      try { session.socket.send(JSON.stringify({ type: 'Terminate' })); } catch (_) {}
      session.socket.close();
      return;
    }
    session.socketReady = true;
    flushAudioQueue(session);
    if (!session.finalizing) setUi('listening', 'Listening', listeningMessage(session));
  });
  session.socket.addEventListener('message', (event) => handleSocketMessage(session, event));
  session.socket.addEventListener('error', () => { session.streamFailed = true; });
  session.socket.addEventListener('close', () => {
    if (!session.finalizing && !session.cancelled) session.streamFailed = true;
  });

  session.limitTimer = setTimeout(() => void finalize(session), Math.max(1, Number(config.maxSessionSeconds || 600) - 5) * 1000);
  if (session.stopRequested) await finalize(session);
}

async function stopCapture(session) {
  if (session.limitTimer) clearTimeout(session.limitTimer);
  session.worklet?.disconnect();
  session.source?.disconnect();
  session.muted?.disconnect();
  if (session.recorder && session.recorder.state !== 'inactive') {
    await new Promise((resolve) => {
      session.recorder.addEventListener('stop', resolve, { once: true });
      session.recorder.stop();
    });
  }
  session.stream?.getTracks().forEach((track) => track.stop());
  if (session.audioContext && session.audioContext.state !== 'closed') await session.audioContext.close().catch(() => {});
}

async function finishSocket(session) {
  if (!session.socket || session.socket.readyState !== WebSocket.OPEN || session.streamFailed) return;
  const finalTurn = new Promise((resolve) => { session.finalTurnResolve = resolve; });
  session.socket.send(JSON.stringify({ type: 'ForceEndpoint' }));
  await Promise.race([finalTurn, delay(4000)]);
  if (session.finalTurnSettleTimer) clearTimeout(session.finalTurnSettleTimer);
  session.finalTurnSettleTimer = null;
  session.finalTurnResolve = null;
  if (session.socket.readyState !== WebSocket.OPEN) return;
  const termination = new Promise((resolve) => { session.terminationResolve = resolve; });
  session.socket.send(JSON.stringify({ type: 'Terminate' }));
  await Promise.race([termination, delay(1500)]);
}

function recoveryBlob(session) {
  return session.recordedChunks.length ? new Blob(session.recordedChunks, { type: session.mimeType }) : null;
}

async function deliver(session, rawText, polishedText) {
  setUi('pasting', 'Pasting', 'Sending your polished text to the active app');
  const result = await bridge.complete({ rawText, text: polishedText });
  if (!result?.ok) throw new Error(result?.error || 'The transcript could not be delivered');
  session.recordedChunks.length = 0;
  current = null;
  if (result.pasted) {
    setUi('success', 'Done', 'Your Flowtype text is ready');
    await delay(900);
    await bridge.dismiss();
    return;
  }
  setUi('success', 'Text ready', 'The active window changed. Use Paste Last.', {
    showActions: true,
    previewText: turnTools.compactPreview(polishedText, 3),
  });
  retryButton.hidden = true;
  copyButton.hidden = false;
}

async function retryFromAudio(session) {
  const blob = recoveryBlob(session);
  if (!blob) throw new Error('No recovery audio is available');
  setUi('finalizing', 'Transcribing', 'Recovering your Flowtype recording', { visible: true });
  const result = await bridge.retry(await blob.arrayBuffer(), blob.type || session.mimeType);
  await deliver(session, result.rawText, result.text);
}

async function processTranscript(session) {
  const raw = transcriptText(session);
  if (session.streamFailed) return retryFromAudio(session);
  if (!raw && session.maxLevel < 0.01) {
    microphoneSelector.forgetSelection();
    session.recordedChunks.length = 0;
    current = null;
    setUi('success', 'No speech detected', `${session.microphoneLabel || 'The microphone'} did not receive speech`);
    await delay(1200);
    return bridge.dismiss();
  }
  if (!raw) return retryFromAudio(session);
  setUi('polishing', 'Polishing', 'Fixing grammar, punctuation, and formatting', { previewText: raw.slice(-180) });
  const polished = await bridge.polish({ rawText: raw, languageCodes: [...session.languages] });
  if (!String(polished.text || '').trim()) {
    session.recordedChunks.length = 0;
    current = null;
    setUi('success', 'No speech detected', 'Nothing was pasted');
    await delay(700);
    return bridge.dismiss();
  }
  return deliver(session, raw, polished.text);
}

async function finalize(session) {
  if (!session || session.cancelled) return;
  if (session.starting) {
    session.stopRequested = true;
    return;
  }
  if (session.finalizing) return;
  session.finalizing = true;
  stopElapsedTimer(session);
  setUi('finalizing', 'Transcribing', 'Completing the transcript', { visible: true });
  try {
    await stopCapture(session);
    await finishSocket(session);
    try { session.socket?.close(); } catch (_) {}
    await processTranscript(session);
  } catch (_) {
    setUi('failed', 'Audio saved', 'Transcription needs another pass', { showActions: true, previewText: transcriptText(session).slice(-180) });
    retryButton.hidden = !recoveryBlob(session);
    copyButton.hidden = !transcriptText(session);
    await bridge.setState({ state: 'failed', expanded: true }).catch(() => {});
  }
}

async function start(command) {
  if (current && !current.cancelled) return;
  const session = {
    mode: command.mode,
    appCategory: command.appCategory || 'generic',
    starting: true,
    stopRequested: false,
    finalizing: false,
    cancelled: false,
    streamFailed: false,
    socketReady: false,
    turns: new Map(),
    languages: new Set(),
    audioQueue: [],
    recordedChunks: [],
    maxLevel: 0,
  };
  current = session;
  startElapsedTimer(session);
  retryButton.hidden = false;
  copyButton.hidden = false;
  setUi('listening', 'Listening', listeningMessage(session));
  try {
    await startCapture(session);
    session.starting = false;
    if (session.stopRequested) await finalize(session);
  } catch (error) {
    session.starting = false;
    session.streamFailed = true;
    stopElapsedTimer(session);
    await stopCapture(session).catch(() => {});
    const failure = startFailure(error);
    setUi('failed', failure.heading, failure.message, { showActions: true });
    retryButton.hidden = true;
    copyButton.hidden = true;
  }
}

async function cancel({ preserveText = false } = {}) {
  if (!current) return bridge.dismiss();
  const session = current;
  session.cancelled = true;
  stopElapsedTimer(session);
  if (session.limitTimer) clearTimeout(session.limitTimer);
  if (session.finalTurnSettleTimer) clearTimeout(session.finalTurnSettleTimer);
  try {
    if (session.socket?.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify({ type: 'Terminate' }));
    session.socket?.close();
  } catch (_) {}
  await stopCapture(session).catch(() => {});
  session.recordedChunks.length = 0;
  session.audioQueue.length = 0;
  current = null;
  setUi('cancelled', 'Cancelled', 'Nothing was pasted', { visible: false });
  return bridge.dismiss(preserveText ? { recoveryText: transcriptText(session) } : undefined);
}

async function testMicrophone() {
  if (microphoneTestRunning || current) return;
  microphoneTestRunning = true;
  setUi('starting', 'Testing microphone', 'Listening briefly for microphone access');
  try {
    const selection = await microphoneSelector.selectMicrophone({ probeMs: 350 });
    microphoneSelector.stopStream(selection.stream);
    if (!selection.signalDetected) {
      setUi('failed', 'Microphone is silent', `${selection.label} is connected but no audio was detected.`, { showActions: true });
      retryButton.hidden = true;
      copyButton.hidden = true;
    } else {
      setUi('success', 'Microphone ready', `Auto-detected ${selection.label}`, { expanded: true });
    }
  } catch (_) {
    setUi('failed', 'Microphone blocked', 'Allow microphone access in system settings.', { showActions: true });
    retryButton.hidden = true;
    copyButton.hidden = true;
  } finally {
    microphoneTestRunning = false;
  }
}

bridge.onCommand((command) => {
  if (command?.type === 'start') void start(command);
  if (command?.type === 'stop' && current) {
    current.stopRequested = true;
    if (!current.starting) void finalize(current);
  }
  if (command?.type === 'cancel') void cancel();
  if (command?.type === 'test-microphone') void testMicrophone();
});

retryButton.addEventListener('click', () => {
  if (!current) return;
  void retryFromAudio(current).catch(() => {
    setUi('failed', 'Retry failed', 'The temporary audio is still available. Check your connection and try again.', {
      showActions: true,
      previewText: transcriptText(current).slice(-180),
    });
    retryButton.hidden = !recoveryBlob(current);
    copyButton.hidden = !transcriptText(current);
  });
});
copyButton.addEventListener('click', () => void bridge.copyLast(current ? transcriptText(current) : ''));
dismissButton.addEventListener('click', () => void cancel({ preserveText: true }));
