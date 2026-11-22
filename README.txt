TEACHMATE OFFLINE DICTATION INTEGRATION

Files to place in the repository:

1. index.html
   Replace the repository-root index.html with this version.

2. ui/speech.js
   Add this new file at ui/speech.js.

3. service-worker.js
   Replace the repository-root service-worker.js with this version.

The index change is deliberately minimal: it adds ui/speech.js after ui/features.js.
The service worker cache version is bumped to teachmate-v6 and includes ui/speech.js
in the app shell. The speech model cache uses the separate name tm-speech-engine-v1,
so the service worker's old-app-cache cleanup will not delete the model cache.

The sherpa JavaScript API, WASM loader, WASM binary, and model data are fetched from
the existing public R2 bucket. The API script, loader, WASM binary, and model data are
saved in Cache Storage where the browser permits. The model is not added to the
service-worker app-shell cache.

FIRST USE
- Open TeachMate while online.
- Tap a microphone icon beside an eligible text field or textarea.
- Allow microphone access.
- Wait for the first engine download (about 205 MB total, including the model data
  and WASM runtime). Do not close the page while it initializes.
- Dictate, then tap the red stop icon. Recognized words are inserted at the field's
  current cursor/selection. Existing text is preserved.

LATER / OFFLINE TEST
- Reload while online once so the new service worker controls the page.
- Use dictation once and wait until the model is ready and the status message confirms
  browser storage caching succeeded.
- Close/reopen TeachMate, then test dictation with the device offline.
- Offline operation is not confirmed until that test succeeds. Browser storage quota,
  eviction, or private-browsing restrictions can prevent persistent caching.

Only microphone audio is processed locally for transcription. This integration does
not upload or save audio recordings. It inserts recognized text into the selected field.
