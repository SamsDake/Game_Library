export function Countdown({ secondsRemaining }: { secondsRemaining: number | null }) {
  const display = secondsRemaining == null ? "3" : secondsRemaining >= 1 ? String(secondsRemaining) : "GO";
  return <div className="app">
    <div className="glow" />
    <div className="screen center-wrap">
      <div className="countdown-num mono">{display}</div>
    </div>
  </div>;
}
