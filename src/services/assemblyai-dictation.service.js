'use strict';

const STREAMING_ROOT = 'https://streaming.assemblyai.com/v3';
const API_ROOT = 'https://api.assemblyai.com/v2';
const TOKEN_TTL_SECONDS = 60;
const MAX_SESSION_SECONDS = 600;
const DEFAULT_STREAMING_MODEL = 'universal-3-5-pro';
const STREAMING_PROMPT = [
  'Transcribe multilingual dictation verbatim with standard punctuation.',
  'The speaker may switch between Hindi and English within the same sentence (Hinglish).',
  'Preserve every language exactly as spoken and never translate.',
  'Include fillers, repetitions, false starts, and spoken self-corrections so a later cleanup step can resolve them faithfully.',
].join(' ');

async function readJson(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`AssemblyAI request failed with HTTP ${response.status}`);
    error.status = response.status;
    error.safeCode = 'ASSEMBLYAI_HTTP_ERROR';
    throw error;
  }
  return payload;
}

function createAssemblyAIDictation({
  apiKey = process.env.ASSEMBLYAI_API_KEY,
  streamingModel = process.env.ASSEMBLYAI_DICTATION_STREAMING_MODEL || DEFAULT_STREAMING_MODEL,
  fetchImpl = fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const token = String(apiKey || '').trim();
  if (!token) throw new Error('ASSEMBLYAI_API_KEY is required');
  const authorization = { authorization: token };

  async function createStreamingSession() {
    const url = new URL(`${STREAMING_ROOT}/token`);
    url.searchParams.set('expires_in_seconds', String(TOKEN_TTL_SECONDS));
    url.searchParams.set('max_session_duration_seconds', String(MAX_SESSION_SECONDS));
    const payload = await readJson(await fetchImpl(url, {
      headers: authorization,
      signal: AbortSignal.timeout(15_000),
    }));
    if (!payload.token) throw new Error('AssemblyAI did not return a streaming token');
    const websocket = new URL('wss://streaming.assemblyai.com/v3/ws');
    websocket.searchParams.set('token', payload.token);
    websocket.searchParams.set('sample_rate', '16000');
    websocket.searchParams.set('speech_model', String(streamingModel).trim() || DEFAULT_STREAMING_MODEL);
    websocket.searchParams.set('mode', 'balanced');
    websocket.searchParams.set('min_turn_silence', '160');
    websocket.searchParams.set('max_turn_silence', '2400');
    websocket.searchParams.set('language_detection', 'true');
    websocket.searchParams.set('prompt', STREAMING_PROMPT);
    return {
      websocketUrl: websocket.toString(),
      expiresInSeconds: Number(payload.expires_in_seconds) || TOKEN_TTL_SECONDS,
      maxSessionSeconds: MAX_SESSION_SECONDS,
    };
  }

  async function uploadAudio(audioBuffer) {
    if (!Buffer.isBuffer(audioBuffer) || !audioBuffer.length) throw new TypeError('audioBuffer is required');
    const payload = await readJson(await fetchImpl(`${API_ROOT}/upload`, {
      method: 'POST',
      headers: { ...authorization, 'content-type': 'application/octet-stream' },
      body: audioBuffer,
      signal: AbortSignal.timeout(60_000),
    }));
    if (!payload.upload_url) throw new Error('AssemblyAI did not return an upload URL');
    return payload.upload_url;
  }

  async function submitRecording(audioUrl) {
    const payload = await readJson(await fetchImpl(`${API_ROOT}/transcript`, {
      method: 'POST',
      headers: { ...authorization, 'content-type': 'application/json' },
      body: JSON.stringify({
        audio_url: audioUrl,
        speech_models: ['universal-3-5-pro', 'universal-2'],
        language_detection: true,
        language_detection_options: {
          code_switching: true,
          code_switching_confidence_threshold: 0.3,
        },
        format_text: true,
        prompt: STREAMING_PROMPT,
      }),
      signal: AbortSignal.timeout(30_000),
    }));
    if (!payload.id) throw new Error('AssemblyAI did not return a transcript ID');
    return payload.id;
  }

  async function pollRecording(transcriptId, { maxAttempts = 60, intervalMs = 1_500 } = {}) {
    const id = encodeURIComponent(String(transcriptId || '').trim());
    if (!id) throw new TypeError('transcriptId is required');
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const payload = await readJson(await fetchImpl(`${API_ROOT}/transcript/${id}`, {
        headers: authorization,
        signal: AbortSignal.timeout(15_000),
      }));
      if (payload.status === 'completed') {
        const codeSwitchingLanguages = payload.language_detection_results?.code_switching_languages;
        const detectedCodes = Array.isArray(codeSwitchingLanguages)
          ? codeSwitchingLanguages.map((item) => String(item?.language || '').trim()).filter(Boolean)
          : [];
        return {
          text: String(payload.text || '').trim(),
          languageCodes: [...new Set([
            ...(payload.language_code ? [String(payload.language_code)] : []),
            ...detectedCodes,
          ])].slice(0, 2),
        };
      }
      if (payload.status === 'error') {
        const error = new Error('AssemblyAI could not transcribe the recovery audio');
        error.safeCode = 'TRANSCRIPTION_FAILED';
        throw error;
      }
      if (attempt < maxAttempts) await sleep(intervalMs);
    }
    const error = new Error('AssemblyAI recovery transcription timed out');
    error.safeCode = 'TRANSCRIPTION_TIMEOUT';
    throw error;
  }

  async function transcribeRecording(audioBuffer) {
    const audioUrl = await uploadAudio(audioBuffer);
    const transcriptId = await submitRecording(audioUrl);
    return pollRecording(transcriptId);
  }

  return { createStreamingSession, pollRecording, submitRecording, transcribeRecording, uploadAudio };
}

module.exports = {
  API_ROOT,
  DEFAULT_STREAMING_MODEL,
  MAX_SESSION_SECONDS,
  STREAMING_ROOT,
  STREAMING_PROMPT,
  TOKEN_TTL_SECONDS,
  createAssemblyAIDictation,
};
