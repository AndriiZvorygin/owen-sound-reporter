# Owen Sound Reporter Documentation

This folder documents the current extraction-first pipeline for Owen Sound council materials.

## Docs Index

- `owen-sound-flows.md`: End-to-end flow map, data locations, and run commands.
- `full-transcript-pipeline.md`: Full long-run transcript -> summary -> hook -> HTML -> image -> lemmy-payload flow.

## Scope Right Now

- Calendar link harvesting (idempotent monthly `.series.pya` files)
- Daily meeting workspace preparation
- Meeting pipeline execution (downloads, conversion, pruning, subreport extraction)
- Full transcript publication asset pipeline
- Wise-chip and summary example paths in `examples/pyash`

Lemmy payload generation is in scope; live posting remains optional and command-hook based.

- [Speaker Identity Guardrails](speaker-identity-guardrails.md)
