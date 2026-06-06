// game-screens.jsx — GameMap, ObjectiveClaimSheet, HiderScreen, SeekerScreen, AdminScreen

const { useState, useEffect, useRef, useCallback } = React;

function hdist(a, b) {
  const R=6371000,toR=Math.PI/180;
  const φ1=a[0]*toR,φ2=b[0]*toR,dφ=(b[0]-a[0])*toR,dλ=(b[1]-a[1])*toR;
  return 2*R*Math.asin(Math.sqrt(Math.sin(dφ/2)**2+Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2));
}

function circlePoints(lat,lng,radiusM,steps=56) {
  const pts=[];
  for(let i=0;i<=steps;i++){
    const a=(i/steps)*2*Math.PI;
    pts.push([lat+(radiusM/111320)*Math.cos(a), lng+(radiusM/(111320*Math.cos(lat*Math.PI/180)))*Math.sin(a)]);
  }
  return pts;
}

function cssVar(name,fb){ return getComputedStyle(document.documentElement).getPropertyValue(name).trim()||fb; }

// ── Map ───────────────────────────────────────────────────────────────────────
function GameMap({ role, gameState, small }) {
  const divRef  = useRef(null);
  const mapRef  = useRef(null);
  const lyrsRef = useRef([]);

  const clearLayers = useCallback(() => {
    if (!mapRef.current) return;
    lyrsRef.current.forEach(l => { try{ mapRef.current.removeLayer(l); }catch(e){} });
    lyrsRef.current = [];
  }, []);

  const add = useCallback(layer => {
    if (!mapRef.current) return layer;
    layer.addTo(mapRef.current); lyrsRef.current.push(layer); return layer;
  }, []);

  useEffect(() => {
    if (!divRef.current || mapRef.current) return;
    const map = L.map(divRef.current, {
      center: [gameState.zone.lat, gameState.zone.lng],
      zoom: small ? 13 : 14,
      zoomControl: false, attributionControl: false,
      dragging: !small, touchZoom: !small,
    });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      { maxZoom:19, subdomains:'abcd' }).addTo(map);
    mapRef.current = map;
    return () => { try{ map.remove(); }catch(e){} mapRef.current = null; };
  }, []); // eslint-disable-line

  useEffect(() => {
    if (!mapRef.current) return;
    clearLayers();
    const { zone, hiders, seekers } = gameState;
    const primary   = cssVar('--primary',   '#00ff88');
    const secondary = cssVar('--secondary', '#00ccff');
    const danger    = cssVar('--danger',    '#ff3355');
    const warn      = cssVar('--warn',      '#ffcc00');

    // Zone
    add(L.polygon(circlePoints(zone.lat,zone.lng,zone.radius), {
      color:secondary, weight:2, fill:true, fillColor:secondary, fillOpacity:0.04,
      opacity:0.75, dashArray:'6 4',
    }));

    hiders.forEach(h => {
      // Lockdown circle
      if (h.lockdownCircle) {
        const {lat,lng,radius} = h.lockdownCircle;
        add(L.polygon(circlePoints(lat,lng,radius), {
          color:warn, weight:1, fill:true, fillColor:warn, fillOpacity:0.05,
          dashArray:'4 4', opacity:0.55,
        }));
      }

      // Objective
      if (h.objective) {
        add(L.divIcon && L.marker([h.objective.lat, h.objective.lng], { icon: L.divIcon({
          className:'', iconSize:[10,10], iconAnchor:[5,5],
          html:`<div style="width:10px;height:10px;border-radius:50%;border:2px solid ${secondary};box-shadow:0 0 10px ${secondary}88;"></div>`,
        })}));
        if (!small) {
          add(L.marker([h.objective.lat,h.objective.lng], { icon: L.divIcon({
            className:'', iconSize:[130,14], iconAnchor:[-2,7],
            html:`<div style="color:${secondary};font-family:monospace;font-size:8px;white-space:nowrap;text-shadow:0 0 6px ${secondary};margin-left:8px;">${h.objective.name}</div>`,
          })}));
        }
      }

      // Real position
      if (role === 'HIDER' || role === 'ADMIN') {
        const col = role === 'HIDER' ? secondary : primary;
        add(L.marker(h.coords, { icon: L.divIcon({
          className:'', iconSize:[12,12], iconAnchor:[6,6],
          html:`<div style="width:12px;height:12px;background:${col};transform:rotate(45deg);box-shadow:0 0 14px ${col};border:1px solid ${col}44;"></div>`,
        })}));
        if (!small) add(L.marker(h.coords, { icon: L.divIcon({
          className:'', iconSize:[60,14], iconAnchor:[0,0],
          html:`<div style="color:${col};font-family:monospace;font-size:8px;margin-top:9px;margin-left:9px;text-shadow:0 0 6px ${col};">${h.name}</div>`,
        })}));
      }

      // Delayed position (seeker/admin)
      if ((role === 'SEEKER' || role === 'ADMIN') && h.delayedCoords) {
        add(L.marker(h.delayedCoords, { icon: L.divIcon({
          className:'', iconSize:[10,10], iconAnchor:[5,5],
          html:`<div style="width:10px;height:10px;background:${danger}99;border:2px solid ${danger};transform:rotate(45deg);box-shadow:0 0 10px ${danger}66;"></div>`,
        })}));
        if (!small) add(L.marker(h.delayedCoords, { icon: L.divIcon({
          className:'', iconSize:[80,14], iconAnchor:[0,0],
          html:`<div style="color:${danger};font-family:monospace;font-size:8px;white-space:nowrap;text-shadow:0 0 6px ${danger};margin-top:9px;margin-left:9px;">${h.delayMins}m ago</div>`,
        })}));
      }
    });

    // Seekers
    seekers.forEach(s => {
      if (role !== 'SEEKER' && role !== 'ADMIN') return;
      const col = s.isMe ? primary : danger;
      add(L.marker(s.coords, { icon: L.divIcon({
        className:'', iconSize:[12,12], iconAnchor:[6,6],
        html:`<div style="width:12px;height:12px;background:${col};border-radius:50%;border:2px solid ${col}88;box-shadow:0 0 12px ${col}88;"></div>`,
      })}));
      if (!small) add(L.marker(s.coords, { icon: L.divIcon({
        className:'', iconSize:[60,14], iconAnchor:[0,0],
        html:`<div style="color:${col};font-family:monospace;font-size:8px;margin-top:10px;margin-left:10px;text-shadow:0 0 6px ${col};">${s.name}</div>`,
      })}));
    });
  }, [gameState, role, clearLayers, add]);

  return <div ref={divRef} style={{ width:'100%', height:'100%' }} />;
}

// ── Objective Claim Sheet ─────────────────────────────────────────────────────
function ObjectiveClaimSheet({ objective, distance, inRange, onDismiss, onClaim }) {
  const [photo,   setPhoto]   = useState(null);
  const inputRef  = useRef(null);

  const handleFile = e => {
    const f = e.target.files && e.target.files[0];
    if (f) setPhoto(URL.createObjectURL(f));
  };

  const canClaim = inRange && photo !== null;

  return (
    <div className="claim-sheet">
      <div className="claim-header">
        <div>
          <div className="claim-title">◎ Claim Objective</div>
          <div className="claim-obj-name">{objective.name}</div>
        </div>
        <button className="claim-dismiss" onClick={onDismiss}>×</button>
      </div>

      {/* Verification checks */}
      <div className="claim-checks">
        <div className={`claim-check ${inRange ? 'ok' : ''}`}>
          <span className={`check-icon ${inRange ? 'check-icon-ok' : 'check-icon-off'}`}>
            {inRange ? '✓' : '○'}
          </span>
          <div>
            <div className="check-lbl">GPS Location</div>
            <div className="check-val" style={{ color: inRange ? 'var(--primary)' : 'var(--text2)' }}>
              {inRange ? 'IN RANGE' : `${Math.round(distance)}m away`}
            </div>
          </div>
        </div>
        <div className={`claim-check ${photo ? 'ok' : ''}`}>
          <span className={`check-icon ${photo ? 'check-icon-ok' : 'check-icon-off'}`}>
            {photo ? '✓' : '○'}
          </span>
          <div>
            <div className="check-lbl">Photo Proof</div>
            <div className="check-val" style={{ color: photo ? 'var(--primary)' : 'var(--text2)' }}>
              {photo ? 'CAPTURED' : 'REQUIRED'}
            </div>
          </div>
        </div>
      </div>

      {/* Photo capture */}
      {photo
        ? <img src={photo} alt="proof" className="photo-preview" />
        : null
      }
      <button
        className={`photo-btn ${photo ? 'captured' : ''}`}
        onClick={() => inputRef.current && inputRef.current.click()}
      >
        {photo ? '↺ RETAKE PHOTO' : '◑ PHOTOGRAPH OBJECTIVE'}
      </button>
      <input
        ref={inputRef} type="file"
        accept="image/*" capture="environment"
        onChange={handleFile}
        style={{ display:'none' }}
      />

      <button className="claim-btn" disabled={!canClaim} onClick={() => canClaim && onClaim()}>
        CONFIRM CLAIM
      </button>
    </div>
  );
}

// ── Hider Screen ──────────────────────────────────────────────────────────────
function HiderScreen({ gameState, config, onBack, onClaimObjective }) {
  const hider      = gameState.hiders[0];
  const [claimOpen, setClaimOpen] = useState(false);

  const objDist = hider.objective
    ? hdist(hider.coords, [hider.objective.lat, hider.objective.lng])
    : null;
  const inRange = objDist !== null && objDist < 40;

  // Auto-open sheet when newly in range
  const wasInRange = useRef(false);
  useEffect(() => {
    if (inRange && !wasInRange.current) { setClaimOpen(true); }
    wasInRange.current = inRange;
  }, [inRange]);

  const handleClaim = () => {
    setClaimOpen(false);
    onClaimObjective();
  };

  return (
    <div className="screen" style={{ position:'relative' }}>
      <GameNavBar title="HIDE &amp; SEEK" role="HIDER" subtitle={gameState.gameId} onBack={onBack} />

      {hider.isOutOfBounds && (
        <div className="oob-overlay"><div className="oob-banner">⚠ OUT OF BOUNDS — RETURN NOW</div></div>
      )}

      <div className="map-pane">
        <GameMap role="HIDER" gameState={gameState} />
      </div>

      <div className="status-panel">
        <GameProximity status={hider.proximity} />

        {/* In-range tap target */}
        {inRange && !claimOpen && (
          <div className="in-range-tap" onClick={() => setClaimOpen(true)}>
            <div className="in-range-label">◎ you are in range</div>
            <div className="in-range-cta">TAP TO CLAIM OBJECTIVE</div>
          </div>
        )}

        {!inRange && <GameObjective objective={hider.objective} distance={objDist} />}

        <div style={{ display:'flex', gap:8 }}>
          <div style={{ flex:1 }}>
            <GameZoneTimer seconds={gameState.shrinkCountdown} totalSeconds={config.shrinkIntervalSeconds} />
          </div>
        </div>
        <div style={{ display:'flex', gap:8 }}>
          <div style={{ flex:1 }}>
            <GameZoneHealth current={gameState.zone.radius} original={gameState.zone.originalRadius} />
          </div>
          {hider.inLockdown && <GameLockdown active radius={config.lockdownRadius} />}
        </div>
      </div>

      {/* Claim sheet slides up */}
      {claimOpen && hider.objective && (
        <ObjectiveClaimSheet
          objective={hider.objective}
          distance={objDist}
          inRange={inRange}
          onDismiss={() => setClaimOpen(false)}
          onClaim={handleClaim}
        />
      )}
    </div>
  );
}

// ── Seeker Screen ─────────────────────────────────────────────────────────────
function SeekerScreen({ gameState, config, onBack }) {
  const mySeeker = gameState.seekers.find(s => s.isMe) || gameState.seekers[0];
  return (
    <div className="screen">
      <GameNavBar title="HIDE &amp; SEEK" role="SEEKER" subtitle={gameState.gameId} onBack={onBack} />
      <div className="map-pane">
        <GameMap role="SEEKER" gameState={gameState} />
      </div>
      <div className="status-panel">
        <div className="section-label">hider signals</div>
        <div className="ping-list">
          {gameState.hiders.map(h => (
            <div key={h.id} className="ping-item">
              <div className="ping-dot" />
              <div style={{ flex:1 }}>
                <div className="ping-name">{h.name}</div>
                <div className="ping-time">last ping · {h.delayMins} min delay</div>
              </div>
              <div className="ping-obj">{h.objective ? h.objective.name : '—'}</div>
            </div>
          ))}
        </div>
        <GameZoneTimer seconds={gameState.shrinkCountdown} totalSeconds={config.shrinkIntervalSeconds} />
        <GameZoneHealth current={gameState.zone.radius} original={gameState.zone.originalRadius} />
        {mySeeker && (
          <div className="my-coords">
            <span className="my-coords-label">pos</span>
            <span className="my-coords-val">
              {mySeeker.coords[0].toFixed(4)}, {mySeeker.coords[1].toFixed(4)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Admin Screen ──────────────────────────────────────────────────────────────
function AdminScreen({ gameState, config, onConfigChange, onGameControl, onBack,
                       appPhase, roster, zoneSetup, onZoneSetupChange, onStartGame }) {
  const [lc, setLc] = useState(config);
  const set = (k,v) => { const n={...lc,[k]:v}; setLc(n); onConfigChange(n); };
  const setN = (p,k,v) => { const n={...lc,[p]:{...lc[p],[k]:v}}; setLc(n); onConfigChange(n); };

  const elapsed = Math.max(0, Math.floor((Date.now() - gameState.startTime) / 60000));

  const useMyLocation = () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      pos => onZoneSetupChange({ ...zoneSetup, lat: +pos.coords.latitude.toFixed(5), lng: +pos.coords.longitude.toFixed(5) }),
      ()  => alert('Location unavailable — enter coordinates manually.')
    );
  };

  // Preview game state for zone setup map (no players)
  const previewState = {
    ...gameState,
    zone:    { lat: zoneSetup.lat, lng: zoneSetup.lng, radius: zoneSetup.radius, originalRadius: zoneSetup.radius },
    hiders:  [],
    seekers: [],
  };

  return (
    <div className="admin-screen">
      <GameNavBar title="ADMIN" role="ADMIN" subtitle={appPhase === 'waiting' ? 'SETUP' : 'CONTROL'} onBack={onBack} />

      <div className="admin-body">

        {appPhase === 'waiting' ? (
          /* ── PRE-GAME SETUP ── */
          <>
            {/* Zone setup */}
            <div className="acard">
              <div className="acard-title">◎ Starting Zone</div>
              <div className="coord-row">
                <div>
                  <div className="coord-label">Latitude</div>
                  <input type="number" className="coord-input" step="0.0001"
                    value={zoneSetup.lat}
                    onChange={e => onZoneSetupChange({ ...zoneSetup, lat: +e.target.value })} />
                </div>
                <div>
                  <div className="coord-label">Longitude</div>
                  <input type="number" className="coord-input" step="0.0001"
                    value={zoneSetup.lng}
                    onChange={e => onZoneSetupChange({ ...zoneSetup, lng: +e.target.value })} />
                </div>
              </div>
              <button className="loc-btn" onClick={useMyLocation}>
                📍 Use My Location
              </button>
              <div className="afield" style={{ marginTop:10 }}>
                <div className="afield-label">
                  Initial Radius <span className="afield-val">{zoneSetup.radius}m</span>
                </div>
                <input type="range" className="aslider" min="200" max="5000" step="50"
                  value={zoneSetup.radius}
                  onChange={e => onZoneSetupChange({ ...zoneSetup, radius: +e.target.value })} />
              </div>
              {/* Zone preview */}
              <div className="admin-map-wrap" style={{ marginTop:10 }}>
                <GameMap role="ADMIN" gameState={previewState} small />
              </div>
            </div>

            {/* Game settings (visible at setup) */}
            <div className="acard">
              <div className="acard-title">⬡ Game Settings</div>
              <div className="afield">
                <div className="afield-label">Shrink per interval <span className="afield-val">{lc.globalSqueezePercentage}%</span></div>
                <input type="range" className="aslider" min="1" max="30" step="1"
                  value={lc.globalSqueezePercentage} onChange={e => set('globalSqueezePercentage',+e.target.value)} />
              </div>
              <div className="afield">
                <div className="afield-label">Shrink interval <span className="afield-val">{lc.shrinkIntervalSeconds}s</span></div>
                <input type="range" className="aslider" min="30" max="600" step="30"
                  value={lc.shrinkIntervalSeconds} onChange={e => set('shrinkIntervalSeconds',+e.target.value)} />
              </div>
              <div className="afield">
                <div className="afield-label">Location delay <span className="afield-val">{lc.locationDelayMinutes} min</span></div>
                <input type="range" className="aslider" min="0" max="10" step="0.5"
                  value={lc.locationDelayMinutes} onChange={e => set('locationDelayMinutes',+e.target.value)} />
              </div>
              <div className="afield">
                <div className="afield-label">Lockdown radius <span className="afield-val">{lc.lockdownRadius}m</span></div>
                <input type="range" className="aslider" min="100" max="1000" step="50"
                  value={lc.lockdownRadius} onChange={e => set('lockdownRadius',+e.target.value)} />
              </div>
            </div>

            {/* Roster + Start */}
            <div className="acard">
              <div className="acard-title">◆ Connected Devices ({roster.length})</div>
              {roster.map(p => (
                <div key={p.id} className="player-row">
                  <span className={`prole ${p.role==='HIDER'?'badge-hider':'badge-seeker'}`}>{p.role}</span>
                  <span className="pname">{p.name}</span>
                  <span className="pstatus">● ready</span>
                </div>
              ))}
              <button className="start-game-btn" onClick={onStartGame}>
                ▶ START GAME
              </button>
            </div>
          </>
        ) : (
          /* ── LIVE GAME ── */
          <>
            <div className="stats-row">
              <div className="stat-box">
                <div className="stat-val">{gameState.seekers.length + gameState.hiders.length}</div>
                <div className="stat-label">players</div>
              </div>
              <div className="stat-box">
                <div className="stat-val">{elapsed}m</div>
                <div className="stat-label">elapsed</div>
              </div>
              <div className="stat-box">
                <div className="stat-val">{Math.round(gameState.zone.radius)}m</div>
                <div className="stat-label">zone r</div>
              </div>
            </div>

            <div className="acard">
              <div className="acard-title">⬡ Game Control</div>
              <div className="abtn-row" style={{ marginBottom:10 }}>
                <button className={`abtn ${gameState.phase==='active'?'is-active':''}`} onClick={()=>onGameControl('start')}>Start</button>
                <button className="abtn" onClick={()=>onGameControl('pause')}>Pause</button>
                <button className="abtn is-danger" onClick={()=>onGameControl('end')}>End</button>
              </div>
              <div className="afield-label">Game ID <span className="afield-val" style={{fontFamily:'var(--font-mono)',letterSpacing:2}}>{gameState.gameId}</span></div>
            </div>

            <div className="acard">
              <div className="acard-title">◎ Zone</div>
              <div className="afield">
                <div className="afield-label">Shrink per interval <span className="afield-val">{lc.globalSqueezePercentage}%</span></div>
                <input type="range" className="aslider" min="1" max="30" step="1"
                  value={lc.globalSqueezePercentage} onChange={e=>set('globalSqueezePercentage',+e.target.value)} />
              </div>
              <div className="afield">
                <div className="afield-label">Shrink interval <span className="afield-val">{lc.shrinkIntervalSeconds}s</span></div>
                <input type="range" className="aslider" min="30" max="600" step="30"
                  value={lc.shrinkIntervalSeconds} onChange={e=>set('shrinkIntervalSeconds',+e.target.value)} />
              </div>
            </div>

            <div className="acard">
              <div className="acard-title">◈ Tracking</div>
              <div className="afield">
                <div className="afield-label">Location delay <span className="afield-val">{lc.locationDelayMinutes} min</span></div>
                <input type="range" className="aslider" min="0" max="10" step="0.5"
                  value={lc.locationDelayMinutes} onChange={e=>set('locationDelayMinutes',+e.target.value)} />
              </div>
              <div className="afield">
                <div className="afield-label">Ping interval <span className="afield-val">{lc.pingIntervalMinutes} min</span></div>
                <input type="range" className="aslider" min="0.5" max="10" step="0.5"
                  value={lc.pingIntervalMinutes} onChange={e=>set('pingIntervalMinutes',+e.target.value)} />
              </div>
            </div>

            <div className="acard">
              <div className="acard-title">◌ Lockdown</div>
              <div className="afield">
                <div className="afield-label">Trigger every N pings <span className="afield-val">every {lc.lockdownIntervalCount}rd</span></div>
                <input type="range" className="aslider" min="1" max="10" step="1"
                  value={lc.lockdownIntervalCount} onChange={e=>set('lockdownIntervalCount',+e.target.value)} />
              </div>
              <div className="afield">
                <div className="afield-label">Lockdown radius <span className="afield-val">{lc.lockdownRadius}m</span></div>
                <input type="range" className="aslider" min="100" max="1000" step="50"
                  value={lc.lockdownRadius} onChange={e=>set('lockdownRadius',+e.target.value)} />
              </div>
            </div>

            <div className="acard">
              <div className="acard-title">◉ Proximity Radar</div>
              <div className="afield">
                <div className="afield-label">Near threshold <span className="afield-val">{lc.proximityThresholds.near}m</span></div>
                <input type="range" className="aslider" min="50" max="500" step="25"
                  value={lc.proximityThresholds.near} onChange={e=>setN('proximityThresholds','near',+e.target.value)} />
              </div>
              <div className="afield">
                <div className="afield-label">Far threshold <span className="afield-val">{lc.proximityThresholds.far}m</span></div>
                <input type="range" className="aslider" min="200" max="3000" step="100"
                  value={lc.proximityThresholds.far} onChange={e=>setN('proximityThresholds','far',+e.target.value)} />
              </div>
            </div>

            <div className="acard">
              <div className="acard-title">◆ Players</div>
              {gameState.hiders.map(h => (
                <div key={h.id} className="player-row">
                  <span className="prole badge-hider">HIDER</span>
                  <span className="pname">{h.name}</span>
                  <span className="pstatus">{h.proximity.toLowerCase()} · {h.isOutOfBounds?'⚠ OOB':'in bounds'}</span>
                </div>
              ))}
              {gameState.seekers.map(s => (
                <div key={s.id} className="player-row">
                  <span className="prole badge-seeker">SEEKER</span>
                  <span className="pname">{s.name}{s.isMe?' (you)':''}</span>
                  <span className="pstatus">active</span>
                </div>
              ))}
            </div>

            <div className="admin-map-wrap">
              <GameMap role="ADMIN" gameState={gameState} small />
            </div>
            <div style={{ height:24 }} />
          </>
        )}
      </div>
    </div>
  );
}

Object.assign(window, { GameMap, ObjectiveClaimSheet, HiderScreen, SeekerScreen, AdminScreen });
