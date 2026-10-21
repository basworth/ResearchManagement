import re, sys
html = open("research-tracker.html").read()
start = html.index("// Bumped whenever these rules learn something new.")
end = html.index("// ---------- The queue ----------")
block = html[start:end].rstrip() + "\n"
# App reads state.studies; the server is handed them.
block = block.replace("state.studies || []", "STUDIES")
EXPORTS = ["PARSER_VERSION", "stripPHI", "setMatchHints", "setMeetings", "matchStudyFromText", "readEmail", "applyChangeTo"]
for name in EXPORTS:
    block = re.sub(r"^(const %s\b|function %s\b)" % (name, name), r"export \1", block, flags=re.M)
header = '''// Shared matching rules — a LITERAL COPY of the block in research-tracker.html that sits between
// "Bumped whenever these rules learn something new" and "The queue".
//
// It is duplicated because the app must read a pasted email with no network, and the server must
// read a forwarded one with no browser. Two copies of a rule is how rules quietly drift apart, so
// test_parser_parity.js runs the same fixtures through both and fails if they ever disagree. If
// you change one, copy it to the other and let the test confirm it.
//
// The only difference between the two: the app reads `state.studies`; here the studies are handed
// in as STUDIES.

// deno-lint-ignore-file no-explicit-any
let STUDIES: any[] = [];
export function setStudies(list: any[]) { STUDIES = list || []; }

'''
open("supabase/functions/ingest-email/rules.ts","w").write(header + block)
print("wrote", len((header+block).split("\n")), "lines")
