## Alignment (LoRA on your own history)

```bash
foreman align status | extract | build | train
```

Builds SFT data from your Claude Code sessions and DPO pairs from Foreman's own
gate ledger (an approval is "like this"; a rejection with a reason is "not like
that"; a chair overruling an advisor is a judgement about a judgement).
The label is the run you decided at the approval gate (`runs.decision`), never
where the task ended up: a ticket you rejected and then finished by hand teaches
nothing, a ticket's earlier attempts are not its approved answer, and the owner
gate's decisions are labelled as its own (`owner-approved` / `owner-rejected`)
so a retry cannot pass them off as yours. Decisions from before the column
existed are read back from the status timeline.

**Redaction is a hard dependency, not a nicety.** Sixteen credential shapes,
plus home paths, usernames, emails and a high-entropy sweep; `assertClean`
re-checks every sample and drops any that still matches a key shape. It is
tested against a planted-secret corpus, and `assertClean` is itself tested to
fail on unredacted input.

Adoption is gated, not vibes: an adapter ships only if it beats the base on the
golden set, wins a blind A/B judged by a **third** model with alternating arm
order, and regresses on nothing in a 20-prompt safety set (10 must-refuse, 10
must-help, so refusing everything scores 0.5). A losing candidate stays on disk
and is simply never registered as an alias. Every alignment call is pinned S2.

