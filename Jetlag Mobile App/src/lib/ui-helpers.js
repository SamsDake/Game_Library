export function fmtClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function fmtMins(ms) {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function fmtTimeOfDay(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export async function requestLocation() {
  // Use native Capacitor plugin on iOS/Android for reliable GPS permissions
  if (typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.()) {
    const { Geolocation } = await import('@capacitor/geolocation');
    const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 10000 });
    const { latitude: lat, longitude: lng } = pos.coords;
    return { lat, lng, label: `${lat.toFixed(4)}, ${lng.toFixed(4)}` };
  }
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('GPS not available on this device'));
    let done = false;
    const t = setTimeout(() => {
      if (!done) {
        done = true;
        reject(new Error('GPS timed out'));
      }
    }, 10000);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        const { latitude: lat, longitude: lng } = pos.coords;
        resolve({ lat, lng, label: `${lat.toFixed(4)}, ${lng.toFixed(4)}` });
      },
      (err) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        reject(new Error(`GPS error: ${err.message}`));
      },
      { enableHighAccuracy: true, timeout: 9500 }
    );
  });
}

export function fileToDataUrl(file, maxDim = 1100) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const cv = document.createElement('canvas');
        cv.width = w;
        cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(cv.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = reject;
      img.src = fr.result;
    };
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

export function answerTone(value) {
  const v = (value || '').toLowerCase();
  if (['yes', 'closer', 'hotter'].includes(v)) return 'var(--c-found)';
  if (['no', 'further', 'colder'].includes(v)) return 'var(--c-curse)';
  if (['vetoed', 'rerolled'].includes(v)) return 'var(--c-veto)';
  return 'var(--text-dim)';
}
