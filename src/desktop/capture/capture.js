/**
 * Hidden capture renderer: holds ONE low-rate display stream for the active
 * session and turns its latest frame into a JPEG on request. All pixel work
 * (decode, scale, encode) happens here, off Electron's main thread.
 * Driven from main via webContents.executeJavaScript (screen-grabber.js).
 *
 * Frames are pulled with MediaStreamTrackProcessor and the newest one is kept:
 * a <video> element in a hidden page gets its playback suspended after a few
 * idle seconds, which made a later grab wait ~1 s for the media pipeline to
 * resume. Reading the track directly does not depend on playback.
 *
 * JPEG encoding uses the SYNCHRONOUS canvas.toDataURL: the async encoders
 * (OffscreenCanvas.convertToBlob / canvas.toBlob) run on a task runner that a
 * hidden page deprioritizes, and after a few idle seconds one encode took
 * ~1 s, against ~10-30 ms synchronously.
 */
(() => {
  let live = null; // { stream, track, reader, latest }
  const canvas = document.createElement("canvas");

  function stop() {
    if (!live) return;
    const current = live;
    live = null;
    try {
      current.reader?.cancel();
    } catch {
      /* already closed */
    }
    current.latest?.close?.();
    for (const track of current.stream.getTracks()) track.stop();
  }

  async function pump(state) {
    try {
      for (;;) {
        const { value, done } = await state.reader.read();
        if (done) break;
        if (live !== state) {
          value?.close?.();
          break;
        }
        state.latest?.close?.();
        state.latest = value;
        state.waiters.splice(0).forEach((resolve) => resolve());
      }
    } catch {
      /* stream ended */
    }
    if (live === state) live = null; // display removed: main re-warms
  }

  /** Open the stream (main answers the display-media request). */
  window.captureWarm = async (maxWidth) => {
    stop();
    const stream = await navigator.mediaDevices.getDisplayMedia({
      // 2 fps is plenty for "what is on screen now" and keeps the idle cost
      // of a live stream negligible.
      video: { width: { max: maxWidth }, frameRate: { max: 2 } },
      audio: false,
    });
    const [track] = stream.getVideoTracks();
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    const state = { stream, track, reader, latest: null, waiters: [] };
    live = state;
    void pump(state);
    return true;
  };

  /** Latest frame -> JPEG bytes. */
  window.captureGrab = async (maxWidth, quality) => {
    const state = live;
    if (!state) throw new Error("capture stream not warm");
    if (!state.latest) await new Promise((resolve) => state.waiters.push(resolve));
    const frame = state.latest;
    const srcWidth = frame.displayWidth;
    const srcHeight = frame.displayHeight;
    const width = Math.min(maxWidth, srcWidth);
    const height = Math.round((srcHeight * width) / srcWidth);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    canvas.getContext("2d").drawImage(frame, 0, 0, width, height);
    const url = canvas.toDataURL("image/jpeg", quality);
    const binary = atob(url.slice(url.indexOf(",") + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return { bytes, width, height };
  };

  window.captureStop = () => {
    stop();
    return true;
  };
})();
