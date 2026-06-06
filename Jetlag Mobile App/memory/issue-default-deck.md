name: issue-default-deck
description: Fix deckConfig initialization and default handling in store.js

**Issue:** The admin panel sometimes showed an empty or incorrect deck because `state.deckConfig` wasn't properly initialized before being read.

**Root causes found:**
1. `freshState()` could receive a `cfg` with undefined `deckConfig`, falling back to `DEFAULT_DECK_CONFIG` correctly but silently
2. `loadState()` had incomplete guards: it only defaulted `deckConfig` if it was missing, not if it existed but was empty/invalid

**Fixes applied:**
1. **store.js** - Added explicit validation in `loadState()`: defaults `s.deckConfig = DEFAULT_DECK_CONFIG` if missing OR if typeof is not object OR if Object.keys() is 0 (empty)
2. **store.js** - Added error handling: catch block now logs warnings to help debug localStorage corruption
3. **store.js** - Added fallback before calling freshState(): if cfg or cfg.deckConfig is invalid, recreate with defaults

**Why the fixes are safe:**
- `DEFAULT_DECK_CONFIG` is imported from data.js and always available
- The fallback happens BEFORE `freshState()` runs, so it always gets valid config
- Error logging helps identify localStorage corruption issues during development

**Files modified:**
- src/lib/store.js - loadState() and freshState() improvements
