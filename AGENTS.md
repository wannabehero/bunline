# Agent Instructions

## Post-Edit Hook
After every file edit (creating, modifying, or renaming files in `src/` or `tests/`), run the following command to ensure code is formatted and linted:
```bash
bun fix
```

## Pre-Commit Hook
Before committing changes (submitting), run the full test suite to ensure no regressions:
```bash
bun test
```
