'use strict';

const PROGRESS_CHANNEL = 'desktop:meetings:progress';

function publicSession(session) {
  return {
    id: session.id,
    state: session.state,
    platform: session.platform,
    codec: session.codec,
    title: session.title,
    bytes: session.bytes,
    meetingId: session.meetingId,
    processingStage: session.processingStage,
  };
}

function createMeetingIpcHandlers({ sessionManager, backendClient, nativeMacHelper, fromLocalDashboard, platform = process.platform, available = true }) {
  const owners = new Map();
  const nativeSessions = new Map();

  function assertLocal(event) {
    if (!fromLocalDashboard(event)) throw new Error('Meeting recording is unavailable outside Ari.');
  }

  function assertOwner(event, sessionId) {
    assertLocal(event);
    if (!sessionId || owners.get(sessionId) !== event.sender.id) {
      throw new Error('Capture session does not belong to this window.');
    }
  }

  return {
    capabilities(event) {
      assertLocal(event);
      const supported = available && (platform === 'win32' || platform === 'darwin');
      return { supported, platform, systemAudio: supported, microphone: supported };
    },
    async prepare(event, metadata = {}) {
      assertLocal(event);
      if (!available) throw new Error('Desktop meeting identity is not configured.');
      const session = await sessionManager.prepare({
        platform,
        codec: String(metadata.codec || (platform === 'darwin' ? 'caf-pcm' : 'webm-opus')),
        title: metadata.title,
      });
      owners.set(session.id, event.sender.id);
      return publicSession(session);
    },
    async start(event, sessionId) {
      assertOwner(event, sessionId);
      const session = await sessionManager.start(sessionId);
      if (platform === 'darwin') {
        if (!nativeMacHelper) throw new Error('macOS meeting capture helper is unavailable.');
        const native = await nativeMacHelper.start({ outputPath: session.recordingPath });
        native.events.on('levels', (levels) => event.sender.send(PROGRESS_CHANNEL, { sessionId, phase: 'recording', levels }));
        nativeSessions.set(sessionId, native);
      }
      return publicSession(session);
    },
    async writeChunk(event, sessionId, chunk) {
      assertOwner(event, sessionId);
      if (platform === 'darwin') throw new Error('macOS meeting audio is written by the native capture helper.');
      const bytes = Buffer.isBuffer(chunk) ? chunk
        : chunk instanceof ArrayBuffer ? Buffer.from(chunk)
          : ArrayBuffer.isView(chunk) ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
            : null;
      if (!bytes) throw new TypeError('Meeting audio chunk must be binary data');
      const session = await sessionManager.writeChunk(sessionId, bytes);
      return { id: session.id, state: session.state, bytes: session.bytes };
    },
    async pause(event, sessionId) {
      assertOwner(event, sessionId);
      if (platform === 'darwin') nativeMacHelper.pause();
      return publicSession(await sessionManager.pause(sessionId));
    },
    async resume(event, sessionId) {
      assertOwner(event, sessionId);
      if (platform === 'darwin') nativeMacHelper.resume();
      return publicSession(await sessionManager.resume(sessionId));
    },
    async stop(event, sessionId) {
      assertOwner(event, sessionId);
      if (platform === 'darwin' && nativeSessions.has(sessionId)) {
        const native = nativeSessions.get(sessionId);
        await nativeMacHelper.stop(native.events);
        nativeSessions.delete(sessionId);
      }
      let session = await sessionManager.stop(sessionId);
      session = await sessionManager.markUploading(sessionId);
      try {
        const result = await backendClient.upload(session, {
          onProgress: (progress) => event.sender.send(PROGRESS_CHANNEL, { sessionId, phase: 'uploading', ...progress }),
        });
        const submitted = await sessionManager.markSubmitted(sessionId, result);
        owners.delete(sessionId);
        event.sender.send(PROGRESS_CHANNEL, { sessionId, phase: 'submitted', meetingId: result.meetingId, processingStage: result.processingStage });
        return publicSession(submitted);
      } catch (error) {
        await sessionManager.markFailed(sessionId, error.message).catch(() => {});
        throw error;
      }
    },
    async cancel(event, sessionId) {
      assertOwner(event, sessionId);
      if (platform === 'darwin' && nativeSessions.has(sessionId)) {
        nativeMacHelper.cancel();
        nativeSessions.delete(sessionId);
      }
      const session = await sessionManager.cancel(sessionId);
      owners.delete(sessionId);
      return publicSession(session);
    },
  };
}

function registerMeetingIpc({ ipcMain, ...dependencies }) {
  const handlers = createMeetingIpcHandlers(dependencies);
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle(`desktop:meetings:${name}`, handler);
  }
  return handlers;
}

module.exports = { PROGRESS_CHANNEL, createMeetingIpcHandlers, registerMeetingIpc };
