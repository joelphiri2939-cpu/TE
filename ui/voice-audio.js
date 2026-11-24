/* ui/voice-audio.js — noise gate for the microphone, used by speech.js before audio reaches the recognizer.
 * Steady background noise (fans, rain on the roof, generators) and far-away chatter are replaced by silence, so the
 * recognizer is not tempted to "hear" words in them. Speech keeps a short lead-in so first syllables are not clipped.
 * The gate adapts to the room, follows the speaker's own loudness (the close talker wins over distant voices), and
 * is held shut while TeachMate itself is speaking, so the assistant never hears (and obeys) its own voice. */
(function () {
  'use strict';
  function rms(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / (a.length || 1)); }
  function zeros(n) { return new Float32Array(n); }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function create() {
    var MIN_OPEN = 0.012,      // quietest level ever treated as speech
        HANG = 6,              // frames the gate stays open after speech (about 0.7 s at 2048 samples / 16 kHz)
        CLOSE_RATIO = 0.30,    // ignore anything much quieter than the speaker's own recent level
        floor = 0.008, speech = 0, hang = 0, prev = null, frames = 0, openFrames = 0, relax = 1, wasMuted = false, run = 0, runSum = 0;
    return {
      /* cur: Float32Array of 16 kHz samples. muted: true while the assistant is talking.
       * Returns {samples, open, muted, reset}. Output is delayed by one frame so the frame BEFORE speech onset is kept. */
      push: function (cur, muted) {
        frames++;
        if (muted) {
          var firstMute = !wasMuted; wasMuted = true; hang = 0; prev = null;
          return { samples: zeros(cur.length), open: false, muted: true, reset: firstMute };
        }
        wasMuted = false;
        var level = rms(cur);
        var thr = Math.max(MIN_OPEN * relax, floor * 2.8, speech * CLOSE_RATIO * relax);
        var isSpeech = level >= thr;
        // a sound that never pauses (about 8 s) is a machine, not a person: treat it as the new noise floor
        if (isSpeech) { run++; runSum += level; } else { run = 0; runSum = 0; }
        if (run > 60) { floor = clamp(runSum / run, 0.004, 0.2); speech = 0; hang = 0; run = 0; runSum = 0; isSpeech = false; }
        if (isSpeech) {
          hang = HANG; openFrames++;
          if (level > speech * 0.6) speech = speech ? 0.85 * speech + 0.15 * level : level;
          speech = Math.min(speech, 0.4);
        } else {
          hang = Math.max(0, hang - 1);
          floor = clamp((frames < 10 ? 0.7 : 0.97) * floor + (frames < 10 ? 0.3 : 0.03) * level, 0.004, 0.05);   // learn the room
          speech *= 0.999;
        }
        // soft speaker / dull mic: if nothing opened the gate for ~5 s, listen more sensitively
        if (frames === 40 && openFrames === 0) relax = 0.6;
        var open = isSpeech || hang > 0, emit = prev; prev = cur;
        if (!emit) return { samples: zeros(cur.length), open: false, muted: false, reset: false };
        return { samples: open ? emit : zeros(emit.length), open: open, muted: false, reset: false };
      }
    };
  }
  window.TeachMateAudioGate = { create: create };
})();
