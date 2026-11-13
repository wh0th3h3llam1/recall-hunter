// Registration marks + sheet grid references around the map viewport, like a survey sheet.
const COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const ROWS = ['1', '2', '3', '4', '5', '6'];

function Reg({ pos }: { pos: string }) {
  return (
    <svg className={`reg reg-${pos}`} width="22" height="22" viewBox="0 0 22 22" aria-hidden>
      <circle cx="11" cy="11" r="5.5" fill="none" stroke="currentColor" strokeWidth="0.8" />
      <path d="M11 0V22M0 11H22" stroke="currentColor" strokeWidth="0.8" />
    </svg>
  );
}

export default function SurveyFrame() {
  return (
    <div className="survey-frame" aria-hidden>
      <Reg pos="tl" />
      <Reg pos="tr" />
      <Reg pos="bl" />
      <Reg pos="br" />
      <div className="ticks ticks-top">
        {COLS.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <div className="ticks ticks-bottom">
        {COLS.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <div className="ticks ticks-left">
        {ROWS.map((r) => (
          <span key={r}>{r}</span>
        ))}
      </div>
      <div className="ticks ticks-right">
        {ROWS.map((r) => (
          <span key={r}>{r}</span>
        ))}
      </div>
    </div>
  );
}
