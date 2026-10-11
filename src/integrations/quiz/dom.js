//
// Tiny DOM helpers + scoped styles for the quiz UI (no innerHTML with user text).
//

function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for(const [k, v] of Object.entries(attrs || {})) {
        if(v === undefined || v === null || v === false) continue;
        if(k === 'class') el.className = v;
        else if(k === 'text') el.textContent = v;
        else if(k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if(k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if(k in el && typeof v !== 'string') el[k] = v;
        else el.setAttribute(k, v === true ? '' : v);
    }
    for(const c of children.flat()) {
        if(c === null || c === undefined || c === false) continue;
        el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
}

const css = `
.quiz { --q-scale: 1; color: var(--foreground-color, #fff); font-family: inherit; }
.quiz button, .quiz select, .quiz input, .quiz textarea { font: inherit; color: inherit; }
.quiz .q-btn {
  min-height: 48px; min-width: 48px; padding: 8px 16px; border-radius: 10px;
  border: 1px solid var(--border-color, #fff3); background: var(--chrome, #35363a);
  cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent;
  font-size: 18px;
}
.quiz .q-btn:active { filter: brightness(1.3); }
.quiz .q-btn[disabled] { opacity: .45; }
.quiz .q-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.quiz .q-muted { color: var(--foreground-color-inactive, #aaa); }

/* in-ride panel */
.quiz-panel { display: flex; flex-direction: column; gap: 12px; padding: 12px; min-height: 100%; }
.quiz-panel .q-status { display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; font-size: 18px; }
.quiz-panel .q-zone { padding: 4px 12px; border-radius: 999px; background: var(--chrome, #35363a); }
.quiz-panel .q-zone[data-zone=work] { background: var(--zone-orange, #FF663A); color: #000; }
.quiz-panel .q-zone[data-zone=tempo] { background: var(--zone-yellow, #F8C73A); color: #000; }
.quiz-panel .q-zone[data-zone=endurance] { background: var(--zone-green, #57C057); color: #000; }
.quiz-panel .q-zone[data-zone=recovery] { background: var(--zone-blue, #328AFF); color: #000; }
.quiz-panel .q-card {
  flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 16px;
  padding: 16px; border-radius: 14px; background: var(--white-opacity-01, #ffffff12);
  min-height: 180px; text-align: center; user-select: none; -webkit-user-select: none;
}
.quiz-panel .q-question { font-size: calc(clamp(28px, 4.2vw, 56px) * var(--q-scale)); line-height: 1.2; white-space: pre-wrap; overflow-wrap: anywhere; }
.quiz-panel .q-answer { font-size: calc(clamp(24px, 3.6vw, 48px) * var(--q-scale)); line-height: 1.2; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--green, #40FF70); }
.quiz-panel .q-answer.q-wrong { color: var(--red, #FF495F); }
.quiz-panel .q-reveal { min-height: 88px; font-size: 30px; width: 100%; }
.quiz-panel .q-choices { display: grid; grid-template-columns: 1fr; gap: 10px; }
@media (min-width: 700px) { .quiz-panel .q-choices { grid-template-columns: 1fr 1fr; } }
.quiz-panel .q-choice { min-height: 72px; font-size: calc(26px * var(--q-scale)); text-align: left; }
.quiz-panel .q-choice.q-correct { background: var(--zone-green, #57C057); color: #000; }
.quiz-panel .q-choice.q-picked-wrong { background: var(--red, #FF495F); color: #000; }
.quiz-panel .q-grades { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.quiz-panel .q-grade { min-height: 96px; font-size: 26px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; }
.quiz-panel .q-grade small { font-size: 15px; opacity: .8; }
.quiz-panel .q-grade[data-r="1"] { background: #b3263a; }
.quiz-panel .q-grade[data-r="2"] { background: #8a6d12; }
.quiz-panel .q-grade[data-r="3"] { background: #23803f; }
.quiz-panel .q-grade[data-r="4"] { background: #1f5fae; }
.quiz-panel .q-grade.q-suggested { outline: 4px solid var(--white, #fff); }
.quiz-panel .q-progress { height: 8px; border-radius: 4px; background: var(--white-opacity-01, #ffffff22); overflow: hidden; }
.quiz-panel .q-progress > div { height: 100%; width: 0; background: var(--foreground-color, #fff); }
.quiz-panel .q-msg { font-size: 26px; text-align: center; padding: 24px 8px; }
.quiz-panel .q-toolbar { display: flex; gap: 10px; justify-content: space-between; flex-wrap: wrap; }
.quiz-panel .q-toolbar .q-btn { min-height: 56px; font-size: 20px; }

/* manager (settings page) */
.quiz-manager { display: flex; flex-direction: column; gap: 20px; padding: 8px 0; }
.quiz-manager h3 { font-size: 22px; margin-bottom: 8px; }
.quiz-manager label { display: flex; flex-direction: column; gap: 4px; font-size: 16px; }
.quiz-manager label.q-check { flex-direction: row; align-items: center; gap: 10px; min-height: 44px; }
.quiz-manager label.q-check input { width: 28px; height: 28px; }
.quiz-manager select, .quiz-manager input[type=text], .quiz-manager input[type=number], .quiz-manager textarea {
  min-height: 44px; padding: 8px; border-radius: 8px; border: 1px solid var(--border-color, #fff3);
  background: var(--background-color, #28272D); font-size: 16px;
}
.quiz-manager textarea { min-height: 160px; width: 100%; }
.quiz-manager .q-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
.quiz-manager .q-list { display: flex; flex-direction: column; gap: 6px; max-height: 480px; overflow: auto; }
.quiz-manager .q-item { display: flex; gap: 10px; align-items: center; padding: 8px; border-radius: 8px; background: var(--white-opacity-01, #ffffff10); }
.quiz-manager .q-item .q-item-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.quiz-manager .q-item input[type=checkbox] { width: 28px; height: 28px; flex: none; }
.quiz-manager .q-note { font-size: 14px; }
.quiz-manager .q-error { color: var(--red, #FF495F); }

.quiz-summary { padding: 12px 0; font-size: 18px; display: flex; gap: 16px; flex-wrap: wrap; }
.quiz-summary b { font-size: 24px; }
`;

let injected = false;
function injectStyles() {
    if(injected || typeof document === 'undefined') return;
    injected = true;
    document.head.append(h('style', { id: 'quiz-styles', text: css }));
}

export { h, injectStyles };
