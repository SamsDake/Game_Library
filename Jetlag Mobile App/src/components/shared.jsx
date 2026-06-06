// shared.jsx — Sheet, QuestionLog, Gallery
import { useState } from 'react';
import { Icon } from './ui.jsx';
import { CAT_BY_ID } from '../lib/data.js';
import { answerTone, fmtTimeOfDay } from '../lib/ui-helpers.js';

export function Sheet({ title, onClose, children, icon = 'list' }) {
  return (
    <div className="sheet">
      <div className="sheet-head">
        <button className="icon-btn" onClick={onClose}><Icon name="back" size={20} /></button>
        <div className="sheet-title"><Icon name={icon} size={18} /> {title}</div>
        <span style={{ width: 36 }} />
      </div>
      <div className="sheet-body">{children}</div>
    </div>
  );
}

function LogEntry({ q, photos }) {
  const cat = CAT_BY_ID[q.catId];
  const photo = q.answer && q.answer.photoUid && photos.find(p => p.uid === q.answer.photoUid);
  return (
    <div className="log-entry">
      <div className="log-entry-head">
        <span className="log-cat"><Icon name={cat.glyph} size={14} /> {cat.name}</span>
        <span className="log-time">{fmtTimeOfDay(q.askedAt)}</span>
      </div>
      <div className="log-q">{q.text}</div>
      {q.instruction && <div className="log-note">{q.instruction}</div>}
      <div className="log-meta">
        {q.askedLoc && <span className="log-loc"><Icon name="pin" size={12} /> {q.askedLoc.label}</span>}
        {q.gps?.p1 && <a href={`https://www.google.com/maps/search/?api=1&query=${q.gps.p1.lat},${q.gps.p1.lng}`} target="_blank" rel="noopener noreferrer" className="log-loc" style={{textDecoration: 'none'}}><Icon name="pin" size={12} /> P1 {q.gps.p1.label}</a>}
        {q.gps?.p2 && <a href={`https://www.google.com/maps/search/?api=1&query=${q.gps.p2.lat},${q.gps.p2.lng}`} target="_blank" rel="noopener noreferrer" className="log-loc" style={{textDecoration: 'none'}}><Icon name="pin" size={12} /> P2 {q.gps.p2.label}</a>}
      </div>
      {q.answer
        ? <div className="log-answer" style={{ '--at': answerTone(q.answer.value) }}><span className="log-answer-dot" /> {q.answer.value}{photo && <img className="log-thumb" src={photo.dataUrl} alt="" />}</div>
        : <div className="log-answer log-pending"><span className="log-answer-dot" /> awaiting answer…</div>}
    </div>
  );
}

export function QuestionLog({ state }) {
  const items = state.activeQuestion ? [state.activeQuestion, ...state.questionLog] : state.questionLog;
  if (items.length === 0) return <div className="empty-state">No questions asked yet.</div>;
  return <div className="log-list">{items.map(q => <LogEntry key={q.id} q={q} photos={state.photos} />)}</div>;
}

function downloadDataUrl(dataUrl, name) {
  const a = document.createElement('a');
  a.href = dataUrl; a.download = name; document.body.appendChild(a); a.click(); a.remove();
}

export function Gallery({ state }) {
  const [open, setOpen] = useState(null);
  const photos = state.photos;
  const safe = (s) => (s || 'photo').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const downloadAll = () => photos.forEach((p, i) => setTimeout(() => downloadDataUrl(p.dataUrl, `${String(i + 1).padStart(2, '0')}-${p.kind}-${safe(p.label)}.jpg`), i * 250));
  if (photos.length === 0) return <div className="empty-state">No photos yet.<br /><span>Photo answers and curse proofs appear here.</span></div>;
  return (
    <>
      <button className="btn btn-outline btn-md btn-full gallery-dl" onClick={downloadAll}><Icon name="download" size={16} /> Download all ({photos.length})</button>
      <div className="gallery-grid">
        {photos.map(p => (
          <button className="gallery-cell" key={p.uid} onClick={() => setOpen(p)}>
            <img src={p.dataUrl} alt={p.label} />
            <span className={`gallery-tag gallery-tag-${p.kind === 'curse-proof' ? 'curse' : 'answer'}`}>{p.kind === 'curse-proof' ? 'proof' : 'answer'}</span>
            <span className="gallery-cap">{p.label}</span>
          </button>
        ))}
      </div>
      {open && (
        <div className="lightbox" onClick={() => setOpen(null)}>
          <img src={open.dataUrl} alt={open.label} onClick={e => e.stopPropagation()} />
          <div className="lightbox-bar" onClick={e => e.stopPropagation()}>
            <div><div className="lightbox-label">{open.label}</div><div className="lightbox-sub">{open.kind === 'curse-proof' ? 'Curse proof · seeker' : 'Question answer · hider'} · {fmtTimeOfDay(open.at)}</div></div>
            <button className="btn btn-solid btn-accent btn-sm" onClick={() => downloadDataUrl(open.dataUrl, `${open.kind}-${safe(open.label)}.jpg`)}><Icon name="download" size={15} /> Save</button>
          </div>
          <button className="lightbox-close" onClick={() => setOpen(null)}><Icon name="close" size={22} /></button>
        </div>
      )}
    </>
  );
}
