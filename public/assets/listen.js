const title = document.querySelector('#title');
const message = document.querySelector('#message');
const button = document.querySelector('#listen');
const cover = document.querySelector('#cover');
const player = document.querySelector('#player');
const audio = document.querySelector('#audio');
const progress = document.querySelector('#progress');
const elapsed = document.querySelector('#elapsed');
const duration = document.querySelector('#duration');
const playState = document.querySelector('#play-state');
let begun = false;

const clock = value => { if (!Number.isFinite(value)) return '—'; const minutes = Math.floor(value / 60); return `${minutes}:${String(Math.floor(value % 60)).padStart(2, '0')}`; };
const show = (heading, detail) => { title.textContent = heading; message.textContent = detail; };
async function load() {
  try {
    const res = await fetch('/api/listening-state', { credentials: 'same-origin' }); const data = await res.json();
    if (data.state === 'available') {
      show(data.title, 'Tienes una escucha disponible.'); button.disabled = false;
      if (data.hasCover) { cover.classList.remove('placeholder'); cover.style.backgroundImage = 'url(/api/cover)'; }
    } else if (data.state === 'used') { show('Tu escucha ya ha sido utilizada.', 'Gracias por haberla escuchado.'); }
    else show('Esta campaña no está disponible.', 'Vuelve a intentarlo más tarde.');
  } catch { show('No hemos podido comprobar tu acceso.', 'Revisa tu conexión e inténtalo de nuevo.'); }
}
button.addEventListener('click', async () => {
  if (begun) { try { await audio.play(); button.hidden = true; playState.textContent = 'Reproduciendo'; } catch { playState.textContent = 'El navegador todavía bloquea el audio.'; } return; }
  button.disabled = true; button.textContent = 'Preparando audio…';
  try {
    const res = await fetch('/api/listen', { method: 'POST', credentials: 'same-origin' }); const data = await res.json();
    if (!res.ok) { show(data.state === 'used' ? 'Tu escucha ya ha sido utilizada.' : 'Esta campaña no está disponible.', 'No es posible iniciar una nueva reproducción.'); return; }
    begun = true; player.hidden = false; button.hidden = true; audio.src = data.audioUrl;
    // The click is intentionally the user gesture that starts playback, including Safari iOS.
    await audio.play(); playState.textContent = 'Reproduciendo';
  } catch (error) {
    if (begun && error instanceof DOMException && error.name === 'NotAllowedError') { button.hidden = false; button.disabled = false; button.textContent = 'Toca para reproducir'; playState.textContent = 'Tu navegador necesita un segundo toque para iniciar el audio.'; }
    else { show('El audio no está disponible.', 'La autorización ha caducado o hay un problema de red.'); button.hidden = true; }
  }
});
audio.addEventListener('loadedmetadata', () => { duration.textContent = clock(audio.duration); progress.max = String(audio.duration); });
audio.addEventListener('timeupdate', () => { elapsed.textContent = clock(audio.currentTime); progress.value = String(audio.currentTime); progress.parentElement.style.setProperty('--progress', `${audio.duration ? audio.currentTime / audio.duration * 100 : 0}%`); });
audio.addEventListener('seeking', () => { if (audio.currentTime < Number(progress.value)) audio.currentTime = Number(progress.value); });
audio.addEventListener('ended', async () => { playState.textContent = 'Tu escucha ha finalizado.'; show('Gracias por escuchar.', 'Tu escucha ha finalizado.'); await fetch('/api/listen/completed', { method: 'POST', credentials: 'same-origin' }).catch(() => {}); });
audio.addEventListener('error', () => { playState.textContent = 'Audio no disponible o autorización expirada.'; });
load();
