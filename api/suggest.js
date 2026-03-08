function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function buildSuggestions(query, offset, limit) {
  const q = query || 'your topic';
  const templates = [
    'Fast overview of "{q}" in 5 bullet points (Idea #{n}).',
    'Beginner-to-advanced roadmap for "{q}" (Idea #{n}).',
    'Trusted sources to validate "{q}" claims (Idea #{n}).',
    'Top 3 competing approaches for "{q}" (Idea #{n}).',
    'Main risks and caveats for "{q}" (Idea #{n}).',
    'Real-world use cases of "{q}" (Idea #{n}).',
    'High-signal search keywords for "{q}" (Idea #{n}).',
    'Explain "{q}" with simple and technical analogies (Idea #{n}).',
    'Evaluation checklist for "{q}" solutions (Idea #{n}).',
    'Action plan to start "{q}" today (Idea #{n}).'
  ];

  const out = [];
  for (let i = 0; i < limit; i += 1) {
    const absoluteIndex = offset + i;
    const base = templates[absoluteIndex % templates.length];
    out.push(
      base
        .replace(/{q}/g, q)
        .replace(/{n}/g, String(absoluteIndex + 1))
    );
  }
  return out;
}

export default function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body = req.body || {};
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    const mode = typeof body.mode === 'string' ? body.mode : 'a';
    const limit = clamp(Number(body.limit) || 10, 1, 10);
    const offset = clamp(Number(body.offset) || 0, 0, 5000);
    const suggestions = buildSuggestions(query, offset, limit);

    res.status(200).json({
      mode,
      query,
      offset,
      suggestions
    });
  } catch (err) {
    res.status(400).json({
      error: err.message || 'Bad request'
    });
  }
}