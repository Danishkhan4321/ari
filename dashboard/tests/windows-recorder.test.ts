import test from "node:test";
import assert from "node:assert/strict";
import { createWindowsMeetingRecorder } from "../app/meetings/windows-recorder";

class FakeTrack { stopped = false; stop() { this.stopped = true; } }
class FakeStream {
  constructor(public audio: FakeTrack[], public video: FakeTrack[] = []) {}
  getAudioTracks() { return this.audio as unknown as MediaStreamTrack[]; }
  getVideoTracks() { return this.video as unknown as MediaStreamTrack[]; }
  getTracks() { return [...this.audio, ...this.video] as unknown as MediaStreamTrack[]; }
}

test("Windows meeting recorder mixes system and microphone audio into five-second chunks", async () => {
  const systemAudio = new FakeTrack();
  const displayVideo = new FakeTrack();
  const microphoneAudio = new FakeTrack();
  const mediaCalls: unknown[] = [];
  const mediaDevices = {
    async getDisplayMedia(options: unknown) { mediaCalls.push(options); return new FakeStream([systemAudio], [displayVideo]) as unknown as MediaStream; },
    async getUserMedia(options: unknown) { mediaCalls.push(options); return new FakeStream([microphoneAudio]) as unknown as MediaStream; },
  };
  const connections: unknown[] = [];
  class FakeAnalyser { fftSize = 8; getByteTimeDomainData(data: Uint8Array) { data.fill(140); } }
  class FakeContext {
    destination = { stream: new FakeStream([new FakeTrack()]) };
    createMediaStreamDestination() { return this.destination; }
    createAnalyser() { return new FakeAnalyser(); }
    createMediaStreamSource(stream: unknown) { return { connect: (target: unknown) => connections.push([stream, target]) }; }
    async close() {}
  }
  class FakeRecorder {
    static isTypeSupported(type: string) { return type.includes("opus"); }
    state: RecordingState = "inactive";
    listeners = new Map<string, ((event: any) => void)[]>();
    timeslice = 0;
    addEventListener(name: string, listener: (event: any) => void) { this.listeners.set(name, [...(this.listeners.get(name) || []), listener]); }
    start(timeslice: number) { this.timeslice = timeslice; this.state = "recording"; }
    pause() { this.state = "paused"; }
    resume() { this.state = "recording"; }
    stop() {
      this.listeners.get("dataavailable")?.forEach((listener) => listener({ data: new Blob(["audio"]) }));
      this.state = "inactive";
      this.listeners.get("stop")?.forEach((listener) => listener({}));
    }
  }
  const calls: unknown[][] = [];
  const meetings = {
    async prepare(meta: unknown) { calls.push(["prepare", meta]); return { id: "session-1" }; },
    async start(id: string) { calls.push(["start", id]); },
    async writeChunk(id: string, chunk: ArrayBuffer) { calls.push(["chunk", id, chunk.byteLength]); },
    async pause(id: string) { calls.push(["pause", id]); },
    async resume(id: string) { calls.push(["resume", id]); },
    async stop(id: string) {
      assert.equal(systemAudio.stopped, true);
      assert.equal(microphoneAudio.stopped, true);
      calls.push(["stop", id]);
      return { meetingId: 7 };
    },
    async cancel(id: string) { calls.push(["cancel", id]); },
  };
  const levelCallbacks: (() => void)[] = [];
  const recorder = createWindowsMeetingRecorder({
    mediaDevices: mediaDevices as any,
    AudioContextCtor: FakeContext as any,
    MediaRecorderCtor: FakeRecorder as any,
    meetings,
    setIntervalImpl: ((callback: () => void) => { levelCallbacks.push(callback); return 1; }) as any,
    clearIntervalImpl: (() => {}) as any,
  });
  const levels: unknown[] = [];
  await recorder.start({ title: "Review", onLevels: (value) => levels.push(value) });
  levelCallbacks[0]();
  await recorder.pause();
  await recorder.resume();
  const result = await recorder.stop();
  assert.deepEqual(mediaCalls, [{ video: true, audio: true }, { audio: true, video: false }]);
  assert.equal(displayVideo.stopped, true);
  assert.equal(systemAudio.stopped, true);
  assert.equal(microphoneAudio.stopped, true);
  assert.equal(connections.length, 4);
  assert.equal((calls.find((call) => call[0] === "chunk") as unknown[])[2], 5);
  assert.equal(levels.length, 1);
  assert.deepEqual(result, { meetingId: 7 });
});

test("Windows meeting recorder fails if either source has no audio", async () => {
  const cancelled: string[] = [];
  const recorder = createWindowsMeetingRecorder({
    mediaDevices: {
      async getDisplayMedia() { return new FakeStream([], [new FakeTrack()]) as unknown as MediaStream; },
      async getUserMedia() { return new FakeStream([new FakeTrack()]) as unknown as MediaStream; },
    } as any,
    AudioContextCtor: class {} as any,
    MediaRecorderCtor: class { static isTypeSupported() { return true; } } as any,
    meetings: {
      async prepare() { return { id: "session-2" }; }, async start() {}, async writeChunk() {}, async pause() {}, async resume() {}, async stop() {},
      async cancel(id: string) { cancelled.push(id); },
    },
  });
  await assert.rejects(recorder.start(), /System audio was not shared/);
  assert.deepEqual(cancelled, ["session-2"]);
});

test("Windows meeting recorder safely retains a failed chunk and retries stop without duplicates", async () => {
  const systemAudio = new FakeTrack();
  const microphoneAudio = new FakeTrack();
  let contextClosed = false;
  class FakeContext {
    createMediaStreamDestination() { return { stream: new FakeStream([new FakeTrack()]) }; }
    createAnalyser() { return { fftSize: 8, getByteTimeDomainData(data: Uint8Array) { data.fill(128); } }; }
    createMediaStreamSource() { return { connect() {} }; }
    async close() { contextClosed = true; }
  }
  class FakeRecorder {
    static isTypeSupported() { return true; }
    state: RecordingState = "inactive";
    listeners = new Map<string, ((event: any) => void)[]>();
    addEventListener(name: string, listener: (event: any) => void) {
      this.listeners.set(name, [...(this.listeners.get(name) || []), listener]);
    }
    start() { this.state = "recording"; }
    pause() { this.state = "paused"; }
    resume() { this.state = "recording"; }
    stop() {
      this.listeners.get("dataavailable")?.forEach((listener) => listener({ data: new Blob(["retry-me"]) }));
      this.state = "inactive";
      this.listeners.get("stop")?.forEach((listener) => listener({}));
    }
  }
  let writeAttempts = 0;
  let backendStops = 0;
  const recorder = createWindowsMeetingRecorder({
    mediaDevices: {
      async getDisplayMedia() { return new FakeStream([systemAudio], [new FakeTrack()]) as unknown as MediaStream; },
      async getUserMedia() { return new FakeStream([microphoneAudio]) as unknown as MediaStream; },
    } as any,
    AudioContextCtor: FakeContext as any,
    MediaRecorderCtor: FakeRecorder as any,
    meetings: {
      async prepare() { return { id: "session-retry" }; },
      async start() {},
      async writeChunk() {
        writeAttempts += 1;
        if (writeAttempts === 1) throw new Error("C:\\secret\\capture.tmp could not be written");
      },
      async pause() {},
      async resume() {},
      async stop() { backendStops += 1; return { meetingId: 11 }; },
      async cancel() {},
    },
  });

  await recorder.start();
  await assert.rejects(recorder.stop(), (error: Error) => {
    assert.equal(error.message, "Meeting audio upload failed. Retry stopping the recording.");
    assert.doesNotMatch(error.message, /secret|capture\.tmp/i);
    return true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(systemAudio.stopped, true);
  assert.equal(microphoneAudio.stopped, true);
  assert.equal(contextClosed, true);
  assert.equal(recorder.getState(), "inactive");
  assert.equal(backendStops, 0);

  assert.deepEqual(await recorder.stop(), { meetingId: 11 });
  assert.equal(writeAttempts, 2);
  assert.equal(backendStops, 1);
});
