import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

private func emit(_ payload: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
          let line = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

private func fail(_ message: String) -> Never {
    emit(["type": "error", "message": message])
    FileHandle.standardError.write(Data(("AriMeetingCapture: \(message)\n").utf8))
    exit(1)
}

private func rms(_ buffer: AVAudioPCMBuffer) -> Double {
    guard let channels = buffer.floatChannelData, buffer.frameLength > 0 else { return 0 }
    var sum = 0.0
    let count = Int(buffer.frameLength)
    for channel in 0..<Int(buffer.format.channelCount) {
        for frame in 0..<count {
            let sample = Double(channels[channel][frame])
            sum += sample * sample
        }
    }
    return min(1, sqrt(sum / Double(max(1, count * Int(buffer.format.channelCount)))))
}

private func pcmBuffer(from sampleBuffer: CMSampleBuffer) -> AVAudioPCMBuffer? {
    guard let description = CMSampleBufferGetFormatDescription(sampleBuffer),
          let streamDescription = CMAudioFormatDescriptionGetStreamBasicDescription(description) else { return nil }
    var asbd = streamDescription.pointee
    guard let format = AVAudioFormat(streamDescription: &asbd) else { return nil }
    let frameCount = AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer))
    guard frameCount > 0, let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else { return nil }
    pcm.frameLength = frameCount
    var retainedBlock: CMBlockBuffer?
    let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        sampleBuffer,
        bufferListSizeNeededOut: nil,
        bufferListOut: pcm.mutableAudioBufferList,
        bufferListSize: AVAudioBuffer.audioBufferListSize(format),
        blockBufferAllocator: kCFAllocatorDefault,
        blockBufferMemoryAllocator: kCFAllocatorDefault,
        flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment),
        blockBufferOut: &retainedBlock
    )
    return status == noErr ? pcm : nil
}

private extension AVAudioBuffer {
    static func audioBufferListSize(_ format: AVAudioFormat) -> Int {
        let buffers = format.isInterleaved ? 1 : Int(format.channelCount)
        return MemoryLayout<AudioBufferList>.size + max(0, buffers - 1) * MemoryLayout<AudioBuffer>.size
    }
}

private final class CaptureController: NSObject, SCStreamOutput, SCStreamDelegate {
    private let outputURL: URL
    private let partialURL: URL
    private let engine = AVAudioEngine()
    private let systemPlayer = AVAudioPlayerNode()
    private let stateQueue = DispatchQueue(label: "com.ari.meeting-capture.state")
    private let systemQueue = DispatchQueue(label: "com.ari.meeting-capture.system-audio")
    private var stream: SCStream?
    private var outputFile: AVAudioFile?
    private var paused = false
    private var stopping = false
    private var systemLevel = 0.0
    private var microphoneLevel = 0.0
    private var lastLevelEvent = Date.distantPast

    init(outputURL: URL) {
        self.outputURL = outputURL
        self.partialURL = outputURL.deletingPathExtension()
            .appendingPathExtension("partial")
            .appendingPathExtension(outputURL.pathExtension)
    }

    func start() async throws {
        try? FileManager.default.removeItem(at: partialURL)
        try? FileManager.default.removeItem(at: outputURL)

        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let mainDisplayID = CGMainDisplayID()
        guard let display = content.displays.first(where: { $0.displayID == mainDisplayID }) ?? content.displays.first else {
            throw NSError(domain: "AriMeetingCapture", code: 10, userInfo: [NSLocalizedDescriptionKey: "No display is available for system audio capture."])
        }
        let currentPID = ProcessInfo.processInfo.processIdentifier
        let ariApplications = content.applications.filter { $0.processID == currentPID }
        let filter = SCContentFilter(display: display, excludingApplications: ariApplications, exceptingWindows: [])
        let configuration = SCStreamConfiguration()
        configuration.capturesAudio = true
        configuration.sampleRate = 48_000
        configuration.channelCount = 2
        configuration.excludesCurrentProcessAudio = true
        configuration.width = 2
        configuration.height = 2
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)

        engine.attach(systemPlayer)
        let mixer = engine.mainMixerNode
        let input = engine.inputNode
        let microphoneFormat = input.inputFormat(forBus: 0)
        guard microphoneFormat.channelCount > 0 else {
            throw NSError(domain: "AriMeetingCapture", code: 11, userInfo: [NSLocalizedDescriptionKey: "No microphone input is available."])
        }
        engine.connect(input, to: mixer, format: microphoneFormat)
        engine.connect(systemPlayer, to: mixer, format: nil)
        let outputFormat = mixer.outputFormat(forBus: 0)
        outputFile = try AVAudioFile(forWriting: partialURL, settings: outputFormat.settings)

        input.installTap(onBus: 0, bufferSize: 2048, format: microphoneFormat) { [weak self] buffer, _ in
            self?.stateQueue.async { self?.microphoneLevel = rms(buffer) }
        }
        mixer.installTap(onBus: 0, bufferSize: 2048, format: outputFormat) { [weak self] buffer, _ in
            guard let self else { return }
            self.stateQueue.sync {
                guard !self.paused, !self.stopping else { return }
                do { try self.outputFile?.write(from: buffer) }
                catch { FileHandle.standardError.write(Data(("audio write failed: \(error.localizedDescription)\n").utf8)) }
                if Date().timeIntervalSince(self.lastLevelEvent) >= 0.2 {
                    self.lastLevelEvent = Date()
                    emit(["type": "levels", "system": self.systemLevel, "microphone": self.microphoneLevel])
                }
            }
        }

        try engine.start()
        systemPlayer.play()
        let captureStream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try captureStream.addStreamOutput(self, type: .audio, sampleHandlerQueue: systemQueue)
        stream = captureStream
        try await captureStream.startCapture()
        emit(["type": "ready", "sampleRate": 48_000, "channels": 2])
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .audio, sampleBuffer.isValid, let buffer = pcmBuffer(from: sampleBuffer) else { return }
        stateQueue.async { [weak self] in
            guard let self, !self.paused, !self.stopping else { return }
            self.systemLevel = rms(buffer)
            self.systemPlayer.scheduleBuffer(buffer, completionHandler: nil)
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        emit(["type": "error", "message": "System audio capture stopped unexpectedly."])
        FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
    }

    func pause() {
        stateQueue.sync { paused = true }
        emit(["type": "paused"])
    }

    func resume() {
        stateQueue.sync { paused = false }
        emit(["type": "resumed"])
    }

    func stop(cancel: Bool) async {
        let alreadyStopping = stateQueue.sync { () -> Bool in
            if stopping { return true }
            stopping = true
            return false
        }
        if alreadyStopping { return }
        try? await stream?.stopCapture()
        engine.inputNode.removeTap(onBus: 0)
        engine.mainMixerNode.removeTap(onBus: 0)
        systemPlayer.stop()
        engine.stop()
        outputFile = nil
        if cancel {
            try? FileManager.default.removeItem(at: partialURL)
            try? FileManager.default.removeItem(at: outputURL)
            emit(["type": "cancelled"])
        } else {
            do {
                try FileManager.default.moveItem(at: partialURL, to: outputURL)
                let attributes = try FileManager.default.attributesOfItem(atPath: outputURL.path)
                emit(["type": "finalized", "bytes": attributes[.size] as? NSNumber ?? 0])
            } catch {
                emit(["type": "error", "message": "Could not finalize the meeting recording."])
            }
        }
        fflush(stdout)
        exit(0)
    }
}

guard CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--output" else {
    fail("Usage: AriMeetingCapture --output <absolute-path>")
}
let outputPath = CommandLine.arguments[2]
guard outputPath.hasPrefix("/") else { fail("Output path must be absolute.") }
guard CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess() else {
    fail("Screen Recording permission is required to capture system audio.")
}

let microphonePermission = DispatchSemaphore(value: 0)
var microphoneAllowed = false
AVCaptureDevice.requestAccess(for: .audio) { allowed in
    microphoneAllowed = allowed
    microphonePermission.signal()
}
microphonePermission.wait()
guard microphoneAllowed else { fail("Microphone permission is required to record meetings.") }

private let controller = CaptureController(outputURL: URL(fileURLWithPath: outputPath))
Task {
    do { try await controller.start() }
    catch { fail(error.localizedDescription) }
}

FileHandle.standardInput.readabilityHandler = { handle in
    let data = handle.availableData
    guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
    for line in text.split(separator: "\n") {
        guard let commandData = String(line).data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: commandData) as? [String: Any],
              let type = object["type"] as? String else { continue }
        switch type {
        case "pause": controller.pause()
        case "resume": controller.resume()
        case "stop": Task { await controller.stop(cancel: false) }
        case "cancel": Task { await controller.stop(cancel: true) }
        default: break
        }
    }
}

dispatchMain()
