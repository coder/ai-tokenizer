// Shared result recorder for the node journeys. Each check records what the user did,
// what tiktoken or the documented behavior expects, and what ai-tokenizer did.
const results = [];

export function outcome(fn) {
  try {
    return { value: fn() };
  } catch (e) {
    return { threw: String(e?.message ?? e) };
  }
}

export function check(id, action, expected, observed, pass) {
  results.push({ id, pass: Boolean(pass), action, expected, observed });
}

export function sameJSON(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function finish(feature) {
  const failed = results.filter((r) => !r.pass);
  console.log(JSON.stringify({ feature, passed: results.length - failed.length, failed: failed.length, checks: results }, null, 2));
  for (const r of results) console.error(`${r.pass ? "PASS" : "FAIL"} ${feature}/${r.id}`);
  process.exitCode = failed.length ? 1 : 0;
}
