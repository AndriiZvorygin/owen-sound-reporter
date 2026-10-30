import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("Owen whole-meeting child timeout scales with recording length", () => {
  const source = fs.readFileSync(
    new URL("../run-full-transcript-pipeline.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /timeoutMs: scaleTimeout\(35 \* 60 \* 1000, audioSeconds, 0\.8\)/u);
  assert.match(source, /long complete meeting\n\s*\/\/ remains retryable instead of being SIGKILLed/u);
});

test("meeting-wide one-sentence generation retries the complete teaser contract", () => {
  const source = fs.readFileSync(
    new URL("../run-full-transcript-pipeline.mjs", import.meta.url),
    "utf8",
  );
  const generator = source.slice(
    source.indexOf("async function generateMeetingWideOneSentenceLlm"),
    source.indexOf("function oneSentenceMatchesLeadTopic"),
  );
  assert.match(generator, /explainMalformedOneSentence\(candidate/u);
  assert.match(generator, /at most 4 commas/u);
  assert.match(generator, /If the reason is too_many_commas, rewrite from scratch with zero commas/u);
  assert.match(generator, /missing_action_verb[\s\S]*?explicit finite action verb/u);
  assert.match(generator, /Do not use only noun forms such as hearing, consideration, review, discussion, or passage/u);
  assert.match(generator, /Fresh repair contract: do not revise or quote the rejected sentence/u);
  assert.match(generator, /Math\.min\(3, blocks\.length\)/u);
  assert.match(generator, /all substantive recap items available for this short meeting/u);
  assert.match(generator, /const singleSubstantiveMeeting = !allowProcedural[\s\S]*?blocks\.length === 1[\s\S]*?Number\(groundedSectionCount\) >= 2/u);
  assert.doesNotMatch(generator, /Number\(groundedSectionCount\) >= 2[\s\S]*?>= 30/u);
  assert.match(generator, /Previous response contained \$\{lastWordCount\} words/u);
  assert.match(generator, /Return exactly 48-64 words/u);
  assert.match(generator, /Remove at least \$\{Math\.max\(1, lastWordCount - 64\)\} words/u);
  assert.match(generator, /maxWords: MEETING_TEASER_MAX_WORDS/u);
  assert.match(generator, /chosenBlocks\.map\(\(block\) => `\$\{String\(block\.heading \|\| ""\)\} \$\{String\(block\.summary \|\| ""\)\}`\)/u);
  assert.match(generator, /const authoritativeRoleConstraint = agendaRoleConstraint/u);
  assert.match(generator, /authoritativeRoleConstraint,/u);
  assert.match(generator, /at least two distinctive words from its matching numbered recap item heading or summary/iu);
  assert.match(generator, /REQUIRED PER-ITEM COVERAGE ANCHORS/iu);
  assert.match(source, /function isStructuralAgendaParent/u);
  assert.match(source, /Do not mention Public Forum, correspondence, minutes/u);
  assert.match(source, /no \(questions\?|participants\?|speakers\?|submissions\?|audience members\?\)/u);
  assert.match(source, /const MEETING_TEASER_MAX_WORDS = 72/u);
  assert.match(source, /oneSentenceValidationContext = \{[\s\S]*?maxWords: MEETING_TEASER_MAX_WORDS/u);
});
