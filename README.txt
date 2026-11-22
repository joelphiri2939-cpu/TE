TEACHMATE VOICE OUTPUT INTEGRATION

This ZIP contains the complete updated index.html, service-worker.js, and ui/voice-tts.js.

Repository placement:
- Replace repository index.html with this index.html.
- Replace repository service-worker.js with this service-worker.js.
- Add ui/voice-tts.js at repository path ui/voice-tts.js.

The index already includes <script src="ui/voice-tts.js"></script> immediately after ui/speech.js. Do not add it again.

Voice output uses the browser/device SpeechSynthesis API. It does not download audio or use a cloud service. Offline speech depends on an offline TTS voice installed on the device.

API for future assistant responses:
window.TeachMateTTS.speak(responseText);

Or dispatch an event:
window.dispatchEvent(new CustomEvent("teachmate:assistant-response", {detail:{text:responseText}}));

A working conversational assistant must call this API when it generates a response. This package provides speech output, not an AI response engine.
