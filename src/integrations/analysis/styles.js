// Scoped styles for the analysis views (kept out of flux.css to ease merging)
const css = `
.an-overlay {
    position: fixed; inset: 0; z-index: 1000;
    background: rgba(0,0,0,0.55);
    display: none; align-items: flex-start; justify-content: center;
    overflow-y: auto; -webkit-overflow-scrolling: touch;
    padding: env(safe-area-inset-top, 0) 0 env(safe-area-inset-bottom, 0) 0;
}
.an-overlay.open { display: flex; }
.an-sheet {
    width: min(760px, 100%); margin: 2em auto; padding: 1em 1.25em 2em;
    background: var(--background-color, #28272D); color: var(--foreground-color, #fff);
    border-radius: 12px; box-sizing: border-box; font-family: 'Roboto', sans-serif;
}
@media (max-width: 600px) { .an-sheet { margin: 0; border-radius: 0; min-height: 100%; } }
.an-head { display: flex; align-items: center; gap: 0.75em; }
.an-head h2 { flex: 1; margin: 0; font-size: 1.3em; }
.an-sub { opacity: 0.7; font-size: 0.9em; }
.an-section { margin-top: 1.25em; }
.an-section h3 { margin: 0 0 0.5em; font-size: 1em; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.8; }
.an-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(7.5em, 1fr)); gap: 0.5em; }
.an-tile { border: 1px solid var(--border-color, #fff2); border-radius: 8px; padding: 0.5em 0.6em; }
.an-tile .v { font-size: 1.35em; font-weight: 700; }
.an-tile .l { font-size: 0.75em; opacity: 0.7; text-transform: uppercase; }
.an-btn {
    min-height: 44px; min-width: 44px; padding: 0 1em; border-radius: 8px;
    border: 1px solid var(--border-color, #fff3); background: transparent;
    color: inherit; font: inherit; font-size: 1em; cursor: pointer;
    touch-action: manipulation;
}
.an-btn.primary { background: var(--zone-blue, #328AFF); border-color: transparent; color: #fff; font-weight: 700; }
.an-btn:disabled { opacity: 0.45; cursor: default; }
.an-btn.small { min-height: 36px; padding: 0 0.75em; font-size: 0.9em; }
.an-row { display: flex; flex-wrap: wrap; gap: 0.5em; align-items: center; }
.an-toggle { display: flex; align-items: center; gap: 0.75em; min-height: 44px; padding: 0 0.25em; cursor: pointer; }
.an-toggle input[type=checkbox] { width: 26px; height: 26px; accent-color: var(--zone-blue, #328AFF); }
.an-toggle .route { opacity: 0.6; font-size: 0.85em; }
.an-table { width: 100%; border-collapse: collapse; font-size: 0.9em; }
.an-table th, .an-table td { text-align: right; padding: 0.35em 0.4em; border-bottom: 1px solid var(--border-color, #fff1); }
.an-table th:first-child, .an-table td:first-child { text-align: left; }
.an-status { display: inline-block; min-width: 4.5em; text-align: center; border-radius: 4px; padding: 0.1em 0.4em; font-size: 0.8em; }
.an-status.on-target, .an-status.done { background: var(--zone-green, #57C057); color: #000; }
.an-status.under, .an-status.failed { background: var(--zone-red, #FE340B); color: #fff; }
.an-status.over { background: var(--zone-orange, #FF663A); color: #000; }
.an-status.pending, .an-status.uploading, .an-status.no-target { background: #8884; }
.an-status.needs-setup { background: var(--zone-yellow, #F8C73A); color: #000; }
.an-bars { display: grid; gap: 0.3em; }
.an-bar { display: grid; grid-template-columns: 3.2em 1fr 3.5em; align-items: center; gap: 0.5em; font-size: 0.85em; }
.an-bar .track { height: 14px; background: #8882; border-radius: 4px; overflow: hidden; }
.an-bar .fill { height: 100%; border-radius: 4px; }
.an-note { opacity: 0.75; font-size: 0.88em; line-height: 1.4; }
.an-note a { color: var(--zone-blue, #328AFF); }
.an-rating { font-size: 2.5em; font-weight: 700; line-height: 1; }
.an-feedback ul { margin: 0.25em 0 0.75em; padding-left: 1.2em; }
.an-feedback li { margin: 0.2em 0; line-height: 1.35; }
.an-textarea, .an-input {
    width: 100%; box-sizing: border-box; font-size: 16px; padding: 0.6em;
    border-radius: 8px; border: 1px solid var(--border-color, #fff3);
    background: transparent; color: inherit; font-family: inherit;
}
.an-input { min-height: 44px; }
.an-field { display: grid; gap: 0.25em; margin: 0.5em 0; }
.an-field label { font-size: 0.85em; opacity: 0.8; }
.an-details summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; }
.an-panel { padding: 0.75em; }
.an-error { color: var(--zone-red, #FE340B); }
#analysis-settings { margin: 1.5em 0; }
#analysis-settings .an-card { border: 1px solid var(--border-color, #fff2); border-radius: 10px; padding: 0.75em 1em; margin: 0.75em 0; }
`;

function injectStyles() {
    if(typeof document === 'undefined' || document.getElementById('analysis-styles')) return;
    const style = document.createElement('style');
    style.id = 'analysis-styles';
    style.textContent = css;
    document.head.appendChild(style);
}

export { injectStyles };
