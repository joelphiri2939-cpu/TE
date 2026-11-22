TEACHMATE OFFLINE NEURAL VOICE OUTPUT — KOKORO

WHAT THIS PACKAGE CHANGES
- Replaces the robotic browser SpeechSynthesis voice with Kokoro neural TTS.
- Runs speech generation in the browser using sherpa-onnx WebAssembly.
- Keeps the existing offline speech-recognition module unchanged.
- Caches the Kokoro runtime/model assets through the service worker for offline use.
- Adds voice selection, speed, automatic response speaking, test, and stop controls.

FILES
- index.html: complete TeachMate page; voice-tts.js is already included once after ui/speech.js.
- service-worker.js: cache version teachmate-v8 and offline model caching.
- ui/voice-tts.js: Kokoro neural voice controller.

INSTALLATION
1. Replace the repository index.html with this index.html.
2. Replace the repository service-worker.js with this service-worker.js.
3. Replace/add ui/voice-tts.js at repository path ui/voice-tts.js.
4. Commit and deploy to GitHub Pages.
5. Open TeachMate while online, refresh once, open the speaker button, and tap
   “Download & enable neural voice”. Keep the page open until the model finishes.
6. Test a voice. Then turn off internet and test again to verify offline playback.

FIRST DOWNLOAD / STORAGE
The selected Kokoro v1.0 FP32 browser package is approximately 427 MB for its
model data, plus the WebAssembly runtime. The first setup therefore needs an
internet connection and substantial free storage. The service worker attempts
to cache the model files so later speech generation can work offline. Browser
storage policies and available device space can affect whether the large model
is retained; verify by testing with internet disabled.

VOICE MODEL
- Kokoro v1.0 multilingual package, FP32 browser build (English voices included).
- sherpa-onnx WebAssembly runtime.
- Model files are fetched from the Hugging Face dataset on first setup and are
  not bundled inside this ZIP.
- Speech text is processed locally after the model is loaded; this TTS code does
  not send the text to a cloud speech service.

API
window.TeachMateTTS.speak(responseText);
window.TeachMateTTS.stop();
window.TeachMateTTS.setAutoSpeak(true);

Or dispatch an assistant response:
window.dispatchEvent(new CustomEvent('teachmate:assistant-response', {
  detail: { text: responseText }
}));

IMPORTANT LIMITATIONS
- This is a browser WebAssembly build and is CPU-intensive; generation can take
  time, especially for long responses and older phones.
- Kokoro's int8 WASM variant has a documented NaN/silent-audio issue in the
  referenced browser demo, so this integration selects the larger FP32 variant.
- This package has passed local JavaScript syntax checks only. It has not yet
  been run on the live TeachMate site or tested on the user's Android device.
- First-time model download and persistent offline caching must be verified on
  the deployed site. If browser storage rejects the large model, offline TTS
  will not be available until a reliable local asset-storage path is configured.
