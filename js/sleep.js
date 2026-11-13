/* Sleep timer for bedtime reading. Kept in memory only, so a timer never
   resumes the next day. Emits lumen:sleeptimer and lumen:sleepend. */

let timer = null;
const listeners = new Set();

function snapshot() {
  if (!timer) return null;
  return {
    minutes: timer.minutes,
    remainingMs: Math.max(0, timer.endsAt - Date.now()),
  };
}

function emit() {
  const value = snapshot();
  for (const fn of listeners) {
    try { fn(value); } catch {}
  }
  window.dispatchEvent(new CustomEvent('lumen:sleeptimer', { detail: value }));
}

function finish() {
  if (!timer) return;
  const minutes = timer.minutes;
  clearInterval(timer.interval);
  timer = null;
  emit();
  window.dispatchEvent(new CustomEvent('lumen:sleepend', { detail: { minutes } }));
}

function tick() {
  if (!timer) return;
  if (Date.now() >= timer.endsAt) finish();
  else emit();
}

export function getSleepTimer() {
  return snapshot();
}

export function onSleepTimer(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  fn(snapshot());
  return () => listeners.delete(fn);
}

export function startSleepTimer(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return null;
  cancelSleepTimer('replace');
  timer = {
    minutes: value,
    endsAt: Date.now() + value * 60 * 1000,
    interval: setInterval(tick, 1000),
  };
  emit();
  return snapshot();
}

export function cancelSleepTimer() {
  if (!timer) return;
  clearInterval(timer.interval);
  timer = null;
  emit();
}

export function formatSleepRemaining(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes >= 1 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}
