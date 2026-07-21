type MeetingBridge = {
  prepare(metadata: { title?: string; codec: string }): Promise<{ id: string }>;
  start(sessionId: string): Promise<unknown>;
  writeChunk(sessionId: string, chunk: ArrayBuffer): Promise<unknown>;
  pause(sessionId: string): Promise<unknown>;
  resume(sessionId: string): Promise<unknown>;
  stop(sessionId: string): Promise<unknown>;
  cancel(sessionId: string): Promise<unknown>;
};

type RecorderDependencies = {
  mediaDevices: Pick<MediaDevices, "getDisplayMedia" | "getUserMedia">;
  AudioContextCtor: typeof AudioContext;
  MediaRecorderCtor: typeof MediaRecorder;
  meetings: MeetingBridge;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
};

export function createWindowsMeetingRecorder({
  mediaDevices,
  AudioContextCtor,
  MediaRecorderCtor,
  meetings,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
}: RecorderDependencies) {
  let sessionId: string | null = null;
  let systemStream: MediaStream | null = null;
  let microphoneStream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let recorder: MediaRecorder | null = null;
  let levelTimer: ReturnType<typeof setInterval> | null = null;
  let chunkQueue: Promise<void> = Promise.resolve();
  let retainedChunks: ArrayBuffer[] = [];
  let chunkWriteFailed = false;
  let chunkFailureReported = false;
  let stopPromise: Promise<void> | null = null;

  function safeChunkWriteError() {
    return new Error("Meeting audio upload failed. Retry stopping the recording.");
  }

  async function writeRetainedChunks(targetSession: string) {
    chunkWriteFailed = false;
    while (retainedChunks.length > 0) {
      try {
        await meetings.writeChunk(targetSession, retainedChunks[0]);
        retainedChunks.shift();
      } catch {
        chunkWriteFailed = true;
        throw safeChunkWriteError();
      }
    }
  }

  function resetChunkState() {
    chunkQueue = Promise.resolve();
    retainedChunks = [];
    chunkWriteFailed = false;
    chunkFailureReported = false;
  }

  function chooseMimeType() {
    for (const candidate of ["audio/webm;codecs=opus", "audio/webm"]) {
      if (MediaRecorderCtor.isTypeSupported(candidate)) return candidate;
    }
    throw new Error("This Windows installation cannot encode meeting audio.");
  }

  function level(analyser: AnalyserNode) {
    const samples = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(samples);
    const energy = samples.reduce((sum, sample) => sum + ((sample - 128) / 128) ** 2, 0);
    return Math.min(1, Math.sqrt(energy / samples.length));
  }

  function cleanup() {
    if (levelTimer) clearIntervalImpl(levelTimer);
    levelTimer = null;
    for (const stream of [systemStream, microphoneStream]) stream?.getTracks().forEach((track) => track.stop());
    systemStream = null;
    microphoneStream = null;
    const closing = context?.close();
    context = null;
    recorder = null;
    return closing;
  }

  async function start({ title, onLevels }: { title?: string; onLevels?: (levels: { system: number; microphone: number }) => void } = {}) {
    if (sessionId) throw new Error("A meeting recording is already active.");
    const mimeType = chooseMimeType();
    const prepared = await meetings.prepare({ title, codec: mimeType });
    sessionId = prepared.id;
    try {
      systemStream = await mediaDevices.getDisplayMedia({ video: true, audio: true });
      microphoneStream = await mediaDevices.getUserMedia({ audio: true, video: false });
      if (!systemStream.getAudioTracks().length) throw new Error("System audio was not shared. Select a screen and enable audio.");
      if (!microphoneStream.getAudioTracks().length) throw new Error("No microphone audio is available.");
      systemStream.getVideoTracks().forEach((track) => track.stop());

      context = new AudioContextCtor({ sampleRate: 48_000 });
      const destination = context.createMediaStreamDestination();
      const systemAnalyser = context.createAnalyser();
      const microphoneAnalyser = context.createAnalyser();
      systemAnalyser.fftSize = 1024;
      microphoneAnalyser.fftSize = 1024;
      const systemSource = context.createMediaStreamSource(systemStream);
      const microphoneSource = context.createMediaStreamSource(microphoneStream);
      systemSource.connect(destination);
      systemSource.connect(systemAnalyser);
      microphoneSource.connect(destination);
      microphoneSource.connect(microphoneAnalyser);

      recorder = new MediaRecorderCtor(destination.stream, { mimeType, audioBitsPerSecond: 192_000 });
      recorder.addEventListener("dataavailable", (event: BlobEvent) => {
        if (!event.data?.size || !sessionId) return;
        const targetSession = sessionId;
        chunkQueue = chunkQueue.then(async () => {
          retainedChunks.push(await event.data.arrayBuffer());
          if (!chunkWriteFailed) await writeRetainedChunks(targetSession);
        }).catch(() => {
          chunkWriteFailed = true;
        });
      });
      await meetings.start(sessionId);
      recorder.start(5_000);
      if (onLevels) levelTimer = setIntervalImpl(() => onLevels({ system: level(systemAnalyser), microphone: level(microphoneAnalyser) }), 200);
      return { sessionId, mimeType };
    } catch (error) {
      await meetings.cancel(sessionId).catch(() => undefined);
      await cleanup();
      sessionId = null;
      resetChunkState();
      throw error;
    }
  }

  async function pause() {
    if (!sessionId || recorder?.state !== "recording") throw new Error("No active meeting recording.");
    recorder.pause();
    await meetings.pause(sessionId);
  }

  async function resume() {
    if (!sessionId || recorder?.state !== "paused") throw new Error("Meeting recording is not paused.");
    recorder.resume();
    await meetings.resume(sessionId);
  }

  async function finishRecorder() {
    if (recorder && recorder.state !== "inactive") {
      stopPromise ||= new Promise<void>((resolve) => recorder?.addEventListener("stop", () => resolve(), { once: true }));
      recorder.stop();
      await stopPromise;
    }
    await chunkQueue;
  }

  async function stop() {
    if (!sessionId) throw new Error("No active meeting recording.");
    const targetSession = sessionId;
    const retryingFailedUpload = chunkFailureReported;
    await finishRecorder();
    await cleanup();
    stopPromise = null;
    if (chunkWriteFailed && !retryingFailedUpload) {
      chunkFailureReported = true;
      throw safeChunkWriteError();
    }
    try {
      await writeRetainedChunks(targetSession);
    } catch {
      chunkFailureReported = true;
      throw safeChunkWriteError();
    }
    const result = await meetings.stop(targetSession);
    sessionId = null;
    resetChunkState();
    return result;
  }

  async function cancel() {
    if (!sessionId) return;
    const targetSession = sessionId;
    try {
      await finishRecorder();
      await meetings.cancel(targetSession);
    } finally {
      try {
        await cleanup();
      } finally {
        sessionId = null;
        stopPromise = null;
        resetChunkState();
      }
    }
  }

  return { start, pause, resume, stop, cancel, getState: () => recorder?.state || "inactive" };
}
