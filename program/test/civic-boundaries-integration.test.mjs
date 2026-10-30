import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("Owen whole-meeting recap preserves civic abbreviations and gives retries rejection feedback", () => {
  const source = fs.readFileSync(
    new URL("../run-full-transcript-pipeline.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /function cleanHeadlineText\(input\)[\s\S]*?splitCivicSentences\(t\)\[0\]/u,
  );
  assert.match(source, /RETRY_FEEDBACK: The prior response was rejected because/u);
  assert.match(source, /PRIOR_REJECTED_OUTPUT:/u);
  assert.match(source, /do not select only its opening sentence/u);
  assert.match(source, /select the central municipal action or topic and one supporting detail/u);
  assert.match(source, /Delete the exact meeting-date phrase/u);
  assert.match(source, /meeting date is article metadata, not SOURCE_ITEM information to preserve/u);
  assert.match(source, /Begin directly with the substantive item action or topic/u);
  assert.match(source, /numPredict: attempt > 1 \? 180 : 110/u);
  assert.doesNotMatch(source, /Council heard\.\.\., considered\.\.\., and adopted/u);
  assert.match(source, /unsupported outcome verb named in that error must be replaced/u);

  const agendaSource = fs.readFileSync(
    new URL("../run-owen-sound-meeting-from-ref.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(agendaSource, /extractCivicLeadingSentence/u);
  assert.match(agendaSource, /REJECTION_REASON:/u);
  assert.match(agendaSource, /candidateText: llmOneSentence \|\| oneSentenceSummary/u);
  assert.doesNotMatch(agendaSource, /function buildAgendaOneSentenceFallback/u);
});
