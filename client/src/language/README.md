# Adding a language

Run `node scripts/extract-language-catalog.mjs` from the repository root after
adding visible text. Copy `en.json`, rename it to the locale code, and
translate the values. Keep the keys unchanged. The filename must be a valid
language code, such as `de.json` or `pt-BR.json`. The client discovers it
automatically; when more than two files exist, the language control becomes a
menu containing every available language.

On a visitor's first load, the closest supported language from the browser's
preferences is selected. Later loads use the visitor's saved selection.
