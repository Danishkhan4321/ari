'use strict';

const API_ROOT = 'https://api.assemblyai.com/v2/transcript';

async function defaultHttp({ method, url, headers, body, timeoutMs }) {
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`AssemblyAI request failed with HTTP ${response.status}`);
    error.status = response.status;
    error.safeCode = 'ASSEMBLYAI_HTTP_ERROR';
    throw error;
  }
  return payload;
}

function normalizeUtterances(utterances = []) {
  return utterances.map((utterance) => ({
    speakerId: String(utterance.speaker || 'A').replace(/^Speaker\s+/i, ''),
    startMs: Number(utterance.start || 0),
    endMs: Number(utterance.end || 0),
    text: String(utterance.text || '').trim(),
    confidence: Number.isFinite(utterance.confidence) ? utterance.confidence : null,
  })).filter((utterance) => utterance.text);
}

function createAssemblyAIClient({
  apiKey = process.env.ASSEMBLYAI_API_KEY,
  http = defaultHttp,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const token = String(apiKey || '').trim();
  if (!token) throw new Error('ASSEMBLYAI_API_KEY is required');
  const headers = { authorization: token, 'content-type': 'application/json' };

  async function submit(audioUrl) {
    const url = String(audioUrl || '').trim();
    if (!/^https:\/\//i.test(url)) throw new TypeError('AssemblyAI requires an HTTPS audio URL');
    return http({
      method: 'POST',
      url: API_ROOT,
      headers,
      timeoutMs: 30_000,
      body: {
        audio_url: url,
        speaker_labels: true,
        language_detection: true,
      },
    });
  }

  async function get(transcriptId) {
    const id = encodeURIComponent(String(transcriptId || '').trim());
    if (!id) throw new TypeError('transcriptId is required');
    return http({ method: 'GET', url: `${API_ROOT}/${id}`, headers, timeoutMs: 30_000 });
  }

  async function poll(transcriptId, { maxAttempts = 120, intervalMs = 5_000 } = {}) {
    const attempts = Math.min(240, Math.max(1, Number(maxAttempts) || 120));
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const response = await get(transcriptId);
      if (response.status === 'completed') {
        const segments = normalizeUtterances(response.utterances);
        const inferredDuration = segments.reduce((max, segment) => Math.max(max, segment.endMs), 0) / 1000;
        return {
          transcriptId: response.id || String(transcriptId),
          segments,
          durationSeconds: Number(response.audio_duration) || inferredDuration,
          raw: response,
        };
      }
      if (response.status === 'error') {
        const error = new Error('AssemblyAI could not transcribe this recording');
        error.safeCode = 'TRANSCRIPTION_FAILED';
        throw error;
      }
      if (attempt < attempts) await sleep(Math.max(0, Number(intervalMs) || 0));
    }
    const error = new Error('AssemblyAI transcription timed out');
    error.safeCode = 'TRANSCRIPTION_TIMEOUT';
    throw error;
  }

  return { submit, get, poll };
}

module.exports = { createAssemblyAIClient, normalizeUtterances };
