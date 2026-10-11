// Scoped styles for the media panel/settings (injected once; avoids editing flux.css).
const css = `
.mp { --mp-bg: rgba(127,127,127,0.08); --mp-fg: inherit; --mp-accent: #1db954; --mp-muted: rgba(127,127,127,0.9);
      --mp-touch: 48px; display: block; font-size: 1rem; color: var(--mp-fg); }
.mp * { box-sizing: border-box; }
.mp button, .mp .mp-btn { min-height: var(--mp-touch); min-width: var(--mp-touch); border: 0; border-radius: 12px;
      background: var(--mp-bg); color: inherit; font: inherit; padding: 0 14px; cursor: pointer; touch-action: manipulation;
      display: inline-flex; align-items: center; justify-content: center; gap: 6px; text-decoration: none; }
.mp button:active { transform: scale(0.97); }
.mp button[disabled] { opacity: 0.4; }
.mp button.mp-primary { background: var(--mp-accent); color: #000; font-weight: 600; }
.mp input[type=text], .mp input[type=url], .mp input[type=search], .mp select {
      min-height: var(--mp-touch); border-radius: 10px; border: 1px solid rgba(127,127,127,0.4); padding: 0 12px;
      background: transparent; color: inherit; font: inherit; width: 100%; }
.mp-tabs { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 8px; }
.mp-tabs button.active { background: var(--mp-accent); color: #000; }
.mp-msg { padding: 10px 12px; border-radius: 10px; background: var(--mp-bg); margin: 8px 0; line-height: 1.4; }
.mp-msg.err { background: rgba(220,60,60,0.15); }
.mp-row { display: flex; gap: 8px; align-items: center; margin: 8px 0; flex-wrap: wrap; }
.mp-row > input, .mp-row > select { flex: 1 1 200px; }
.mp-card { display: grid; grid-template-columns: minmax(96px, 180px) 1fr; gap: 16px; align-items: center;
      padding: 12px; border-radius: 16px; background: var(--mp-bg); }
.mp-art { width: 100%; aspect-ratio: 1; border-radius: 12px; object-fit: cover; background: rgba(127,127,127,0.2); }
.mp-title { font-size: 1.6rem; font-weight: 700; line-height: 1.2; overflow: hidden; display: -webkit-box;
      -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.mp-sub { font-size: 1.1rem; color: var(--mp-muted); margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mp-badge { display: inline-block; font-size: 0.8rem; padding: 2px 8px; border-radius: 999px; background: var(--mp-bg); margin-top: 6px; }
.mp-progress { width: 100%; height: var(--mp-touch); margin: 8px 0 0; accent-color: var(--mp-accent); }
.mp-times { display: flex; justify-content: space-between; font-variant-numeric: tabular-nums; color: var(--mp-muted); }
.mp-controls { display: flex; gap: 10px; justify-content: center; align-items: center; margin: 12px 0; }
.mp-controls button { min-width: 64px; min-height: 64px; font-size: 1.4rem; border-radius: 50%; }
.mp-controls button.mp-play { min-width: 88px; min-height: 88px; font-size: 2rem; background: var(--mp-accent); color: #000; }
.mp-list { list-style: none; margin: 0; padding: 0; }
.mp-item { display: flex; align-items: center; gap: 12px; min-height: 60px; padding: 6px 8px; border-radius: 10px; cursor: pointer; }
.mp-item:active { background: var(--mp-bg); }
.mp-item img, .mp-item .mp-noart { width: 48px; height: 48px; border-radius: 6px; object-fit: cover; flex: none; background: rgba(127,127,127,0.2); }
.mp-item .mp-meta { flex: 1; min-width: 0; }
.mp-item .mp-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mp-item .mp-desc { font-size: 0.85rem; color: var(--mp-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mp-bar { height: 4px; border-radius: 2px; background: rgba(127,127,127,0.3); margin-top: 4px; overflow: hidden; }
.mp-bar > i { display: block; height: 100%; background: var(--mp-accent); }
.mp-h { font-size: 1.1rem; font-weight: 700; margin: 16px 0 6px; }
.mp-seg { padding: 8px 12px; border-radius: 10px; background: var(--mp-bg); margin-top: 8px; }
.mp-toggle { display: flex; align-items: center; gap: 10px; min-height: var(--mp-touch); }
.mp-toggle input { width: 28px; height: 28px; }
.mp-vol { width: 100%; height: var(--mp-touch); accent-color: var(--mp-accent); }
.mp code { word-break: break-all; }
@media (max-width: 600px) {
  .mp-card { grid-template-columns: 1fr; }
  .mp-art { max-width: 240px; margin: 0 auto; }
}
`;

let injected = false;
function injectStyles() {
    if(injected || typeof document === 'undefined') return;
    const style = document.createElement('style');
    style.id = 'media-integration-styles';
    style.textContent = css;
    document.head.appendChild(style);
    injected = true;
}

export { injectStyles };
