export function Scanning({ label = 'ACQUIRING SURVEY DATA', compact = false }: { label?: string; compact?: boolean }) {
  return (
    <div className={`scanning ${compact ? 'compact' : ''}`} role="status" aria-live="polite">
      <div className="scan-grid">
        <div className="scan-line" />
      </div>
      <div className="micro">{label}<span className="blink">_</span></div>
    </div>
  );
}

export function ErrorBox({ title, message, onRetry }: { title: string; message: string; onRetry?: () => void }) {
  return (
    <div className="errorbox" role="alert">
      <div className="micro err-k">■ {title}</div>
      <p className="err-msg">{message}</p>
      {onRetry && (
        <button className="btn-ghost" onClick={onRetry}>
          RETRY ↻
        </button>
      )}
    </div>
  );
}
