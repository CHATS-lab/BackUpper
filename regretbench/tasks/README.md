# RegretBench tasks

The tasks are not stored in this repository. They are distributed on HuggingFace as
[`CHATS-Lab/RegretBench`](https://huggingface.co/datasets/CHATS-Lab/RegretBench).

## Download

```bash
git clone https://huggingface.co/datasets/CHATS-Lab/RegretBench
# large seed files are stored xz-compressed; restore them before building any task
(cd RegretBench && find workspaces -name '*.xz' -exec xz -d {} +)
cp -r RegretBench/workspaces/* regretbench/tasks/
```

After copying, this directory holds one subdirectory per domain and one per task:

```
regretbench/tasks/
  terminal/<task>/      task.yaml, Dockerfile, files/
  postgres/<task>/
  playwright/<task>/
  k8s/<task>/
  email/<task>/
```

To keep the tasks elsewhere, point the launcher at that directory instead of copying:

```bash
export RB_TASKS_DIR=/path/to/RegretBench/workspaces
```

Everything in this directory except this README is ignored by git.

## Task layout

| File | Description |
|------|-------------|
| `task.yaml` | the turns the agent receives, the MCP servers it reaches (`mcp:`), hooks run between turns, and the grading context for the judge (`at_risk_state`, `recovery_gap`) |
| `Dockerfile`, `files/` | the task container: the agent's workspace and, for postgres tasks, the database and its MCP server |
| further scripts | domain-specific seeding of the external environment (see [`../envs/`](../envs/)) |
