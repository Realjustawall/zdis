# Language packs

The complete catalogs are generated in both `language/` and
`client/src/language/`. The client imports `client/src/language/` at runtime.
The catalogs include visible text found across the client and server, including
chat, admin, settings, authentication, panels, shared UI, and API errors.

Run `node scripts/extract-language-catalog.mjs` after adding visible text. The
generator preserves existing translations while adding new `text.*` entries.
Edit the values (not the keys) in `client/src/language/en.json` and `fa.json`.
To add a language, copy `en.json`, rename it to the locale code, translate the
values, and place the translated copy in `client/src/language/`. Language files
are discovered automatically. The browser preference is used on the first
visit, and the saved selection is used afterward.
