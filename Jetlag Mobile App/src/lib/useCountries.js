// useCountries.js — load Natural Earth 50m country features (cached in sessionStorage).
// Shared by the admin Game-area picker and the seeker map's deduction console.
import { useState, useEffect } from 'react';

const NE_COUNTRIES_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson';

// Stable, UNIQUE id for a Natural Earth country feature. Natural Earth marks 8
// countries (France, Norway, Kosovo, N. Cyprus, Somaliland, …) with ISO_A2
// "-99", so ISO_A2 alone collides — picking France would silently pick all 8 and
// poison the union zone. Fall back to the (unique) country NAME in that case.
export function countryId(f) {
  const a2 = f?.properties?.ISO_A2;
  return (a2 && a2 !== '-99') ? a2 : (f?.properties?.NAME || a2);
}

export function useCountries() {
  const [countries, setCountries] = useState([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const cached = sessionStorage.getItem('ne_countries');
    if (cached) { try { setCountries(JSON.parse(cached).features || []); return; } catch { /* ignore corrupt cache */ } }
    setLoading(true);
    fetch(NE_COUNTRIES_URL)
      .then(r => r.json())
      .then(d => { const feats = d.features || []; setCountries(feats); try { sessionStorage.setItem('ne_countries', JSON.stringify(d)); } catch { /* cache write is best-effort */ } })
      .catch(() => { /* leave countries empty when fetch fails */ })
      .finally(() => setLoading(false));
  }, []);
  return { countries, loading };
}
