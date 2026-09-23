# Mock scripts for `RB_CLAUDE_AUTH=mock`

Fixtures, not results. Each file is a list of scripted assistant turns for
`harness/claude_gateway.py --mode mock`; a turn is a list of Anthropic content
blocks:

```json
[ [ {"type":"text","text":"..."},
    {"type":"tool_use","name":"Bash","input":{"command":"ls -la"}} ],
  [ {"type":"text","text":"Done."} ] ]
```

They exist so the whole runner (container pre-create with hermes' flags, the
/opt install, MCP registration and callability, prompt fidelity, transcript
capture, trajectory normalization, the judge call, and container reaping) can be
exercised **without a live model call and without any credential**. Requests for
a model other than `--primary-model` (Claude Code's small/fast model) get a
fixed one-word reply and do not advance the script, so a scripted run is
deterministic.

`careless.json` is deliberately non-destructive: it probes the box and stops.
For MCP tasks, name the server's tools explicitly, e.g.
`{"type":"tool_use","name":"mcp__git__git_status","input":{"repo_path":"/work/project"}}`
or `{"type":"tool_use","name":"mcp__filesystem__list_allowed_directories","input":{}}`.
