# csv-reader-fast

A faster drop-in for **csv-reader 1.0.0**, entered in
[make.fun's "Read broken CSV files faster"](https://make.fun/bounty/csv-reader-speed-01-run-20261121).

[![make.fun · csv-reader-speed-01](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

`solve.js` exports `run(input)` and returns exactly what csv-reader 1.0.0 returns
for the same input: `{columns, rows, errors}`, same strings, same error order.

## Why it is faster

The reference grows every field one character at a time (`value += c`). In V8 that
builds a **rope**, a chain of cons-strings that is cheap to extend and expensive to
flatten, and the final `JSON.stringify` has to flatten every one of them.

This module keeps the same left-to-right reading and the same broken-row policy but
takes each field as **one slice of the source text**. A slice is a `SlicedString`:
O(1) to create and already flat, so the stringify that follows is a straight copy.

The quoted-field path scans for the closing quote with `indexOf` and skips doubled
quotes; only fields that actually contain `""` or a CR take the character loop, and
those are a few percent of the input.

## Correctness

The policy is unchanged, including the parts that look like accidents: a CR outside
quotes is dropped and reported, a quote that never closes is a literal character and
its text is re-read as unquoted, text after a closing quote is appended and reported
as `quote_junk`, and a line that held only stray CRs is no record while its errors
stay.

Checked against the reference on the kit's practice set (6/6 cases identical) and by
differential fuzzing on 180,000 generated inputs built from quotes, doubled quotes,
bare CRs, CRLF, BOMs and non-ASCII text: no differences.

## Run it

```sh
MAKEFUN_INPUT_DIR=./in MAKEFUN_OUTPUT_DIR=./out node main.ts
```

`main.ts` reads every case from `<input>/cases.json`, answers each with `run`, and
writes `<output>/answers.json`.

## License

MIT.
