/**
 * Stable IPC failure codes. The renderer needs to branch on failure kind
 * (e.g. show "start the local server" for E_MODULE_UNAVAILABLE) without
 * parsing human messages, so codes are part of the boundary contract.
 */
export const ErrorCode = Object.freeze({
  UNKNOWN_CHANNEL: "E_UNKNOWN_CHANNEL",
  INVALID_CHANNEL: "E_INVALID_CHANNEL",
  INVALID_HANDLER: "E_INVALID_HANDLER",
  INVALID_LISTENER: "E_INVALID_LISTENER",
  DUPLICATE_CHANNEL: "E_DUPLICATE_CHANNEL",
  PAYLOAD_TOO_LARGE: "E_PAYLOAD_TOO_LARGE",
  PAYLOAD_NOT_SERIALIZABLE: "E_PAYLOAD_NOT_SERIALIZABLE",
  RESULT_NOT_SERIALIZABLE: "E_RESULT_NOT_SERIALIZABLE",
  HANDLER_FAILED: "E_HANDLER_FAILED",
  LISTENER_FAILED: "E_LISTENER_FAILED",
  MODULE_UNAVAILABLE: "E_MODULE_UNAVAILABLE",
  SESSION_START: "E_SESSION_START",
  SESSION_STATE: "E_SESSION_STATE",
  SCREEN_ANALYSE: "E_SCREEN_ANALYSE",
  CAPTURE_EMPTY: "E_CAPTURE_EMPTY",
  /** No audio source could start (e.g. the native backend is unsupported here). */
  CAPTURE_UNAVAILABLE: "E_CAPTURE_UNAVAILABLE",
  /** OS denied the microphone. The message stays generic. */
  AUDIO_DEVICE_DENIED: "E_AUDIO_DEVICE_DENIED",
  /** The saved endpoint is gone or the preference is not usable. */
  AUDIO_DEVICE_INVALID: "E_AUDIO_DEVICE_INVALID",
  /** The device mix format cannot be captured. */
  AUDIO_FORMAT: "E_AUDIO_FORMAT",
  /** The utility process exited or never became ready. */
  AUDIO_WORKER: "E_AUDIO_WORKER",
  /** A native audio call failed. The numeric code stays off the renderer. */
  AUDIO_HRESULT: "E_AUDIO_HRESULT",
  /** Device choice changes are refused while a source is open. */
  AUDIO_CAPTURE_ACTIVE: "AUDIO_CAPTURE_ACTIVE",
  CONFLICT: "CONFLICT",
  NOT_ACTIVE: "E_NOT_ACTIVE",
  INVALID_PAYLOAD: "E_INVALID_PAYLOAD",
  TIMEOUT: "E_TIMEOUT",
  FORBIDDEN_SENDER: "E_FORBIDDEN_SENDER",
  /** The file manager could not open the data folder. */
  OPEN_FOLDER: "E_OPEN_FOLDER",
  /** The default app could not open a settings file (known-terms.txt). */
  OPEN_FILE: "E_OPEN_FILE",
});
