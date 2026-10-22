# BackUpper

A plug-in backup layer for coding agents. BackUpper checks every tool call and preserves the state it is about to modify, so the original can be restored later. It works with Claude Code, Codex, Hermes, OpenHands, DeepSeek Harness, and OpenClaw.

This is the Python distribution of the [`agents-backupper`](https://www.npmjs.com/package/agents-backupper) npm package. It bundles the same build and requires **Node.js >= 18** on `PATH`.

```bash
pip install agents-backupper

# in the project you want to protect
backupper init
backupper install claude-code   # or: codex | hermes | openhands | deepseek-harness | openclaw
```

See the [GitHub repository](https://github.com/CHATS-lab/BackUpper) for the full documentation.

**Paper:** [Back Up Before You Regret: Measuring Backup Awareness and Automating Backup in Coding Agents](https://arxiv.org/abs/2610.28934)

```bibtex
@article{li2026regretmeasuringbackupawareness,
  title   = {Back Up Before You Regret: Measuring Backup Awareness and Automating Backup in Coding Agents},
  author  = {Xu Li and Simon Yu and Minzhou Pan and Yiyou Sun and Zhaorun Chen and Bo Li and Weiyan Shi},
  journal = {arXiv preprint arXiv:2610.28934},
  year    = {2026}
}
```
