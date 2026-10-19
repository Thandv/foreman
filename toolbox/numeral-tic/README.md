# numeral-tic

Finds the numbers a manuscript leans on.

A book whose whole aesthetic is that every quantity was counted gives itself away
when the same few numbers do all the counting: one number used far more often
than its neighbours, while others are never used at all, and inside a single
chapter the same number for the crates, the price, the distance and the days.
Each use is fine. Together they read as decoration, and it is the first thing
an outside reader names.

## Usage

```
echo '{"chapters":[{"path":"ch01.md","text":"..."}]}' | node tool.js
```

Input: every chapter of the book in one call, so the totals mean something.
`topN` (default 8) is how many numerals to report per chapter; `minRate`
(default 2) is the uses-per-thousand-words bar for counting as leaned on.

Output: `overall` (the whole book's tally), `perChapter` (each chapter's top
numerals, the ones over the rate bar, and a `concentration` score), and
`worstChapters` (where a sweep buys the most).

## What it counts, and what it deliberately does not

- **Spelled numbers, not digits.** Prose says "eleven wagons", not "11 wagons".
- **Compounds whole.** "forty-one" is its own number, not a forty beside a one.
- **Not "one".** It is a pronoun and an article far more often than a quantity
  — "one of them", "the one with the dog" — and counting it drowns the signal
  in grammar.
- **Scale words stay out of the ranking.** "four hundred" and "eleven hundred"
  both spend a "hundred", so on a real manuscript it topped every chapter and
  buried the number the writer was actually reaching for. It is still in the
  overall tally, where it is honest.

It counts and it never edits. It cannot know which figures are load-bearing — a
grain total another chapter depends on looks exactly like an invented one — so
it reports where the leaning is worst and leaves every decision to a person.
