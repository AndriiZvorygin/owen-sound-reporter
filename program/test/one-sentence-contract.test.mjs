import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { verifyAgendaOneSentenceStrictLlm } from "../run-owen-sound-meeting-from-ref.mjs";

test("Owen one-sentence verifier retries when corrected prose omits a selected topic", async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    const request = JSON.parse(options.body);
    if (calls === 2) {
      assert.match(request.messages[1].content, /selected agenda topics/u);
      assert.match(request.messages[1].content, /REJECTION_REASON:.*selected agenda topic coverage/u);
      assert.match(request.messages[1].content, /PRIOR_REJECTED_CORRECTED_OUTPUT:/u);
    }
    const corrected = calls === 1
      ? "Council reviews shifting funds from the WSIB Reserve while residents challenge water charges before the committee considers further financial policy changes."
      : "Council reviews parking limits and the WSIB Reserve while residents challenge water charges during the scheduled Committee meeting.";
    return {
      ok: true,
      async json() {
        return { message: { content: JSON.stringify({ pass: true, corrected, reason: "grounded" }) } };
      },
    };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await verifyAgendaOneSentenceStrictLlm({
    candidateText: "Council reviews parking limits and the WSIB Reserve while residents challenge water charges.",
    sourceTopNews: "8.c.1 Reserves and Reserve Fund Policy Update: The WSIB Reserve is under review. 8.b.1 Parking Management and Enforcement Review: parking limits are under review.",
    sourceSections: "8.c.1 Reserves and Reserve Fund Policy Update\n8.b.1 Parking Management and Enforcement Review",
    selectedItems: [
      { item: "8.c.1", title: "Report CR-26-070 AF016 Reserves and Reserve Fund Policy Update" },
      { item: "8.b.1", title: "Report CR-26-085 Parking Management and Enforcement Review" },
    ],
  });

  assert.equal(calls, 2);
  assert.equal(result.pass, true);
  assert.match(result.corrected, /parking/u);
});

test("Owen agenda teaser retries and gates the complete one-sentence contract", () => {
  const source = fs.readFileSync(
    new URL("../run-owen-sound-meeting-from-ref.mjs", import.meta.url),
    "utf8",
  );
  const generator = source.slice(
    source.indexOf("async function generateOneSentenceSummaryLlm"),
    source.indexOf("async function rewriteUpcomingAgendaSummaryLlm"),
  );
  const verifier = source.slice(
    source.indexOf("async function verifyAgendaOneSentenceStrictLlm"),
    source.indexOf("async function buildAgendaSummarySourcePath"),
  );

  assert.match(source, /const AGENDA_ONE_SENTENCE_MIN_WORDS = 18/u);
  assert.match(source, /const AGENDA_ONE_SENTENCE_MAX_WORDS = 32/u);
  assert.match(generator, /REJECTED_CANDIDATE:/u);
  assert.match(generator, /numeric fidelity defect/u);
  assert.match(generator, /if \(!defects\.length\) return candidate/u);
  assert.doesNotMatch(generator, /extractLeadingSentence/u);
  assert.match(verifier, /PRIOR_REJECTED_CORRECTED_OUTPUT:/u);
  assert.match(verifier, /numeric fidelity defect/u);
  assert.match(verifier, /isValidAgendaOneSentence\(normalizedCorrected\)/u);
  assert.match(source, /const oneSentenceLocalPass = isValidAgendaOneSentence\(oneSentenceSummary\)/u);
  assert.match(source, /const oneSentencePass = oneSentenceLocalPass/u);

  const agendaPublisher = fs.readFileSync(
    new URL("../../../../../command/publish_agenda_to_helpos_from_payload.mjs", import.meta.url),
    "utf8",
  );
  assert.match(agendaPublisher, /loadEnvFallbacks\(process\.cwd\(\), payloadPath\)/u);
  assert.match(agendaPublisher, /path\.dirname\(path\.resolve\(payloadPath\)\)/u);
});

