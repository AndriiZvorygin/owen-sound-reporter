import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

test("Owen transcript wrappers enable sentence-level cue diarization", () => {
  const runner = read("run-owen-sound-youtube-from-ref.mjs");
  const pipeline = read("run-full-transcript-pipeline.mjs");
  assert.match(runner, /PYA_SPEAKER_CUE_LEVEL_TURNS: "1"/u);
  assert.match(pipeline, /buildSentenceDiarizationEnv/u);
  for (const source of [runner, pipeline]) {
    assert.doesNotMatch(source, /PYA_SPEAKER_REASSIGN_PASS/u);
    assert.doesNotMatch(source, /PYA_SPEAKER_RELABEL_MODE/u);
  }
});

test("Owen uses the shared anonymous sentence policy by default", () => {
  const source = read("run-full-transcript-pipeline.mjs");
  assert.match(source, /buildSentenceDiarizationEnv/u);
  assert.match(source, /speakerArtifactUsesDefaultLabels/u);
  assert.match(source, /skipWhen: \(\) => !namedSpeakerIdentity/u);
});
