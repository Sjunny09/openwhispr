const fs = require("fs");
const WhisperServerManager = require("./whisperServer");
const WhisperManager = require("./whisper");
const { pcm16ToWav } = require("../utils/audioUtils");
const debugLogger = require("./debugLogger");

// Local live transcription provider.
//
// Mirrors the cloud streaming providers (see deepgramStreaming.js) so it slots into
// the existing STREAMING_PROVIDERS pipeline, but runs fully offline on whisper.cpp.
//
// Two-pass, progressive correction:
//   - Interim: a fast model (default `base`) re-transcribes the OPEN segment every
//     ~INTERIM_INTERVAL_MS -> onPartialTranscript(text). Word-level live preview.
//   - Final: when a speech pause is detected (own silence detector), the accurate
//     model (e.g. `turbo`) transcribes the just-closed segment and commits it via
//     onFinalTranscript(accumulatedText). So text is corrected DURING dictation,
//     not only at the end; stopping only has to flush the last open segment.

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const FRAME_SAMPLES = 800; // matches the AudioWorklet pcm-streaming-processor buffer
const FRAME_MS = (FRAME_SAMPLES / SAMPLE_RATE) * 1000; // 50ms

const SILENCE_RMS = 500; // int16 RMS below this counts as silence
const SILENCE_HANG_MS = 700; // trailing silence that closes a segment
const MIN_SEGMENT_MS = 350; // ignore ultra-short blips
const MAX_OPEN_SEGMENT_MS = 30000; // force-finalize a segment that never pauses
const INTERIM_INTERVAL_MS = 1200; // min gap between interim passes

function rms16(buffer) {
  const n = Math.floor(buffer.length / BYTES_PER_SAMPLE);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = buffer.readInt16LE(i * BYTES_PER_SAMPLE);
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

class LocalWhisperStreaming {
  constructor() {
    // Callback contract (set by the IPC start handler), identical to the cloud providers.
    this.onPartialTranscript = null;
    this.onFinalTranscript = null;
    this.onError = null;
    this.onSessionEnd = null;

    this.whisperHelper = new WhisperManager(); // only used for model-path resolution
    this.interimServer = null;
    this.finalServer = null;

    this.isConnected = false;
    this.language = "auto";
    this.initialPrompt = null;
    this.finalModel = "turbo";
    this.interimModel = "base";

    this.currentModel = "local-whisper"; // for usage logging parity with cloud providers
    this.audioBytesSent = 0;

    this._resetSession();
  }

  _resetSession() {
    this.segmentChunks = []; // Buffers for the currently open segment
    this.segmentBytes = 0;
    this.segmentMs = 0;
    this.silenceMs = 0;
    this.hasSpeech = false;

    this.finalSegments = [];
    this.accumulatedText = "";

    this.interimInFlight = false;
    this.lastInterimAt = 0;
    this._finalizeChain = Promise.resolve();
  }

  setTokenRefreshFn() {
    /* no-op: local provider needs no token */
  }

  getCachedToken() {
    return null;
  }

  hasWarmConnection() {
    return !!(this.finalServer && this.finalServer.ready);
  }

  async warmup(options = {}) {
    // Pre-start the servers so the first recording is responsive.
    this._applyOptions(options);
    await this._ensureServers();
    return;
  }

  _applyOptions(options = {}) {
    if (options.language) this.language = options.language;
    if (options.initialPrompt != null) this.initialPrompt = options.initialPrompt;
    else if (Array.isArray(options.keyterms) && options.keyterms.length) {
      this.initialPrompt = options.keyterms.join(", ");
    }
    if (options.finalModel) this.finalModel = options.finalModel;
    if (options.interimModel) this.interimModel = options.interimModel;
  }

  async _ensureServers() {
    if (!this.finalServer) this.finalServer = new WhisperServerManager();
    if (!this.finalServer.isAvailable()) {
      throw new Error("whisper-server binary niet beschikbaar");
    }
    if (!this.finalServer.ready) {
      const finalPath = this.whisperHelper.getModelPath(this.finalModel);
      if (!fs.existsSync(finalPath)) {
        throw new Error(`Model '${this.finalModel}' niet gedownload (${finalPath})`);
      }
      await this.finalServer.start(finalPath, {});
    }

    // Interim server (fast model). Falls back to the final server if base is missing.
    let interimPath = null;
    try {
      interimPath = this.whisperHelper.getModelPath(this.interimModel);
    } catch {
      interimPath = null;
    }
    if (interimPath && fs.existsSync(interimPath)) {
      if (!this.interimServer || this.interimServer === this.finalServer) {
        this.interimServer = new WhisperServerManager();
      }
      if (!this.interimServer.ready) {
        await this.interimServer.start(interimPath, {});
      }
    } else {
      debugLogger.debug(
        "Local streaming: interim model missing, reusing final model for preview",
        { interimModel: this.interimModel },
        "streaming"
      );
      this.interimServer = this.finalServer;
    }
  }

  async connect(options = {}) {
    this._applyOptions(options);
    this._resetSession();
    await this._ensureServers();
    this.isConnected = true;
    debugLogger.debug(
      "Local streaming connected",
      { finalModel: this.finalModel, interimModel: this.interimModel, language: this.language },
      "streaming"
    );
  }

  // PCM int16 frames arrive here (one ~50ms frame at a time from the AudioWorklet).
  sendAudio(pcmBuffer) {
    if (!this.isConnected) return false;
    const buf = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer);
    if (buf.length === 0) return true;

    this.audioBytesSent += buf.length;
    this.segmentChunks.push(buf);
    this.segmentBytes += buf.length;
    this.segmentMs += (buf.length / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000;

    const level = rms16(buf);
    if (level >= SILENCE_RMS) {
      this.silenceMs = 0;
      this.hasSpeech = true;
    } else {
      this.silenceMs += FRAME_MS;
    }

    // Close the segment on a real pause (or if it runs too long without one).
    const pausedAfterSpeech =
      this.hasSpeech && this.silenceMs >= SILENCE_HANG_MS && this.segmentMs >= MIN_SEGMENT_MS;
    const tooLong = this.segmentMs >= MAX_OPEN_SEGMENT_MS && this.hasSpeech;
    if (pausedAfterSpeech || tooLong) {
      this._closeSegment();
      return true;
    }

    // Otherwise keep the live preview fresh.
    this._maybeInterim();
    return true;
  }

  _maybeInterim() {
    const now = Date.now();
    if (this.interimInFlight) return;
    if (!this.hasSpeech) return;
    if (now - this.lastInterimAt < INTERIM_INTERVAL_MS) return;

    this.lastInterimAt = now;
    this.interimInFlight = true;
    const chunks = this.segmentChunks.slice();
    this._transcribe(this.interimServer, chunks)
      .then((text) => {
        if (text && this.isConnected) this.onPartialTranscript?.(text);
      })
      .catch((err) => {
        debugLogger.debug("Local interim transcription failed", { error: err.message }, "streaming");
      })
      .finally(() => {
        this.interimInFlight = false;
      });
  }

  // Finalize the open segment with the accurate model and commit the result.
  _closeSegment() {
    const chunks = this.segmentChunks;
    const segMs = this.segmentMs;
    // Reset the open segment immediately so new audio starts a fresh one.
    this.segmentChunks = [];
    this.segmentBytes = 0;
    this.segmentMs = 0;
    this.silenceMs = 0;
    this.hasSpeech = false;

    if (!chunks.length || segMs < MIN_SEGMENT_MS) return;

    // Serialize finalize passes so committed segments stay in order.
    this._finalizeChain = this._finalizeChain
      .then(async () => {
        const text = await this._transcribe(this.finalServer, chunks);
        if (!text || !this.isConnected) return;
        this.finalSegments.push(text);
        this.accumulatedText = this.finalSegments.join(" ");
        this.onFinalTranscript?.(this.accumulatedText, Date.now());
      })
      .catch((err) => {
        debugLogger.error("Local segment finalize failed", { error: err.message }, "streaming");
        this.onError?.(err);
      });
    return this._finalizeChain;
  }

  async _transcribe(server, chunks) {
    if (!server || !chunks || !chunks.length) return "";
    const pcm = Buffer.concat(chunks);
    const wav = pcm16ToWav(pcm, SAMPLE_RATE, 1);
    const res = await server.transcribe(wav, {
      language: this.language,
      initialPrompt: this.initialPrompt,
    });
    const text = (res && (res.text || res.transcription)) || "";
    return text.trim();
  }

  // Flush the current open segment as final (user paused/ended the utterance).
  finalize() {
    if (!this.isConnected) return false;
    this._closeSegment();
    return true;
  }

  async disconnect(closeStream = true) {
    debugLogger.debug(
      "Local streaming disconnect",
      { audioBytesSent: this.audioBytesSent, segments: this.finalSegments.length },
      "streaming"
    );
    // Flush whatever is still open, then wait for all finalize passes to complete.
    this._closeSegment();
    try {
      await this._finalizeChain;
    } catch {
      /* already reported via onError */
    }
    const text = this.accumulatedText;
    this.isConnected = false;
    // Servers are kept warm for the next recording; stopped in cleanup().
    const result = { text };
    this._resetSession();
    return result;
  }

  async cleanup() {
    this.isConnected = false;
    const servers = new Set([this.interimServer, this.finalServer].filter(Boolean));
    this.interimServer = null;
    this.finalServer = null;
    for (const server of servers) {
      try {
        await server.stop();
      } catch (err) {
        debugLogger.debug("Local streaming server stop failed", { error: err.message }, "streaming");
      }
    }
  }

  async cleanupAll() {
    await this.cleanup();
  }

  getStatus() {
    return {
      isConnected: this.isConnected,
      finalModel: this.finalModel,
      interimModel: this.interimModel,
      serverReady: this.hasWarmConnection(),
    };
  }
}

module.exports = LocalWhisperStreaming;
