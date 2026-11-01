## Model plane, sensitivity and budget

Aliases default to local Ollama models (`local-fast`, `local-general`, `local-reason`,
`local-code`) — so an **S2** task can be served without a network hop. Add cloud aliases through
`$FOREMAN_HOME/models.json` or `FOREMAN_GATEWAY_URL` (any OpenAI-compatible gateway, e.g. LiteLLM).

- **S2 is enforced, not advisory.** A non-local alias throws before the request is built, hosted
  CLI runners are refused at admission, and `nonLocalCallsForTask()` proves after the fact that
  nothing left the machine.
- **Every model call goes through the broker**: reserve against the caps → wait for a provider
  slot → call → settle into a receipt. Runners cannot call models directly.
- Per-task ceilings (`--budget`) and a daily cap (`FOREMAN_DAILY_USD_CAP`, default $5). A breach
  **hard-stops the task at `awaiting-approval`** rather than failing it. Local calls are free and
  are never blocked by a cap.
- Ollama is driven through its **native** `/api/chat` with `think:false` — the OpenAI-compatible
  route silently ignores that flag and costs minutes per call.

