/* TeachMate Voice Output — browser/device speech synthesis (no cloud service). */
(function () {
  'use strict';
  if (window.TeachMateTTS) return;
  var synth = window.speechSynthesis;
  var enabled = true;
  var rate = 1;
  var selectedVoiceURI = '';
  var panel;
  function voices() { return synth ? synth.getVoices() : []; }
  function chosenVoice() {
    var list = voices();
    return list.find(function (v) { return v.voiceURI === selectedVoiceURI; }) ||
      list.find(function (v) { return /^en/i.test(v.lang); }) || list[0] || null;
  }
  function stop() { if (synth) synth.cancel(); }
  function speak(text) {
    if (!synth || !enabled || !text) return false;
    stop();
    var clean = String(text).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean) return false;
    var utterance = new SpeechSynthesisUtterance(clean);
    utterance.rate = rate;
    var voice = chosenVoice();
    if (voice) utterance.voice = voice;
    synth.speak(utterance);
    return true;
  }
  function makePanel() {
    if (panel) return;
    var style = document.createElement('style');
    style.textContent = '#tm-tts-panel{position:fixed;right:16px;bottom:76px;z-index:100000;background:#fff;color:#17202a;border:1px solid #ccd3d8;border-radius:14px;padding:14px;width:min(290px,calc(100vw - 32px));box-shadow:0 8px 30px #0003;font:14px system-ui}#tm-tts-panel label{display:block;margin:10px 0 5px}#tm-tts-panel select,#tm-tts-panel input{width:100%;box-sizing:border-box}#tm-tts-panel button{margin:8px 6px 0 0;padding:8px 12px;border:0;border-radius:8px;background:#087f5b;color:white}#tm-tts-toggle{position:fixed;right:16px;bottom:16px;z-index:100000;border:0;border-radius:50%;width:50px;height:50px;background:#087f5b;color:white;font-size:22px;box-shadow:0 3px 12px #0004}';
    document.head.appendChild(style);
    var toggle = document.createElement('button'); toggle.id = 'tm-tts-toggle'; toggle.type = 'button'; toggle.textContent = '🔊'; toggle.title = 'Voice output settings'; toggle.setAttribute('aria-label','Voice output settings');
    panel = document.createElement('div'); panel.id = 'tm-tts-panel'; panel.hidden = true;
    panel.innerHTML = '<strong>TeachMate voice output</strong><label><input id="tm-tts-enabled" type="checkbox" checked> Speak assistant responses automatically</label><label for="tm-tts-voice">Voice</label><select id="tm-tts-voice"></select><label for="tm-tts-rate">Speaking speed: <span id="tm-tts-rate-value">1.0×</span></label><input id="tm-tts-rate" type="range" min="0.7" max="1.4" step="0.1" value="1"><button type="button" id="tm-tts-test">Test voice</button><button type="button" id="tm-tts-stop">Stop</button>';
    document.body.appendChild(toggle); document.body.appendChild(panel);
    toggle.addEventListener('click', function(){ panel.hidden = !panel.hidden; refreshVoices(); });
    panel.querySelector('#tm-tts-enabled').addEventListener('change',function(e){ enabled=e.target.checked; });
    panel.querySelector('#tm-tts-rate').addEventListener('input',function(e){ rate=Number(e.target.value); panel.querySelector('#tm-tts-rate-value').textContent=rate.toFixed(1)+'×'; });
    panel.querySelector('#tm-tts-voice').addEventListener('change',function(e){ selectedVoiceURI=e.target.value; });
    panel.querySelector('#tm-tts-test').addEventListener('click',function(){ speak('Hello. TeachMate voice output is ready.'); });
    panel.querySelector('#tm-tts-stop').addEventListener('click',stop);
    refreshVoices();
  }
  function refreshVoices() {
    if (!panel) return;
    var select=panel.querySelector('#tm-tts-voice'), list=voices(), previous=selectedVoiceURI;
    select.innerHTML='';
    list.forEach(function(v){ var option=document.createElement('option'); option.value=v.voiceURI; option.textContent=v.name+' ('+v.lang+')'; select.appendChild(option); });
    if (previous && list.some(function(v){return v.voiceURI===previous;})) select.value=previous;
    else if (list.length) { var v=chosenVoice(); if(v) {selectedVoiceURI=v.voiceURI; select.value=v.voiceURI;} }
  }
  window.TeachMateTTS={speak:speak,stop:stop,setAutoSpeak:function(value){enabled=!!value;if(panel)panel.querySelector('#tm-tts-enabled').checked=enabled;},isAutoSpeakEnabled:function(){return enabled;},refreshVoices:refreshVoices};
  window.addEventListener('teachmate:assistant-response',function(event){var detail=event.detail||{};if(detail.text) speak(detail.text);});
  document.addEventListener('click',function(event){var target=event.target.closest('[data-tts-speak]');if(target)speak(target.getAttribute('data-tts-speak'));});
  if (synth) synth.onvoiceschanged=refreshVoices;
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',makePanel);else makePanel();
})();
