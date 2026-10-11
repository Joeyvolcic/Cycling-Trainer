//
// Post-ride "Coach feedback": sends the ride summary (+ planned workout + optional plan
// context) to Claude through the shared AI client and normalizes the answer.
//

const SYSTEM = [
    'You are an experienced, evidence-based cycling coach reviewing one indoor trainer ride.',
    'Judge workout quality against what was planned (interval compliance, pacing, completion),',
    'and use heart-rate response (drift / aerobic decoupling, zones) as a signal of fatigue or fitness.',
    'Be specific and concise, reference actual numbers from the data, and do not invent data that is missing.',
    'If FTP or heart-rate data is missing, say what that limits instead of guessing.',
    'Suggested adjustments must be practical changes to the upcoming sessions (intensity, duration, recovery, FTP test),',
    'and should be conservative when signs of fatigue are present. You are not a doctor; do not give medical advice.',
].join(' ');

const RESPONSE_SHAPE = `{
  "rating": <integer 1-10, overall workout quality/execution>,
  "headline": "<one sentence verdict>",
  "wentWell": ["<short point>", ...],
  "improve": ["<short point>", ...],
  "adjustments": [{"when": "<date or 'next ride' etc>", "suggestion": "<concrete change>"}, ...]
}`;

// compact the planned workout so the prompt stays small
function compactWorkout(workout, ftp) {
    if(!workout || !Array.isArray(workout.intervals)) return null;
    return {
        name: workout.meta?.name ?? null,
        description: workout.meta?.description ?? null,
        intervals: workout.intervals.map((interval, i) => {
            const steps = interval.steps ?? [];
            const powers = steps.map(s => s.power).filter(p => typeof p === 'number');
            const pct = powers.map(p => p < 9 ? Math.round(p * 100) : (ftp ? Math.round(p / ftp * 100) : null));
            return {
                index: i,
                durationSec: interval.duration ?? steps.reduce((a, s) => a + (s.duration ?? 0), 0),
                targetPctFtp: pct.length === 0 ? null :
                    (Math.min(...pct) === Math.max(...pct) ? pct[0] : [Math.min(...pct), Math.max(...pct)]),
                cadence: steps.find(s => s.cadence)?.cadence ?? null,
                slope: steps.find(s => typeof s.slope === 'number')?.slope ?? null,
            };
        }),
    };
}

function buildCoachRequest({summary, workout, planContext, athlete = {}, notes = ''} = {}) {
    const payload = {
        athlete: {ftp: summary?.ftp ?? null, maxHr: athlete.maxHr ?? null, lthr: athlete.lthr ?? null},
        ride: summary,
        plannedWorkout: compactWorkout(workout, summary?.ftp),
        trainingPlan: planContext ?? null,
        riderNotes: notes || null,
    };
    const prompt = [
        'Here is the data for the ride I just finished (JSON):',
        '```json',
        JSON.stringify(payload, null, 1),
        '```',
        'Rate the workout quality from 1 to 10, list what went well and what to improve,',
        'and suggest adjustments to my upcoming training' +
            (planContext ? ' (the upcoming planned sessions are in trainingPlan).' : '.'),
        `Respond with JSON only, in this shape:\n${RESPONSE_SHAPE}`,
    ].join('\n');
    return {system: SYSTEM, prompt};
}

function asList(x) {
    if(Array.isArray(x)) return x.map(v => typeof v === 'string' ? v : (v?.text ?? JSON.stringify(v))).filter(Boolean);
    if(typeof x === 'string' && x.trim()) return [x.trim()];
    return [];
}

function normalizeFeedback(raw) {
    let data = raw;
    if(typeof raw === 'string') {
        try {
            const m = raw.match(/\{[\s\S]*\}/);
            data = JSON.parse(m ? m[0] : raw);
        } catch(e) {
            return {rating: null, headline: '', wentWell: [], improve: [], adjustments: [], text: raw};
        }
    }
    data = data ?? {};
    let rating = Math.round(Number(data.rating));
    rating = Number.isFinite(rating) ? Math.min(10, Math.max(1, rating)) : null;
    const adjustments = (Array.isArray(data.adjustments) ? data.adjustments : asList(data.adjustments))
        .map(a => typeof a === 'string' ? {when: '', suggestion: a} : {
            when: String(a?.when ?? ''),
            suggestion: String(a?.suggestion ?? a?.text ?? ''),
        })
        .filter(a => a.suggestion);
    return {
        rating,
        headline: String(data.headline ?? ''),
        wentWell: asList(data.wentWell),
        improve: asList(data.improve),
        adjustments,
    };
}

// ai = {isConfigured, complete}
async function requestFeedback(ai, args = {}) {
    if(!ai?.isConfigured?.()) throw new Error('AI is not configured');
    const {system, prompt} = buildCoachRequest(args);
    const raw = await ai.complete({system, prompt, json: true, maxTokens: 4000});
    return Object.assign(normalizeFeedback(raw), {
        createdAt: Date.now(),
        source: 'claude',
    });
}

export {
    buildCoachRequest,
    normalizeFeedback,
    requestFeedback,
    compactWorkout,
};
