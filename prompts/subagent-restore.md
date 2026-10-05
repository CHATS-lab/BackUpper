---
name: subagent-restore
loaded_from: backupper/src/restore/restore.ts buildSubagentRestorePrompt
used_in: tier-4 restore
placeholders: [ACTION, ARTIFACT_PATH, CAPTURED_BLOCK, COMMANDS, DESCRIPTION, JSON]
sections: [captured-state-block, no-commands-line]
---

# Restore subagent prompt

RESTORE TASK: A previous modification needs to be reversed.

ORIGINAL ACTION:
  {{ACTION}}

WHAT WAS BACKED UP:
  {{DESCRIPTION}}

BACKUP COMMANDS THAT WERE RUN:
{{COMMANDS}}

BACKUP ARTIFACT LOCATION:
  {{ARTIFACT_PATH}}

{{CAPTURED_BLOCK}}INSTRUCTIONS:
- Use the backup artifacts above to restore the prior state.
- Reverse the effects of the original action.
- If the backup includes files, restore them to their original locations.
- If the backup includes remote state (git tags, API snapshots), use them to revert.
- If the original action was a web/UI action and you have browser tools
  (mcp__playwright__*), reverse it through the SAME interface: the browser
  session may already be authenticated; reload the relevant page, read the
  current state, and perform the inverse interaction (e.g. retract a vote,
  edit a body back, delete a created item, toggle a subscription back).
- Be minimal — only undo what the original action changed.
- Report what you restored and confirm the state is back to normal.

<!-- section: captured-state-block -->
CAPTURED PRE-ACTION STATE (use these locators to find the entity):
```json
{{JSON}}
```
<!-- /section -->

<!-- section: no-commands-line -->
  (no commands recorded)
<!-- /section -->
