// game-app.jsx — App phases, roster, zone setup, claim handling, simulation

const { useState, useEffect, useRef } = React;

const DEFAULT_CONFIG = {
  pingIntervalMinutes:     3,
  locationDelayMinutes:    3,
  lockdownIntervalCount:   3,
  globalSqueezePercentage: 10,
  lockdownRadius:          500,
  shrinkIntervalSeconds:   120,
  proximityThresholds: { near: 200, far: 1000 },
};

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "direction":     "Ghost",
  "scanlines":     true,
  "mapBrightness": 80
}/*EDITMODE-END*/;

const LANDMARKS = [
  { name: 'Barbican Library',      lat: 51.5199, lng: -0.0867 },
  { name: 'Museum of London',      lat: 51.5177, lng: -0.0966 },
  { name: "St Paul's Cathedral",   lat: 51.5138, lng: -0.0984 },
  { name: 'Tate Modern',           lat: 51.5076, lng: -0.0994 },
  { name: 'London Bridge Station', lat: 51.5031, lng: -0.0872 },
  { name: 'Borough Market',        lat: 51.5055, lng: -0.0910 },
  { name: 'Southwark Cathedral',   lat: 51.5056, lng: -0.0875 },
  { name: 'Guildhall',             lat: 51.5155, lng: -0.0922 },
  { name: 'Cannon St Station',     lat: 51.5113, lng: -0.0904 },
  { name: 'The Monument',          lat: 51.5101, lng: -0.0860 },
];

// Demo roster — pre-connected devices
const DEMO_ROSTER = [
  { id:'d1', name:'Shadow',  role:'HIDER'  },
  { id:'d2', name:'Wraith',  role:'HIDER'  },
  { id:'d3', name:'Alpha-2', role:'SEEKER' },
  { id:'d4', name:'Bravo-1', role:'SEEKER' },
  { id:'d5', name:'Bravo-2', role:'SEEKER' },
];

function hdist(a,b) {
  const R=6371000,toR=Math.PI/180;
  const φ1=a[0]*toR,φ2=b[0]*toR,dφ=(b[0]-a[0])*toR,dλ=(b[1]-a[1])*toR;
  return 2*R*Math.asin(Math.sqrt(Math.sin(dφ/2)**2+Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2));
}
function nudge(c,dlat,dlng){ return [c[0]+dlat, c[1]+dlng]; }
function clampToZone(c, zone) {
  if (hdist(c,[zone.lat,zone.lng]) <= zone.radius) return c;
  const bear = Math.atan2(c[1]-zone.lng, c[0]-zone.lat);
  const r    = zone.radius * 0.92;
  return [zone.lat+(r/111320)*Math.cos(bear), zone.lng+(r/(111320*Math.cos(zone.lat*Math.PI/180)))*Math.sin(bear)];
}

function makeGameState(zone, objIdx = 0) {
  const hiderStart = [zone.lat + 0.0075, zone.lng + 0.0065];
  return {
    gameId:            'HUNT-' + Math.floor(1000+Math.random()*9000),
    phase:             'active',
    startTime:         Date.now(),
    zone:              { ...zone, originalRadius: zone.radius },
    shrinkCountdown:   110,
    pingCount:         0,
    objIdx,
    objectivesCleared: 0,
    oobCount:          0,
    hiders: [{
      id:'h1', name:'Ghost',
      coords:         hiderStart,
      delayedCoords:  nudge(hiderStart, -0.001, -0.0012),
      delayMins:      3,
      lockdownCircle: { lat:hiderStart[0], lng:hiderStart[1], radius:500 },
      inLockdown:     true,
      objective:      LANDMARKS[objIdx % LANDMARKS.length],
      proximity:      'Distant',
      isOutOfBounds:  false,
    }],
    seekers: [
      { id:'s1', name:'Alpha-1', coords:[zone.lat - 0.006, zone.lng - 0.005], isMe:true  },
      { id:'s2', name:'Alpha-2', coords:[zone.lat - 0.003, zone.lng + 0.007], isMe:false },
    ],
  };
}

// ── App ───────────────────────────────────────────────────────────────────────
function App() {
  // App-level phases: lobby → waiting → playing → gameover
  const [appPhase,  setAppPhase]  = useState('lobby');
  const [myRole,    setMyRole]    = useState(null);
  const [myName,    setMyName]    = useState('');
  const [roster,    setRoster]    = useState(DEMO_ROSTER);
  const [zoneSetup, setZoneSetup] = useState({ lat:51.5125, lng:-0.0915, radius:900 });
  const [gameState, setGameState] = useState(() => makeGameState({ lat:51.5125, lng:-0.0915, radius:900 }));
  const [config,    setConfig]    = useState(DEFAULT_CONFIG);
  const [winner,    setWinner]    = useState(null);
  const [paused,    setPaused]    = useState(false);

  const pausedRef = useRef(false);
  const configRef = useRef(config);
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);

  useEffect(() => { configRef.current = config; }, [config]);
  useEffect(() => { pausedRef.current = paused;  }, [paused]);

  // ── Simulation (only runs during 'playing') ───────────────────────────────
  useEffect(() => {
    const id = setInterval(() => {
      if (pausedRef.current || appPhase !== 'playing') return;
      const cfg = configRef.current;

      setGameState(prev => {
        if (prev.phase !== 'active') return prev;

        const hider = prev.hiders[0];

        // Hider drifts toward current objective with jitter
        const obj    = hider.objective;
        const toOLat = obj ? obj.lat - hider.coords[0] : 0;
        const toOLng = obj ? obj.lng - hider.coords[1] : 0;
        const oMag   = Math.sqrt(toOLat**2 + toOLng**2) || 0.0001;
        const jitter = 0.000028, bias = 0.000018;
        let newCoords = nudge(hider.coords,
          (toOLat/oMag)*bias + (Math.random()-0.5)*jitter,
          (toOLng/oMag)*bias + (Math.random()-0.5)*jitter,
        );

        // Clamp to lockdown circle
        if (hider.inLockdown && hider.lockdownCircle) {
          const d = hdist(newCoords, [hider.lockdownCircle.lat, hider.lockdownCircle.lng]);
          if (d > hider.lockdownCircle.radius * 0.9) newCoords = hider.coords;
        }
        newCoords = clampToZone(newCoords, prev.zone);
        const isOOB = hdist(newCoords, [prev.zone.lat, prev.zone.lng]) > prev.zone.radius;

        // Seekers converge on hider
        const seekers = prev.seekers.map((s,i) => {
          const speed = i===0 ? 0.000022 : 0.000012;
          const dlat  = hider.coords[0]-s.coords[0], dlng = hider.coords[1]-s.coords[1];
          const mag   = Math.sqrt(dlat**2+dlng**2)||0.0001;
          return {...s, coords:[s.coords[0]+(dlat/mag)*speed, s.coords[1]+(dlng/mag)*speed]};
        });

        // Proximity
        const minDist  = Math.min(...seekers.map(s => hdist(newCoords, s.coords)));
        const proximity = minDist < cfg.proximityThresholds.near ? 'Near'
          : minDist < cfg.proximityThresholds.far ? 'Far' : 'Distant';

        // Win: seeker within 25m
        if (minDist < 25) return { ...prev, phase:'ended', winner:'SEEKERS', seekers };

        // Zone shrink
        let { shrinkCountdown, zone } = prev;
        shrinkCountdown -= 1;
        if (shrinkCountdown <= 0) {
          const f = 1 - cfg.globalSqueezePercentage/100;
          zone = { ...zone, radius: Math.max(80, zone.radius*f) };
          shrinkCountdown = cfg.shrinkIntervalSeconds;
        }

        // Ping & lockdown
        let { pingCount, oobCount } = prev;
        pingCount += 1;
        if (isOOB) oobCount += 1;

        let { lockdownCircle, inLockdown } = hider;
        if (pingCount % cfg.lockdownIntervalCount === 0) {
          lockdownCircle = { lat:newCoords[0], lng:newCoords[1], radius:cfg.lockdownRadius };
          inLockdown = true;
        }

        // Delayed coords simulate position lag
        const delayedCoords = nudge(newCoords,
          (Math.random()-0.5)*0.0015, (Math.random()-0.5)*0.0015);

        return {
          ...prev, zone, shrinkCountdown, pingCount, oobCount, seekers,
          hiders: [{ ...hider, coords:newCoords, delayedCoords, lockdownCircle, inLockdown, proximity, isOutOfBounds:isOOB }],
        };
      });
    }, 1000);
    return () => clearInterval(id);
  }, [appPhase]);

  // Check ended state
  useEffect(() => {
    if (gameState.phase === 'ended') {
      setWinner(gameState.winner || 'SEEKERS');
      setAppPhase('gameover');
    }
  }, [gameState.phase]);

  // Map brightness CSS injection
  useEffect(() => {
    let el = document.getElementById('__mb');
    if (!el) { el=document.createElement('style'); el.id='__mb'; document.head.appendChild(el); }
    el.textContent = `.leaflet-tile-pane{filter:brightness(${t.mapBrightness/100}) !important}`;
  }, [t.mapBrightness]);

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleJoin = (role, name) => {
    setMyRole(role); setMyName(name || 'Player');
    if (role !== 'ADMIN') {
      setRoster(prev => [...prev.filter(p=>p.id!=='me'), { id:'me', name:name||'Player', role }]);
    }
    setAppPhase('waiting');
  };

  const handleStartGame = () => {
    const newState = makeGameState(zoneSetup);
    // Update roster player names into seekers/hiders lists
    setGameState(newState);
    setAppPhase('playing');
  };

  const handleClaimObjective = () => {
    setGameState(prev => {
      const hider  = prev.hiders[0];
      const nIdx   = prev.objIdx + 1;
      const nObj   = LANDMARKS[nIdx % LANDMARKS.length];
      return {
        ...prev,
        objIdx:            nIdx,
        objectivesCleared: prev.objectivesCleared + 1,
        hiders: [{ ...hider, objective: nObj }],
      };
    });
  };

  const handleGameControl = action => {
    if (action === 'end')   { setWinner('SEEKERS'); setAppPhase('gameover'); }
    if (action === 'pause') { setPaused(p => !p); }
    if (action === 'start') { setPaused(false); }
  };

  const handleRestart = () => {
    setRoster(DEMO_ROSTER); setWinner(null); setPaused(false);
    setGameState(makeGameState(zoneSetup));
    setAppPhase('lobby');
  };

  const stats = {
    duration:   `${Math.max(0,Math.floor((Date.now()-gameState.startTime)/60000))}m`,
    objectives: gameState.objectivesCleared,
    zoneSize:   Math.round((gameState.zone.radius / (gameState.zone.originalRadius||900)) * 100),
    oobCount:   gameState.oobCount,
  };

  // Direction class
  const dir      = (t.direction||'Ghost').toLowerCase();
  const dirClass = dir==='ghost' ? '' : `dir-${dir}`;
  const showScan = t.scanlines && dir==='ghost';

  return (
    <div className={`app ${dirClass}`}>
      {showScan && <div className="scanlines-overlay" />}

      {/* LOBBY */}
      {appPhase==='lobby' && <GameLobby onJoin={handleJoin} />}

      {/* WAITING — non-admin */}
      {appPhase==='waiting' && myRole!=='ADMIN' && (
        <WaitingRoom roster={roster} myRole={myRole} myName={myName} />
      )}

      {/* WAITING — admin setup panel */}
      {appPhase==='waiting' && myRole==='ADMIN' && (
        <AdminScreen
          gameState={gameState} config={config}
          onConfigChange={setConfig} onGameControl={handleGameControl}
          onBack={() => setAppPhase('lobby')}
          appPhase="waiting"
          roster={roster}
          zoneSetup={zoneSetup} onZoneSetupChange={setZoneSetup}
          onStartGame={handleStartGame}
        />
      )}

      {/* PLAYING */}
      {appPhase==='playing' && myRole==='HIDER' && (
        <HiderScreen
          gameState={gameState} config={config}
          onBack={() => setAppPhase('lobby')}
          onClaimObjective={handleClaimObjective}
        />
      )}
      {appPhase==='playing' && myRole==='SEEKER' && (
        <SeekerScreen gameState={gameState} config={config} onBack={() => setAppPhase('lobby')} />
      )}
      {appPhase==='playing' && myRole==='ADMIN' && (
        <AdminScreen
          gameState={gameState} config={config}
          onConfigChange={setConfig} onGameControl={handleGameControl}
          onBack={() => setAppPhase('lobby')}
          appPhase="playing"
          roster={roster}
          zoneSetup={zoneSetup} onZoneSetupChange={setZoneSetup}
          onStartGame={handleStartGame}
        />
      )}

      {/* GAME OVER */}
      {appPhase==='gameover' && (
        <GameOver winner={winner} stats={stats} onRestart={handleRestart} />
      )}

      <TweaksPanel>
        <TweakSection label="Visual Direction" />
        <TweakRadio
          label="Theme" value={t.direction}
          options={['Ghost','Shadow','Hunt']}
          onChange={v => setTweak('direction',v)}
        />
        <TweakToggle label="Scan Lines" value={t.scanlines} onChange={v=>setTweak('scanlines',v)} />
        <TweakSlider label="Map Brightness" value={t.mapBrightness} min={25} max={100} step={5} unit="%"
          onChange={v=>setTweak('mapBrightness',v)} />
        <TweakSection label="Quick Navigate" />
        <TweakButton label="→ Lobby"        onClick={()=>setAppPhase('lobby')}   />
        <TweakButton label="→ Waiting Room" onClick={()=>{ setMyRole('HIDER'); setMyName('Ghost'); setAppPhase('waiting'); }} />
        <TweakButton label="→ Admin Setup"  onClick={()=>{ setMyRole('ADMIN'); setAppPhase('waiting'); }} />
        <TweakButton label="→ Hider View"   onClick={()=>{ setMyRole('HIDER'); setAppPhase('playing'); }} />
        <TweakButton label="→ Seeker View"  onClick={()=>{ setMyRole('SEEKER'); setAppPhase('playing'); }} />
        <TweakButton label="→ Admin Live"   onClick={()=>{ setMyRole('ADMIN'); setAppPhase('playing'); }} />
        <TweakButton label="→ Game Over"    onClick={()=>{ setWinner('SEEKERS'); setAppPhase('gameover'); }} />
        <TweakSection label="Simulation" />
        <TweakToggle
          label={paused ? 'Paused' : 'Running'}
          value={!paused}
          onChange={v => setPaused(!v)}
        />
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
